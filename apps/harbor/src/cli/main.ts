#!/usr/bin/env bun
/**
 * harbor CLI —— 入口层之一（P1）。
 * device ls / agent create·ls / chat / issue draft·create·assign·continue·review·changes·done·cancel / watch
 * 连接配置：HARBOR_SERVER_URL / HARBOR_TOKEN（或 ~/.harbor.yaml）。
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { databasePath, serverUrl, token as harborToken, workspace as configuredWorkspace } from "../config.js";
import { HarborClient } from "./client.js";
import { RunRenderer, c, fmtAgo, fmtRunCost } from "./render.js";
import type { ConversationStatus } from "../protocol.js";
import {
  daemonServiceStatus,
  setupDaemonService,
  showDaemonLogs,
  uninstallDaemonService,
} from "../daemon/service.js";
import {
  deploymentWorkerServiceStatus,
  setupDeploymentWorkerService,
  showDeploymentWorkerLogs,
  uninstallDeploymentWorkerService,
} from "../deployment-worker/service.js";
import { acknowledgeLegacyLocalDeployment, recoverLocalDeployment } from "../deployment-worker/recovery.js";
import { inspectIdentityNormalization } from "../server/identity-normalization.js";

const USAGE = `${c.bold}harbor${c.reset} — 个人多设备 agent 调度

${c.bold}派活${c.reset}
  harbor workspace ls · workspace create --name <n> [--slug <s>]
  harbor repo ls · repo create --name <n> [--device <d> --path <绝对路径>]
  harbor repo mount <repo> --device <d> --path <绝对路径>
  harbor device ls                                        已注册设备（在线状态/能力）
  harbor agent create --name <n> --device <d> [--repository <repo>]
                      [--workdir <路径>]  # 兼容：自动注册 Repository mount
                      [--model <m>] [--permission readonly|auto-edit|full|default]
                      [--backend claude|codex] [--isolation none|worktree]
                      [--instruction <系统提示>] [--description <说明>]
  harbor agent ls
  harbor chat <agent> "<prompt>"        [--detach]
  harbor issue draft "<描述>" [--title <t>] [--priority <p>] [--agent <a>]
                                                               保存到 Inbox，不启动 Run
  harbor issue create <agent> "<prompt>" [--title <t>] [--detach]
  harbor issue assign <id> <agent> ["<prompt>"] [--detach]  指派并执行
  harbor issue continue <id> "<prompt>"  [--detach]        续多轮（resume 上下文）
  harbor issue changes <id> "<反馈>" [--agent <a>] [--detach]
  harbor issue review <id> <agent> ["<要求>"] [--detach]  独立 AI Review
  harbor issue ls [--status backlog|todo|doing|review|done|canceled]
  harbor issue show <id>                                   详情 + run 流水
  harbor issue done <id> · harbor issue cancel <id>        人工验收/取消（收尾 worktree）
  harbor watch <run-id>                                    (重)连一个 run 的实时输出

${c.bold}设备 daemon${c.reset}
  harbor daemon setup [--server-url <url>] [--token <secret>] [--device-name <name>]
  harbor daemon status
  harbor daemon logs [--lines 100] [--follow]
  harbor daemon uninstall                                  卸服务，保留配置与日志

${c.bold}部署 host worker（独立 LaunchAgent）${c.reset}
  harbor deploy-worker setup
  harbor deploy-worker status
  harbor deploy-worker logs [--lines 100] [--follow]
  harbor deploy-worker recover <job-id> --target <target-id> --confirm <job-id>
  harbor deploy-worker acknowledge <legacy-job-id> --baseline-revision <exact-sha> --confirm <legacy-job-id>
  harbor deploy-worker uninstall

${c.bold}数据库迁移预检（只读，不启动 server）${c.reset}
  harbor db identity-report [--database <v22.db>] [--json]   P6.1 identity normalization dry-run

${c.bold}审批${c.reset}（permission=default 的 agent 用工具时上抛）
  harbor approvals [--status pending]                      审批列表
  harbor approve <id> · harbor deny <id>                   批/拒（飞书卡片同步可批）

${c.bold}Automations${c.reset}
  harbor auto create --name <n> --agent <a> --prompt "<p>"
                     [--trigger schedule --cron "<表达式>" --timezone Asia/Shanghai
                      | --trigger codebase --repository <repo> --event merge_request_opened]
                     [--output run|chat|issue]
  harbor auto ls · auto log <id> · auto enable|disable|rm <id>

${c.bold}用量${c.reset}
  harbor usage [--days 7] [--agent <a>] [--runs]           agent×model×日聚合 / 逐 run 下钻

${c.dim}id 支持前缀匹配；--workspace <id|slug> 选择作用域；server 地址/token 走 env 或 ~/.harbor.yaml${c.reset}`;

// ── 极简 argparse：--flag value / --flag（bool 白名单）+ 位置参数 ──

const BOOL_FLAGS = new Set(["detach", "follow", "help", "runs", "json"]);

function parseArgs(argv: string[]): { pos: string[]; flags: Record<string, string | true> } {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") {
      flags.help = true;
    } else if (a.startsWith("--")) {
      const key = a.slice(2);
      if (BOOL_FLAGS.has(key)) flags[key] = true;
      else {
        const v = argv[++i];
        if (v === undefined) throw new Error(`--${key} 缺少值`);
        flags[key] = v;
      }
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
}

function req(flags: Record<string, string | true>, key: string): string {
  const v = flags[key];
  if (typeof v !== "string" || !v) throw new Error(`缺少 --${key}（-h 看用法）`);
  return v;
}

function table(rows: string[][], headers: string[]): void {
  const all = [headers, ...rows];
  const widths = headers.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  const line = (r: string[], dim = false) =>
    console.log(
      (dim ? c.dim : "") + r.map((cell, i) => (cell ?? "").padEnd(widths[i]! + 2)).join("") + (dim ? c.reset : ""),
    );
  line(headers, true);
  for (const r of rows) line(r);
}

// ── watch（chat / issue create / continue / watch 共用） ──

async function watchRun(client: HarborClient, runId: string): Promise<number> {
  const run = await client.getRun(runId);
  if (run.status === "queued") {
    console.log(`${c.dim}⏳ 排队中（设备离线或并发已满；Ctrl-C 退出不影响执行）${c.reset}`);
  }
  const renderer = new RunRenderer();
  let sawDone = false;
  for await (const frame of client.watchRun(runId)) {
    const done = renderer.frame(frame);
    if (done) {
      sawDone = true;
      return done.status === "succeeded" ? 0 : 1;
    }
  }
  if (!sawDone) {
    console.log(`${c.yellow}⚠ 事件流中断（server 重启？）——harbor watch ${runId} 可重连${c.reset}`);
    return 1;
  }
  return 0;
}

// ── 命令实现 ────────────────────────────────────────────

async function main(): Promise<number> {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || pos.length === 0) {
    console.log(USAGE);
    return 0;
  }
  const [domain, verb] = [pos[0]!, pos[1]];

  // 本机服务管理不依赖 server/token，必须在 HarborClient 初始化前处理。
  if (domain === "daemon") {
    if (verb === "setup") {
      const status = await setupDaemonService({
        serverUrl: typeof flags["server-url"] === "string" ? flags["server-url"] : undefined,
        token: typeof flags.token === "string" ? flags.token : undefined,
        deviceName: typeof flags["device-name"] === "string" ? flags["device-name"] : undefined,
      });
      console.log(`${c.green}✓${c.reset} harbord service 已安装并启动（${status.platform}）`);
      console.log(`${c.dim}  state=${status.state} pid=${status.pid ?? "-"} definition=${status.definitionPath}${c.reset}`);
      return status.running ? 0 : 1;
    }
    if (verb === "status") {
      const status = daemonServiceStatus();
      const color = status.running ? c.green : status.loaded ? c.yellow : c.red;
      console.log(`${color}${status.running ? "● running" : status.loaded ? "● loaded" : "○ stopped"}${c.reset}`);
      console.log(`${c.dim}  platform=${status.platform} state=${status.state} pid=${status.pid ?? "-"}${c.reset}`);
      console.log(`${c.dim}  definition=${status.definitionPath}${c.reset}`);
      if (status.stdoutPath) console.log(`${c.dim}  logs=${status.stdoutPath}, ${status.stderrPath}${c.reset}`);
      return status.running ? 0 : 1;
    }
    if (verb === "logs") {
      const lines = typeof flags.lines === "string" ? Number(flags.lines) : 100;
      if (!Number.isFinite(lines) || lines <= 0) throw new Error("--lines 必须是正整数");
      return showDaemonLogs(lines, flags.follow === true);
    }
    if (verb === "uninstall") {
      const status = uninstallDaemonService();
      console.log(`${c.green}✓${c.reset} harbord service 已卸载（配置与日志保留）`);
      console.log(`${c.dim}  definition=${status.definitionPath}${c.reset}`);
      return 0;
    }
    throw new Error("用法：harbor daemon setup|status|logs|uninstall");
  }

  if (domain === "deploy-worker") {
    if (verb === "setup") {
      const status = setupDeploymentWorkerService();
      console.log(`${c.green}✓${c.reset} deployment worker LaunchAgent 已安装并启动`);
      console.log(`${c.dim}  definition=${status.definitionPath}${c.reset}`);
      return 0;
    }
    if (verb === "status") {
      const status = deploymentWorkerServiceStatus();
      console.log(`${status.running ? c.green : c.yellow}${status.running ? "● running" : "○ stopped"}${c.reset} ${status.state}${status.pid ? ` pid=${status.pid}` : ""}`);
      console.log(`${c.dim}  definition=${status.definitionPath}${c.reset}`);
      return status.running ? 0 : 1;
    }
    if (verb === "logs") {
      const lines = typeof flags.lines === "string" ? Number(flags.lines) : 100;
      if (!Number.isFinite(lines) || lines <= 0) throw new Error("--lines 必须是正整数");
      return showDeploymentWorkerLogs(lines, flags.follow === true);
    }
    if (verb === "recover") {
      const jobId = pos[2];
      if (!jobId) throw new Error("用法：harbor deploy-worker recover <job-id> --target <target-id> --confirm <job-id>");
      if (flags.confirm !== jobId) throw new Error("recovery 会操作 host service/rollback anchor；--confirm 必须精确重复完整 job-id");
      await recoverLocalDeployment(jobId, req(flags, "target"));
      console.log(`${c.green}✓${c.reset} deployment ${jobId} 已恢复并验证旧 baseline；现在可从 Delivery 执行普通 Retry`);
      return 0;
    }
    if (verb === "acknowledge") {
      const jobId = pos[2];
      if (!jobId) throw new Error("用法：harbor deploy-worker acknowledge <legacy-job-id> --baseline-revision <exact-sha> --confirm <legacy-job-id>");
      if (flags.confirm !== jobId) throw new Error("legacy ack 会解除不可执行的旧 gate；--confirm 必须精确重复完整 job-id");
      await acknowledgeLegacyLocalDeployment(jobId, req(flags, "baseline-revision"));
      console.log(`${c.yellow}!${c.reset} legacy deployment ${jobId} 已记为 failed；必须先 bootstrap trusted baseline manifest 才能 Retry`);
      return 0;
    }
    if (verb === "uninstall") {
      const status = uninstallDeploymentWorkerService();
      console.log(`${c.green}✓${c.reset} deployment worker LaunchAgent 已卸载（配置与日志保留）`);
      console.log(`${c.dim}  definition=${status.definitionPath}${c.reset}`);
      return 0;
    }
    throw new Error("用法：harbor deploy-worker setup|status|logs|recover|acknowledge|uninstall");
  }

  if (domain === "db") {
    if (verb !== "identity-report")
      throw new Error("用法：harbor db identity-report [--database <v22.db>] [--json]");
    const path = resolve(typeof flags.database === "string" ? flags.database : databasePath());
    if (!existsSync(path)) throw new Error(`数据库不存在：${path}`);
    const db = new Database(path, { readonly: true });
    try {
      const report = inspectIdentityNormalization(db);
      if (flags.json === true) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        const state = report.migratable ? `${c.green}PASS${c.reset}` : `${c.red}BLOCKED${c.reset}`;
        console.log(`${c.bold}Harbor P6.1 identity normalization dry-run${c.reset}  ${state}`);
        console.log(`${c.dim}database=${path} schema=v${report.sourceSchemaVersion} report=v${report.reportVersion}${c.reset}`);
        console.log(
          `legacy members=${report.counts.legacyMembers} → accounts=${report.counts.projectedAccounts}` +
          ` memberships=${report.counts.projectedMemberships} invitations=${report.counts.projectedInvitations}` +
          ` auth identities=${report.counts.projectedAuthIdentities} PATs=${report.counts.workspaceApiTokens}`,
        );
        console.log(
          `dedupe synthetic=${report.counts.syntheticMembers} external-members=${report.counts.externalIdentityMembers}` +
          ` duplicate-email-groups=${report.duplicateEmails.length}（email 不参与自动合并）`,
        );
        for (const entry of report.issues) {
          const marker = entry.severity === "error" ? `${c.red}ERROR${c.reset}` : `${c.yellow}WARN${c.reset}`;
          console.log(`${marker} ${entry.code}: ${entry.message}`);
          console.log(`${c.dim}  refs=${entry.refs.join(", ") || "-"}${c.reset}`);
        }
        if (report.issues.length === 0) console.log(`${c.green}✓${c.reset} 未发现阻断项或警告`);
      }
      return report.migratable ? 0 : 2;
    } finally {
      db.close();
    }
  }

  const workspace = typeof flags.workspace === "string" ? flags.workspace : configuredWorkspace();
  const client = new HarborClient(serverUrl(), harborToken(), workspace);

  if (domain === "workspace" && verb === "ls") {
    const workspaces = await client.workspaces();
    table(workspaces.map((item) => [item.name, item.slug, item.id]), ["NAME", "SLUG", "ID"]);
    return 0;
  }

  if (domain === "workspace" && verb === "create") {
    const created = await client.createWorkspace({ name: req(flags, "name"), slug: flags.slug, description: flags.description });
    console.log(`${c.green}✓${c.reset} workspace ${c.bold}${created.name}${c.reset}（${created.slug} · ${created.id}）已创建`);
    return 0;
  }

  if (domain === "repo" && verb === "ls") {
    const repositories = await client.repositories();
    table(
      repositories.map((repository) => [
        repository.name,
        repository.defaultBranch,
        repository.mounts.map((mount) => `${mount.deviceName}:${mount.path}`).join(" · ") || "-",
        repository.id,
      ]),
      ["NAME", "BRANCH", "MOUNTS", "ID"],
    );
    return 0;
  }

  if (domain === "repo" && verb === "create") {
    const repository = await client.createRepository({
      name: req(flags, "name"),
      remoteUrl: flags.remote,
      defaultBranch: flags.branch,
      device: flags.device,
      path: flags.path,
    });
    console.log(`${c.green}✓${c.reset} repository ${c.bold}${repository.name}${c.reset}（${repository.id}）已创建`);
    return 0;
  }

  if (domain === "repo" && verb === "mount") {
    const id = pos[2];
    if (!id) throw new Error("用法：harbor repo mount <repo> --device <d> --path <绝对路径>");
    await client.mountRepository(id, { device: req(flags, "device"), path: req(flags, "path") });
    console.log(`${c.green}✓${c.reset} repository mount 已保存`);
    return 0;
  }

  if (domain === "device" && verb === "ls") {
    const devices = await client.devices();
    table(
      devices.map((d) => [
        d.name,
        d.online ? `${c.green}online${c.reset}` : `${c.red}offline${c.reset}`,
        fmtAgo(d.lastSeenAt),
        Object.entries(d.capabilities.clis).map(([k, v]) => `${k}@${v}`).join(" ") || "-",
        String(
          d.capabilities.modelRoutes
            ? new Set(d.capabilities.modelRoutes.filter((route) => route.ready).map((route) => route.id)).size || "-"
            : new Set(d.capabilities.endpoints).size || "-",
        ),
        d.id,
      ]),
      ["NAME", "STATE", "SEEN", "CLIS", "MODELS", "ID"],
    );
    return 0;
  }

  if (domain === "agent" && verb === "create") {
    const agent = await client.createAgent({
      name: req(flags, "name"),
      device: req(flags, "device"),
      repository: flags.repository,
      workdir: flags.workdir,
      model: flags.model,
      permission: flags.permission,
      backend: flags.backend,
      isolation: flags.isolation,
      instruction: flags.instruction,
      description: flags.description,
    });
    console.log(`${c.green}✓${c.reset} agent ${c.bold}${agent.name}${c.reset}（${agent.id}）已创建`);
    console.log(
      `${c.dim}  device=${agent.deviceId} model=${agent.model ?? "CLI 默认"} permission=${agent.permission} isolation=${agent.isolation} repository=${agent.repositoryId ?? "none"}${c.reset}`,
    );
    return 0;
  }

  if (domain === "agent" && verb === "ls") {
    const [agents, devices] = await Promise.all([client.agents(), client.devices()]);
    const dev = new Map(devices.map((d) => [d.id, d.name]));
    table(
      agents.map((a) => [
        a.name,
        dev.get(a.deviceId) ?? a.deviceId,
        a.backend,
        a.model ?? "(默认)",
        a.permission,
        a.isolation === "worktree" ? "worktree" : "-",
        a.repositoryId ?? "-",
      ]),
      ["NAME", "DEVICE", "BACKEND", "MODEL", "PERM", "ISO", "REPOSITORY"],
    );
    return 0;
  }

  if (domain === "chat") {
    const agent = pos[1];
    const prompt = pos.slice(2).join(" ");
    if (!agent || !prompt) throw new Error(`用法：harbor chat <agent> "<prompt>"`);
    const conv = await client.createConversation({ kind: "chat", agent });
    const run = await client.createRun(conv.id, prompt);
    console.log(`${c.dim}chat ${conv.id} · run ${run.id}${c.reset}`);
    return flags.detach ? 0 : watchRun(client, run.id);
  }

  if (domain === "issue") {
    if (verb === "draft") {
      const description = pos.slice(2).join(" ");
      if (!description) throw new Error(`用法：harbor issue draft "<描述>" [--title t] [--agent a]`);
      const conv = await client.createConversation({
        kind: "issue",
        agent: flags.agent,
        title: typeof flags.title === "string" ? flags.title : description.slice(0, 60),
        description,
        priority: flags.priority,
      });
      console.log(`${c.green}✓${c.reset} issue ${c.bold}${conv.id}${c.reset} 已保存到 Inbox${conv.agentId ? "（已指派，未执行）" : ""}`);
      return 0;
    }

    if (verb === "create") {
      const agent = pos[2];
      const prompt = pos.slice(3).join(" ");
      if (!agent || !prompt) throw new Error(`用法：harbor issue create <agent> "<prompt>" [--title t]`);
      const conv = await client.createConversation({
        kind: "issue",
        agent,
        title: typeof flags.title === "string" ? flags.title : prompt.slice(0, 60),
        description: prompt,
        priority: flags.priority,
      });
      const run = await client.dispatchIssue(conv.id, agent, prompt);
      console.log(`${c.green}✓${c.reset} issue ${c.bold}${conv.id}${c.reset} · run ${run.id}`);
      return flags.detach ? 0 : watchRun(client, run.id);
    }

    if (verb === "assign") {
      const id = pos[2];
      const agent = pos[3];
      const prompt = pos.slice(4).join(" ") || undefined;
      if (!id || !agent) throw new Error(`用法：harbor issue assign <id> <agent> ["<prompt>"]`);
      const run = await client.dispatchIssue(id, agent, prompt);
      console.log(`${c.dim}issue ${run.conversationId} · run ${run.id}（assign & run）${c.reset}`);
      return flags.detach ? 0 : watchRun(client, run.id);
    }

    if (verb === "continue") {
      const id = pos[2];
      const prompt = pos.slice(3).join(" ");
      if (!id || !prompt) throw new Error(`用法：harbor issue continue <id> "<prompt>"`);
      const run = await client.createRun(id, prompt);
      console.log(`${c.dim}issue ${run.conversationId} · run ${run.id}（resume 上一轮上下文）${c.reset}`);
      return flags.detach ? 0 : watchRun(client, run.id);
    }

    if (verb === "changes") {
      const id = pos[2];
      const feedback = pos.slice(3).join(" ");
      if (!id || !feedback) throw new Error(`用法：harbor issue changes <id> "<反馈>" [--agent a]`);
      const run = await client.requestChanges(id, feedback, typeof flags.agent === "string" ? flags.agent : undefined);
      console.log(`${c.dim}issue ${run.conversationId} · run ${run.id}（request changes）${c.reset}`);
      return flags.detach ? 0 : watchRun(client, run.id);
    }

    if (verb === "review") {
      const id = pos[2];
      const agent = pos[3];
      const prompt = pos.slice(4).join(" ") || undefined;
      if (!id || !agent) throw new Error(`用法：harbor issue review <id> <agent> ["<要求>"]`);
      const run = await client.reviewIssue(id, agent, prompt);
      console.log(`${c.dim}issue ${run.conversationId} · review run ${run.id}${c.reset}`);
      return flags.detach ? 0 : watchRun(client, run.id);
    }

    if (verb === "ls") {
      const status = typeof flags.status === "string" ? flags.status : undefined;
      const convs = await client.conversations({ kind: "issue", status });
      table(
        convs.map((cv) => [cv.id, cv.status, (cv.title ?? "").slice(0, 40), cv.agentName ?? "(unassigned)", fmtAgo(cv.updatedAt)]),
        ["ID", "STATUS", "TITLE", "AGENT", "UPDATED"],
      );
      return 0;
    }

    if (verb === "show") {
      const id = pos[2];
      if (!id) throw new Error("用法：harbor issue show <id>");
      const { conversation, agent, runs } = await client.getConversation(id);
      console.log(`${c.bold}${conversation.title ?? "(无标题)"}${c.reset}  ${c.dim}${conversation.id}${c.reset}`);
      console.log(
        `${c.dim}kind=${conversation.kind} status=${c.reset}${conversation.status}${c.dim} priority=${conversation.priority} agent=${agent?.name ?? conversation.agentId ?? "unassigned"} session=${conversation.claudeSessionId?.slice(0, 8) ?? "-"}${c.reset}`,
      );
      table(
        runs.map((r) => [
          r.id,
          `${r.purpose}/${r.status}`,
          fmtAgo(r.queuedAt),
          fmtRunCost(r) || "-",
          (r.error ?? r.prompt).slice(0, 50),
        ]),
        ["RUN", "STATUS", "QUEUED", "COST", "ERROR/PROMPT"],
      );
      return 0;
    }

    if (verb === "done" || verb === "cancel") {
      const id = pos[2];
      if (!id) throw new Error(`用法：harbor issue ${verb} <id>`);
      const conv = verb === "done" ? await client.approveIssue(id) : await client.cancelIssue(id);
      console.log(`${c.green}✓${c.reset} issue ${conv.id} → ${conv.status}`);
      return 0;
    }
  }

  if (domain === "watch") {
    const id = pos[1];
    if (!id) throw new Error("用法：harbor watch <run-id>");
    const run = await client.getRun(id);
    return watchRun(client, run.id);
  }

  // ── 审批 ──
  if (domain === "approvals") {
    const status = typeof flags.status === "string" ? (flags.status as import("../protocol.js").ApprovalStatus) : undefined;
    const rows = await client.approvals(status);
    table(
      rows.map((a) => [
        a.id,
        a.status + (a.decidedBy ? `(${a.decidedBy})` : ""),
        a.toolName,
        JSON.stringify(a.input ?? {}).slice(0, 50),
        a.runId,
        fmtAgo(a.createdAt),
      ]),
      ["ID", "STATUS", "TOOL", "INPUT", "RUN", "CREATED"],
    );
    return 0;
  }

  if (domain === "approve" || domain === "deny") {
    const id = pos[1];
    if (!id) throw new Error(`用法：harbor ${domain} <approval-id>`);
    const expected = domain === "approve" ? "allowed" : "denied";
    const a = await client.decideApproval(id, domain === "approve" ? "allow" : "deny");
    if (a.status === expected) {
      console.log(`${c.green}✓${c.reset} approval ${a.id} → ${a.status}`);
    } else {
      console.log(`${c.yellow}⚠ approval ${a.id} 已是 ${a.status}（by ${a.decidedBy ?? "?"}），本次操作未生效${c.reset}`);
    }
    return 0;
  }

  // ── automation ──
  if (domain === "auto") {
    if (verb === "create") {
      const triggerType = String(flags.trigger ?? "schedule");
      if (triggerType !== "schedule" && triggerType !== "codebase") {
        throw new Error("--trigger 只支持 schedule/codebase");
      }
      const auto = await client.createAutomation({
        name: req(flags, "name"),
        agent: req(flags, "agent"),
        trigger: triggerType === "schedule"
          ? {
              type: "schedule",
              cron: req(flags, "cron"),
              timezone: String(flags.timezone ?? "Asia/Shanghai"),
            }
          : {
              type: "codebase",
              repository: req(flags, "repository"),
              event: String(flags.event ?? "merge_request_opened"),
            },
        prompt: req(flags, "prompt"),
        output: flags.output ?? "run",
      });
      console.log(`${c.green}✓${c.reset} automation ${c.bold}${auto.name}${c.reset}（${auto.id}）已创建`);
      console.log(`${c.dim}  trigger=${auto.trigger.type} output=${auto.output}${c.reset}`);
      return 0;
    }
    if (verb === "ls") {
      const autos = await client.automations();
      table(
        autos.map((a) => [
          a.id,
          a.enabled ? `${c.green}on${c.reset}` : `${c.dim}off${c.reset}`,
          a.name,
          a.agentName,
          a.trigger.type === "schedule"
            ? `schedule:${a.trigger.cron} (${a.trigger.timezone})`
            : `codebase:${a.trigger.codebaseEvent}`,
          a.output,
          fmtAgo(a.lastFiredAt),
        ]),
        ["ID", "STATE", "NAME", "AGENT", "TRIGGER", "OUTPUT", "LAST FIRED"],
      );
      return 0;
    }
    if (verb === "log") {
      const id = pos[2];
      if (!id) throw new Error("用法：harbor auto log <id>");
      const rows = await client.automationLog(id);
      table(
        rows.map((l) => [
          new Date(l.ts).toLocaleString("sv-SE"),
          l.kind === "fired" ? `${c.green}fired${c.reset}` : `${c.yellow}${l.kind}${c.reset}`,
          l.runId ?? "-",
          l.note ?? "",
        ]),
        ["TS", "KIND", "RUN", "NOTE"],
      );
      return 0;
    }
    if (verb === "enable" || verb === "disable") {
      const id = pos[2];
      if (!id) throw new Error(`用法：harbor auto ${verb} <id>`);
      const auto = await client.setAutomationEnabled(id, verb === "enable");
      console.log(`${c.green}✓${c.reset} automation ${auto.name} → ${auto.enabled ? "enabled" : "disabled"}`);
      return 0;
    }
    if (verb === "rm") {
      const id = pos[2];
      if (!id) throw new Error("用法：harbor auto rm <id>");
      await client.deleteAutomation(id);
      console.log(`${c.green}✓${c.reset} automation 已删除`);
      return 0;
    }
  }

  // ── usage ──
  if (domain === "usage") {
    const days = typeof flags.days === "string" ? Math.max(1, Number(flags.days)) : 7;
    if (flags.runs) {
      const runs = await client.usageRuns({ days, agent: typeof flags.agent === "string" ? flags.agent : undefined });
      table(
        runs.map((r) => [
          r.id,
          r.status,
          new Date(r.queuedAt).toLocaleString("sv-SE"),
          fmtRunCost(r) || "-",
          (r.error ?? r.prompt).slice(0, 40),
        ]),
        ["RUN", "STATUS", "QUEUED", "COST", "ERROR/PROMPT"],
      );
      return 0;
    }
    const rows = await client.usage(days);
    const filtered = typeof flags.agent === "string" ? rows.filter((r) => r.agentName === flags.agent) : rows;
    table(
      filtered.map((r) => [
        r.day,
        r.agentName,
        r.model,
        String(r.runs),
        `$${r.usd.toFixed(4)}`,
        String(r.inputTokens),
        String(r.outputTokens),
        String(r.cachedTokens),
      ]),
      ["DAY", "AGENT", "MODEL", "RUNS", "USD", "IN", "OUT", "CACHED"],
    );
    const total = filtered.reduce((s, r) => s + r.usd, 0);
    console.log(`${c.dim}—— 近 ${days} 天合计 $${total.toFixed(4)}（${filtered.reduce((s, r) => s + r.runs, 0)} runs）${c.reset}`);
    return 0;
  }

  console.log(USAGE);
  throw new Error(`未知命令：${pos.join(" ")}`);
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`${c.red}✗ ${e instanceof Error ? e.message : e}${c.reset}`);
    process.exit(1);
  });

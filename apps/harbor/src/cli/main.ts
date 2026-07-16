#!/usr/bin/env bun
/**
 * harbor CLI —— 入口层之一（P1）。
 * device ls / agent create·ls / chat / issue create·continue·ls·show·done·cancel / watch <run>
 * 连接配置：HARBOR_SERVER_URL / HARBOR_TOKEN（或 ~/.harbor.yaml）。
 */

import { serverUrl, token as harborToken } from "../config.js";
import { HarborClient } from "./client.js";
import { RunRenderer, c, fmtAgo, fmtRunCost } from "./render.js";
import type { ConversationStatus } from "../protocol.js";
import {
  daemonServiceStatus,
  setupDaemonService,
  showDaemonLogs,
  uninstallDaemonService,
} from "../daemon/service.js";

const USAGE = `${c.bold}harbor${c.reset} — 个人多设备 agent 调度

${c.bold}派活${c.reset}
  harbor device ls                                        已注册设备（在线状态/能力）
  harbor agent create --name <n> --device <d> --workdir <路径>
                      [--model <m>] [--permission readonly|auto-edit|full|default]
                      [--backend claude|codex] [--isolation none|worktree]
                      [--instruction <系统提示>] [--description <说明>]
  harbor agent ls
  harbor chat <agent> "<prompt>"        [--detach]        临时对话（不留 issue）
  harbor issue create <agent> "<prompt>" [--title <t>] [--detach]
  harbor issue continue <id> "<prompt>"  [--detach]        续多轮（resume 上下文）
  harbor issue ls [--status backlog|doing|review|done|canceled]
  harbor issue show <id>                                   详情 + run 流水
  harbor issue done <id> · harbor issue cancel <id>        人工验收/取消（收尾 worktree）
  harbor watch <run-id>                                    (重)连一个 run 的实时输出

${c.bold}设备 daemon${c.reset}
  harbor daemon setup [--server-url <url>] [--token <secret>] [--device-name <name>]
  harbor daemon status
  harbor daemon logs [--lines 100] [--follow]
  harbor daemon uninstall                                  卸服务，保留配置与日志

${c.bold}审批${c.reset}（permission=default 的 agent 用工具时上抛）
  harbor approvals [--status pending]                      审批列表
  harbor approve <id> · harbor deny <id>                   批/拒（飞书卡片同步可批）

${c.bold}定时${c.reset}
  harbor auto create --name <n> --agent <a> --cron "<表达式>" --prompt "<p>"
                     [--mode new_issue|append --target <conv-id>] [--notify-chat <oc_xx>]
  harbor auto ls · auto log <id> · auto enable|disable|rm <id>

${c.bold}用量${c.reset}
  harbor usage [--days 7] [--agent <a>] [--runs]           agent×model×日聚合 / 逐 run 下钻

${c.dim}id 支持前缀匹配；--detach 派活后不等输出。server 地址/token 走 env 或 ~/.harbor.yaml${c.reset}`;

// ── 极简 argparse：--flag value / --flag（bool 白名单）+ 位置参数 ──

const BOOL_FLAGS = new Set(["detach", "follow", "help", "runs"]);

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

  const client = new HarborClient(serverUrl(), harborToken());

  if (domain === "device" && verb === "ls") {
    const devices = await client.devices();
    table(
      devices.map((d) => [
        d.name,
        d.online ? `${c.green}online${c.reset}` : `${c.red}offline${c.reset}`,
        fmtAgo(d.lastSeenAt),
        Object.entries(d.capabilities.clis).map(([k, v]) => `${k}@${v}`).join(" ") || "-",
        String(new Set(d.capabilities.endpoints.map((e) => e.split(":")[0])).size || "-"),
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
      workdir: req(flags, "workdir"),
      model: flags.model,
      permission: flags.permission,
      backend: flags.backend,
      isolation: flags.isolation,
      instruction: flags.instruction,
      description: flags.description,
    });
    console.log(`${c.green}✓${c.reset} agent ${c.bold}${agent.name}${c.reset}（${agent.id}）已创建`);
    console.log(
      `${c.dim}  device=${agent.deviceId} model=${agent.model ?? "CLI 默认"} permission=${agent.permission} isolation=${agent.isolation} workdir=${agent.workdir}${c.reset}`,
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
        a.workdir,
      ]),
      ["NAME", "DEVICE", "BACKEND", "MODEL", "PERM", "ISO", "WORKDIR"],
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
    if (verb === "create") {
      const agent = pos[2];
      const prompt = pos.slice(3).join(" ");
      if (!agent || !prompt) throw new Error(`用法：harbor issue create <agent> "<prompt>" [--title t]`);
      const conv = await client.createConversation({
        kind: "issue",
        agent,
        title: typeof flags.title === "string" ? flags.title : prompt.slice(0, 60),
      });
      const run = await client.createRun(conv.id, prompt);
      console.log(`${c.green}✓${c.reset} issue ${c.bold}${conv.id}${c.reset} · run ${run.id}`);
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

    if (verb === "ls") {
      const status = typeof flags.status === "string" ? flags.status : undefined;
      const convs = await client.conversations({ kind: "issue", status });
      table(
        convs.map((cv) => [cv.id, cv.status, (cv.title ?? "").slice(0, 40), cv.agentName, fmtAgo(cv.updatedAt)]),
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
        `${c.dim}kind=${conversation.kind} status=${c.reset}${conversation.status}${c.dim} agent=${agent?.name ?? conversation.agentId} session=${conversation.claudeSessionId?.slice(0, 8) ?? "-"}${c.reset}`,
      );
      table(
        runs.map((r) => [
          r.id,
          r.status,
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
      const to: ConversationStatus = verb === "done" ? "done" : "canceled";
      const conv = await client.setConversationStatus(id, to);
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
      const auto = await client.createAutomation({
        name: req(flags, "name"),
        agent: req(flags, "agent"),
        cron: req(flags, "cron"),
        prompt: req(flags, "prompt"),
        mode: flags.mode,
        target: flags.target,
        notifyChat: flags["notify-chat"],
      });
      console.log(`${c.green}✓${c.reset} automation ${c.bold}${auto.name}${c.reset}（${auto.id}）已创建并排班`);
      console.log(`${c.dim}  cron="${auto.cron}"（server 本机时区）mode=${auto.mode}${auto.notifyChatId ? ` notify=${auto.notifyChatId}` : ""}${c.reset}`);
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
          a.cron,
          a.mode,
          fmtAgo(a.lastFiredAt),
        ]),
        ["ID", "STATE", "NAME", "AGENT", "CRON", "MODE", "LAST FIRED"],
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
          l.kind === "fired" ? `${c.green}fired${c.reset}` : `${c.yellow}missed${c.reset}`,
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

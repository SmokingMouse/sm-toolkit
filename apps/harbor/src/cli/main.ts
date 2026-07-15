#!/usr/bin/env bun
/**
 * harbor CLI —— 入口层之一（P1）。
 * device ls / agent create·ls / chat / issue create·continue·ls·show·done·cancel / watch <run>
 * 连接配置：HARBOR_SERVER_URL / HARBOR_TOKEN（或 ~/.harbor.yaml）。
 */

import { serverUrl, token } from "../config.js";
import { HarborClient } from "./client.js";
import { RunRenderer, c, fmtAgo, fmtRunCost } from "./render.js";
import type { ConversationStatus } from "../protocol.js";

const USAGE = `${c.bold}harbor${c.reset} — 个人多设备 agent 调度

${c.bold}用法${c.reset}
  harbor device ls                                        已注册设备（在线状态/能力）
  harbor agent create --name <n> --device <d> --workdir <路径>
                      [--model <m>] [--permission <p>] [--backend claude|codex]
                      [--instruction <系统提示>] [--description <说明>]
  harbor agent ls
  harbor chat <agent> "<prompt>"        [--detach]        临时对话（不留 issue）
  harbor issue create <agent> "<prompt>" [--title <t>] [--detach]
  harbor issue continue <id> "<prompt>"  [--detach]        续多轮（resume 上下文）
  harbor issue ls [--status backlog|doing|review|done|canceled]
  harbor issue show <id>                                   详情 + run 流水
  harbor issue done <id> · harbor issue cancel <id>        人工验收/取消
  harbor watch <run-id>                                    (重)连一个 run 的实时输出

${c.dim}id 支持前缀匹配；--detach 派活后不等输出。server 地址/token 走 env 或 ~/.harbor.yaml${c.reset}`;

// ── 极简 argparse：--flag value / --flag（bool 白名单）+ 位置参数 ──

const BOOL_FLAGS = new Set(["detach", "help"]);

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
  const client = new HarborClient(serverUrl(), token());
  const [domain, verb] = [pos[0]!, pos[1]];

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
      instruction: flags.instruction,
      description: flags.description,
    });
    console.log(`${c.green}✓${c.reset} agent ${c.bold}${agent.name}${c.reset}（${agent.id}）已创建`);
    console.log(`${c.dim}  device=${agent.deviceId} model=${agent.model ?? "CLI 默认"} permission=${agent.permission} workdir=${agent.workdir}${c.reset}`);
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
        a.workdir,
      ]),
      ["NAME", "DEVICE", "BACKEND", "MODEL", "PERM", "WORKDIR"],
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

  console.log(USAGE);
  throw new Error(`未知命令：${pos.join(" ")}`);
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`${c.red}✗ ${e instanceof Error ? e.message : e}${c.reset}`);
    process.exit(1);
  });

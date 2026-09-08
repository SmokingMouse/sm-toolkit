import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { MockEngine } from "@smokingmouse/agent-server";
import { AgentClient } from "@smokingmouse/agent-server/client";
import { resolveDaemonPaths, runDaemon, type RunningDaemon } from "@smokingmouse/agent-server/daemon";
import { ErrorCode, ProtocolError, type JsonObject, type StartTurnParams } from "@smokingmouse/agent-server/protocol";
import { shortId } from "./sessions.js";

// Captured native 2.1.258 response field shapes, without launching an engine.
const cases: Array<{ input: string; subtype: string; params: JsonObject; payload: JsonObject; visible: string }> = [
  { input: "/diff", subtype: "get_workspace_diff", params: {}, payload: { diff: { hunks: [{ path: "demo.ts", hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-before", "+after"] }] }], skippedLarge: [], restricted: [] } }, visible: "+after" },
  { input: "/context", subtype: "get_context_usage", params: {}, payload: { totalTokens: 50000, rawMaxTokens: 100000, categories: [{ name: "messages", tokens: 40000 }] }, visible: "50% · 50000 / 100000 tokens" },
  { input: "/usage", subtype: "get_usage", params: {}, payload: { session: { total_cost_usd: 1.23, model_usage: { sonnet: { inputTokens: 20 } } }, rate_limits: null }, visible: "session.total_cost_usd | 1.23" },
  { input: "/cost", subtype: "get_session_cost", params: {}, payload: { text: "Total cost: $1.23" }, visible: "Total cost: $1.23" },
  { input: "/mcp", subtype: "mcp_status", params: {}, payload: { mcpServers: [{ name: "search", status: "connected" }, { name: "broken", status: "failed", error: "offline" }] }, visible: "[failed] broken · offline" },
  { input: "/rewind native-message latest-message", subtype: "rewind_conversation", params: { target_message_uuid: "native-message", last_seen_user_message_uuid: "latest-message" }, payload: { rewound: true, prefillText: "previous prompt" }, visible: "会话已回滚（引擎确认）" },
  { input: "/btw explain this", subtype: "side_question", params: { question: "explain this" }, payload: { response: "side answer" }, visible: "side answer" },
];

class ShellMock extends MockEngine {
  validateTurn(options: StartTurnParams): void {
    if (this.backend === "codex" && options.input.some(p => p.type === "bash")) throw new ProtocolError(ErrorCode.backend_unsupported, "bash input requires Claude");
  }
}

for (const backend of ["claude", "codex"] as const) test(`engine commands PTY (${backend}): every RPC success/unsupported, rewind y/N, shell items and interrupt`, async () => {
  const home = mkdtempSync("/tmp/tui-engine-cmd-"), env = { ...process.env, HOME: home, XDG_STATE_HOME: join(home, "state"), XDG_RUNTIME_DIR: "", AGENT_SERVER_SOCKET_PATH: "", HERDR_PANE_ID: "", TERM: "xterm-256color" };
  const paths = resolveDaemonPaths(env), requests: any[] = [];
  let daemon: RunningDaemon | undefined, client: AgentClient | undefined, proc: ReturnType<typeof Bun.spawn> | undefined, screen = "";
  let reject: "unsupported" | "native" | "rewind" | undefined;
  const engine = new ShellMock(undefined, backend);
  engine.controlResponse = subtype => {
    if (reject === "unsupported") throw new ProtocolError(ErrorCode.backend_unsupported, "fixture unavailable");
    if (reject === "native") return { response: { subtype: "error", error: "native policy denied" } };
    return { type: "control_response", response: { subtype: "success", response: reject === "rewind" ? { rewound: false, error: "stale target" } : cases.find(c => c.subtype === subtype)!.payload } };
  };
  const frame = () => screen.slice(screen.lastIndexOf("\x1b[H")).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
  const wait = async (predicate: () => boolean, reason: string) => {
    const until = Date.now() + 6000;
    while (!predicate()) { if (Date.now() > until) throw new Error(`${reason}\n${frame()}`); await Bun.sleep(10); }
  };
  const write = (keys: string) => { screen = ""; proc!.terminal!.write(keys); };
  const command = async (text: string) => {
    write(`\x15${text}${text.startsWith("!") ? "" : " "}\r`);
    if (text.startsWith("/rewind ")) {
      await wait(() => frame().includes("仅实体 y 确认"), "rewind confirmation visible");
      write("y");
    }
  };
  try {
    daemon = await runDaemon({ paths, graceMs: 10, logger: () => {}, serverOptions: { allowedRoots: [home], idleTimeoutMs: 0, engineFactory: () => engine } });
    const accept = daemon.manager.accept.bind(daemon.manager);
    daemon.manager.accept = peer => {
      const connection = accept(peer), receive = connection.receive.bind(connection);
      connection.receive = text => { requests.push(JSON.parse(text)); receive(text); };
      return connection;
    };
    client = await AgentClient.connectUnix({ path: paths.socketPath, token: readFileSync(paths.tokenPath, "utf8").trim(), reconnect: false });
    const { thread } = await client.request("thread/start", { backend, cwd: home });
    const decoder = new TextDecoder();
    proc = Bun.spawn([resolve(import.meta.dir, "../bin/agent-tui"), "--attach", thread.id, "--socket", paths.socketPath], { env, terminal: { cols: 180, rows: 36, data(_terminal, data) { screen += decoder.decode(data, { stream: true }); } } });
    await wait(() => frame().includes(shortId(thread.id)) && frame().endsWith("> "), "first raw frame");
    expect(requests.find(r => r.method === "initialize" && r.params.client.name === "agent-tui").params.capabilities.bashInput).toBe(true);

    // Enter, n, Esc, pasted y and Ctrl-C must not issue a destructive RPC.
    for (const cancel of ["\r", "n", "\x1b", "\x03"]) {
      write("/rewind native-message \r"); await wait(() => frame().includes("仅实体 y 确认"), "confirm before cancellation");
      const count = requests.filter(r => r.method === "thread/engineControl").length;
      write("\x1b[200~y\x1b[201~"); await Bun.sleep(40);
      expect(requests.filter(r => r.method === "thread/engineControl")).toHaveLength(count);
      write(cancel); await wait(() => !frame().includes("仅实体 y 确认") && frame().includes(cancel === "\x03" ? "已请求中断" : "已取消回滚"), "default cancellation");
      expect(requests.filter(r => r.method === "thread/engineControl")).toHaveLength(count);
    }

    for (const c of cases) {
      await command(c.input);
      await wait(() => frame().includes(backend === "claude" ? c.visible : "当前后端不支持此操作"), `${c.input} result`);
      const rpc = requests.filter(r => r.method === "thread/engineControl").at(-1);
      expect(rpc.params).toEqual({ threadId: thread.id, subtype: c.subtype, params: c.params });
      expect(engine.sent).toHaveLength(0);
      if (backend === "claude" && c.subtype === "get_workspace_diff") expect(screen).toContain("\x1b[32m+after\x1b[0m");
      if (backend === "claude" && c.subtype === "get_context_usage") expect(frame()).toContain("50% / 100000");
      if (backend === "claude") {
        write("\x1b"); await wait(() => !frame().includes("Esc 关闭 · PgUp/PgDn 滚动\n"), "close result panel");
      }
    }
    if (backend === "claude") {
      reject = "unsupported";
      for (const c of cases) {
        await command(c.input); await wait(() => frame().includes("当前后端不支持此操作"), `${c.input} unsupported`);
        expect(engine.controls.at(-1)).toEqual({ subtype: c.subtype, params: c.params });
      }
      reject = "native";
      await command("/usage"); await wait(() => frame().includes("native policy denied"), "native error response");
      reject = "rewind";
      await command("/rewind native-message"); await wait(() => frame().includes("未回滚：stale target"), "rewound false is not success");
      reject = undefined;
    }
    for (const input of ["/add-dir /tmp", "/cd /tmp", "/engineControl initialize"]) {
      const count = requests.filter(r => r.method === "thread/engineControl").length;
      await command(input); await wait(() => frame().includes("白名单"), "outside allowlist");
      expect(requests.filter(r => r.method === "thread/engineControl")).toHaveLength(count); expect(engine.sent).toHaveLength(0);
    }
    await command("/help"); await wait(() => frame().includes("/diff: workspace diff") && frame().includes("standalone bash input"), "help contains engine commands");
    expect(engine.sent).toHaveLength(0);
    await command("/context 123456"); await wait(() => frame().includes("/ 123456"), "legacy context window override remains available");
    await command("!printf @untouched");
    if (backend === "codex") {
      await wait(() => frame().includes("当前后端不支持此操作"), "bash unsupported"); expect(engine.sent).toHaveLength(0);
    } else {
      await wait(() => engine.sent.length === 1, "bash delivered");
      expect(engine.sent[0].input).toEqual([{ type: "bash", command: "printf @untouched" }]);
      const turnId = engine.sent[0].turnId;
      const item = { id: "shell-result", type: "commandExecution" as const, payload: { command: "printf @untouched", cwd: home, aggregatedOutput: "shell stdout\nshell stderr", exitCode: 2 } };
      engine.emit({ type: "itemStarted", turnId, item }); engine.emit({ type: "itemCompleted", turnId, item }); engine.emit({ type: "turnCompleted", turnId, status: "completed" });
      await wait(() => frame().includes("shell stderr") && frame().includes("exit: 2"), "shell output is an item");
      await command("!sleep 600"); await wait(() => engine.sent.length === 2, "long shell started");
      const running = engine.sent[1].turnId;
      write("\x03"); await wait(() => engine.interrupted.includes(running) && frame().includes("claude idle"), "Ctrl-C interrupts shell through turn/interrupt");
      expect(proc.exitCode).toBeNull();
      await command("ordinary prompt"); await wait(() => engine.sent.length === 3, "usable after interrupt");
      expect(engine.sent[2].input).toEqual([{ type: "text", text: "ordinary prompt " }]);
    }
    proc.terminal!.write("\x03\x03"); expect(await proc.exited).toBe(0);
  } finally {
    if (proc) { if (proc.exitCode === null) proc.kill(); await proc.exited; proc.terminal?.close(); }
    client?.close(); await daemon?.shutdown(); rmSync(home, { recursive: true, force: true });
  }
}, 40000);

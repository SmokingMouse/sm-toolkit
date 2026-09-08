import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { MockEngine } from "@smokingmouse/agent-server";
import { AgentClient } from "@smokingmouse/agent-server/client";
import { resolveDaemonPaths, runDaemon, type RunningDaemon } from "@smokingmouse/agent-server/daemon";
import type { ServerRequestResult } from "@smokingmouse/agent-server/protocol";

test("tui-live: real daemon, WS phone, Unix PTY, fake Herdr, race, reconnect and shutdown", async () => {
  const home = mkdtempSync("/tmp/as-tui-live-"), state = join(home, "state");
  const env = { ...process.env, HOME: home, XDG_STATE_HOME: state, XDG_RUNTIME_DIR: "", AGENT_SERVER_SOCKET_PATH: "" };
  const paths = resolveDaemonPaths(env), engine = new MockEngine(), herdrPath = join(home, "herdr.sock");
  const reports: Array<{ id: string; method: string; params: Record<string, any> }> = [], sockets = new Set<Socket>();
  const herdr = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
    let buffer = ""; socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk; let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        const message = JSON.parse(line); reports.push(message);
        socket.write(JSON.stringify({ id: message.id, result: {} }) + "\n");
      }
    });
  });
  let daemon: RunningDaemon | undefined, phone: AgentClient | undefined, proc: ReturnType<typeof Bun.spawn> | undefined;
  let screen = "";
  const wait = async (predicate: () => boolean, reason: string) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error(`${reason}\n${screen.slice(-1500)}`);
      await Bun.sleep(10);
    }
  };
  try {
    await new Promise<void>((resolve, reject) => { herdr.once("error", reject); herdr.listen(herdrPath, resolve); });
    daemon = await runDaemon({ paths, wsPort: 0, graceMs: 50, logger: () => {}, serverOptions: { allowedRoots: [home], engineFactory: () => engine, idleTimeoutMs: 0 } });
    const token = readFileSync(paths.tokenPath, "utf8").trim();
    for (const path of [paths.socketPath, paths.tokenPath, paths.databasePath, `${paths.databasePath}-wal`, `${paths.databasePath}-shm`, paths.logPath, paths.endpointPath, paths.pidPath]) expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(paths.logPath, "utf8")).not.toContain(token);
    phone = await AgentClient.connectWebSocket({ url: daemon.webSocketUrl!, token, client: { name: "phone", kind: "test", label: "phone", version: "1" }, capabilities: { serverRequests: ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/tool/requestUserInput"] }, reconnect: false });
    const { thread } = await phone.request("thread/start", { model: "sonnet", backend: "claude", cwd: home });
    const decoder = new TextDecoder();
    proc = Bun.spawn([resolve(import.meta.dir, "../bin/agent-tui"), "--attach", thread.id, "--socket", paths.socketPath], {
      env: { ...env, HERDR_PANE_ID: "pane-test", HERDR_SOCKET_PATH: herdrPath, TERM: "xterm-256color" },
      terminal: { cols: 140, rows: 34, data(_terminal, data) { screen += decoder.decode(data, { stream: true }); } },
    });
    // Herdr emits an OSC title with this id before runTerminal installs raw input.
    // Sending Enter then lets the PTY turn CR into LF (our intentional Ctrl-J newline).
    // Wait for the actual first draw and its input row, not the early title.
    await wait(() => {
      const start = screen.lastIndexOf("\x1b[H");
      const frame = start < 0 ? "" : screen.slice(start);
      return frame.includes(thread.id.slice(0, 11)) && frame.endsWith("> \x1b[K");
    }, "TUI first frame and raw input ready");
    proc.terminal!.write("hello from pty\r"); await wait(() => engine.sent.length === 1, "prompt reached engine");
    expect(engine.sent[0].input).toEqual([{ type: "text", text: "hello from pty" }]);
    const turnId = engine.sent[0].turnId;
    engine.emit({ type: "itemStarted", turnId, item: { id: "answer", type: "agentMessage", payload: { text: "" } } });
    engine.emit({ type: "itemDelta", turnId, itemId: "answer", kind: "text", text: "streamed 中文 text" });
    await wait(() => screen.includes("streamed 中文 text"), "Unicode streaming rendered");
    const base = { threadId: thread.id, turnId, itemId: "answer", startedAtMs: Date.now() };
    let decision: ServerRequestResult | undefined, answers: ServerRequestResult | undefined, raced: ServerRequestResult | undefined;
    engine.emit({ type: "approval", request: { method: "item/commandExecution/requestApproval", params: { ...base, requestId: "command", command: "echo hi", cwd: home } }, respond: result => { decision = result; } });
    await wait(() => screen.includes("Command: echo hi"), "approval visible"); proc.terminal!.write("y");
    await wait(() => !!decision, "TUI answered approval"); expect(decision).toEqual({ decision: "accept" });
    engine.emit({ type: "approval", request: { method: "item/tool/requestUserInput", params: { ...base, requestId: "question", isBlocking: true, questions: [{ id: "q", question: "PTY 选择?", options: [{ label: "OK" }] }] } }, respond: result => { answers = result; } });
    await wait(() => screen.includes("PTY 选择?"), "question visible"); proc.terminal!.write("1\r");
    await wait(() => !!answers, "TUI answered question"); expect(answers).toEqual({ answers: { q: { answers: ["OK"] } } });
    engine.emit({ type: "approval", request: { method: "item/fileChange/requestApproval", params: { ...base, requestId: "race", changes: [{ path: "x.ts", kind: "update" }] } }, respond: result => { raced = result; } });
    await wait(() => screen.includes("update x.ts") && phone!.pendingRequests.has("race"), "both clients see file card");
    phone.pendingRequests.get("race")!.respond({ decision: "reject" });
    await wait(() => screen.includes("已由 phone 处理"), "TUI withdraws losing card"); expect(raced).toEqual({ decision: "reject" });

    // Drop both wire connections, then complete before the TUI's reconnect timer fires.
    phone.close(); daemon.manager.close();
    engine.emit({ type: "itemCompleted", turnId, item: { id: "answer", type: "agentMessage", payload: { text: "FINAL AFTER RECONNECT" } } });
    await wait(() => screen.includes("FINAL AFTER RECONNECT"), "offline completion recovered");
    expect(engine.spawnCount).toBe(1);
    await wait(() => reports.length >= 2, "Herdr received reports");
    expect(reports.slice(0, 2).map(r => r.method)).toEqual(["pane.report_agent", "pane.report_agent_session"]);
    expect(reports[0].params).toMatchObject({ pane_id: "pane-test", source: "agent-tui", agent: "claude", agent_session_id: thread.id, state: "idle" });
    const seqs = reports.map(r => r.params.seq);
    expect(seqs.every(n => typeof n === "number")).toBe(true); expect(seqs).toEqual(seqs.toSorted((a, b) => a - b));
    expect(reports.some(r => r.params.state === "working")).toBe(true);
    expect(reports.some(r => r.params.state === "blocked")).toBe(true);
    const shutdown = daemon.shutdown("test_shutdown");
    await wait(() => screen.includes("daemon stopping"), "shutdown notification rendered"); await shutdown;
    proc.terminal!.write("\x03\x03");
    expect(await Promise.race([proc.exited, Bun.sleep(3000).then(() => -100)])).toBe(0);
    await wait(() => screen.includes("\x1b[?1049l"), "alternate screen restored");
    expect(screen).toContain("\x1b[?25h"); expect(readFileSync(paths.logPath, "utf8")).not.toContain(token);
  } finally {
    if (proc) { if (proc.exitCode === null) proc.kill(); await proc.exited; proc.terminal?.close(); }
    phone?.close(); await daemon?.shutdown();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => herdr.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);

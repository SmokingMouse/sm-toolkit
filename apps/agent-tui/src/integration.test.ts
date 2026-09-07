import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AgentServer, MockEngine, type EngineEvent } from "@smokingmouse/agent-server";
import { AgentClient, type ClientEndpoint } from "@smokingmouse/agent-server/client";
import { ConnectionManager, listenUnix, listenWebSocket, type WirePeer } from "@smokingmouse/agent-server/transport";
import type { PendingServerRequest, ServerRequestResult } from "@smokingmouse/agent-server/protocol";
import { bindClient, TuiModel } from "./model.js";
import { Controller } from "./controller.js";
import { InputLease } from "./lease.js";
import { render, renderItem } from "./render.js";

export async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("condition timed out"); await Bun.sleep(5); }
}
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function setup(transport: "unix" | "ws" = "unix") {
  const home = mkdtempSync("/tmp/agent-tui-test-");
  const engine = new MockEngine();
  const server = new AgentServer({ databasePath: join(home, "db"), token: "test", allowedRoots: [home], engineFactory: () => engine, idleTimeoutMs: 0 });
  const manager = new ConnectionManager(server);
  const peers: WirePeer[] = [], accept = manager.accept.bind(manager);
  manager.accept = peer => { peers.push(peer); return accept(peer); };
  const listener = transport === "unix" ? listenUnix(manager, { path: join(home, "sock") }) : listenWebSocket(manager);
  const endpoint: ClientEndpoint = "path" in listener ? { transport: "unix", path: listener.path } : { transport: "ws", url: listener.url };
  const clients: AgentClient[] = [];
  cleanup.push(async () => { clients.forEach(c => c.close()); listener.close(); await server.close(); rmSync(home, { recursive: true, force: true }); });
  async function connect(label: string) {
    const client = new AgentClient(endpoint, { token: "test", client: { name: label, label, kind: "test", version: "1" }, reconnect: { minDelayMs: 150, maxDelayMs: 150 }, capabilities: { engineEvents: true, serverRequests: ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput"] } });
    clients.push(client); const model = new TuiModel(); bindClient(client, model);
    let exited = false;
    const controller = new Controller(client, model, () => { exited = true; });
    await client.connect();
    return { client, model, controller, get exited() { return exited; } };
  }
  const a = await connect("terminal"), b = await connect("phone");
  const { thread } = await a.client.request("thread/start", { backend: "claude", cwd: home });
  await a.client.request("thread/attach", { threadId: thread.id });
  await b.client.request("thread/attach", { threadId: thread.id });
  return { home, server, engine, manager, a, b, thread, peers };
}

test("P2-f: real approval resolves before a delayed thread scan completes", async () => {
  const { a, engine, thread, home } = await setup();
  const { turn } = await a.client.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "approve" }] });
  await until(() => engine.sent.length === 1);
  engine.emit({ type: "itemStarted", turnId: turn.id, item: { id: "tool", type: "toolCall", payload: { name: "test", input: {} } } });
  await until(() => a.model.items.has("tool"));
  let decision: ServerRequestResult | undefined, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), request = a.client.request.bind(a.client);
  a.client.request = async (method, params) => { if (method === "thread/list") await gate; return request(method, params); };
  const scan = a.controller.sessions.run("/threads");
  try {
    engine.emit({ type: "approval", request: { method: "item/commandExecution/requestApproval", params: { threadId: thread.id, turnId: turn.id, itemId: "tool", requestId: "scan-approval", startedAtMs: Date.now(), command: "pwd", cwd: home } }, respond: result => { decision = result; } });
    await until(() => !!a.model.activeCard);
    for (const text of ["y", "s", "n", "a"]) await a.controller.key(text, { paste: true });
    expect(decision).toBeUndefined(); expect(a.model.input).toBe("ysna");
    await a.controller.key("y"); await until(() => !!decision);
    expect(decision).toEqual({ decision: "accept" }); expect(a.controller.sessions.scanning).toBe(true);
    expect(a.model.discardNote).toBe("");
  } finally { release(); await scan; }
});

for (const transport of ["unix", "ws"] as const) describe(`${transport}: real AS transport with MockEngine`, () => {
  test("N1: invalid notifications leave the TUI connected and streaming on the same turn", async () => {
    const { a, engine, thread, peers } = await setup(transport);
    const { turn } = await a.client.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "go" }] });
    engine.emit({ type: "itemStarted", turnId: turn.id, item: { id: "answer", type: "agentMessage", payload: { text: "" } } });
    await until(() => a.model.items.has("answer"));
    const errors: Error[] = [], states: string[] = [], clientId = a.client.clientId;
    a.client.onError(error => errors.push(error)); a.client.onStateChange(state => states.push(state));
    peers[0].send(JSON.stringify({ jsonrpc: "2.0", method: "error", params: { threadId: thread.id, turnId: "", error: { code: -32015, message: "malformed" }, willRetry: false } }));
    await until(() => errors.length > 0);
    expect(errors).toHaveLength(1); expect(a.model.message).toContain("turnId");
    expect(a.model.connection).toBe("connected"); expect(a.model.activeTurnId).toBe(turn.id);
    engine.emit({ type: "itemDelta", turnId: turn.id, itemId: "answer", kind: "text", text: "survived" });
    await until(() => render(a.model).includes("survived"));
    expect(a.client.clientId).toBe(clientId); expect(states).toEqual([]);
    await a.client.request("server/health", {});
  });
  test("attach, streaming text, queue, steer, usage, interrupt and exit", async () => {
    const { a, b, engine, thread } = await setup(transport);
    expect(a.model.thread?.id).toBe(thread.id);
    a.model.input = "first"; await a.controller.key("\r", { name: "return" });
    await until(() => engine.sent.length === 1 && !!a.model.activeTurnId);
    const turnId = engine.sent[0].turnId;
    engine.emit({ type: "itemStarted", turnId, item: { id: "answer", type: "agentMessage", payload: { text: "" } } });
    engine.emit({ type: "itemDelta", turnId, itemId: "answer", kind: "text", text: "Hello " });
    engine.emit({ type: "itemDelta", turnId, itemId: "answer", kind: "text", text: "世界" });
    await until(() => render(a.model).includes("Hello 世界") && render(b.model).includes("Hello 世界"));
    a.model.input = "/steer detail"; await a.controller.key("\r", { name: "return" });
    expect(engine.steered[0]).toMatchObject({ turnId, input: [{ text: "detail" }] });
    a.model.input = "second"; await a.controller.key("\r", { name: "return" });
    await until(() => a.model.queue.length === 1);
    expect(render(a.model)).toContain("排队 #1: second"); expect(a.model.message).toBe("已排队 #1");
    engine.emit({ type: "itemCompleted", turnId, item: { id: "answer", type: "agentMessage", payload: { text: "Hello 世界!" } } });
    const usage = { usd: null, inputTokens: 12, outputTokens: 3, cachedTokens: 2, cacheCreation: 0, estimated: false, contextTokens: null };
    engine.emit({ type: "turnCompleted", turnId, status: "completed", usage });
    await until(() => engine.sent.length === 2 && a.model.usage?.outputTokens === 3);
    expect(renderItem(a.model.items.get("answer")!).join("\n")).toBe("Agent: Hello 世界!");
    expect(render(a.model, 160)).toContain("tokens 12 in / 3 out / 2 cached");
    await a.controller.key("\x03", { name: "c", ctrl: true });
    expect(engine.interrupted).toContain(engine.sent[1].turnId);
    await a.controller.key("\x03", { name: "c", ctrl: true }); expect(a.exited).toBe(true);
    expect(engine.closed).toBe(false);
  });

  test("approval decisions, permissions, multi-question input, another client resolves card", async () => {
    const { a, b, engine, thread, home } = await setup(transport);
    a.model.input = "work"; await a.controller.submit(); await until(() => engine.sent.length === 1);
    const turnId = engine.sent[0].turnId;
    engine.emit({ type: "itemStarted", turnId, item: { id: "tool", type: "toolCall", payload: { name: "test", input: {} } } });
    await until(() => a.model.items.has("tool"));
    let sequence = 0;
    async function request(kind: "command" | "file" | "permissions" | "questions") {
      const params = { requestId: `r${++sequence}`, threadId: thread.id, turnId, itemId: "tool", startedAtMs: Date.now() };
      const r: PendingServerRequest = kind === "command" ? { method: "item/commandExecution/requestApproval", params: { ...params, command: "pwd", cwd: home } }
        : kind === "file" ? { method: "item/fileChange/requestApproval", params: { ...params, changes: [{ path: "a.ts", kind: "update" }] } }
        : kind === "permissions" ? { method: "item/permissions/requestApproval", params: { ...params, cwd: home, permissions: { network: { enabled: true } } } }
        : { method: "item/tool/requestUserInput", params: { ...params, isBlocking: true, questions: [
          { id: "one", question: "Pick one", options: [{ label: "A" }, { label: "B" }] },
          { id: "many", question: "Pick many", multiSelect: true, options: [{ label: "X" }, { label: "Y" }, { label: "Z" }] },
          { id: "free", question: "Details" },
        ] } };
      let answer: ServerRequestResult | undefined;
      engine.emit({ type: "approval", request: r, respond(result) { answer = result; } });
      await until(() => a.model.cards.get(params.requestId)?.state === "pending" && b.model.cards.get(params.requestId)?.state === "pending");
      expect(a.model.agentState).toBe("blocked");
      return { id: params.requestId, get answer() { return answer; } };
    }
    for (const [key, decision] of [["y", "accept"], ["s", "acceptForSession"], ["n", "reject"], ["a", "abort"]] as const) {
      const r = await request("command"); await a.controller.key(key); await until(() => !!r.answer);
      expect(r.answer).toEqual({ decision }); expect(a.model.cards.get(r.id)?.state).toBe("resolved");
    }
    const file = await request("file"); await a.controller.key("s"); await until(() => !!file.answer); expect(file.answer).toEqual({ decision: "acceptForSession" });
    for (const key of ["y", "s", "n"] as const) {
      const r = await request("permissions"); await a.controller.key(key); await until(() => !!r.answer);
      expect(r.answer).toEqual({ permissions: key === "n" ? {} : { network: { enabled: true } }, scope: key === "s" ? "session" : "turn" });
    }
    const questions = await request("questions");
    await a.controller.key("2"); await a.controller.key("\r", { name: "return" });
    await a.controller.key("1"); await a.controller.key("2"); await a.controller.key("1"); await a.controller.key("3");
    await a.controller.key("\r", { name: "return" }); await a.controller.key("details"); await a.controller.key("\r", { name: "return" });
    await until(() => !!questions.answer);
    expect(questions.answer).toEqual({ answers: { one: { answers: ["B"] }, many: { answers: ["Y", "Z"] }, free: { answers: ["details"] } } });
    const rival = await request("file"); await b.controller.key("y");
    await until(() => a.model.cards.get(rival.id)?.state === "resolved");
    expect(a.model.cards.get(rival.id)?.note).toBe("已由 phone 处理");
    expect(a.model.activeCard).toBeUndefined(); expect(render(a.model, 100, 80)).toContain("已由 phone 处理");
    const abort = await request("permissions"); await a.controller.key("a"); await until(() => !!abort.answer && engine.interrupted.length > 0);
    expect(abort.answer).toEqual({ permissions: {}, scope: "turn" }); expect(engine.interrupted).toContain(turnId);
  });

  test("R4: disconnect uses completion cursors, restores pending requests and removes offline-resolved cards", async () => {
    const { a, b, engine, manager, thread, home } = await setup(transport);
    a.model.input = "stream"; await a.controller.submit(); await until(() => engine.sent.length === 1);
    const turnId = engine.sent[0].turnId;
    engine.emit({ type: "itemStarted", turnId, item: { id: "answer", type: "agentMessage", payload: { text: "" } } });
    engine.emit({ type: "itemDelta", turnId, itemId: "answer", kind: "text", text: "before" });
    const pending: PendingServerRequest = { method: "item/commandExecution/requestApproval", params: { requestId: "offline-approval", threadId: thread.id, turnId, itemId: "answer", command: "pwd", cwd: home, startedAtMs: Date.now() } };
    engine.emit({ type: "approval", request: pending, respond() {} });
    await until(() => !!a.model.activeCard && renderItem(a.model.items.get("answer")!).join().includes("before"));
    expect(a.client.sinceSeq(thread.id)).toBe(a.model.items.get("answer")!.seq);
    const oldClient = a.client.clientId!; manager.disconnect(oldClient);
    await until(() => a.model.connection !== "connected");
    expect(a.model.activeCard).toBeUndefined(); expect(a.model.cards.get("offline-approval")?.state).toBe("offline");
    await b.controller.key("y");
    engine.emit({ type: "itemDelta", turnId, itemId: "answer", kind: "text", text: " during" });
    engine.emit({ type: "itemCompleted", turnId, item: { id: "answer", type: "agentMessage", payload: { text: "before during done" } } });
    engine.emit({ type: "itemStarted", turnId, item: { id: "live", type: "agentMessage", payload: { text: "" } } });
    engine.emit({ type: "itemDelta", turnId, itemId: "live", kind: "text", text: "partial offline" });
    const question: PendingServerRequest = { method: "item/tool/requestUserInput", params: { requestId: "offline-question", threadId: thread.id, turnId, itemId: "live", isBlocking: true, questions: [{ id: "q", question: "Continue?", options: [{ label: "yes" }] }] } };
    let answered = false; engine.emit({ type: "approval", request: question, respond() { answered = true; } });
    await until(() => a.client.clientId !== oldClient && a.model.connection === "connected" && a.model.activeCard?.request.params.requestId === "offline-question");
    expect(renderItem(a.model.items.get("answer")!).join()).toContain("before during done");
    expect(renderItem(a.model.items.get("live")!).join()).toContain("partial offline");
    expect([...a.model.items.keys()].filter(id => id === "answer")).toHaveLength(1);
    expect(a.model.items.get("answer")!.completedSeq!).toBeGreaterThan(a.model.items.get("answer")!.seq);
    expect(a.model.cards.get("offline-approval")?.note).toContain("处理者未知");
    await a.controller.key("1"); await a.controller.key("\r", { name: "return" }); await until(() => answered);
    expect(engine.spawnCount).toBe(1);
    engine.emit({ type: "itemDelta", turnId, itemId: "live", kind: "text", text: " + live" });
    await until(() => renderItem(a.model.items.get("live")!).join().includes("partial offline + live"));
  });
});

test("all delta item kinds and expired cards update without leaking unrelated thread events", async () => {
  const { a, engine, thread } = await setup(); a.model.input = "work"; await a.controller.submit();
  await until(() => engine.sent.length > 0); const turnId = engine.sent[0].turnId;
  const events: EngineEvent[] = [
    { type: "itemStarted", turnId, item: { id: "r", type: "reasoning", payload: {} } },
    { type: "itemDelta", turnId, itemId: "r", kind: "reasoning", text: "think" },
    { type: "itemDelta", turnId, itemId: "r", kind: "summary", text: "summary" },
    { type: "itemStarted", turnId, item: { id: "cmd", type: "commandExecution", payload: { command: "pwd", cwd: thread.cwd } } },
    { type: "itemDelta", turnId, itemId: "cmd", kind: "stdout", text: "out" },
    { type: "itemDelta", turnId, itemId: "cmd", kind: "stderr", text: "err" },
  ];
  events.forEach(e => engine.emit(e));
  await until(() => a.model.items.get("cmd")?.type === "commandExecution" && renderItem(a.model.items.get("cmd")!).join().includes("outerr"));
  expect(renderItem(a.model.items.get("r")!, true).join()).toContain("summary,think");
  a.model.notification({ jsonrpc: "2.0", method: "thread/status/changed", params: { threadId: "other", status: { type: "closed" } } });
  expect(a.model.thread?.status.type).toBe("running");
  const r: PendingServerRequest = { method: "item/tool/requestUserInput", params: { requestId: "expire", threadId: thread.id, turnId, itemId: "r", isBlocking: true, questions: [] } };
  a.model.request(r);
  a.model.notification({ jsonrpc: "2.0", method: "serverRequest/expired", params: { threadId: thread.id, requestId: "expire", reason: "timeout" } });
  expect(a.model.activeCard).toBeUndefined(); expect(a.model.cards.get("expire")?.note).toBe("已过期：timeout");
});

test("real bin in Bun PTY attaches, draws deltas, answers both cards, and restores terminal on exit", async () => {
  const { home, a, engine, thread } = await setup();
  const state = join(home, "state"), tokenDir = join(state, "sm-toolkit", "agent-server");
  mkdirSync(tokenDir, { recursive: true }); writeFileSync(join(tokenDir, "token"), "test\n");
  let screen = ""; const decoder = new TextDecoder();
  const proc = Bun.spawn([resolve(import.meta.dir, "../bin/agent-tui"), "--attach", thread.id, "--socket", join(home, "sock")], {
    env: { ...process.env, HOME: home, XDG_STATE_HOME: state, HERDR_PANE_ID: "", TERM: "xterm-256color" },
    terminal: { cols: 140, rows: 30, data(_terminal, data) { screen += decoder.decode(data, { stream: true }); } },
  });
  try {
    await until(() => screen.includes(thread.id.slice(0, 11)) && screen.includes("Enter"));
    proc.terminal!.write("pty prompt\r"); await until(() => engine.sent.length === 1);
    const turnId = engine.sent[0].turnId;
    expect(engine.sent[0].input).toEqual([{ type: "text", text: "pty prompt" }]);
    engine.emit({ type: "itemStarted", turnId, item: { id: "pty", type: "agentMessage", payload: { text: "" } } });
    engine.emit({ type: "itemDelta", turnId, itemId: "pty", kind: "text", text: "PTY streamed" });
    await until(() => screen.includes("PTY streamed"));
    const base = { requestId: "pty-approval", threadId: thread.id, turnId, itemId: "pty", startedAtMs: Date.now() };
    let decision: ServerRequestResult | undefined;
    engine.emit({ type: "approval", request: { method: "item/commandExecution/requestApproval", params: { ...base, command: "pwd", cwd: home } }, respond(result) { decision = result; } });
    await until(() => screen.includes("Command: pwd")); proc.terminal!.write("y"); await until(() => !!decision);
    expect(decision).toEqual({ decision: "accept" });
    let answers: ServerRequestResult | undefined;
    engine.emit({ type: "approval", request: { method: "item/tool/requestUserInput", params: { ...base, requestId: "pty-question", isBlocking: true, questions: [{ id: "q", question: "PTY choice?", options: [{ label: "OK" }] }] } }, respond(result) { answers = result; } });
    await until(() => screen.includes("PTY choice?")); proc.terminal!.write("1\r"); await until(() => !!answers);
    expect(answers).toEqual({ answers: { q: { answers: ["OK"] } } });
    proc.terminal!.resize(80, 24);
    proc.terminal!.write("\x03"); await until(() => engine.interrupted.length === 1); proc.terminal!.write("\x03");
    const code = await Promise.race([proc.exited, Bun.sleep(3000).then(() => -100)]); expect(code).toBe(0);
    await until(() => screen.includes("\x1b[?1049l"));
    expect(screen).toContain("\x1b[?25h"); expect(engine.closed).toBe(false);
    expect(a.model.cards.get("pty-approval")?.note).toBe("已由 agent-tui 处理");
  } finally { if (proc.exitCode === null) proc.kill(); await proc.exited; proc.terminal?.close(); }
}, 10000);

test("a lost turn response preserves input and reuses the idempotency key on manual retry", async () => {
  const { a, engine } = await setup();
  const request = a.client.request.bind(a.client); let loseResponse = true;
  a.client.request = async (method, params) => {
    const result = await request(method, params);
    if (method === "turn/start" && loseResponse) { loseResponse = false; throw new Error("response lost; delivery unknown"); }
    return result;
  };
  a.model.input = "exactly once"; await a.controller.key("\r", { name: "return" });
  expect(a.model.input).toBe("exactly once"); expect(a.model.message).toContain("delivery unknown");
  await a.controller.key("\r", { name: "return" });
  expect(a.model.input).toBe(""); expect(engine.sent).toHaveLength(1); expect(a.model.queue).toHaveLength(0);
});

// Each PTY step gets its own diagnostic deadline. The outer budget includes startup,
// several RPC/render round trips, the deliberately slow clipboard fixture, and cleanup.
const inputPtyTimeout = 60_000;
type PtyWait = (predicate: () => boolean, reason: string) => Promise<void>;
async function inputPty(run: (h: Awaited<ReturnType<typeof setup>> & { write: (text: string) => void; screen: () => string; clearScreen: () => void; wait: PtyWait }) => Promise<void>, clipboardDelayMs = 0) {
  const h = await setup();
  const state = join(h.home, "state"), tokenDir = join(state, "sm-toolkit", "agent-server");
  mkdirSync(tokenDir, { recursive: true }); writeFileSync(join(tokenDir, "token"), "test\n");
  mkdirSync(join(h.home, ".claude/skills/global-skill"), { recursive: true });
  writeFileSync(join(h.home, ".claude/skills/global-skill/SKILL.md"), "---\ndescription: global skill description\n---\n");
  writeFileSync(join(h.home, "alpha-file.ts"), ""); writeFileSync(join(h.home, "beta-file.ts"), "");
  writeFileSync(join(h.home, "test.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9S0AAAAASUVORK5CYII=", "base64"));
  const binDir = join(h.home, "bin"); mkdirSync(binDir);
  // All four input workflows run with neither rg nor git in PATH, even on dev machines.
  symlinkSync(process.execPath, join(binDir, "bun"));
  expect(Bun.which("rg", { PATH: binDir })).toBeNull();
  expect(Bun.which("git", { PATH: binDir })).toBeNull();
  // Absolute utilities keep shell aliases/wrappers in the parent's PATH out of the fixture.
  // Delay injection is a regression probe, never a synchronization mechanism.
  writeFileSync(join(binDir, "pngpaste"), `#!/bin/sh\n/bin/sleep ${clipboardDelayMs / 1000}\nexec /bin/cp '${join(h.home, "test.png")}' "$1"\n`, { mode: 0o755 });
  let screen = ""; const decoder = new TextDecoder();
  const proc = Bun.spawn([resolve(import.meta.dir, "../bin/agent-tui"), "--attach", h.thread.id, "--socket", join(h.home, "sock")], {
    env: { ...process.env, HOME: h.home, XDG_STATE_HOME: state, HERDR_PANE_ID: "", TERM: "xterm-256color", PATH: binDir },
    terminal: { cols: 140, rows: 32, data(_terminal, data) { screen += decoder.decode(data, { stream: true }); } },
  });
  const wait = async (predicate: () => boolean, reason: string, allowExit = false) => {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
      if ((!allowExit && proc.exitCode !== null) || Date.now() >= deadline) {
        throw new Error(`PTY step: ${reason}; exit=${proc.exitCode}; deadline=10000ms\n${screen.slice(-6000)}`);
      }
      await Bun.sleep(10);
    }
  };
  try {
    await wait(() => screen.includes(h.thread.id.slice(0, 11)) && screen.includes("Enter"), "TUI attached and input ready");
    // Inspect only the latest draw, so an old candidate cannot satisfy a later wait.
    await run({ ...h, write: text => proc.terminal!.write(text), screen: () => screen.slice(Math.max(0, screen.lastIndexOf("\x1b[H"))), clearScreen: () => { screen = ""; }, wait });
    proc.terminal!.write("\x03\x03");
    expect(await Promise.race([proc.exited, Bun.sleep(3000).then(() => -100)])).toBe(0);
    // The process exit event can precede the last PTY data callback.
    await wait(() => screen.includes("\x1b[?2004l"), "terminal restored after exit", true);
  } finally { if (proc.exitCode === null) proc.kill(); await proc.exited; proc.terminal?.close(); }
}

test("PTY input: image references, /image, clipboard attachment and bubble placeholder", async () => {
  await inputPty(async ({ home, thread, engine, write, screen, clearScreen, wait }) => {
    write("look @test.png \r"); await wait(() => engine.sent.length === 1, "image reference reaches engine");
    expect(engine.sent[0].input).toEqual([{ type: "text", text: "look  " }, { type: "image", path: join(thread.cwd, "test.png"), mime: "image/png" }]);
    await wait(() => screen().includes(`[image] ${join(thread.cwd, "test.png")}`), "image bubble rendered");
    engine.emit({ type: "turnCompleted", turnId: engine.sent[0].turnId, status: "completed" });
    write(`/image ${join(home, "test.png")}\r`); await wait(() => engine.sent.length === 2, "/image reaches engine");
    expect(engine.sent[1].input).toEqual([{ type: "image", path: join(home, "test.png"), mime: "image/png" }]);
    engine.emit({ type: "turnCompleted", turnId: engine.sent[1].turnId, status: "completed" });
    clearScreen(); write("/paste-image \r");
    if (process.platform === "darwin") {
      await wait(() => screen().includes("已附加剪贴板图片"), "slow pngpaste completes and attachment is visible");
      expect(engine.sent).toHaveLength(2); write("clipboard caption\r");
      await wait(() => engine.sent.length === 3, "clipboard caption reaches engine");
      expect(engine.sent[2].input[0]).toEqual({ type: "text", text: "clipboard caption" });
      const image = engine.sent[2].input[1]; expect(image).toMatchObject({ type: "image", mime: "image/png" });
      if (image.type === "image") { expect(await Bun.file(image.path).size).toBeGreaterThan(0); rmSync(resolve(image.path, ".."), { recursive: true, force: true }); }
    } else await wait(() => screen().includes("仅支持 macOS"), "unsupported clipboard platform reported");
  }, 5200); // Exceeds Bun's old 5s default: prove the explicit PTY budget is exercised.
}, inputPtyTimeout);

test("PTY input: @ fuzzy candidates navigate with arrows, Tab and Enter before sending relative paths", async () => {
  await inputPty(async ({ engine, write, screen, clearScreen, wait }) => {
    write("@filets"); await wait(() => screen().includes("❯ @beta-file.ts") && screen().includes("@alpha-file.ts"), "fuzzy candidates rendered");
    clearScreen(); write("\x1b[B"); await wait(() => screen().includes("❯ @alpha-file.ts"), "down selects alpha");
    clearScreen(); write("\x1b[A"); await wait(() => screen().includes("❯ @beta-file.ts"), "up selects beta");
    clearScreen(); write("\t"); await wait(() => screen().includes("> @beta-file.ts "), "Tab inserts beta");
    expect(engine.sent).toHaveLength(0);
    clearScreen(); write("@alfts"); await wait(() => screen().includes("❯ @alpha-file.ts") && screen().includes("> @beta-file.ts @alfts"), "second query and candidate rendered");
    clearScreen(); write("\r"); await wait(() => screen().includes("> @beta-file.ts @alpha-file.ts "), "Enter inserts alpha");
    expect(engine.sent).toHaveLength(0); write("\r"); await wait(() => engine.sent.length === 1, "relative references reach engine");
    expect(engine.sent[0].input).toEqual([{ type: "text", text: "@beta-file.ts @alpha-file.ts " }]);
  });
}, inputPtyTimeout);

test("PTY input: slash builtin and skill descriptions complete without sending on selection", async () => {
  await inputPty(async ({ engine, write, screen, clearScreen, wait }) => {
    write("/"); await wait(() => screen().includes("/clear —") && screen().includes("/compact —") && screen().includes("/context —"), "commands and skill descriptions rendered");
    clearScreen(); write("gsk"); await wait(() => screen().includes("❯ /global-skill") && screen().includes("> /gsk"), "skill query rendered");
    clearScreen(); write("\r"); await wait(() => screen().includes("> /global-skill "), "Enter inserts skill");
    expect(engine.sent).toHaveLength(0); write("explain\r"); await wait(() => engine.sent.length === 1, "skill prompt reaches engine");
    expect(engine.sent[0].input).toEqual([{ type: "text", text: "/global-skill explain" }]);
  });
}, inputPtyTimeout);

test("PTY input: Ctrl-J, Shift-Enter and bracketed multiline paste stay in one exact message", async () => {
  await inputPty(async ({ engine, write, screen, wait }) => {
    write("first\nsecond\x1b[13;2uthird\x1b[27;2;13~");
    write("\x1b[200~  中文🙂\r\tlast\r\n\x1b[201~");
    await wait(() => screen().includes("中文🙂") && screen().includes("last"), "multiline paste rendered without send");
    expect(engine.sent).toHaveLength(0); write("\r"); await wait(() => engine.sent.length === 1, "one multiline message reaches engine");
    expect(engine.sent[0].input).toEqual([{ type: "text", text: "first\nsecond\nthird\n  中文🙂\n\tlast\n" }]);
    expect(screen()).not.toContain("中文🙂last");
  });
}, inputPtyTimeout);

test("image validation and lost responses preserve drafts and retry the same attachment exactly once", async () => {
  const { a, engine, thread } = await setup();
  a.model.input = "@missing.png"; await a.controller.key("\r", { name: "return" });
  expect(a.model.input).toBe("@missing.png"); expect(engine.sent).toHaveLength(0);
  writeFileSync(join(thread.cwd, "valid.png"), "fixture");
  a.model.attachments = [{ type: "image", path: join(thread.cwd, "valid.png"), mime: "image/png" }];
  a.model.input = "  caption\n";
  const request = a.client.request.bind(a.client); let loseResponse = true;
  a.client.request = async (method, params) => {
    const result = await request(method, params);
    if (method === "turn/start" && loseResponse) { loseResponse = false; throw new Error("response lost"); }
    return result;
  };
  await a.controller.key("\r", { name: "return" });
  expect(a.model.input).toBe("  caption\n"); expect(a.model.attachments).toHaveLength(1);
  await a.controller.key("\r", { name: "return" });
  expect(engine.sent).toHaveLength(1); expect(engine.sent[0].input).toHaveLength(2);
  expect(a.model.input).toBe(""); expect(a.model.attachments).toEqual([]);
});

test("review2 input P2-1 PTY pasted y/s/n/a stay in input; physical approval keys still decide", async () => {
  await inputPty(async ({ engine, thread, write, screen, wait }) => {
    write("work\r"); await wait(() => engine.sent.length === 1, "approval turn started");
    const turnId = engine.sent[0].turnId;
    engine.emit({ type: "itemStarted", turnId, item: { id: "paste-approval-tool", type: "toolCall", payload: { name: "shell", input: {} } } });
    let answer: ServerRequestResult | undefined;
    engine.emit({ type: "approval", request: { method: "item/commandExecution/requestApproval", params: {
      requestId: "paste-approval", threadId: thread.id, turnId, itemId: "paste-approval-tool", startedAtMs: Date.now(), command: "pwd paste-approval", cwd: thread.cwd,
    } }, respond(result) { answer = result; } });
    await wait(() => screen().includes("pwd paste-approval"), "approval card rendered");
    let draft = "";
    for (const text of ["y", "s", "n", "a"]) {
      write(`\x1b[200~${text}\x1b[201~`); draft += text;
      await wait(() => screen().includes(`> ${draft}`), "paste appears in input");
      expect(answer).toBeUndefined(); expect(engine.interrupted).toHaveLength(0);
    }
    write("n"); await wait(() => answer !== undefined, "physical n rejects");
    expect(answer).toEqual({ decision: "reject" });
    expect(screen()).toContain("> ysna"); expect(engine.sent).toHaveLength(1);
  });
}, inputPtyTimeout);

test("P2-2 PTY question card accepts normalized multiline paste without selecting or submitting", async () => {
  await inputPty(async ({ engine, thread, write, screen, wait }) => {
    write("work\r"); await wait(() => engine.sent.length === 1, "question turn started");
    const turnId = engine.sent[0].turnId;
    engine.emit({ type: "itemStarted", turnId, item: { id: "paste-question-tool", type: "toolCall", payload: { name: "ask", input: {} } } });
    let answer: ServerRequestResult | undefined;
    engine.emit({ type: "approval", request: { method: "item/tool/requestUserInput", params: {
      requestId: "paste-question", threadId: thread.id, turnId, itemId: "paste-question-tool", isBlocking: true,
      questions: [{ id: "q", question: "Paste a multiline answer", options: [{ label: "Option one" }] }],
    } }, respond(result) { answer = result; } });
    await wait(() => screen().includes("Paste a multiline answer"), "question card rendered");
    write("\x1b[200~1\x1b[201~");
    await wait(() => screen().includes("自由回答: 1"), "pasted digit stays free text");
    write("\x1b[200~\ralpha\r\nbeta\n\ttail\x1b[201~");
    await wait(() => screen().includes("alpha") && screen().includes("beta") && screen().includes("tail"), "all pasted answer lines rendered");
    expect(answer).toBeUndefined();
    write("\r"); await wait(() => answer !== undefined, "explicit Enter submits answer");
    expect(answer).toEqual({ answers: { q: { answers: ["1\nalpha\nbeta\n\ttail"] } } });
    expect(engine.sent).toHaveLength(1);
  });
}, inputPtyTimeout);

test("P0-1: Ctrl-C interrupts under another client's lease before the second press exits", async () => {
  const { a, b, engine } = await setup();
  a.model.input = "running"; await a.controller.submit();
  b.model.input = "/takeover"; await b.controller.submit();
  await a.controller.key("\x03", { ctrl: true, name: "c" });
  expect(engine.interrupted).toEqual([engine.sent[0].turnId]); expect(a.exited).toBe(false);
  await a.controller.key("\x03", { ctrl: true, name: "c" }); expect(a.exited).toBe(true);
});
test("P0-1: approval abort still interrupts when its reply lease is denied", async () => {
  const { a, b, engine, thread } = await setup();
  a.model.input = "work"; await a.controller.submit(); const turnId = engine.sent[0].turnId;
  engine.emit({ type: "itemStarted", turnId, item: { id: "cmd", type: "commandExecution", payload: { command: "pwd", cwd: thread.cwd } } });
  engine.emit({ type: "approval", request: { method: "item/commandExecution/requestApproval", params: { requestId: "abort-held", threadId: thread.id, turnId, itemId: "cmd", command: "pwd", cwd: thread.cwd, startedAtMs: Date.now() } }, respond() {} });
  await until(() => !!a.model.activeCard); await b.client.request("thread/lease/acquire", { threadId: thread.id });
  await a.controller.key("a"); expect(engine.interrupted).toContain(turnId);
});
test("P1-3: real server lease excludes rivals across multiple TTLs and releases after long work", async () => {
  const { a, b, thread } = await setup(), lease = new InputLease(a.client, a.model, 200);
  let finish!: () => void;
  try {
    const work = lease.run(thread.id, () => new Promise<void>(resolve => { finish = resolve; }));
    await until(() => !!finish); await Bun.sleep(450);
    await expect(b.client.request("thread/lease/acquire", { threadId: thread.id })).rejects.toMatchObject({ code: -32012 });
    expect(render(a.model, 160)).toContain("租约:持有/续期中");
    finish(); await work; expect(render(a.model, 160)).toContain("租约:未持有");
    await b.client.request("thread/lease/acquire", { threadId: thread.id });
  } finally { finish?.(); lease.dispose(); }
});

test("P2-4: first attach marks the live-only log gap even when no events were replayed", async () => {
  const { a, b, engine, thread } = await setup();
  await b.client.request("thread/detach", { threadId: thread.id });
  engine.emit({ type: "engineEvent", backend: "claude", subtype: "memory", payload: { message: "before attach" } });
  await until(() => a.model.logs.length === 1);
  await b.client.request("thread/attach", { threadId: thread.id });
  expect(b.model.logs.length).toBe(0); expect(render(b.model)).toContain("仅显示接入后事件");
});

test("P2-1: asynchronous already_resolved response withdraws the matching approval card", async () => {
  const { a, engine, thread, peers } = await setup();
  a.model.input = "work"; await a.controller.submit(); const turnId = engine.sent[0].turnId;
  engine.emit({ type: "itemStarted", turnId, item: { id: "cmd", type: "commandExecution", payload: { command: "pwd", cwd: thread.cwd } } });
  engine.emit({ type: "approval", request: { method: "item/commandExecution/requestApproval", params: { requestId: "stale", threadId: thread.id, turnId, itemId: "cmd", command: "pwd", cwd: thread.cwd, startedAtMs: Date.now() } }, respond() {} });
  await until(() => !!a.model.activeCard);
  a.model.activeCard!.state = "sending";
  peers[0].send(JSON.stringify({ jsonrpc: "2.0", id: a.client.pendingRequests.get("stale")!.id, error: { code: -32014, message: "server request already resolved" } }));
  await until(() => a.model.cards.get("stale")?.state === "resolved");
  expect(a.model.activeCard).toBeUndefined(); expect(a.model.message).toBe("该请求已由其他客户端处理"); expect(a.model.leaseLabel).toBe("未持有");
});

test("observation commands stay local offline; contested sends and approvals retain input and name lease holder", async () => {
  const { a, b, engine, thread } = await setup();
  a.model.connection = "disconnected";
  for (const command of ["/log", "/tasks", "/agents"]) { a.model.input = command; await a.controller.submit(); expect(a.model.input).toBe(""); }
  expect(a.model.logExpanded).toBe(true); expect(a.model.tasksVisible).toBe(true); expect(engine.sent).toHaveLength(0);
  a.model.input = "/agents missing"; await a.controller.submit(); expect(a.model.message).toBe("没有匹配的子 agent");
  a.model.connection = "connected";
  b.model.input = "/takeover"; await b.controller.submit();
  a.model.input = "preserved"; await a.controller.key("\r", { name: "return" });
  expect(a.model.input).toBe("preserved"); expect(a.model.message).toContain("另一客户端持有控制权：phone"); expect(engine.sent).toHaveLength(0);
  b.model.input = "/release"; await b.controller.submit();
  await a.controller.key("\r", { name: "return" }); expect(engine.sent).toHaveLength(1);
  // Ordinary sends release their short lease, allowing another client to acquire it.
  b.model.input = "/takeover"; await b.controller.submit();
  let decided = false;
  engine.emit({ type: "itemStarted", turnId: engine.sent[0].turnId, item: { id: "cmd", type: "commandExecution", payload: { command: "pwd", cwd: thread.cwd } } });
  engine.emit({ type: "approval", request: { method: "item/commandExecution/requestApproval", params: { requestId: "leased", threadId: thread.id, turnId: engine.sent[0].turnId, itemId: "cmd", command: "pwd", cwd: thread.cwd, startedAtMs: Date.now() } }, respond() { decided = true; } });
  await until(() => !!a.model.activeCard);
  await a.controller.key("y"); expect(decided).toBe(false); expect(a.model.activeCard?.state).toBe("pending"); expect(a.model.message).toContain("phone");
  b.model.input = "/release"; await b.controller.submit(); await a.controller.key("y"); await until(() => decided);
  a.model.input = "/takeover"; await a.controller.submit(); expect(a.model.message).toContain("已接管控制权");
  a.model.input = "/release"; await a.controller.submit();
});

test("fix2 P2-1: failed lease cleanup preserves delivered turn result and reports a separate warning", async () => {
  for (const failure of [new Error("release lost"), Object.assign(new Error("lease taken"), { code: -32012, data: { holder: { label: "phone" } } })]) {
    const { a, engine } = await setup(); const request = a.client.request.bind(a.client);
    a.client.request = async (method, params) => { if (method === "thread/lease/release") throw failure; return request(method, params); };
    a.model.input = "important"; await a.controller.key("\r", { name: "return" });
    expect(engine.sent).toHaveLength(1); expect(a.model.input).toBe(""); expect(a.model.message).toBe("已发送");
    expect(a.model.leaseWarning).toContain("租约释放未确认"); expect(render(a.model, 200)).toContain("已发送 · 租约释放未确认");
  }
});

test("fix2 P1-1: a resolved or expired card cannot be revived after delayed lease acquisition", async () => {
  for (const expired of [false, true]) {
    const { a, b, engine, thread } = await setup();
    a.model.input = "work"; await a.controller.submit(); const turnId = engine.sent[0].turnId;
    engine.emit({ type: "itemStarted", turnId, item: { id: "cmd", type: "commandExecution", payload: { command: "pwd", cwd: thread.cwd } } });
    engine.emit({ type: "approval", request: { method: "item/commandExecution/requestApproval", params: { requestId: "race", threadId: thread.id, turnId, itemId: "cmd", command: "pwd", cwd: thread.cwd, startedAtMs: Date.now() } }, respond() {} });
    await until(() => !!a.model.activeCard && !!b.model.activeCard);
    const request = a.client.request.bind(a.client); let acquiring = false;
    a.client.request = async (method, params) => { if (method === "thread/lease/acquire") { acquiring = true; await Bun.sleep(150); } return request(method, params); };
    const reply = a.controller.key("y"); await until(() => acquiring);
    if (expired) engine.emit({ type: "approvalExpired", turnId, requestId: "race", reason: "timeout" });
    else await b.controller.key("n");
    await reply;
    expect(a.model.cards.get("race")?.state).toBe(expired ? "expired" : "resolved");
    expect(a.model.activeCard).toBeUndefined(); expect(a.model.lease.state).toBe("none");
    await a.controller.key("Z"); expect(a.model.input).toBe("Z");
  }
});

test("fix2 P1-1: late error correlation survives removed handles; timeout restores retry and releases lease", async () => {
  const { a, engine, thread, peers } = await setup();
  a.model.input = "work"; await a.controller.submit(); const turnId = engine.sent[0].turnId;
  engine.emit({ type: "itemStarted", turnId, item: { id: "cmd", type: "commandExecution", payload: { command: "pwd", cwd: thread.cwd } } });
  engine.emit({ type: "approval", request: { method: "item/commandExecution/requestApproval", params: { requestId: "late", threadId: thread.id, turnId, itemId: "cmd", command: "pwd", cwd: thread.cwd, startedAtMs: Date.now() } }, respond() {} });
  await until(() => !!a.model.activeCard);
  const card = a.model.activeCard!, handle = a.client.pendingRequests.get("late")!;
  // No response reaches the server, like a stalled outgoing approval response.
  const respond = handle.respond; handle.respond = () => {};
  a.client.options.requestTimeoutMs = 80;
  await a.controller.key("y");
  expect(card.state).toBe("pending"); expect(card.replying).toBe(false); expect(a.model.lease.state).toBe("none"); expect(a.model.message).toContain("超时");
  // Simulate client bookkeeping removal while preserving the card's response correlation.
  const pending = Object.getOwnPropertyDescriptor(a.client, "pendingRequests");
  Object.defineProperty(a.client, "pendingRequests", { configurable: true, get: () => new Map() });
  card.state = "sending";
  peers[0].send(JSON.stringify({ jsonrpc: "2.0", id: handle.id, error: { code: -32014, message: "already resolved" } }));
  await until(() => card.state === "resolved"); expect(a.model.activeCard).toBeUndefined();
  if (pending) Object.defineProperty(a.client, "pendingRequests", pending); else Reflect.deleteProperty(a.client, "pendingRequests");
  handle.respond = respond;
});

test("fix2 P1-1 PTY: rival during acquire, immediate resolve and slow network keep keyboard and lease usable", async () => {
  const { home, engine, thread, manager, b } = await setup();
  const state = join(home, "state"), tokenDir = join(state, "sm-toolkit", "agent-server");
  mkdirSync(tokenDir, { recursive: true }); writeFileSync(join(tokenDir, "token"), "test\n");
  let acquireDelay = 0, acquired = false, resolvedDelay = 0, dropResolved = false;
  const accept = manager.accept.bind(manager);
  manager.accept = peer => {
    const send = peer.send.bind(peer);
    peer.send = text => {
      const frame = JSON.parse(text);
      if (frame.method === "serverRequest/resolved") {
        if (dropResolved) return;
        if (resolvedDelay) { setTimeout(() => send(text), resolvedDelay); return; }
      }
      send(text);
    };
    const connection = accept(peer), receive = connection.receive.bind(connection);
    connection.receive = text => {
      if (JSON.parse(text).method === "thread/lease/acquire" && acquireDelay) { acquired = true; setTimeout(() => receive(text), acquireDelay); }
      else receive(text);
    };
    return connection;
  };
  let screen = ""; const decoder = new TextDecoder();
  const current = () => screen.slice(screen.lastIndexOf("\x1b[H")).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
  const proc = Bun.spawn([resolve(import.meta.dir, "../bin/agent-tui"), "--attach", thread.id, "--socket", join(home, "sock")], {
    env: { ...process.env, HOME: home, XDG_STATE_HOME: state, XDG_RUNTIME_DIR: "", HERDR_PANE_ID: "", TERM: "xterm-256color" },
    terminal: { cols: 160, rows: 40, data(_terminal, data) { screen += decoder.decode(data, { stream: true }); } },
  });
  try {
    await until(() => current().includes(thread.id.slice(0, 11)) && current().includes("> ")); proc.terminal!.write("work\r"); await until(() => engine.sent.length === 1);
    const turnId = engine.sent[0].turnId;
    engine.emit({ type: "itemStarted", turnId, item: { id: "cmd", type: "commandExecution", payload: { command: "pwd", cwd: home } } });
    const approval = async (id: string) => {
      engine.emit({ type: "approval", request: { method: "item/commandExecution/requestApproval", params: { requestId: id, threadId: thread.id, turnId, itemId: "cmd", command: `pwd ${id}`, cwd: home, startedAtMs: Date.now() } }, respond() {} });
      await until(() => current().includes(`Command: pwd ${id}`));
    };
    await approval("rival"); acquireDelay = 200; proc.terminal!.write("y"); await until(() => acquired);
    await b.controller.key("n"); await until(() => current().includes("已由 phone 处理") && current().includes("租约:未持有"));
    await Bun.sleep(250); // Also check after the delayed acquire round trip completes.
    expect(current()).not.toContain("审批确认中"); acquireDelay = 0;
    proc.terminal!.write("Z"); await until(() => current().includes("> Z")); proc.terminal!.write("\x15"); await until(() => current().endsWith("> "));
    await approval("instant"); proc.terminal!.write("y"); await until(() => current().includes("已由 agent-tui 处理") && current().includes("租约:未持有"));
    await approval("slow"); resolvedDelay = 300; proc.terminal!.write("y"); await until(() => current().includes("审批确认中"));
    proc.terminal!.write("N"); await until(() => current().includes("> N"));
    await until(() => !current().includes("审批确认中") && current().includes("租约:未持有")); proc.terminal!.write("\x15"); await until(() => current().endsWith("> "));
    resolvedDelay = 0; dropResolved = true; await approval("timeout"); proc.terminal!.write("y");
    await Bun.sleep(5100); await until(() => current().includes("审批回复超时") && current().includes("租约:未持有"));
    await b.client.request("thread/lease/acquire", { threadId: thread.id }); await b.client.request("thread/lease/release", { threadId: thread.id });
    proc.terminal!.write("y"); await until(() => current().includes("该请求已由其他客户端处理") && !current().includes("审批确认中"));
    proc.terminal!.write("K"); await until(() => current().includes("> K"));
  } finally { if (proc.exitCode === null) proc.kill(); await proc.exited; proc.terminal?.close(); }
}, 15000);

test("P1-2 PTY benchmark: input echo stays below 50ms after 5000 engine events", async () => {
  const { home, engine, thread } = await setup();
  const state = join(home, "state"), tokenDir = join(state, "sm-toolkit", "agent-server");
  mkdirSync(tokenDir, { recursive: true }); writeFileSync(join(tokenDir, "token"), "test\n");
  let screen = ""; const decoder = new TextDecoder();
  const proc = Bun.spawn([resolve(import.meta.dir, "../bin/agent-tui"), "--attach", thread.id, "--socket", join(home, "sock")], {
    env: { ...process.env, HOME: home, XDG_STATE_HOME: state, XDG_RUNTIME_DIR: "", HERDR_PANE_ID: "", TERM: "xterm-256color" },
    terminal: { cols: 160, rows: 40, data(_terminal, data) { screen += decoder.decode(data, { stream: true }); } },
  });
  try {
    await until(() => screen.includes("\x1b[H") && screen.includes(thread.id.slice(0, 11)) && screen.includes("> ")); proc.terminal!.write("\x0c");
    for (let i = 0; i < 5000; i++) engine.emit({ type: "engineEvent", backend: "claude", subtype: "memory", payload: { message: `benchmark-${i}` } });
    await until(() => screen.includes("已丢弃 3000 条") && screen.includes("benchmark-4999"));
    const timings: number[] = []; let input = "";
    for (const letter of "ABCDE") {
      screen = ""; input += letter; const start = performance.now(); proc.terminal!.write(letter);
      await until(() => screen.includes(`> ${input}`)); timings.push(performance.now() - start);
    }
    console.info(`P1-2 PTY 5000 events: echo ms=${timings.map(t => t.toFixed(2)).join(",")}, max=${Math.max(...timings).toFixed(2)}`);
    expect(Math.max(...timings)).toBeLessThan(50);
  } finally { if (proc.exitCode === null) proc.kill(); await proc.exited; proc.terminal?.close(); }
}, 15000);

test("observe PTY: engine event folding/scrolling, nested agents, task refresh and reconnect gap", async () => {
  const { home, engine, thread, manager } = await setup();
  const state = join(home, "state"), tokenDir = join(state, "sm-toolkit", "agent-server");
  mkdirSync(tokenDir, { recursive: true }); writeFileSync(join(tokenDir, "token"), "test\n");
  let screen = ""; const decoder = new TextDecoder();
  const current = () => screen.slice(screen.lastIndexOf("\x1b[H")).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
  const proc = Bun.spawn([resolve(import.meta.dir, "../bin/agent-tui"), "--attach", thread.id, "--socket", join(home, "sock")], {
    env: { ...process.env, HOME: home, XDG_STATE_HOME: state, XDG_RUNTIME_DIR: "", HERDR_PANE_ID: "", TERM: "xterm-256color" },
    terminal: { cols: 160, rows: 60, data(_terminal, data) { screen += decoder.decode(data, { stream: true }); } },
  });
  try {
    await until(() => current().includes(thread.id.slice(0, 11)) && current().includes("> "));
    proc.terminal!.write("observe\r"); await until(() => engine.sent.length === 1);
    const turnId = engine.sent[0].turnId;
    const subtypes = ["stop_hook_summary", "local_command", "api_retry", "rate_limit", "model_refusal_fallback", "memory", "away_summary", "unknown_future"];
    for (const subtype of subtypes) engine.emit({ type: "engineEvent", backend: "claude", turnId, subtype, payload: { message: `echo-${subtype}`, extra: { retained: true } } });
    await until(() => current().includes("系统日志 8 条")); expect(current()).not.toContain("echo-local_command");
    proc.terminal!.write("\x0c"); await until(() => current().includes("unknown_future") && current().endsWith("> "));
    for (const subtype of subtypes) expect(current()).toContain(subtype);
    expect(current()).toContain('"extra":{"retained":true}'); expect(screen).toContain("\x1b[31m");
    proc.terminal!.write("/log \r"); await until(() => current().includes("折叠 · Ctrl-L")); expect(current()).not.toContain("echo-local_command");
    engine.emit({ type: "itemStarted", turnId, item: { id: "parent", type: "toolCall", payload: { name: "Agent", input: { prompt: "inspect" } } } });
    engine.emit({ type: "itemStarted", turnId, item: { id: "child", type: "subAgent", payload: { kind: "agent", parentItemId: "parent", phase: "working", text: "CHILD TEXT" } } });
    engine.emit({ type: "itemStarted", turnId, item: { id: "nested", type: "subAgent", payload: { kind: "agent", parentItemId: "child", phase: "working", text: "NESTED TEXT" } } });
    await until(() => current().includes("NESTED TEXT"));
    expect(current()).toContain("      NESTED TEXT"); expect(current()).toContain("[inProgress] working · parent parent");
    engine.emit({ type: "itemUpdated", turnId, item: { id: "child", type: "subAgent", payload: { kind: "agent", parentItemId: "parent", phase: "working", text: "CHILD STREAMED", progress: { text: "CHILD STREAMED" } } } });
    await until(() => current().includes("CHILD STREAMED")); expect(current()).not.toContain("CHILD TEXT");
    proc.terminal!.write("/agents child\r"); await until(() => current().includes("▸ SubAgent child")); expect(current()).not.toContain("NESTED TEXT");
    proc.terminal!.write("/agents child\r"); await until(() => current().includes("NESTED TEXT"));
    engine.emit({ type: "itemCompleted", turnId, item: { id: "child", type: "subAgent", payload: { kind: "agent", parentItemId: "parent", phase: "done", text: "CHILD FINAL" } } });
    await until(() => current().includes("[completed] done") && current().includes("CHILD FINAL"));
    proc.terminal!.write("/tasks \r"); await until(() => current().includes("Tasks 0"));
    engine.emit({ type: "itemStarted", turnId, item: { id: "create", type: "toolCall", payload: { name: "TaskCreate", input: { id: "42", subject: "PTY TASK" } } } });
    await until(() => current().includes("[pending] #42 PTY TASK"));
    engine.emit({ type: "itemStarted", turnId, item: { id: "update", type: "toolCall", payload: { name: "TaskUpdate", input: { taskId: "42", status: "completed" } } } });
    await until(() => current().includes("[completed] #42 PTY TASK"));
    engine.emit({ type: "itemStarted", turnId, item: { id: "list", type: "toolCall", payload: { name: "TaskList", input: { tasks: [{ id: "99", subject: "LIST TASK", status: "in_progress" }] } } } });
    await until(() => current().includes("[in_progress] #99 LIST TASK")); expect(current()).not.toContain("[completed] #42");
    proc.terminal!.write("/tasks \r"); await until(() => !current().includes("Tasks 1"));
    for (let i = 0; i < 40; i++) engine.emit({ type: "engineEvent", backend: "claude", turnId, subtype: "memory", payload: { message: `scroll-event-${i}` } });
    await until(() => current().includes("系统日志 48 条"));
    proc.terminal!.write("/log \r"); await until(() => current().includes("scroll-event-39"));
    proc.terminal!.write("\x1b[5~"); await until(() => !current().includes("scroll-event-39") && current().includes("scroll-event-34"));
    proc.terminal!.write("\x1b[6~"); await until(() => current().includes("scroll-event-39"));
    manager.close();
    engine.emit({ type: "engineEvent", backend: "claude", turnId, subtype: "local_command", payload: { message: "OFFLINE LOST" } });
    await until(() => current().includes("重连后可能缺失") && current().includes("| connected"));
    expect(current()).not.toContain("OFFLINE LOST"); expect(engine.spawnCount).toBe(1);
    proc.terminal!.write("/log \r"); await until(() => current().includes("折叠 · Ctrl-L"));
    proc.terminal!.write("/tasks \r");
    try { await until(() => current().includes("[in_progress] #99 LIST TASK")); }
    catch (error) { throw new Error(`${String(error)}\n${current()}`); }
    proc.terminal!.write("\x03"); await until(() => engine.interrupted.length === 1); proc.terminal!.write("\x03");
    expect(await Promise.race([proc.exited, Bun.sleep(3000).then(() => -100)])).toBe(0);
  } finally { if (proc.exitCode === null) proc.kill(); await proc.exited; proc.terminal?.close(); }
}, 15000);

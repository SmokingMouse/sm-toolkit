import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AgentServer, MockEngine, type EngineEvent } from "@smokingmouse/agent-server";
import { AgentClient, type ClientEndpoint } from "@smokingmouse/agent-server/client";
import { ConnectionManager, listenUnix, listenWebSocket, type WirePeer } from "@smokingmouse/agent-server/transport";
import type { PendingServerRequest, ServerRequestResult } from "@smokingmouse/agent-server/protocol";
import { bindClient, TuiModel } from "./model.js";
import { Controller } from "./controller.js";
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
    await until(() => screen.includes(thread.id) && screen.includes("Enter"));
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

test("observation commands stay local offline; contested sends and approvals retain input and name lease holder", async () => {
  const { a, b, engine, thread } = await setup();
  a.model.connection = "disconnected";
  for (const command of ["/log", "/tasks", "/agents"]) { a.model.input = command; await a.controller.submit(); expect(a.model.input).toBe(""); }
  expect(a.model.logExpanded).toBe(true); expect(a.model.tasksVisible).toBe(true); expect(engine.sent).toHaveLength(0);
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
  a.model.input = "/takeover"; await a.controller.submit(); expect(a.model.message).toContain("已取得控制权");
  a.model.input = "/release"; await a.controller.submit();
});

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
    await until(() => current().includes(thread.id));
    proc.terminal!.write("observe\r"); await until(() => engine.sent.length === 1);
    const turnId = engine.sent[0].turnId;
    const subtypes = ["stop_hook_summary", "local_command", "api_retry", "rate_limit", "model_refusal_fallback", "memory", "away_summary", "unknown_future"];
    for (const subtype of subtypes) engine.emit({ type: "engineEvent", backend: "claude", turnId, subtype, payload: { message: `echo-${subtype}`, extra: { retained: true } } });
    await until(() => current().includes("系统日志 8 条")); expect(current()).not.toContain("echo-local_command");
    proc.terminal!.write("\x0c"); await until(() => current().includes("echo-local_command"));
    for (const subtype of subtypes) expect(current()).toContain(subtype);
    expect(current()).toContain('"extra":{"retained":true}'); expect(screen).toContain("\x1b[31m");
    proc.terminal!.write("/log\r"); await until(() => current().includes("折叠 · Ctrl-L")); expect(current()).not.toContain("echo-local_command");
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
    proc.terminal!.write("/tasks\r"); await until(() => current().includes("Tasks 0"));
    engine.emit({ type: "itemStarted", turnId, item: { id: "create", type: "toolCall", payload: { name: "TaskCreate", input: { id: "42", subject: "PTY TASK" } } } });
    await until(() => current().includes("[pending] #42 PTY TASK"));
    engine.emit({ type: "itemStarted", turnId, item: { id: "update", type: "toolCall", payload: { name: "TaskUpdate", input: { taskId: "42", status: "completed" } } } });
    await until(() => current().includes("[completed] #42 PTY TASK"));
    engine.emit({ type: "itemStarted", turnId, item: { id: "list", type: "toolCall", payload: { name: "TaskList", input: { tasks: [{ id: "99", subject: "LIST TASK", status: "in_progress" }] } } } });
    await until(() => current().includes("[in_progress] #99 LIST TASK")); expect(current()).not.toContain("[completed] #42");
    proc.terminal!.write("/tasks\r"); await until(() => !current().includes("Tasks 1"));
    for (let i = 0; i < 40; i++) engine.emit({ type: "engineEvent", backend: "claude", turnId, subtype: "memory", payload: { message: `scroll-event-${i}` } });
    await until(() => current().includes("系统日志 48 条"));
    proc.terminal!.write("/log\r"); await until(() => current().includes("scroll-event-39"));
    proc.terminal!.write("\x1b[5~"); await until(() => !current().includes("scroll-event-39") && current().includes("scroll-event-34"));
    proc.terminal!.write("\x1b[6~"); await until(() => current().includes("scroll-event-39"));
    manager.close();
    engine.emit({ type: "engineEvent", backend: "claude", turnId, subtype: "local_command", payload: { message: "OFFLINE LOST" } });
    await until(() => current().includes("重连后可能缺失") && current().includes("| connected |"));
    expect(current()).not.toContain("OFFLINE LOST"); expect(engine.spawnCount).toBe(1);
    proc.terminal!.write("/log\r"); await until(() => current().includes("折叠 · Ctrl-L"));
    proc.terminal!.write("/tasks\r");
    try { await until(() => current().includes("[in_progress] #99 LIST TASK")); }
    catch (error) { throw new Error(`${String(error)}\n${current()}`); }
    proc.terminal!.write("\x03"); await until(() => engine.interrupted.length === 1); proc.terminal!.write("\x03");
    expect(await Promise.race([proc.exited, Bun.sleep(3000).then(() => -100)])).toBe(0);
  } finally { if (proc.exitCode === null) proc.kill(); await proc.exited; proc.terminal?.close(); }
}, 15000);

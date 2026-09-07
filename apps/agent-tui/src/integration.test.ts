import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    const client = new AgentClient(endpoint, { token: "test", client: { name: label, label, kind: "test", version: "1" }, reconnect: { minDelayMs: 150, maxDelayMs: 150 }, capabilities: { serverRequests: ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput"] } });
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
    await wait(() => screen.includes(h.thread.id) && screen.includes("Enter"), "TUI attached and input ready");
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
    write("/"); await wait(() => screen().includes("/image —") && screen().includes("/steer —") && screen().includes("global skill description"), "commands and skill descriptions rendered");
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

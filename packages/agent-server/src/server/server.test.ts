import { afterEach, describe, expect, test } from "bun:test";
import { AgentServer, MockEngine, type Frame, type InProcessClient, type ServerNotification } from "../index.js";
import { capability, capture, client, flush, input, setup, until } from "../test-helpers.test.js";

const servers: AgentServer[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await s.close(); });
const create = (options = {}) => { const fixture = setup(options); servers.push(fixture.server); return fixture; };
describe("in-process JSON-RPC server", () => {
  test("N1: service errors reach initialized clients once without requiring a thread", async () => {
    const { server } = create(); const a = await client(server), b = await client(server), uninitialized = server.connectInProcess();
    const muted = server.connectInProcess();
    await muted.request("initialize", { protocolVersion: "as/1", client: { name: "muted", version: "1", kind: "test", label: "muted" }, capabilities: { notifications: { optOut: ["error"] } } }); await muted.notifyInitialized();
    const af = capture(a), bf = capture(b), uf = capture(uninitialized), mf = capture(muted);
    const notification = { jsonrpc: "2.0" as const, method: "error" as const, params: { error: { code: -32603, message: "service failure", data: { retryable: false } }, willRetry: false } };
    server.log.publish(notification);
    expect(af).toEqual([notification]); expect(bf).toEqual([notification]); expect(uf).toEqual([]); expect(mf).toEqual([]);
    b.close(); server.log.publish(notification); expect(bf).toHaveLength(1); expect(af).toHaveLength(2);
  });
  test("K1: reused requestId rejects only the duplicate callback and keeps the thread alive", async () => {
    const { server, engines } = create(); const c = await client(server), frames = capture(c);
    const { thread } = await c.request("thread/start", { model: "sonnet", backend: "claude", cwd: process.cwd() });
    const { turn } = await c.request("turn/start", { threadId: thread.id, input: input("go") });
    const engine = engines[0], decisions: unknown[] = [], duplicate: unknown[] = [];
    engine.emit({ type: "itemStarted", turnId: turn.id, item: { id: "cmd", type: "commandExecution", payload: { command: "pwd", cwd: process.cwd() } } });
    const request = { method: capability, params: { requestId: "dup", threadId: thread.id, turnId: turn.id, itemId: "cmd", command: "pwd", cwd: process.cwd(), startedAtMs: Date.now() } };
    engine.emit({ type: "approval", request, respond: result => { decisions.push(result); } });
    engine.emit({ type: "approval", request, respond: result => { duplicate.push(result); } });
    await until(() => duplicate.length === 1);
    expect(duplicate).toEqual([{ decision: "reject" }]); expect(decisions).toEqual([]);
    expect(server.threads.get(thread.id).status.type).toBe("running");
    expect(server.log.pendingRequests(thread.id)).toHaveLength(1);
    const cards = frames.filter(f => "method" in f && f.method === capability && "id" in f);
    expect(cards).toHaveLength(1);
    await c.respond((cards[0] as any).id, { decision: "accept" });
    expect(decisions).toEqual([{ decision: "accept" }]);
    engine.emit({ type: "approval", request, respond: result => { duplicate.push(result); } });
    await until(() => duplicate.length === 2);
    expect(duplicate[1]).toEqual({ decision: "reject" });
    expect(frames.filter(f => "method" in f && f.method === "error" && f.params.error.code === -32015)).toHaveLength(2);
    engine.emit({ type: "turnCompleted", turnId: turn.id, status: "completed" });
    await until(() => server.threads.get(thread.id).status.type === "idle");
  });
  test("P1: attach rejects limit; complete suffix and bounded history have separate contracts", async () => {
    const { server } = create({ allowedRoots: [process.cwd()] }); const c = await client(server);
    const { thread } = await c.request("thread/start", { model: "sonnet", backend: "claude", cwd: process.cwd() });
    for (let i = 0; i < 5; i++) {
      await c.request("turn/start", { threadId: thread.id, input: input(String(i)) });
      await c.request("thread/interrupt", { threadId: thread.id }); await flush();
    }
    await expect(c.request("thread/attach", { threadId: thread.id, limit: 2 } as any)).rejects.toMatchObject({ code: -32602 });
    expect((await c.request("thread/attach", { threadId: thread.id })).items).toHaveLength(5);
    expect((await c.request("thread/items/list", { threadId: thread.id, limit: 2 })).items).toHaveLength(2);
  });
  test("S3: clients cannot override PATH or ANTHROPIC_* on start or resume", async () => {
    const { server, engines } = create({ allowedRoots: [process.cwd()] });
    const c = await client(server);
    for (const backend of ["claude", "codex"] as const) {
      const { thread } = await c.request("thread/start", { model: "sonnet", backend, cwd: process.cwd() });
      for (const key of ["PATH", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "NODE_OPTIONS", "DYLD_INSERT_LIBRARIES", "LD_PRELOAD"]) {
        await expect(c.request("thread/start", { model: "sonnet", backend, env: { [key]: "attacker" } } as any)).rejects.toMatchObject({ code: -32602 });
        await expect(c.request("thread/resume", { threadId: thread.id, env: { [key]: "attacker" } } as any)).rejects.toMatchObject({ code: -32602 });
      }
    }
    expect(engines).toHaveLength(2);
    expect(engines.every(e => !("env" in e.options!))).toBe(true);
  });
  test("two-step handshake, unknown methods and malformed frames", async () => {
    const { server } = create(); const c = server.connectInProcess(); const frames = capture(c);
    await expect(c.request("thread/list", {})).rejects.toMatchObject({ code: -32002 });
    await c.request("initialize", { protocolVersion: "as/1", client: { name: "test", version: "1", kind: "test", label: "test" } });
    await expect(c.request("thread/list", {})).rejects.toMatchObject({ code: -32002 }); await c.notifyInitialized();
    await c.send({ jsonrpc: "2.0", id: "unknown", method: "unknown", params: {} }); expect(frames.at(-1)).toMatchObject({ error: { code: -32601 } });
    await c.send({ jsonrpc: "1.0", id: 10 }); expect(frames.at(-1)).toMatchObject({ id: 10, error: { code: -32600 } });
    expect((await c.request("thread/list", {})).threads).toEqual([]);
  });
  test("version mismatch closes connection without downgrade", async () => {
    const { server } = create(); const c = server.connectInProcess();
    await expect(c.request("initialize", { protocolVersion: "as/2", client: { name: "t", version: "1", kind: "test", label: "t" } })).rejects.toMatchObject({ code: -32003 }); expect(c.closed).toBe(true);
  });
  test("token authorization and read-only config never disclose token", async () => {
    const { server } = create({ token: "test-secret" }); const c = server.connectInProcess();
    await expect(c.request("initialize", { protocolVersion: "as/1", client: { name: "t", version: "1", kind: "test", label: "t" } })).rejects.toMatchObject({ code: -32005 });
    const d = server.connectInProcess(); await d.request("initialize", { protocolVersion: "as/1", token: "test-secret", client: { name: "t", version: "1", kind: "test", label: "t" } }); await d.notifyInitialized();
    expect(JSON.stringify(await d.request("server/config/read", {}))).not.toContain("test-secret");
  });
  test("unattached clients receive no thread notifications and detach preserves live engine", async () => {
    const { server, engines } = create(); const a = await client(server), b = await client(server); const seen = capture(b);
    const { thread } = await a.request("thread/start", { model: "sonnet", backend: "claude", cwd: process.cwd() }); await a.request("turn/start", { threadId: thread.id, input: input("one") }); expect(seen).toEqual([]);
    await b.request("thread/attach", { threadId: thread.id }); await b.request("thread/detach", { threadId: thread.id }); seen.splice(0);
    engines[0].emit({ type: "exit" }); await flush(); expect(seen).toEqual([]);
  });
  test("notification opt-out only affects the declaring connection", async () => {
    const { server, engines } = create(); const a = await client(server); const b = server.connectInProcess();
    await b.request("initialize", { protocolVersion: "as/1", client: { name: "b", version: "1", kind: "test", label: "b" }, capabilities: { notifications: { optOut: ["item/reasoning/textDelta"] } } }); await b.notifyInitialized();
    const { thread } = await a.request("thread/start", { model: "sonnet", backend: "claude", cwd: process.cwd() }); await b.request("thread/attach", { threadId: thread.id }); const af = capture(a), bf = capture(b);
    const { turn } = await a.request("turn/start", { threadId: thread.id, input: input("one") });
    engines[0].emit({ type: "itemStarted", turnId: turn.id, item: { id: "reason", type: "reasoning", payload: { text: "" } } });
    engines[0].emit({ type: "itemDelta", turnId: turn.id, itemId: "reason", kind: "reasoning", text: "think" }); await flush();
    expect(af.some(f => "method" in f && f.method === "item/reasoning/textDelta")).toBe(true); expect(bf.some(f => "method" in f && f.method === "item/reasoning/textDelta")).toBe(false);
  });
  test("thread and turn keys deduplicate canonical payloads; conflicts are -32013", async () => {
    const { server, engines } = create(); const a = await client(server), b = await client(server);
    const [one, two] = await Promise.all([a.request("thread/start", { model: "sonnet", backend: "claude", cwd: process.cwd(), clientThreadId: "thread-key", meta: { a: 1, b: 2 } }), b.request("thread/start", { model: "sonnet", backend: "claude", cwd: process.cwd(), clientThreadId: "thread-key", meta: { b: 2, a: 1 } })]);
    expect(one.thread.id).toBe(two.thread.id); expect(two.deduplicated).toBe(true); expect(engines).toHaveLength(1);
    await expect(a.request("thread/start", { model: "sonnet", backend: "claude", cwd: process.cwd(), clientThreadId: "thread-key", meta: {} })).rejects.toMatchObject({ code: -32013 });
    const p = { threadId: one.thread.id, input: input("same"), clientTurnId: "turn-key" };
    const [t1, t2] = await Promise.all([a.request("turn/start", p), b.request("turn/start", p)]); expect(t1.turn.id).toBe(t2.turn.id); expect(t2.deduplicated).toBe(true); expect(engines[0].sent).toHaveLength(1);
    await expect(a.request("turn/start", { ...p, input: input("different") })).rejects.toMatchObject({ code: -32013 });
  });
  test("input lease excludes others, can be renewed, and disconnect releases", async () => {
    const { server } = create(); const a = await client(server, "a"), b = await client(server, "b"); const { thread } = await a.request("thread/start", { model: "sonnet", backend: "claude", cwd: process.cwd() });
    const first = await a.request("thread/lease/acquire", { threadId: thread.id }); expect(first.lease.holder.label).toBe("a");
    const renewed = await a.request("thread/lease/acquire", { threadId: thread.id }); expect(renewed.lease.expiresAtMs).toBeGreaterThanOrEqual(first.lease.expiresAtMs);
    await expect(b.request("turn/start", { threadId: thread.id, input: input("blocked") })).rejects.toMatchObject({ code: -32012, data: { holder: { label: "a" } } });
    a.close(); expect((await b.request("turn/start", { threadId: thread.id, input: input("allowed") })).turn.status).toBe("inProgress");
  });
  test("cwd guard and unsupported backend fail before spawning", async () => {
    const { server, engines } = create(); const c = await client(server);
    await expect(c.request("thread/start", { model: "sonnet", backend: "claude", cwd: "/" })).rejects.toMatchObject({ code: -32005 });
    await expect(c.request("thread/start", { model: "sonnet", backend: "external", cwd: process.cwd() })).rejects.toMatchObject({ code: -32008 }); expect(engines).toHaveLength(0);
  });
  test("transport adapters consume the same frame objects through async iteration", async () => {
    const { server } = create(); const c = server.connectInProcess(); const stream = c.frames[Symbol.asyncIterator]();
    await c.send({ jsonrpc: "2.0", id: "wire-init", method: "initialize", params: { protocolVersion: "as/1", client: { name: "wire", version: "1", kind: "test", label: "wire" } } });
    expect((await stream.next()).value).toMatchObject({ id: "wire-init", result: { protocolVersion: "as/1" } }); c.close(); expect((await stream.next()).done).toBe(true);
  });
  test("reattach on the same connection reissues pending requests with fresh wire IDs", async () => {
    const { server, engines } = create(); const c = await client(server); const frames = capture(c); const { thread } = await c.request("thread/start", { model: "sonnet", backend: "claude", cwd: process.cwd() });
    const { turn } = await c.request("turn/start", { threadId: thread.id, input: input("approval") });
    engines[0].emit({ type: "itemStarted", turnId: turn.id, item: { id: "cmd", type: "commandExecution", payload: { command: "pwd", cwd: process.cwd() } } });
    engines[0].emit({ type: "approval", request: { method: capability, params: { requestId: "reattach-ar", threadId: thread.id, turnId: turn.id, itemId: "cmd", command: "pwd", cwd: process.cwd(), startedAtMs: Date.now() } }, respond: () => {} });
    const cards = () => frames.filter(f => "method" in f && f.method === capability && "id" in f);
    await until(() => cards().length === 1); await c.request("thread/detach", { threadId: thread.id }); await c.request("thread/attach", { threadId: thread.id });
    expect(cards()).toHaveLength(2); expect((cards()[0] as { id: string }).id).not.toBe((cards()[1] as { id: string }).id);
  });
  test("external backend remains read-only even with an injected engine", async () => {
    const { server } = create({ backends: ["external"], engineFactory: () => new MockEngine(undefined, "external") }); const c = await client(server); const { thread } = await c.request("thread/start", { model: "sonnet", backend: "external", cwd: process.cwd() });
    await expect(c.request("turn/start", { threadId: thread.id, input: input("no") })).rejects.toMatchObject({ code: -32008 });
  });
  test("shutdown rejects new requests while a live engine is closing", async () => {
    const { server, engines } = create(); const c = await client(server); await c.request("thread/start", { model: "sonnet", backend: "claude", cwd: process.cwd() });
    const closing = server.close(); await expect(c.request("thread/start", { model: "sonnet", backend: "claude", cwd: process.cwd() })).rejects.toThrow(); await closing; expect(engines).toHaveLength(1);
  });
  test("MockEngine end-to-end: two clients, approval race, stream, usage, reconnect snapshot", async () => {
    let decision: unknown;
    const { server } = create({ engineFactory: () => new MockEngine(function* (turnId, _input, engine) {
      const threadId = engine.options!.threadId;
      yield { type: "itemStarted", turnId, item: { id: "cmd", type: "commandExecution", payload: { command: "pwd", cwd: process.cwd() } } };
      yield { approval: { method: capability, params: { requestId: "approval-e2e", threadId, turnId, itemId: "cmd", command: "pwd", cwd: process.cwd(), startedAtMs: Date.now() } }, onDecision: result => { decision = result; } };
      yield { type: "itemCompleted", turnId, item: { id: "cmd", type: "commandExecution", payload: { command: "pwd", cwd: process.cwd(), exitCode: 0, aggregatedOutput: process.cwd() }, status: "completed" } };
      yield { type: "itemStarted", turnId, item: { id: "answer", type: "agentMessage", payload: { text: "" } } };
      yield { type: "itemDelta", turnId, itemId: "answer", kind: "text", text: "done" };
      yield { type: "itemCompleted", turnId, item: { id: "answer", type: "agentMessage", payload: { text: "done" }, status: "completed" } };
      yield { type: "turnCompleted", turnId, status: "completed", usage: { usd: null, inputTokens: 10, outputTokens: 2, cachedTokens: 0, cacheCreation: 0, estimated: false, contextTokens: 10 } };
    }) });
    const a = await client(server, "web"), b = await client(server, "phone"), readonly = await client(server, "display", []); const af = capture(a), bf = capture(b), rf = capture(readonly);
    const { thread } = await a.request("thread/start", { model: "sonnet", backend: "claude", cwd: process.cwd() }); await b.request("thread/attach", { threadId: thread.id }); await readonly.request("thread/attach", { threadId: thread.id });
    const { turn } = await a.request("turn/start", { threadId: thread.id, input: input("do it") });
    const approvalFrame = (frames: Frame[]) => frames.find(f => "method" in f && f.method === capability && "id" in f) as { id: string } | undefined;
    await until(() => Boolean(approvalFrame(af) && approvalFrame(bf)));
    expect(approvalFrame(rf)).toBeUndefined(); expect(approvalFrame(af)!.id).not.toBe(approvalFrame(bf)!.id);
    expect((await b.request("thread/attach", { threadId: thread.id })).pendingRequests).toHaveLength(1);
    await b.respond(approvalFrame(bf)!.id, { decision: "accept" }); await until(() => server.log.turn(turn.id).status === "completed");
    expect(decision).toEqual({ decision: "accept" }); expect(af.some(f => "method" in f && f.method === "serverRequest/resolved")).toBe(true);
    await a.respond(approvalFrame(af)!.id, { decision: "reject" }); expect(af.at(-1)).toMatchObject({ error: { code: -32014 } });
    a.close(); const reconnect = await client(server); const snapshot = await reconnect.request("thread/attach", { threadId: thread.id });
    expect(snapshot.items.map(i => i.type)).toEqual(["userMessage", "commandExecution", "agentMessage"]); expect(snapshot.items.at(-1)!.payload).toEqual({ text: "done" }); expect(snapshot.pendingRequests).toEqual([]);
    expect(server.log.turn(turn.id).usage?.usd).toBeNull(); expect(snapshot.nextSeq).toBe(7);
  });
});

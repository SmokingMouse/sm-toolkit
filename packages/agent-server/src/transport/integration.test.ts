import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AgentClient, type ClientOptions, type ServerRequestHandle } from "../client/index.js";
import { openWire, type ClientEndpoint, type ClientWire } from "../client/wire.js";
import { AgentServer } from "../server/index.js";
import { MockEngine } from "../engines/index.js";
import type { AttachResult, Frame, Item, ServerNotification } from "../protocol/index.js";
import { input, until } from "../test-helpers.test.js";
import { ConnectionManager, listenUnix, listenWebSocket } from "./index.js";

const approval = "item/commandExecution/requestApproval" as const;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

for (const transport of ["unix", "ws"] as const) describe(`${transport} transport integration (MockEngine)`, () => {
  async function setup() {
    const home = mkdtempSync("/tmp/as-integration-");
    const engines: MockEngine[] = [];
    const server = new AgentServer({ databasePath: join(home, "state.db"), token: "test-token", allowedRoots: [home], idleTimeoutMs: 0, engineFactory: () => { const engine = new MockEngine(); engines.push(engine); return engine; } });
    const manager = new ConnectionManager(server);
    const listener = transport === "unix" ? listenUnix(manager, { path: join(home, "sock") }) : listenWebSocket(manager);
    const endpoint: ClientEndpoint = "path" in listener ? { transport, path: listener.path } as ClientEndpoint : { transport: "ws", url: listener.url };
    const clients: AgentClient[] = [], wires: ClientWire[] = [];
    cleanups.push(async () => { for (const client of clients) client.close(); for (const wire of wires) wire.close(); await server.close(); listener.close(); expect(manager.size).toBe(0); rmSync(home, { recursive: true, force: true }); });
    async function connect(label: string, options: ClientOptions = {}) {
      const client = new AgentClient(endpoint, { token: "test-token", reconnect: false, capabilities: { serverRequests: [approval] }, client: { name: label, version: "1", kind: "test", label }, ...options });
      clients.push(client); await client.connect(); return client;
    }
    async function raw() {
      const frames: Frame[] = []; let closed = false;
      const wire = await openWire(endpoint, text => frames.push(JSON.parse(text)), () => { closed = true; }, 1000);
      wires.push(wire);
      return { frames, wire, get closed() { return closed; }, send(frame: unknown) { wire.send(JSON.stringify(frame)); } };
    }
    return { home, server, manager, engines, connect, raw };
  }

  test("two attached clients receive identical ordered items; unrelated clients remain silent", async () => {
    const { home, engines, connect } = await setup();
    const a = await connect("a"), b = await connect("b"), unrelated = await connect("unrelated");
    const { thread } = await a.request("thread/start", { backend: "claude", cwd: home });
    await b.request("thread/attach", { threadId: thread.id });
    const af: ServerNotification[] = [], bf: ServerNotification[] = [], uf: Frame[] = [];
    a.onFrame(f => { if ("method" in f && !("id" in f)) af.push(f as ServerNotification); });
    b.onFrame(f => { if ("method" in f && !("id" in f)) bf.push(f as ServerNotification); });
    unrelated.onFrame(f => uf.push(f));
    const { turn } = await a.request("turn/start", { threadId: thread.id, input: input("go") });
    for (let i = 0; i < 3; i++) {
      engines[0].emit({ type: "itemStarted", turnId: turn.id, item: { id: `answer-${i}`, type: "agentMessage", payload: { text: "" } } });
      engines[0].emit({ type: "itemDelta", turnId: turn.id, itemId: `answer-${i}`, kind: "text", text: `text-${i}` });
      engines[0].emit({ type: "itemCompleted", turnId: turn.id, item: { id: `answer-${i}`, type: "agentMessage", payload: { text: `text-${i}` }, status: "completed" } });
    }
    engines[0].emit({ type: "turnCompleted", turnId: turn.id, status: "completed" });
    await until(() => bf.some(f => f.method === "turn/completed") && af.some(f => f.method === "turn/completed"));
    expect(af).toEqual(bf); expect(uf).toEqual([]);
    const seqs = af.filter(f => f.method === "item/started").map(f => f.params.seq);
    expect(seqs).toEqual([1, 3, 5, 7]);
    const items = af.filter(f => f.method === "item/completed").map(f => f.params.item);
    expect(items.map(item => item.payload)).toContainEqual({ text: "text-2" });
  });

  test("capable attached clients race by separate wire IDs; late answers get -32014", async () => {
    const { home, engines, server, connect } = await setup();
    const a = await connect("a"), b = await connect("b"), display = await connect("display", { capabilities: {} }), unattached = await connect("unattached");
    const { thread } = await a.request("thread/start", { backend: "claude", cwd: home });
    await b.request("thread/attach", { threadId: thread.id }); await display.request("thread/attach", { threadId: thread.id });
    const cards: ServerRequestHandle<typeof approval>[] = [], excluded: Frame[] = [];
    a.onServerRequest(approval, request => cards.push(request)); b.onServerRequest(approval, request => cards.push(request));
    display.onFrame(frame => excluded.push(frame)); unattached.onFrame(frame => excluded.push(frame));
    const resolved: string[] = [], errors: Array<{ code?: number; id: unknown }> = [];
    b.onNotification("serverRequest/resolved", p => resolved.push(p.decidedBy.clientId));
    b.onError((error, id) => errors.push({ code: (error as { code?: number }).code, id }));
    const { turn } = await a.request("turn/start", { threadId: thread.id, input: input("approval") });
    engines[0].emit({ type: "itemStarted", turnId: turn.id, item: { id: "command", type: "commandExecution", payload: { command: "pwd", cwd: home } } });
    const decisions: unknown[] = [];
    engines[0].emit({ type: "approval", request: { method: approval, params: { requestId: "race", threadId: thread.id, turnId: turn.id, itemId: "command", command: "pwd", cwd: home, startedAtMs: Date.now() } }, respond: result => { decisions.push(result); } });
    await until(() => cards.length === 2);
    expect(cards[0].params.requestId).toBe(cards[1].params.requestId); expect(cards[0].id).not.toBe(cards[1].id);
    expect(excluded.some(f => "method" in f && f.method === approval)).toBe(false);
    const first = a.pendingRequests.get("race")!, second = b.pendingRequests.get("race")!;
    first.respond({ decision: "accept" }); await until(() => resolved.length === 1);
    expect(resolved).toEqual([a.clientId!]); expect(decisions).toEqual([{ decision: "accept" }]);
    expect(b.pendingRequests.size).toBe(0); second.respond({ decision: "reject" });
    await until(() => errors.some(error => error.code === -32014));
    expect(errors).toContainEqual({ code: -32014, id: second.id });
    expect(server.log.approval("race")?.status).toBe("decided"); expect(decisions).toHaveLength(1);
  });

  test("reconnect replays missing items and final text, never offline deltas", async () => {
    const { home, engines, server, manager, connect } = await setup();
    const a = await connect("a", { reconnect: { minDelayMs: 80, maxDelayMs: 80 } });
    const { thread } = await a.request("thread/start", { backend: "claude", cwd: home });
    const { turn } = await a.request("turn/start", { threadId: thread.id, input: input("stream") });
    engines[0].emit({ type: "itemStarted", turnId: turn.id, item: { id: "partial", type: "agentMessage", payload: { text: "" } } });
    const deltas: string[] = [], snapshots: AttachResult[] = [];
    a.onNotification("item/agentMessage/delta", p => deltas.push(p.delta)); a.onSnapshot(s => snapshots.push(s));
    engines[0].emit({ type: "itemDelta", turnId: turn.id, itemId: "partial", kind: "text", text: "before" });
    await until(() => deltas.length === 1);
    const old = a.clientId!; manager.disconnect(old);
    engines[0].emit({ type: "itemDelta", turnId: turn.id, itemId: "partial", kind: "text", text: " offline" });
    engines[0].emit({ type: "itemCompleted", turnId: turn.id, item: { id: "partial", type: "agentMessage", payload: { text: "before offline" }, status: "completed" } });
    engines[0].emit({ type: "itemStarted", turnId: turn.id, item: { id: "missing", type: "agentMessage", payload: { text: "new" } } });
    await until(() => snapshots.length === 1 && a.state === "connected" && a.clientId !== old);
    expect(snapshots[0].items.map(item => item.id)).toEqual(["partial", "missing"]);
    expect(snapshots[0].items[0].payload).toEqual({ text: "before offline" });
    expect(snapshots[0].items[1].status).toBe("inProgress"); expect(deltas).toEqual(["before"]);
    expect(server.log.snapshot(thread.id).items.map(item => item.seq)).toEqual([1, 3, 5]);
  });

  test("approvals created offline reappear in attach snapshots with answerable new wire IDs", async () => {
    const { home, engines, manager, connect } = await setup();
    const a = await connect("a", { reconnect: { minDelayMs: 80, maxDelayMs: 80 } });
    const { thread } = await a.request("thread/start", { backend: "claude", cwd: home });
    const { turn } = await a.request("turn/start", { threadId: thread.id, input: input("offline approval") });
    manager.disconnect(a.clientId!);
    const snapshots: AttachResult[] = []; a.onSnapshot(s => snapshots.push(s));
    engines[0].emit({ type: "itemStarted", turnId: turn.id, item: { id: "command", type: "commandExecution", payload: { command: "pwd", cwd: home } } });
    let decision: unknown;
    engines[0].emit({ type: "approval", request: { method: approval, params: { requestId: "offline", threadId: thread.id, turnId: turn.id, itemId: "command", command: "pwd", cwd: home, startedAtMs: Date.now() } }, respond: result => { decision = result; } });
    await until(() => snapshots.length === 1 && a.pendingRequests.has("offline"));
    expect(snapshots[0].pendingRequests[0].params.requestId).toBe("offline");
    const handle = a.pendingRequests.get("offline")!; const oldId = handle.id;
    manager.disconnect(a.clientId!);
    await until(() => snapshots.length === 2 && a.pendingRequests.get("offline")?.id !== oldId && a.pendingRequests.has("offline"));
    expect(() => handle.respond({ decision: "reject" })).toThrow("disconnected");
    a.pendingRequests.get("offline")!.respond({ decision: "accept" });
    await until(() => decision !== undefined); expect(decision).toEqual({ decision: "accept" });
  });

  test("disconnect detaches, releases leases and keeps the engine alive", async () => {
    const { home, engines, connect, manager } = await setup();
    const a = await connect("a"), b = await connect("b");
    const { thread } = await a.request("thread/start", { backend: "claude", cwd: home });
    await b.request("thread/attach", { threadId: thread.id });
    await a.request("thread/lease/acquire", { threadId: thread.id });
    await expect(b.request("turn/start", { threadId: thread.id, input: input("blocked") })).rejects.toMatchObject({ code: -32012 });
    a.close(); await until(() => manager.size === 1);
    expect(engines[0].closed).toBe(false);
    expect((await b.request("turn/start", { threadId: thread.id, input: input("allowed") })).turn.status).toBe("inProgress");
    await b.request("thread/detach", { threadId: thread.id });
    const items: Item[] = []; b.onNotification("item/started", p => items.push(p.item));
    engines[0].emit({ type: "itemStarted", turnId: engines[0].sent[0].turnId, item: { id: "after-detach", type: "agentMessage", payload: { text: "" } } });
    await b.request("server/health", {}); expect(items).toEqual([]);
  });

  test("wrong token returns -32005 and protocol mismatch returns -32003 then closes", async () => {
    const { raw } = await setup();
    for (const [protocolVersion, token, code] of [["as/1", "wrong", -32005], ["as/2", "test-token", -32003]] as const) {
      const peer = await raw();
      peer.send({ jsonrpc: "2.0", id: "init", method: "initialize", params: { protocolVersion, token, client: { name: "test", version: "1", kind: "test", label: "test" } } });
      await until(() => peer.closed && peer.frames.length > 0);
      expect(peer.frames[0]).toMatchObject({ id: "init", error: { code } });
    }
  });

  test("handshake gates requests; malformed JSON and batch envelopes fail explicitly", async () => {
    const { raw } = await setup(); const peer = await raw();
    peer.send({ jsonrpc: "2.0", id: 1, method: "server/health", params: {} });
    peer.wire.send("{"); peer.send([]);
    peer.send({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "as/1", token: "test-token", client: { name: "test", version: "1", kind: "test", label: "test" } } });
    peer.send({ jsonrpc: "2.0", id: 3, method: "server/health", params: {} });
    peer.send({ jsonrpc: "2.0", method: "initialized", params: {} });
    peer.send({ jsonrpc: "2.0", id: 4, method: "server/health", params: {} });
    await until(() => peer.frames.length === 6);
    expect(peer.frames[0]).toMatchObject({ error: { code: -32002 } });
    expect(peer.frames[1]).toMatchObject({ id: null, error: { code: -32700 } });
    expect(peer.frames[2]).toMatchObject({ id: null, error: { code: -32600 } });
    expect(peer.frames[4]).toMatchObject({ id: 3, error: { code: -32002 } });
    expect(peer.frames[5]).toMatchObject({ id: 4, result: { engines: [] } });
  });

  test("large multibyte item messages survive socket backpressure without truncation", async () => {
    const { home, engines, connect } = await setup(); const a = await connect("a");
    const { thread } = await a.request("thread/start", { backend: "claude", cwd: home });
    const { turn } = await a.request("turn/start", { threadId: thread.id, input: input("large") });
    const text = "中文\n".repeat(128 * 1024), items: Item[] = [];
    a.onNotification("item/completed", p => items.push(p.item));
    engines[0].emit({ type: "itemStarted", turnId: turn.id, item: { id: "large", type: "agentMessage", payload: { text: "" } } });
    engines[0].emit({ type: "itemCompleted", turnId: turn.id, item: { id: "large", type: "agentMessage", payload: { text }, status: "completed" } });
    await until(() => items.some(item => item.id === "large"));
    expect(items.find(item => item.id === "large")!.payload).toEqual({ text });
  });

  test("attach snapshot precedes a delta produced immediately after its read boundary", async () => {
    const { home, engines, server, connect } = await setup(); const a = await connect("a"), b = await connect("b");
    const { thread } = await a.request("thread/start", { backend: "claude", cwd: home });
    const { turn } = await a.request("turn/start", { threadId: thread.id, input: input("race") });
    engines[0].emit({ type: "itemStarted", turnId: turn.id, item: { id: "answer", type: "agentMessage", payload: { text: "before" } } });
    await until(() => server.log.snapshot(thread.id).items.length === 2);
    const snapshot = server.log.snapshot.bind(server.log);
    server.log.snapshot = (...args) => {
      const value = snapshot(...args);
      queueMicrotask(() => server.log.delta(thread.id, "answer", "text", " after"));
      return value;
    };
    let rendered = "", gotDelta = false;
    b.onSnapshot(snapshot => { rendered = (snapshot.items.find(item => item.id === "answer")!.payload as { text: string }).text; });
    b.onNotification("item/agentMessage/delta", p => { rendered += p.delta; gotDelta = true; });
    await b.request("thread/attach", { threadId: thread.id });
    await until(() => gotDelta); expect(rendered).toBe("before after");
  });

  test("an additive AS v1 notification remains observable without dropping the connection", async () => {
    const { home, server, connect } = await setup(); const a = await connect("a");
    const { thread } = await a.request("thread/start", { backend: "claude", cwd: home });
    const frames: Frame[] = []; a.onFrame(frame => frames.push(frame));
    server.log.publish({ jsonrpc: "2.0", method: "thread/futureMetadata", params: { threadId: thread.id } } as unknown as ServerNotification);
    await a.request("server/health", {});
    expect(frames.some(frame => "method" in frame && frame.method === "thread/futureMetadata")).toBe(true);
    expect(a.state).toBe("connected");
  });
});

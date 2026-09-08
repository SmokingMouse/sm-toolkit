import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentServer, type ServerOptions } from "./server.js";
import { MockEngine } from "../engines/mock.js";
import { AgentClient } from "../client/client.js";
import { ConnectionManager, listenUnix, listenWebSocket } from "../transport/index.js";
import { capability, capture, client, input, until } from "../test-helpers.test.js";
import type { ServerRequestResult } from "../protocol/index.js";

// Formal versions of review probe2/3/4/5/6/7. Bug-specific probes live beside their fixes.
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(options: ServerOptions = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "as-review-"))), engines: MockEngine[] = [];
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const server = new AgentServer({ databasePath: ":memory:", allowedRoots: [directory], idleTimeoutMs: 0, engineFactory: backend => { const engine = new MockEngine(undefined, backend); engines.push(engine); return engine; }, ...options });
  cleanup.push(() => server.close());
  const c = await client(server, "phone");
  const start = () => c.request("thread/start", { model: "sonnet", backend: "claude", cwd: directory });
  return { directory, engines, server, c, start };
}
async function running(options: ServerOptions = {}) {
  const f = await fixture(options), { thread } = await f.start();
  const { turn } = await f.c.request("turn/start", { threadId: thread.id, input: input("go") });
  return { ...f, thread, turn, engine: f.engines[0] };
}
async function approval(f: Awaited<ReturnType<typeof running>>, id: string, decisions: ServerRequestResult[]) {
  f.engine.emit({ type: "itemStarted", turnId: f.turn.id, item: { id, type: "commandExecution", payload: { command: "pwd", cwd: f.directory } } });
  f.engine.emit({ type: "approval", request: { method: capability, params: { requestId: id, threadId: f.thread.id, turnId: f.turn.id, itemId: id, command: "pwd", cwd: f.directory, startedAtMs: Date.now() } }, respond: result => { decisions.push(result); } });
  await until(() => f.server.log.pendingRequests(f.thread.id).length === 1);
}

test("Q1: queue capacity has an exact boundary and preserves FIFO", async () => {
  const f = await running({ maxQueuedTurns: 2 });
  const pending = [];
  for (const text of ["q1", "q2"]) pending.push((await f.c.request("turn/start", { threadId: f.thread.id, input: input(text) })).turn.id);
  await expect(f.c.request("turn/start", { threadId: f.thread.id, input: input("overflow") })).rejects.toMatchObject({ code: -32006 });
  expect(f.server.log.queue(f.thread.id).map(t => t.turnId)).toEqual(pending);
  expect(f.engine.sent.map(t => t.turnId)).toEqual([f.turn.id]);
});
test("Q2 / N3: interrupt only targets the running turn, cancel only queued turns", async () => {
  const f = await running();
  const queued = await f.c.request("turn/start", { threadId: f.thread.id, input: input("queued") });
  await expect(f.c.request("turn/interrupt", { threadId: f.thread.id, turnId: queued.turn.id })).rejects.toMatchObject({ code: -32011 });
  await expect(f.c.request("turn/interrupt", { threadId: f.thread.id, turnId: "missing" })).rejects.toMatchObject({ code: -32010 });
  await expect(f.c.request("turn/cancel", { threadId: f.thread.id, turnId: f.turn.id })).rejects.toMatchObject({ code: -32011 });
  expect(f.engine.interrupted).toEqual([]);
  expect(f.server.log.queue(f.thread.id).map(t => t.turnId)).toEqual([queued.turn.id]);
  expect(await f.c.request("thread/interrupt", { threadId: f.thread.id })).toEqual({ interruptedTurnId: f.turn.id });
  await until(() => f.engine.sent.length === 2);
  expect(f.engine.sent[1].turnId).toBe(queued.turn.id);
});
test("Q3: queued and stale steer identities never reach the engine", async () => {
  const f = await running(), queued = await f.c.request("turn/start", { threadId: f.thread.id, input: input("queued") });
  const steer = () => f.c.request("turn/steer", { threadId: f.thread.id, expectedTurnId: queued.turn.id, input: input("late") });
  await expect(steer()).rejects.toMatchObject({ code: -32011 });
  f.engine.emit({ type: "turnCompleted", turnId: f.turn.id, status: "completed" });
  await until(() => f.engine.sent.length === 2);
  f.engine.emit({ type: "turnCompleted", turnId: queued.turn.id, status: "completed" });
  await until(() => f.server.threads.get(f.thread.id).status.type === "idle");
  await expect(steer()).rejects.toMatchObject({ code: -32011 }); expect(f.engine.steered).toEqual([]);
});
test("A1: only attached capable clients get distinct wire IDs and the first answer wins", async () => {
  const f = await running(), web = await client(f.server, "web"), display = await client(f.server, "display", []), unattached = await client(f.server, "unattached");
  for (const c of [web, display]) await c.request("thread/attach", { threadId: f.thread.id });
  const pf = capture(f.c), wf = capture(web), df = capture(display), uf = capture(unattached), decisions: ServerRequestResult[] = [];
  await approval(f, "race", decisions);
  const card = (frames: ReturnType<typeof capture>) => frames.find(n => "method" in n && n.method === capability && "id" in n) as { id: string } | undefined;
  expect(card(df)).toBeUndefined(); expect(card(uf)).toBeUndefined();
  expect(card(pf)).toBeDefined(); expect(card(wf)).toBeDefined(); expect(card(pf)!.id).not.toBe(card(wf)!.id);
  await f.c.respond(card(pf)!.id, { decision: "accept" });
  expect(wf).toContainEqual(expect.objectContaining({ method: "serverRequest/resolved", params: expect.objectContaining({ decidedBy: { clientId: f.c.clientId, label: "phone" } }) }));
  await web.respond(card(wf)!.id, { decision: "reject" });
  expect(wf.at(-1)).toMatchObject({ error: { code: -32014 } }); expect(decisions).toEqual([{ decision: "accept" }]);
});
test("A2: lease excludes start, steer and approval answers but still displays the card", async () => {
  const f = await running(), other = await client(f.server, "other"), decisions: ServerRequestResult[] = [];
  await other.request("thread/attach", { threadId: f.thread.id }); const frames = capture(other);
  await f.c.request("thread/lease/acquire", { threadId: f.thread.id });
  await expect(other.request("turn/start", { threadId: f.thread.id, input: input("x") })).rejects.toMatchObject({ code: -32012 });
  await expect(other.request("turn/steer", { threadId: f.thread.id, expectedTurnId: f.turn.id, input: input("x") })).rejects.toMatchObject({ code: -32012 });
  for (const method of ["thread/lease/acquire", "thread/lease/release"] as const) await expect(other.request(method, { threadId: f.thread.id })).rejects.toMatchObject({ code: -32012 });
  await approval(f, "leased", decisions);
  const card = frames.find(n => "method" in n && n.method === capability && "id" in n) as { id: string };
  expect(card).toBeDefined(); await other.respond(card.id, { decision: "accept" });
  expect(frames.at(-1)).toMatchObject({ error: { code: -32012 } }); expect(decisions).toEqual([]);
  f.c.close(); await other.respond(card.id, { decision: "reject" });
  expect(decisions).toEqual([{ decision: "reject" }]);
});
test("A3: engine death rejects pending approval, fails active turn and freezes queued work", async () => {
  const f = await running(), decisions: ServerRequestResult[] = [];
  const queued = await f.c.request("turn/start", { threadId: f.thread.id, input: input("queued") });
  await approval(f, "death", decisions);
  f.engine.emit({ type: "exit", error: { code: -32004, message: "boom", data: { retryable: true } } });
  await until(() => f.server.threads.get(f.thread.id).status.type === "systemError");
  expect(decisions).toEqual([{ decision: "reject" }]); expect(f.server.log.pendingRequests(f.thread.id)).toEqual([]);
  expect(f.server.log.turn(f.turn.id).status).toBe("failed"); expect(f.server.log.turn(queued.turn.id).status).toBe("queued");
  expect(f.engine.sent).toHaveLength(1);
});
test("R1 / R1b: sequential, concurrent, closed, crashed and unknown native resumes spawn exactly once", async () => {
  const f = await fixture(), { thread } = await f.start(), native = thread.engineThreadId!, other = await client(f.server, "other");
  for (const params of [{ engineThreadId: native }, { threadId: thread.id }]) expect((await f.c.request("thread/resume", params)).attached).toBe(true);
  const joined = await Promise.all([f.c.request("thread/resume", { engineThreadId: native }), other.request("thread/resume", { engineThreadId: native })]);
  expect(joined.every(r => r.attached && r.thread.id === thread.id)).toBe(true); expect(f.engines).toHaveLength(1);
  await f.c.request("thread/close", { threadId: thread.id });
  expect((await f.c.request("thread/resume", { threadId: thread.id })).attached).toBe(false);
  expect(f.engines[1].options?.engineThreadId).toBe(native);
  f.engines[1].emit({ type: "exit", error: { code: -32004, message: "crashed", data: { retryable: true } } });
  await until(() => f.server.threads.get(thread.id).status.type === "systemError");
  expect((await f.c.request("thread/resume", { threadId: thread.id })).attached).toBe(false); expect(f.engines).toHaveLength(3);
  const imported = await Promise.all([f.c, other].map(c => c.request("thread/resume", { model: "sonnet", engineThreadId: "ghost", backend: "claude", cwd: f.directory })));
  expect(imported[0].thread.id).toBe(imported[1].thread.id); expect(imported.map(r => r.attached).sort()).toEqual([false, true]); expect(f.engines).toHaveLength(4);
});
test("R2: thread and turn keys deduplicate identical payloads and reject divergence", async () => {
  const f = await fixture(), params = { backend: "claude" as const, model: "sonnet", cwd: f.directory, clientThreadId: "key" };
  const first = await f.c.request("thread/start", params), second = await f.c.request("thread/start", params);
  expect(second).toMatchObject({ deduplicated: true, thread: { id: first.thread.id } });
  await expect(f.c.request("thread/start", { ...params, backend: "codex" })).rejects.toMatchObject({ code: -32013 });
  const p = { threadId: first.thread.id, input: input("a"), clientTurnId: "turn-key" };
  const a = await f.c.request("turn/start", p), b = await f.c.request("turn/start", p);
  expect(b).toMatchObject({ deduplicated: true, turn: { id: a.turn.id } });
  await expect(f.c.request("turn/start", { ...p, input: input("b") })).rejects.toMatchObject({ code: -32013 });
  expect(f.engines).toHaveLength(1); expect(f.engines[0].sent).toHaveLength(1);
});
test("S1: both transports reject missing/wrong token and accept the correct token", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "as-auth-")));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const server = new AgentServer({ databasePath: ":memory:", token: "secret", allowedRoots: [directory], idleTimeoutMs: 0 }); cleanup.push(() => server.close());
  const manager = new ConnectionManager(server), unix = listenUnix(manager, { path: join(directory, "sock") }), ws = listenWebSocket(manager);
  cleanup.push(() => { unix.close(); ws.close(); });
  for (const endpoint of [{ transport: "unix" as const, path: unix.path }, { transport: "ws" as const, url: ws.url }]) for (const token of [undefined, "wrong", "secret"]) {
    const c = new AgentClient(endpoint, { token, reconnect: false });
    try {
      if (token === "secret") { await c.connect(); expect(c.state).toBe("connected"); }
      else { await expect(c.connect()).rejects.toMatchObject({ code: -32005 }); expect(c.state).toBe("closed"); }
    } finally { c.close(); }
  }
});
test("S2: allowed_roots rejects sibling-prefix, traversal, symlink escape and filesystem root", async () => {
  const f = await fixture(), root = join(f.directory, "allowed"), sibling = join(f.directory, "allowed-evil");
  mkdirSync(root); mkdirSync(sibling); const inside = join(root, "inside"); mkdirSync(inside); const link = join(root, "escape"); symlinkSync(sibling, link);
  const server = new AgentServer({ databasePath: ":memory:", allowedRoots: [root], engineFactory: () => new MockEngine(), idleTimeoutMs: 0 }); cleanup.push(() => server.close()); const c = await client(server);
  for (const cwd of [sibling, `${root}/../allowed-evil`, link, "/", "/etc"]) await expect(c.request("thread/start", { model: "sonnet", backend: "claude", cwd })).rejects.toMatchObject({ code: -32005 });
  expect((await c.request("thread/start", { model: "sonnet", backend: "claude", cwd: inside })).thread.cwd).toBe(inside);
});
test("N4: asc and desc pagination exhaust exactly the same seven identities", async () => {
  const f = await running();
  for (let i = 0; i < 6; i++) {
    const item = { id: `answer-${i}`, type: "agentMessage" as const, payload: { text: String(i) } };
    f.engine.emit({ type: "itemStarted", turnId: f.turn.id, item }); f.engine.emit({ type: "itemCompleted", turnId: f.turn.id, item });
  }
  await until(() => f.server.log.snapshot(f.thread.id).items.filter(i => i.status === "completed").length === 7);
  const results: string[][] = [];
  for (const direction of ["asc", "desc"] as const) {
    const ids: string[] = []; let cursor: string | undefined;
    do {
      const page = await f.c.request("thread/items/list", { threadId: f.thread.id, direction, limit: 3, cursor });
      ids.push(...page.items.map(i => i.id)); cursor = page.nextCursor ?? undefined;
      expect(ids.length).toBeLessThanOrEqual(7);
    } while (cursor);
    expect(ids).toHaveLength(7); expect(new Set(ids).size).toBe(7); results.push(ids);
  }
  expect(results[1]).toEqual(results[0].toReversed());
});
test("N5: idle sweep preserves completed history and closes the engine", async () => {
  const f = await running({ idleTimeoutMs: 10 });
  f.engine.emit({ type: "turnCompleted", turnId: f.turn.id, status: "completed" });
  await until(() => f.server.threads.get(f.thread.id).status.type === "closed");
  expect(f.engine.closed).toBe(true); expect(f.server.log.snapshot(f.thread.id).items).toHaveLength(1);
  await expect(f.c.request("turn/start", { threadId: f.thread.id, input: input("closed") })).rejects.toMatchObject({ code: -32007 });
});
test("C3: capabilities describe implemented backends and AS v2 fails closed", async () => {
  const f = await fixture(), c = f.server.connectInProcess();
  const init = await c.request("initialize", { protocolVersion: "as/1", client: { name: "test", kind: "test", version: "1", label: "test" } });
  expect(init.capabilities).toMatchObject({ backends: ["claude", "codex"], externalProviders: false, maxQueuedTurns: 8 });
  expect((await f.c.request("server/config/read", {})).allowed_roots).toEqual([f.directory]);
  await expect(f.c.request("thread/start", { model: "sonnet", backend: "external", cwd: f.directory })).rejects.toMatchObject({ code: -32008 });
  const future = f.server.connectInProcess();
  await expect(future.request("initialize", { protocolVersion: "as/2", client: { name: "test", kind: "test", version: "1", label: "test" } })).rejects.toMatchObject({ code: -32003 });
  expect(future.closed).toBe(true);
});

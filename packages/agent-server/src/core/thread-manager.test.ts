import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentServer, ErrorCode, MockEngine, ProtocolError } from "../index.js";
import { capture, client, flush, input, setup, until } from "../test-helpers.test.js";

const servers: AgentServer[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); });
const create = (options = {}) => { const fixture = setup(options); servers.push(fixture.server); return fixture; };
describe("ThreadManager", () => {
  test("R1c: importing an unknown native thread requires explicit cwd", async () => {
    const { server, engines } = create(); const c = await client(server);
    await expect(c.request("thread/resume", { engineThreadId: "unknown", backend: "claude" })).rejects.toMatchObject({ code: -32602 });
    expect(engines).toHaveLength(0); expect(server.log.allThreads()).toHaveLength(0);
    const imported = await c.request("thread/resume", { engineThreadId: "unknown", backend: "claude", cwd: process.cwd() });
    expect(imported.attached).toBe(false);
    const resumed = await c.request("thread/resume", { threadId: imported.thread.id });
    expect(resumed.attached).toBe(true); expect(resumed.thread.cwd).toBe(imported.thread.cwd);
    expect(engines).toHaveLength(1);
  });
  test("concurrent resume by engine ID attaches to one live process", async () => {
    const { server, engines } = create(); const c = await client(server); const d = await client(server, "second");
    const { thread } = await c.request("thread/start", { backend: "claude", cwd: process.cwd() });
    const results = await Promise.all([d.request("thread/resume", { engineThreadId: thread.engineThreadId! }), c.request("thread/resume", { threadId: thread.id })]);
    expect(results.every(r => r.attached && r.thread.id === thread.id)).toBe(true); expect(engines).toHaveLength(1); expect(engines[0].attachCount).toBe(2);
    expect(server.threads.engineThreads.get(thread.engineThreadId!)).toBe(thread.id);
  });
  test("two simultaneous imports of an unknown engine ID spawn once", async () => {
    const { server, engines } = create(); const a = await client(server), b = await client(server);
    const [first, second] = await Promise.all([a.request("thread/resume", { engineThreadId: "existing-session", cwd: process.cwd() }), b.request("thread/resume", { engineThreadId: "existing-session", cwd: process.cwd() })]);
    expect(first.thread.id).toBe(second.thread.id); expect([first.attached, second.attached].sort()).toEqual([false, true]); expect(engines).toHaveLength(1);
  });
  test("close retains history and resume spawns with engine session ID", async () => {
    const { server, engines } = create(); const c = await client(server); const { thread } = await c.request("thread/start", { backend: "claude", cwd: process.cwd() });
    await c.request("turn/start", { threadId: thread.id, input: input("history") });
    await c.request("thread/close", { threadId: thread.id });
    expect(server.log.snapshot(thread.id).items).toHaveLength(1); expect(server.threads.engineThreads.size).toBe(0);
    const resumed = await c.request("thread/resume", { threadId: thread.id });
    expect(resumed.attached).toBe(false); expect(engines).toHaveLength(2); expect(engines[1].options?.engineThreadId).toBe(thread.engineThreadId);
  });
  test("metadata is persisted before notification", async () => {
    const { server, engines } = create(); const c = await client(server); const frames = capture(c);
    const { thread } = await c.request("thread/start", { backend: "claude", cwd: process.cwd() });
    expect(thread.engineThreadId).toBe(engines[0].engineThreadId);
    expect(frames.some(f => "method" in f && f.method === "thread/metadata/updated")).toBe(true);
    expect(server.log.findEngine(thread.engineThreadId!)?.id).toBe(thread.id);
  });
  test("default fork uses native resume + forkSession; fromItemId returns -32008", async () => {
    const { server, engines } = create(); const c = await client(server); const { thread } = await c.request("thread/start", { backend: "claude", cwd: process.cwd() });
    const fork = await c.request("thread/fork", { threadId: thread.id, clientThreadId: "fork-key" });
    expect(engines[1].options?.forkSession).toBe(true); expect(engines[1].options?.engineThreadId).toBe(thread.engineThreadId); expect(fork.thread.engineThreadId).not.toBe(thread.engineThreadId);
    expect((await c.request("thread/fork", { threadId: thread.id, clientThreadId: "fork-key" })).deduplicated).toBe(true);
    await expect(c.request("thread/fork", { threadId: thread.id, fromItemId: "item" })).rejects.toMatchObject({ code: ErrorCode.unsupported_capability }); expect(engines).toHaveLength(2);
  });
  test("spawn failure leaves systemError row and can be resumed", async () => {
    const engines: MockEngine[] = [];
    const { server } = create({ engineFactory: () => { const e = new MockEngine(); if (!engines.length) e.spawn = async () => { throw new ProtocolError(ErrorCode.engine_unavailable, "handshake failed"); }; engines.push(e); return e; } });
    const c = await client(server);
    await expect(c.request("thread/start", { backend: "claude", cwd: process.cwd(), clientThreadId: "failed" })).rejects.toMatchObject({ code: ErrorCode.engine_unavailable });
    const [thread] = server.log.allThreads(); expect(thread.status.type).toBe("systemError"); expect(server.threads.live.size).toBe(0);
    expect((await c.request("thread/resume", { threadId: thread.id })).thread.status.type).toBe("idle");
  });
  test("restart fails abandoned running turn and preserves queued turns for resume", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "as-restart-")), "test.db");
    const first = setup({ databasePath: path }); const c = await client(first.server); const { thread } = await c.request("thread/start", { backend: "claude", cwd: process.cwd() });
    const active = await c.request("turn/start", { threadId: thread.id, input: input("one") });
    const queued = await c.request("turn/start", { threadId: thread.id, input: input("two") });
    // A second owner sees a persisted crash image; no real engine is involved.
    const second = create({ databasePath: path });
    expect(second.server.threads.get(thread.id).status.type).toBe("systemError"); expect(second.server.log.turn(active.turn.id).status).toBe("failed");
    const d = await client(second.server); await d.request("thread/resume", { threadId: thread.id }); await flush();
    expect(second.engines[0].sent[0].turnId).toBe(queued.turn.id);
    await first.server.close();
  });
  test("idle timeout closes engine without dropping items", async () => {
    const { server, engines } = create({ idleTimeoutMs: 20 }); const c = await client(server); const { thread } = await c.request("thread/start", { backend: "claude", cwd: process.cwd() });
    await until(() => server.threads.get(thread.id).status.type === "closed"); expect(engines[0].closed).toBe(true);
  });
});

describe("TurnQueue", () => {
  test("FIFO, one running turn, full queue and complete queue notifications", async () => {
    const { server, engines } = create({ maxQueuedTurns: 2 }); const c = await client(server); const frames = capture(c); const { thread } = await c.request("thread/start", { backend: "claude", cwd: process.cwd() });
    const turns = [];
    for (const text of ["first", "second", "third"]) turns.push((await c.request("turn/start", { threadId: thread.id, input: input(text) })).turn);
    await expect(c.request("turn/start", { threadId: thread.id, input: input("fourth") })).rejects.toMatchObject({ code: ErrorCode.thread_busy });
    expect(turns.map(t => t.status)).toEqual(["inProgress", "queued", "queued"]); expect(engines[0].sent).toHaveLength(1);
    engines[0].emit({ type: "turnCompleted", turnId: turns[0].id, status: "completed" }); await until(() => engines[0].sent.length === 2);
    expect(engines[0].sent.map(t => t.turnId)).toEqual(turns.slice(0, 2).map(t => t.id));
    expect(server.log.queue(thread.id).map(t => [t.turnId, t.position])).toEqual([[turns[2].id, 0]]);
    const queues = frames.filter(f => "method" in f && f.method === "thread/queue/changed"); expect(queues.length).toBeGreaterThan(4);
  });
  test("default maxQueuedTurns is 8", async () => {
    const { server } = create(); const c = await client(server); const { thread } = await c.request("thread/start", { backend: "claude", cwd: process.cwd() });
    for (let i = 0; i < 9; i++) await c.request("turn/start", { threadId: thread.id, input: input(String(i)) });
    await expect(c.request("turn/start", { threadId: thread.id, input: input("full") })).rejects.toMatchObject({ code: -32006 });
  });
  test("steer requires current turn, does not queue, and idle steer fails", async () => {
    const { server, engines } = create(); const c = await client(server); const { thread } = await c.request("thread/start", { backend: "claude", cwd: process.cwd() });
    await expect(c.request("turn/steer", { threadId: thread.id, expectedTurnId: "wrong", input: input("hi") })).rejects.toMatchObject({ code: -32011 });
    const { turn } = await c.request("turn/start", { threadId: thread.id, input: input("one") });
    await c.request("turn/steer", { threadId: thread.id, expectedTurnId: turn.id, input: input("steer") });
    expect(engines[0].steered).toHaveLength(1); expect(server.log.queue(thread.id)).toEqual([]); expect(server.log.snapshot(thread.id).items).toHaveLength(2);
  });
  test("steer rechecks turn after pending dispatch (TOCTOU)", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const e = new MockEngine(); e.sendTurn = async () => gate;
    const { server } = create({ engineFactory: () => e }); const c = await client(server); const { thread } = await c.request("thread/start", { backend: "claude", cwd: process.cwd() });
    const { turn } = await c.request("turn/start", { threadId: thread.id, input: input("first") });
    const steering = server.threads.queue(thread.id).steer({ threadId: thread.id, expectedTurnId: turn.id, input: input("late") });
    server.threads.queue(thread.id).complete(turn.id, "completed"); release();
    await expect(steering).rejects.toMatchObject({ code: -32011 }); expect(e.steered).toHaveLength(0);
  });
  test("interrupt preserves queue; cancel only queued turns and creates no user item", async () => {
    const { server, engines } = create(); const c = await client(server); const { thread } = await c.request("thread/start", { backend: "claude", cwd: process.cwd() });
    const turns = [];
    for (const text of ["one", "two", "cancel"]) turns.push((await c.request("turn/start", { threadId: thread.id, input: input(text) })).turn);
    await expect(c.request("turn/cancel", { threadId: thread.id, turnId: turns[0].id })).rejects.toMatchObject({ code: -32011 });
    await c.request("turn/cancel", { threadId: thread.id, turnId: turns[2].id });
    await c.request("turn/interrupt", { threadId: thread.id, turnId: turns[0].id }); await until(() => engines[0].sent.length === 2);
    expect(server.log.turn(turns[0].id).status).toBe("interrupted"); expect(server.log.turn(turns[2].id).status).toBe("cancelled");
    expect(server.log.snapshot(thread.id).items.some(i => i.turnId === turns[2].id)).toBe(false); expect(engines[0].sent[1].turnId).toBe(turns[1].id);
  });
  test("engine death freezes FIFO queue, fails active and resume drains the next turn", async () => {
    const { server, engines } = create(); const c = await client(server); const { thread } = await c.request("thread/start", { backend: "claude", cwd: process.cwd() });
    const first = await c.request("turn/start", { threadId: thread.id, input: input("one") }); const second = await c.request("turn/start", { threadId: thread.id, input: input("two") });
    engines[0].emit({ type: "exit" }); await until(() => server.threads.get(thread.id).status.type === "systemError");
    expect(server.log.turn(first.turn.id).status).toBe("failed"); expect(server.log.queue(thread.id)[0].turnId).toBe(second.turn.id); expect(engines[0].sent).toHaveLength(1);
    await c.request("thread/resume", { threadId: thread.id }); await until(() => engines[1].sent.length === 1); expect(engines[1].sent[0].turnId).toBe(second.turn.id);
  });
  test("sendTurn rejection removes live registration and resume restarts", async () => {
    const engines: MockEngine[] = [];
    const { server } = create({ engineFactory: () => { const e = new MockEngine(); if (!engines.length) e.sendTurn = async () => { throw new Error("broken stdin"); }; engines.push(e); return e; } });
    const c = await client(server); const { thread } = await c.request("thread/start", { backend: "claude", cwd: process.cwd() }); await c.request("turn/start", { threadId: thread.id, input: input("one") });
    await until(() => server.threads.get(thread.id).status.type === "systemError"); expect(server.threads.live.has(thread.id)).toBe(false);
    expect((await c.request("thread/resume", { threadId: thread.id })).attached).toBe(false);
  });
});

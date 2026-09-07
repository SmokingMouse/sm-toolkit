import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentServer, MockEngine, type Item } from "../index.js";
import { client, input, until } from "../test-helpers.test.js";
import type { EngineItem } from "../engines/session.js";

const servers: AgentServer[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); });
function fixture(databasePath = ":memory:") {
  const engines: MockEngine[] = [];
  const server = new AgentServer({ databasePath, idleTimeoutMs: 0, allowedRoots: [process.cwd()], engineFactory: backend => {
    const engine = new MockEngine(undefined, backend); engines.push(engine); return engine;
  } });
  servers.push(server); return { server, engines };
}
const withoutTurn = ({ turnId: _, ...item }: Item) => item;

for (const backend of ["claude", "codex"] as const) describe(`midfork ${backend}`, () => {
  test("P2-2: nested native forks retain only prefix checkpoints; seeded forks report fallback without copying coordinates", async () => {
    const { server, engines } = fixture(), c = await client(server);
    const { thread } = await c.request("thread/start", { backend, cwd: process.cwd() });
    const first = await c.request("turn/start", { threadId: thread.id, input: input("first") });
    engines[0].emit({ type: "turnCompleted", turnId: first.turn.id, status: "completed", forkPoint: "point-1" });
    await until(() => server.threads.get(thread.id).status.type === "idle");
    const itemId = server.log.snapshot(thread.id).items.at(-1)!.id;
    const second = await c.request("turn/start", { threadId: thread.id, input: input("second") });
    engines[0].emit({ type: "turnCompleted", turnId: second.turn.id, status: "completed", forkPoint: "point-2" });
    await until(() => server.threads.get(thread.id).status.type === "idle");
    const suffixId = server.log.snapshot(thread.id).items.at(-1)!.id;
    const branch = await c.request("thread/fork", { threadId: thread.id, fromItemId: itemId });
    expect(server.log.forkPoint(branch.thread.id, itemId)).toBe("point-1");
    expect(server.log.forkPoint(branch.thread.id, suffixId)).toBeUndefined();
    await c.request("thread/fork", { threadId: branch.thread.id, fromItemId: itemId });
    expect(engines[2].options).toMatchObject({ forkSession: true, forkPoint: "point-1", engineThreadId: branch.thread.engineThreadId });
    expect(engines[2].options?.seedHistory).toBeUndefined();
    await c.request("turn/start", { threadId: thread.id, input: input("unmapped") });
    const events: unknown[] = [];
    const seeded = await server.threads.fork({ threadId: thread.id }, created => {
      server.log.subscribe(created.id, event => { if (event.method === "thread/engineEvent") events.push(event.params); });
    });
    expect(engines[3].options?.seedHistory).toHaveLength(3);
    expect(server.log.forkPoint(seeded.thread.id, itemId)).toBeUndefined();
    expect(server.log.forkPoint(seeded.thread.id, suffixId)).toBeUndefined();
    expect(events).toContainEqual({ threadId: seeded.thread.id, backend, subtype: "fork/seeded", payload: {
      reason: "native_checkpoint_unavailable", sourceThreadId: thread.id, itemId: seeded.thread.forkedFrom!.itemId,
    } });
  });

  test("inclusive middle snapshot preserves source, cursors and independent continuation", async () => {
    const { server, engines } = fixture(), c = await client(server);
    const { thread } = await c.request("thread/start", { backend, cwd: process.cwd() });
    const { turn } = await c.request("turn/start", { threadId: thread.id, input: input("first") });
    const answer: EngineItem = { id: "middle", type: "agentMessage", payload: { text: "answer" } };
    server.log.startItem(thread.id, turn.id, answer); server.log.updateItem(thread.id, answer, true);
    engines[0].emit({ type: "turnCompleted", turnId: turn.id, status: "completed" });
    await until(() => server.threads.get(thread.id).status.type === "idle");
    const second = await c.request("turn/start", { threadId: thread.id, input: input("excluded suffix") });
    const before = server.log.snapshot(thread.id), beforeTurns = server.log.turns(thread.id);
    const fork = await c.request("thread/fork", { threadId: thread.id, fromItemId: "middle", clientThreadId: "fork" });
    const copied = server.log.snapshot(fork.thread.id), prefix = before.items.slice(0, 2);
    expect(fork.thread.forkedFrom).toEqual({ threadId: thread.id, itemId: "middle" });
    expect(copied.items.map(withoutTurn)).toEqual(prefix.map(withoutTurn));
    expect(copied.items[0].turnId).not.toBe(turn.id);
    expect(new Set(copied.items.map(item => item.turnId)).size).toBe(1);
    expect(copied.nextSeq).toBe(Math.max(...prefix.flatMap(item => [item.seq, item.completedSeq ?? 0])) + 1);
    expect(copied.queue).toEqual([]); expect(copied.pendingRequests).toEqual([]);
    expect(server.log.snapshot(thread.id)).toEqual(before); expect(server.log.turns(thread.id)).toEqual(beforeTurns);
    expect(engines[1].options?.seedHistory).toEqual(prefix);
    expect(engines[1].options?.engineThreadId).toBeUndefined();
    expect((await c.request("thread/items/list", { threadId: fork.thread.id })).items).toEqual(copied.items);
    const branchTurn = await c.request("turn/start", { threadId: fork.thread.id, input: input("branch only") });
    expect(branchTurn.turn.ordinal).toBe(2); expect(engines[1].sent[0].input).toEqual(input("branch only"));
    expect(server.log.snapshot(fork.thread.id).items.at(-1)?.seq).toBe(copied.nextSeq);
    expect(server.log.snapshot(thread.id)).toEqual(before);
    engines[0].emit({ type: "turnCompleted", turnId: second.turn.id, status: "completed" });
    engines[1].emit({ type: "turnCompleted", turnId: branchTurn.turn.id, status: "completed" });
    await until(() => server.threads.get(thread.id).status.type === "idle" && server.threads.get(fork.thread.id).status.type === "idle");
    const sourceTurn = await c.request("turn/start", { threadId: thread.id, input: input("source only") });
    expect(engines[0].sent.at(-1)?.turnId).toBe(sourceTurn.turn.id);
    expect(server.log.snapshot(fork.thread.id).items.some(item => JSON.stringify(item.payload).includes("source only"))).toBe(false);
    expect((await c.request("thread/attach", { threadId: fork.thread.id, sinceSeq: copied.nextSeq - 1 })).items.every(item => item.seq >= copied.nextSeq)).toBe(true);
    const count = engines.length;
    expect((await c.request("thread/fork", { threadId: thread.id, fromItemId: "middle", clientThreadId: "fork" })).thread.id).toBe(fork.thread.id);
    expect(engines).toHaveLength(count);
    await expect(c.request("thread/fork", { threadId: thread.id, fromItemId: "absent" })).rejects.toMatchObject({ code: -32602 });
    expect(engines).toHaveLength(count);
  });

  test("native checkpoint survives restart and does not include later source turns", async () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), "as-midfork-")), "db");
    const first = fixture(databasePath), c = await client(first.server);
    const { thread } = await c.request("thread/start", { backend, cwd: process.cwd() });
    const { turn } = await c.request("turn/start", { threadId: thread.id, input: input("checkpoint") });
    first.engines[0].emit({ type: "turnCompleted", turnId: turn.id, status: "completed", forkPoint: "native-checkpoint" });
    await until(() => first.server.threads.get(thread.id).status.type === "idle");
    const itemId = first.server.log.snapshot(thread.id).items.at(-1)!.id;
    await c.request("turn/start", { threadId: thread.id, input: input("suffix") });
    await first.server.close(); servers.splice(servers.indexOf(first.server), 1);
    const second = fixture(databasePath), d = await client(second.server);
    const { thread: fork } = await d.request("thread/fork", { threadId: thread.id, fromItemId: itemId });
    expect(second.engines[0].options).toMatchObject({ forkSession: true, forkPoint: "native-checkpoint", engineThreadId: thread.engineThreadId });
    expect(second.server.log.snapshot(fork.id).items.map(item => item.id)).toEqual([itemId]);
    expect(fork.engineThreadId).not.toBe(thread.engineThreadId);
    expect((await d.request("thread/read", { threadId: fork.id })).thread.forkedFrom).toEqual({ threadId: thread.id, itemId });
  });

  test("default fork snapshots tip; empty source has null lineage item and cursor 1", async () => {
    const { server, engines } = fixture(), c = await client(server);
    const { thread } = await c.request("thread/start", { backend, cwd: process.cwd() });
    const empty = await c.request("thread/fork", { threadId: thread.id });
    expect(empty.thread.forkedFrom).toEqual({ threadId: thread.id, itemId: null });
    expect(server.log.snapshot(empty.thread.id)).toMatchObject({ items: [], nextSeq: 1 });
    expect(engines[1].options?.forkSession).not.toBe(true);
    expect(engines[1].options?.seedHistory).toEqual([]);
    await c.request("turn/start", { threadId: thread.id, input: input("live tip") });
    const before = server.log.snapshot(thread.id);
    const live = await c.request("thread/fork", { threadId: thread.id });
    expect(live.thread.forkedFrom?.itemId).toBe(before.items.at(-1)!.id);
    expect(engines[2].options?.forkSession).not.toBe(true);
    expect(server.log.snapshot(live.thread.id).items.map(withoutTurn)).toEqual(before.items.map(withoutTurn));
  });
});

test("midfork: idle tip without native coordinate seeds its captured prefix despite concurrent append", async () => {
  const { server, engines } = fixture(), c = await client(server);
  const { thread } = await c.request("thread/start", { backend: "claude", cwd: process.cwd() });
  const { turn } = await c.request("turn/start", { threadId: thread.id, input: input("captured") });
  engines[0].emit({ type: "turnCompleted", turnId: turn.id, status: "completed" });
  await until(() => server.threads.get(thread.id).status.type === "idle");
  const before = server.log.snapshot(thread.id).items;
  const forkJob = server.threads.fork({ threadId: thread.id });
  await c.request("turn/start", { threadId: thread.id, input: input("arrived after fork") });
  const fork = await forkJob;
  expect(engines[1].options?.engineThreadId).toBeUndefined();
  expect(engines[1].options?.forkSession).not.toBe(true);
  expect(engines[1].options?.seedHistory).toEqual(before);
  expect(server.log.snapshot(fork.thread.id).items.map(withoutTurn)).toEqual(before.map(withoutTurn));
});

test("midfork: every item kind is a valid boundary and live payload is frozen", async () => {
  const { server, engines } = fixture(), c = await client(server);
  const { thread } = await c.request("thread/start", { backend: "claude", cwd: process.cwd() });
  const { turn } = await c.request("turn/start", { threadId: thread.id, input: input("user") });
  const drafts: EngineItem[] = [
    { id: "a", type: "agentMessage", payload: { text: "partial" } },
    { id: "r", type: "reasoning", payload: { text: "visible reasoning" } },
    { id: "cmd", type: "commandExecution", payload: { command: "pwd", cwd: process.cwd(), aggregatedOutput: "partial" } },
    { id: "file", type: "fileChange", payload: { changes: [], status: "inProgress" } },
    { id: "tool", type: "toolCall", payload: { name: "read", input: {} } },
    { id: "mcp", type: "mcpToolCall", payload: { server: "server", tool: "tool", arguments: {} } },
    { id: "sub", type: "subAgent", payload: { kind: "agent", parentItemId: "tool", phase: "running" } },
    { id: "web", type: "webSearch", payload: { query: "q" } },
    { id: "image", type: "imageOutput", payload: { paths: [] } },
    { id: "plan", type: "plan", payload: { text: "plan" } },
    { id: "compact", type: "contextCompaction", payload: {} },
    { id: "err", type: "error", payload: { message: "error", retryable: false } },
  ];
  for (const draft of drafts) server.log.startItem(thread.id, turn.id, draft);
  const original = server.log.snapshot(thread.id);
  for (let index = 0; index < original.items.length; index++) {
    const item = original.items[index];
    const { thread: fork } = await c.request("thread/fork", { threadId: thread.id, fromItemId: item.id });
    expect(server.log.snapshot(fork.id).items.map(withoutTurn)).toEqual(original.items.slice(0, index + 1).map(withoutTurn));
  }
  const branch = server.log.allThreads().find(t => t.forkedFrom?.itemId === "a")!;
  server.log.delta(thread.id, "a", "text", " added later");
  expect(server.log.item(branch.id, "a").payload).toEqual({ text: "partial" });
  expect(engines[2].options?.seedHistory?.at(-1)?.payload).toEqual({ text: "partial" });
  const other = await c.request("thread/start", { backend: "claude", cwd: process.cwd() });
  await expect(c.request("thread/fork", { threadId: other.thread.id, fromItemId: "a" })).rejects.toMatchObject({ code: -32602 });
});

for (const status of ["failed", "interrupted"] as const) test(`P2-1: seeded Claude ${status} first turn preserves replay guard until completed`, async () => {
  const { server, engines } = fixture(), c = await client(server);
  const { thread } = await c.request("thread/start", { backend: "claude", cwd: process.cwd() });
  await c.request("turn/start", { threadId: thread.id, input: input("prefix") });
  const { thread: fork } = await c.request("thread/fork", { threadId: thread.id });
  const { turn } = await c.request("turn/start", { threadId: fork.id, input: input("unsuccessful") });
  engines[1].emit({ type: "turnCompleted", turnId: turn.id, status });
  await until(() => server.log.turn(turn.id, fork.id).status === status);
  expect(server.log.options(fork.id)).toHaveProperty("seedHistory");
  await c.request("thread/close", { threadId: fork.id });
  await c.request("thread/resume", { threadId: fork.id });
  expect(engines[2].options?.seedHistory?.length).toBe(1);
  expect(engines[2].options?.engineThreadId).toBeUndefined();
  const next = await c.request("turn/start", { threadId: fork.id, input: input("successful") });
  engines[2].emit({ type: "turnCompleted", turnId: next.turn.id, status: "completed" });
  await until(() => server.log.turn(next.turn.id, fork.id).status === "completed");
  expect(server.log.options(fork.id)).not.toHaveProperty("seedHistory");
  const native = server.threads.get(fork.id).engineThreadId;
  await c.request("thread/close", { threadId: fork.id });
  await c.request("thread/resume", { threadId: fork.id });
  expect(engines[3].options?.seedHistory).toBeUndefined();
  expect(engines[3].options?.engineThreadId).toBe(native);
});

test("midfork: seeded Claude close/resume before first turn recreates seed, after turn resumes native", async () => {
  const { server, engines } = fixture(), c = await client(server);
  const { thread } = await c.request("thread/start", { backend: "claude", cwd: process.cwd() });
  await c.request("turn/start", { threadId: thread.id, input: input("prefix") });
  const { thread: fork } = await c.request("thread/fork", { threadId: thread.id });
  await c.request("thread/close", { threadId: fork.id });
  await c.request("thread/resume", { threadId: fork.id });
  expect(engines[2].options?.seedHistory?.length).toBe(1); expect(engines[2].options?.engineThreadId).toBeUndefined();
  const { turn } = await c.request("turn/start", { threadId: fork.id, input: input("continue") });
  engines[2].emit({ type: "turnCompleted", turnId: turn.id, status: "completed" });
  await until(() => server.threads.get(fork.id).status.type === "idle");
  const native = server.threads.get(fork.id).engineThreadId;
  await c.request("thread/close", { threadId: fork.id }); await c.request("thread/resume", { threadId: fork.id });
  expect(engines[3].options?.seedHistory).toBeUndefined(); expect(engines[3].options?.engineThreadId).toBe(native);
  expect(server.log.snapshot(fork.id).items).toHaveLength(2);
});

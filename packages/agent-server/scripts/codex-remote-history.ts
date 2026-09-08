import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

// Companion to the PTY smoke. Real native WebSocket, read views and AS fork;
// keeps its own wire evidence separate from the official TUI's connection.
const [url, threadId, output] = process.argv.slice(2) as [string, string, string];
const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${process.env.SMOKE_BEARER}` } });
const wire: any[] = [], pending = new Map<number, (frame: any) => void>();
let sequence = 0;
socket.onmessage = event => { const frame = JSON.parse(String(event.data)); wire.push({ direction: "in", ...frame }); pending.get(frame.id)?.(frame); };
await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("history socket failed")); });
async function request(method: string, params: any = {}, allowError = false): Promise<any> {
  const id = ++sequence, frame = { id, method, params }; wire.push({ direction: "out", ...frame });
  const response = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`history timeout: ${method}`)); }, 20000);
    pending.set(id, frame => { clearTimeout(timer); pending.delete(id); resolve(frame); }); socket.send(JSON.stringify(frame));
  });
  if (allowError) return response;
  assert.equal(response.error, undefined, JSON.stringify(response.error)); return response.result;
}
try {
  await request("initialize", { clientInfo: { name: "history-probe", version: "0.153.4" }, capabilities: { experimentalApi: true } });
  socket.send(JSON.stringify({ method: "initialized" }));
  const full = (await request("thread/read", { threadId, includeTurns: true })).thread;
  const expected = full.turns.flatMap((turn: any) => turn.items.map((item: any) => ({ turnId: turn.id, item })));
  assert.ok(expected.length >= 200, `only ${expected.length} native items`);
  let pageCount = 0;
  for (const sortDirection of ["asc", "desc"]) {
    const items: any[] = []; let cursor: string | null = null;
    do {
      const page = await request("thread/items/list", { threadId, sortDirection, limit: 17, cursor });
      assert.deepEqual(Object.keys(page).sort(), ["backwardsCursor", "data", "nextCursor"]);
      assert.ok(page.data.length <= 17); assert.ok(page.backwardsCursor);
      const reverse = await request("thread/items/list", { threadId, sortDirection: sortDirection === "asc" ? "desc" : "asc", limit: 1, cursor: page.backwardsCursor });
      assert.deepEqual(reverse.data, [page.data[0]]);
      items.push(...page.data); cursor = page.nextCursor; pageCount++;
    } while (cursor);
    assert.deepEqual(items, sortDirection === "asc" ? expected : [...expected].reverse());
  }
  assert.equal((await request("thread/items/list", { threadId })).data.length, 25);
  assert.equal((await request("thread/items/list", { threadId, limit: 1000 })).data.length, 100);
  const first = await request("thread/items/list", { threadId, limit: 0 });
  assert.equal(first.data.length, 1);
  const empty = await request("thread/items/list", { threadId, sortDirection: "desc", cursor: first.nextCursor });
  assert.deepEqual(empty, { data: [], nextCursor: null, backwardsCursor: null });
  const resumed = await request("thread/resume", { threadId, excludeTurns: true, initialTurnsPage: { limit: 2, itemsView: "notLoaded" } });
  assert.deepEqual(resumed.thread.turns, []); assert.equal(resumed.initialTurnsPage.data.length, 2);
  for (const turn of resumed.initialTurnsPage.data) { assert.deepEqual(turn.items, []); assert.equal(turn.itemsView, "notLoaded"); }
  const last = await request("thread/items/list", { threadId, sortDirection: "desc", limit: 1, cursor: resumed.itemsBackwardsCursor });
  assert.deepEqual(last.data, expected.slice(-1));
  const summary = await request("thread/turns/list", { threadId, limit: 1 });
  assert.equal(summary.data[0].itemsView, "summary"); assert.equal(summary.data[0].id, full.turns.at(-1).id);
  const lastTurn = full.turns.at(-1);
  assert.deepEqual(summary.data[0].items, [lastTurn.items.find((i: any) => i.type === "userMessage"), lastTurn.items.findLast((i: any) => i.type === "agentMessage")].filter(Boolean));
  const bad = await request("thread/items/list", { threadId, cursor: "not-a-cursor" }, true); assert.deepEqual(bad.error, { code: -32600, message: "invalid cursor: not-a-cursor" });
  // A middle-of-turn AS boundary must never inherit the later native suffix.
  const boundaryIndex = expected.findIndex((i: any) => i.item.id === "long_100"); assert.ok(boundaryIndex > 0);
  const fork = await request("thread/fork", { threadId, fromItemId: "long_100" });
  assert.notEqual(fork.thread.id, threadId);
  const prefix = fork.thread.turns.flatMap((t: any) => t.items);
  assert.deepEqual(prefix, expected.slice(0, boundaryIndex + 1).map((i: any) => i.item));
  const forkResume = await request("thread/resume", { threadId: fork.thread.id });
  assert.deepEqual(forkResume.thread.turns.flatMap((t: any) => t.items), prefix);
  const offset = wire.length;
  const turn = await request("turn/start", { threadId: fork.thread.id, input: [{ type: "text", text: "Reply exactly S3_REPLY_BOUNDARY" }] });
  const deadline = Date.now() + 20000;
  while (!wire.slice(offset).some(f => f.method === "turn/completed" && f.params.threadId === fork.thread.id && f.params.turn.id === turn.turn.id && f.params.turn.status === "completed")) {
    assert.ok(Date.now() < deadline, "seeded fork did not complete a new turn"); await Bun.sleep(10);
  }
  const parent = (await request("thread/read", { threadId, includeTurns: true })).thread;
  assert.deepEqual(parent.turns, full.turns);
  writeFileSync(output, JSON.stringify({ summary: { items: expected.length, pages: pageCount, defaults: true, reverse: true, excludeTurns: true, empty: true, fromItemId: true, seededForkTurn: true }, wire }, null, 2));
} finally { socket.close(); }

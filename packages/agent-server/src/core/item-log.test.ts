import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ItemLog } from "./item-log.js";
import type { ServerNotification, Thread, Turn } from "../protocol/index.js";

const logs: ItemLog[] = [];
afterEach(() => { for (const log of logs.splice(0)) log.close(); });
export function seed(log: ItemLog, id = "th"): void {
  const thread: Thread = { id, backend: "claude", engineThreadId: null, status: { type: "idle" }, cwd: "/tmp", createdAtMs: 1 };
  log.insertThread(thread, {});
  const turn: Turn = { id: `tn_${id}`, threadId: id, ordinal: 1, status: "inProgress", enqueuedAtMs: 1, startedAtMs: 1 };
  log.insertTurn(turn, { threadId: id, input: [{ type: "text", text: "hello" }] }, "hello"); log.dequeue(turn.id);
}
const create = () => { const log = new ItemLog(); logs.push(log); seed(log); return log; };
describe("ItemLog", () => {
  test("seq is monotonic per thread and survives reopen", () => {
    const path = join(mkdtempSync(join(tmpdir(), "as-log-")), "test.db");
    const log = new ItemLog(path); seed(log); seed(log, "other");
    for (let i = 1; i <= 3; i++) expect(log.startItem("th", "tn_th", { id: `it_${i}`, type: "agentMessage", payload: { text: "" } }).seq).toBe(i);
    expect(log.startItem("other", "tn_other", { id: "other", type: "agentMessage", payload: { text: "" } }).seq).toBe(1);
    log.close(); const reopened = new ItemLog(path); logs.push(reopened);
    expect(reopened.startItem("th", "tn_th", { id: "it_4", type: "agentMessage", payload: { text: "" } }).seq).toBe(4);
    expect(reopened.snapshot("th").nextSeq).toBe(5);
  });
  test("commit precedes broadcast; attach before or during publish cannot lose started item", () => {
    const log = create(), received: ServerNotification[] = [];
    log.attach("th", n => received.push(n));
    let during = 0;
    log.subscribe("th", n => { if (n.method === "item/started") during = log.attach("th", () => {}).snapshot.items.length; });
    log.startItem("th", "tn_th", { id: "it", type: "agentMessage", payload: { text: "" } });
    expect(during).toBe(1); expect(received.filter(n => n.method === "item/started")).toHaveLength(1);
    expect(log.snapshot("th").items[0].id).toBe("it");
  });
  test("snapshot merges partial text, while deltas do not persist until completed", () => {
    const log = create(); const item = log.startItem("th", "tn_th", { id: "it", type: "agentMessage", payload: { text: "" } });
    log.delta("th", "it", "text", "hello "); log.delta("th", "it", "text", "world");
    expect(log.snapshot("th", item.seq).items[0].payload).toEqual({ text: "hello world" });
    const row = log.db.query<{ payload_json: string }, []>("SELECT payload_json FROM items").get()!;
    expect(JSON.parse(row.payload_json)).toEqual({ text: "" });
    log.updateItem("th", { ...item, payload: { text: "hello world" }, status: "completed" }, true);
    expect(JSON.parse(log.db.query<{ payload_json: string }, []>("SELECT payload_json FROM items").get()!.payload_json)).toEqual({ text: "hello world" });
  });
  test("cursor pagination is stable both directions and limits never create attach gaps", () => {
    const log = create();
    for (let i = 1; i <= 5; i++) { const item = log.startItem("th", "tn_th", { id: `i${i}`, type: "reasoning", payload: { text: "think" } }); log.updateItem("th", { ...item, status: "completed" }, true); }
    expect(log.listItems({ threadId: "th", limit: 2 }).nextCursor).toBe("3");
    expect(log.listItems({ threadId: "th", cursor: "3", limit: 2 }).items.map(i => i.seq)).toEqual([5, 7]);
    expect(log.listItems({ threadId: "th", direction: "desc", limit: 2 }).items.map(i => i.seq)).toEqual([9, 7]);
    expect(log.listItems({ threadId: "th", direction: "desc", cursor: "7" }).items.map(i => i.seq)).toEqual([5, 3, 1]);
    expect(log.snapshot("th", 4, 1).items.map(i => i.seq)).toEqual([5, 7, 9]);
  });
  test("R4 / R3: highest-seen cursor replays offline completions, including interleaved items", () => {
    const log = create(), seen: ServerNotification[] = [];
    log.subscribe("th", n => seen.push(n));
    const first = log.startItem("th", "tn_th", { id: "first", type: "agentMessage", payload: { text: "" } });
    log.delta("th", first.id, "text", "hello ");
    const second = log.startItem("th", "tn_th", { id: "second", type: "reasoning", payload: {} });
    const cursor = log.snapshot("th").nextSeq - 1;
    const done = log.updateItem("th", { ...first, payload: { text: "hello world (final)" } }, true);
    expect(done.seq).toBe(first.seq);
    expect(done.completedSeq!).toBeGreaterThan(cursor);
    expect(log.snapshot("th", cursor).items).toEqual([done, second]);
    expect(seen.at(-1)).toMatchObject({ method: "item/completed", params: { seq: done.completedSeq } });
    expect(log.snapshot("th", done.completedSeq).items).toEqual([second]);
  });
  test("P2: completed payload and cursor survive reopen; completion is committed before notification", () => {
    const path = join(mkdtempSync(join(tmpdir(), "as-completed-")), "db");
    const log = new ItemLog(path); seed(log);
    const item = log.startItem("th", "tn_th", { id: "answer", type: "agentMessage", payload: { text: "" } });
    let persisted: unknown;
    log.subscribe("th", n => {
      if (n.method === "item/completed") {
        const reader = new ItemLog(path);
        try { persisted = reader.snapshot("th", item.seq).items[0]; }
        finally { reader.close(); }
      }
    });
    const completed = log.updateItem("th", { ...item, payload: { text: "persisted" } }, true);
    expect(persisted).toEqual(completed);
    const before = log.snapshot("th"); log.close();
    const reopened = new ItemLog(path); logs.push(reopened);
    expect(reopened.snapshot("th")).toEqual(before);
  });
  test("legacy completed items receive replay cursors once during migration", () => {
    const path = join(mkdtempSync(join(tmpdir(), "as-migrate-")), "db");
    const log = new ItemLog(path); seed(log);
    const item = log.startItem("th", "tn_th", { id: "answer", type: "agentMessage", payload: { text: "legacy" }, status: "completed" });
    log.db.exec("ALTER TABLE items DROP COLUMN completed_seq"); log.close();
    const migrated = new ItemLog(path);
    const snapshot = migrated.snapshot("th", item.seq);
    expect(snapshot.items[0]).toMatchObject({ id: "answer", completedSeq: 2, payload: { text: "legacy" } });
    migrated.close();
    const reopened = new ItemLog(path); logs.push(reopened);
    expect(reopened.snapshot("th", item.seq)).toEqual(snapshot);
  });
  test("failed writes neither consume seq nor publish; listener failure cannot undo commits", () => {
    const log = create(); const received: ServerNotification[] = [];
    log.subscribe("th", () => { throw new Error("broken socket"); }); log.subscribe("th", n => received.push(n));
    expect(() => log.startItem("th", "tn_th", { id: "bad", type: "agentMessage", payload: {} })).toThrow();
    expect(log.snapshot("th").nextSeq).toBe(1); expect(received).toHaveLength(0);
    log.startItem("th", "tn_th", { id: "it", type: "agentMessage", payload: { text: "" } });
    expect(received).toHaveLength(1);
  });
  test("reentrant publication preserves start seq order for every subscriber", () => {
    const log = create(), seen: number[] = [];
    log.subscribe("th", n => { if (n.method === "item/started" && n.params.seq === 1) log.startItem("th", "tn_th", { id: "second", type: "agentMessage", payload: { text: "" } }); });
    log.subscribe("th", n => { if (n.method === "item/started") seen.push(n.params.seq); });
    log.startItem("th", "tn_th", { id: "first", type: "agentMessage", payload: { text: "" } }); expect(seen).toEqual([1, 2]);
  });
});

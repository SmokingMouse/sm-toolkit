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
    expect(log.listItems({ threadId: "th", limit: 2 }).nextCursor).toBe("2");
    expect(log.listItems({ threadId: "th", cursor: "2", limit: 2 }).items.map(i => i.seq)).toEqual([3, 4]);
    expect(log.listItems({ threadId: "th", direction: "desc", limit: 2 }).items.map(i => i.seq)).toEqual([5, 4]);
    expect(log.listItems({ threadId: "th", direction: "desc", cursor: "4" }).items.map(i => i.seq)).toEqual([3, 2, 1]);
    expect(log.snapshot("th", 2, 1).items.map(i => i.seq)).toEqual([3, 4, 5]);
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

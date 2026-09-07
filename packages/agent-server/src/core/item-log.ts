import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ErrorCode, ItemSchema, ProtocolError, type AttachResult, type Item, type MethodParams, type PendingServerRequest, type QueuedTurn, type ServerNotification, type Thread, type Turn } from "../protocol/index.js";
import type { DeltaKind, EngineItem } from "../engines/session.js";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
type JsonRow = { data_json: string };
type ItemRow = { id: string; seq: number; completed_seq: number | null; turn_id: string; type: string; status: string; payload_json: string; started_at: number; completed_at: number | null };
export interface ApprovalRow { id: string; thread_id: string; status: string; params_json: string; decided_by: string | null; decision_json: string | null }
export type NotificationListener = (notification: ServerNotification) => void;

export class ItemLog {
  readonly db: Database;
  private partial = new Map<string, Item>();
  private listeners = new Map<string, Set<NotificationListener>>();
  private broadcasts: ServerNotification[] = [];
  private broadcasting = false;
  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY, backend TEXT NOT NULL, engine_thread_id TEXT, cwd TEXT NOT NULL,
        status TEXT NOT NULL, created_at INTEGER NOT NULL, client_thread_id TEXT UNIQUE,
        request_json TEXT NOT NULL, options_json TEXT NOT NULL, data_json TEXT NOT NULL, next_seq INTEGER NOT NULL DEFAULT 1,
        UNIQUE(backend, engine_thread_id)
      );
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), ordinal INTEGER NOT NULL,
        status TEXT NOT NULL, client_turn_id TEXT UNIQUE, request_json TEXT NOT NULL, data_json TEXT NOT NULL,
        UNIQUE(thread_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS items (
        thread_id TEXT NOT NULL REFERENCES threads(id), id TEXT NOT NULL, seq INTEGER NOT NULL,
        turn_id TEXT NOT NULL REFERENCES turns(id), type TEXT NOT NULL, status TEXT NOT NULL,
        payload_json TEXT NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER,
        PRIMARY KEY(thread_id, id), UNIQUE(thread_id, seq)
      );
      CREATE INDEX IF NOT EXISTS items_turn ON items(thread_id, turn_id, seq);
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), turn_id TEXT NOT NULL REFERENCES turns(id),
        item_id TEXT NOT NULL, kind TEXT NOT NULL, params_json TEXT NOT NULL, status TEXT NOT NULL,
        decided_by TEXT, decision_json TEXT, created_at INTEGER NOT NULL, decided_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS queue (
        turn_id TEXT PRIMARY KEY REFERENCES turns(id), thread_id TEXT NOT NULL REFERENCES threads(id),
        ordinal INTEGER NOT NULL, enqueued_at INTEGER NOT NULL, preview TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS queue_thread ON queue(thread_id, ordinal);
    `);
    // Migrate databases created before completion cursors were introduced.
    const columns = this.db.query<{ name: string }, []>("PRAGMA table_info(items)").all();
    if (!columns.some(column => column.name === "completed_seq")) this.db.exec("ALTER TABLE items ADD COLUMN completed_seq INTEGER");
    this.transaction(() => {
      for (const row of this.db.query<{ thread_id: string; id: string }, []>("SELECT thread_id,id FROM items WHERE status != 'inProgress' AND completed_seq IS NULL ORDER BY thread_id,seq").all()) {
        const seq = this.allocateSeq(row.thread_id);
        this.db.query("UPDATE items SET completed_seq=? WHERE thread_id=? AND id=?").run(seq, row.thread_id, row.id);
      }
    });
  }
  private allocateSeq(threadId: string): number {
    return this.db.query<{ next_seq: number }, [string]>("UPDATE threads SET next_seq=next_seq+1 WHERE id=? RETURNING next_seq-1 AS next_seq").get(threadId)!.next_seq;
  }
  transaction<T>(work: () => T): T { return this.db.transaction(work).immediate(); }
  thread(threadId: string): Thread {
    const row = this.db.query<JsonRow, [string]>("SELECT data_json FROM threads WHERE id = ?").get(threadId);
    if (!row) throw new ProtocolError(ErrorCode.thread_not_found, "thread not found", { threadId });
    return JSON.parse(row.data_json);
  }
  allThreads(): Thread[] { return this.db.query<JsonRow, []>("SELECT data_json FROM threads ORDER BY created_at, id").all().map(row => JSON.parse(row.data_json)); }
  findEngine(engineId: string, backend?: string): Thread | undefined {
    const row = this.db.query<JsonRow, [string, string | null, string | null]>("SELECT data_json FROM threads WHERE engine_thread_id = ? AND (? IS NULL OR backend = ?)").get(engineId, backend ?? null, backend ?? null);
    return row ? JSON.parse(row.data_json) : undefined;
  }
  options<T = MethodParams<"thread/start">>(id: string): T { return JSON.parse(this.db.query<{ options_json: string }, [string]>("SELECT options_json FROM threads WHERE id = ?").get(id)!.options_json); }
  saveOptions(id: string, options: unknown): void { this.db.query("UPDATE threads SET options_json = ? WHERE id = ?").run(JSON.stringify(options), id); }
  deduplicate<T extends Thread | Turn>(table: "threads" | "turns", key: string | undefined, request: unknown): T | undefined {
    if (!key) return;
    const column = table === "threads" ? "client_thread_id" : "client_turn_id";
    const row = this.db.query<JsonRow & { request_json: string }, [string]>(`SELECT data_json, request_json FROM ${table} WHERE ${column} = ?`).get(key);
    if (!row) return;
    if (row.request_json !== canonical(request)) throw new ProtocolError(ErrorCode.duplicate_client_id, "idempotency key used for a different payload");
    return JSON.parse(row.data_json);
  }
  insertThread(thread: Thread, request: unknown, options: unknown = request): void {
    this.db.query("INSERT INTO threads(id, backend, engine_thread_id, cwd, status, created_at, client_thread_id, request_json, options_json, data_json) VALUES(?,?,?,?,?,?,?,?,?,?)").run(thread.id, thread.backend, thread.engineThreadId, thread.cwd, thread.status.type, thread.createdAtMs, thread.clientThreadId ?? null, canonical(request), JSON.stringify(options), JSON.stringify(thread));
  }
  saveThread(thread: Thread): void { this.db.query("UPDATE threads SET engine_thread_id = ?, cwd = ?, status = ?, data_json = ? WHERE id = ?").run(thread.engineThreadId, thread.cwd, thread.status.type, JSON.stringify(thread), thread.id); }
  insertTurn(turn: Turn, request: unknown, preview: string): void {
    this.db.query("INSERT INTO turns(id,thread_id,ordinal,status,client_turn_id,request_json,data_json) VALUES(?,?,?,?,?,?,?)").run(turn.id, turn.threadId, turn.ordinal, turn.status, turn.clientTurnId ?? null, canonical(request), JSON.stringify(turn));
    this.db.query("INSERT INTO queue(turn_id,thread_id,ordinal,enqueued_at,preview) VALUES(?,?,?,?,?)").run(turn.id, turn.threadId, turn.ordinal, turn.enqueuedAtMs, preview);
  }
  turn(id: string, threadId?: string): Turn {
    const row = this.db.query<JsonRow, [string]>("SELECT data_json FROM turns WHERE id = ?").get(id);
    const turn: Turn | undefined = row ? JSON.parse(row.data_json) : undefined;
    if (!turn || (threadId && turn.threadId !== threadId)) throw new ProtocolError(ErrorCode.turn_not_found, "turn not found", { threadId, turnId: id });
    return turn;
  }
  turnInput(id: string): MethodParams<"turn/start"> { return JSON.parse(this.db.query<{ request_json: string }, [string]>("SELECT request_json FROM turns WHERE id = ?").get(id)!.request_json); }
  turns(threadId: string): Turn[] { return this.db.query<JsonRow, [string]>("SELECT data_json FROM turns WHERE thread_id = ? ORDER BY ordinal").all(threadId).map(row => JSON.parse(row.data_json)); }
  saveTurn(turn: Turn): void { this.db.query("UPDATE turns SET status = ?, data_json = ? WHERE id = ?").run(turn.status, JSON.stringify(turn), turn.id); }
  dequeue(turnId: string): void { this.db.query("DELETE FROM queue WHERE turn_id = ?").run(turnId); }
  queue(threadId: string): QueuedTurn[] {
    const rows = this.db.query<{ turn_id: string; client_turn_id: string | null; enqueued_at: number; preview: string }, [string]>("SELECT q.*,t.client_turn_id FROM queue q JOIN turns t ON t.id=q.turn_id WHERE q.thread_id=? ORDER BY q.ordinal").all(threadId);
    return rows.map((r, position) => ({ turnId: r.turn_id, ...(r.client_turn_id ? { clientTurnId: r.client_turn_id } : {}), position, enqueuedAtMs: r.enqueued_at, preview: r.preview }));
  }
  private key(threadId: string, itemId: string): string { return `${threadId}\0${itemId}`; }
  private decodeItem(threadId: string, row: ItemRow): Item {
    return structuredClone(this.partial.get(this.key(threadId, row.id)) ?? ItemSchema.parse({ id: row.id, seq: row.seq, ...(row.completed_seq !== null ? { completedSeq: row.completed_seq } : {}), turnId: row.turn_id, type: row.type, status: row.status, payload: JSON.parse(row.payload_json), startedAtMs: row.started_at, ...(row.completed_at !== null ? { completedAtMs: row.completed_at } : {}) }));
  }
  private readItems(threadId: string): Item[] {
    return this.logRows(threadId).map(row => this.decodeItem(threadId, row));
  }
  private logRows(threadId: string): ItemRow[] { return this.db.query<ItemRow, [string]>("SELECT * FROM items WHERE thread_id = ? ORDER BY seq").all(threadId); }
  item(threadId: string, itemId: string): Item {
    const partial = this.partial.get(this.key(threadId, itemId)); if (partial) return structuredClone(partial);
    const row = this.db.query<ItemRow, [string, string]>("SELECT * FROM items WHERE thread_id=? AND id=?").get(threadId, itemId);
    if (!row) throw new ProtocolError(ErrorCode.engine_protocol_error, "item not found", { threadId, itemId });
    return this.decodeItem(threadId, row);
  }
  startItem(threadId: string, turnId: string, draft: EngineItem, now = Date.now()): Item {
    const item = this.transaction(() => {
      this.turn(turnId, threadId);
      const seq = this.db.query<{ next_seq: number }, [string]>("SELECT next_seq FROM threads WHERE id = ?").get(threadId)!.next_seq;
      const item = ItemSchema.parse({ ...draft, status: draft.status ?? "inProgress", turnId, seq, startedAtMs: now });
      this.db.query("INSERT INTO items(thread_id,id,seq,turn_id,type,status,payload_json,started_at) VALUES(?,?,?,?,?,?,?,?)").run(threadId, item.id, seq, turnId, item.type, item.status!, JSON.stringify(item.payload), now);
      this.db.query("UPDATE threads SET next_seq = next_seq + 1 WHERE id = ?").run(threadId);
      return item;
    });
    this.partial.set(this.key(threadId, item.id), structuredClone(item));
    this.publish({ jsonrpc: "2.0", method: "item/started", params: { threadId, turnId, itemId: item.id, item, seq: item.seq, startedAtMs: now } });
    return item;
  }
  delta(threadId: string, itemId: string, kind: DeltaKind, text: string): void {
    const item = this.item(threadId, itemId);
    if (item.status !== "inProgress") throw new ProtocolError(ErrorCode.engine_protocol_error, "delta after item completed", { threadId, itemId });
    const field = kind === "stdout" || kind === "stderr" ? "aggregatedOutput" : kind === "summary" ? "summary" : "text";
    const payload = item.payload as Record<string, unknown>;
    payload[field] = String(payload[field] ?? "") + text;
    this.partial.set(this.key(threadId, itemId), ItemSchema.parse(item));
    const base = { threadId, turnId: item.turnId, itemId };
    if (kind === "stdout" || kind === "stderr") this.publish({ jsonrpc: "2.0", method: "item/commandExecution/outputDelta", params: { ...base, chunk: text, stream: kind } });
    else this.publish({ jsonrpc: "2.0", method: kind === "reasoning" ? "item/reasoning/textDelta" : kind === "summary" ? "item/reasoning/summaryTextDelta" : "item/agentMessage/delta", params: { ...base, delta: text } });
  }
  updateItem(threadId: string, draft: EngineItem, completed = false, now = Date.now()): Item {
    const old = this.item(threadId, draft.id);
    if (old.type !== draft.type) throw new ProtocolError(ErrorCode.engine_protocol_error, "item type changed");
    const item = this.transaction(() => {
      const item = ItemSchema.parse({ ...old, ...draft, ...(completed ? { status: draft.status === "inProgress" ? "completed" : draft.status ?? "completed", completedAtMs: now, completedSeq: this.allocateSeq(threadId) } : {}) });
      this.db.query("UPDATE items SET status=?,payload_json=?,completed_at=?,completed_seq=? WHERE thread_id=? AND id=?").run(item.status ?? "inProgress", JSON.stringify(item.payload), item.completedAtMs ?? null, item.completedSeq ?? null, threadId, item.id);
      return item;
    });
    if (completed) this.partial.delete(this.key(threadId, item.id)); else this.partial.set(this.key(threadId, item.id), structuredClone(item));
    const base = { threadId, turnId: item.turnId, itemId: item.id };
    if (completed) this.publish({ jsonrpc: "2.0", method: "item/completed", params: { ...base, item, seq: item.completedSeq!, completedAtMs: now } });
    else if (item.type === "fileChange") this.publish({ jsonrpc: "2.0", method: "item/fileChange/patchUpdated", params: { ...base, changes: item.payload.changes } });
    else if (item.type === "subAgent") this.publish({ jsonrpc: "2.0", method: "item/subAgent/progress", params: { ...base, phase: item.payload.phase, ...(item.payload.progress !== undefined ? { progress: item.payload.progress } : {}) } });
    return item;
  }
  finishOpenItems(threadId: string, turnId: string, failed: boolean): void {
    for (const item of this.readItems(threadId)) if (item.turnId === turnId && item.status === "inProgress") {
      if (item.type === "fileChange") item.payload.status = failed ? "failed" : "completed";
      this.updateItem(threadId, { ...item, status: failed ? "failed" : "completed" }, true);
    }
  }
  listItems(params: MethodParams<"thread/items/list">): { items: Item[]; nextCursor: string | null } {
    this.thread(params.threadId);
    const direction = params.direction ?? "asc", limit = params.limit ?? 100;
    const cursor = params.cursor === undefined ? undefined : Number(params.cursor);
    if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) throw new ProtocolError(ErrorCode.invalid_params, "invalid item cursor");
    const rows = this.db.query<ItemRow, [string, string | null, string | null, number | null, number | null, number]>(`SELECT * FROM items WHERE thread_id=? AND (? IS NULL OR turn_id=?) AND (? IS NULL OR seq ${direction === "asc" ? ">" : "<"} ?) ORDER BY seq ${direction === "asc" ? "ASC" : "DESC"} LIMIT ?`).all(params.threadId, params.turnId ?? null, params.turnId ?? null, cursor ?? null, cursor ?? null, limit + 1);
    const more = rows.length > limit, items = rows.slice(0, limit).map(row => this.decodeItem(params.threadId, row));
    return { items, nextCursor: more ? String(items.at(-1)!.seq) : null };
  }
  pendingRequests(threadId: string): PendingServerRequest[] { return this.db.query<{ params_json: string }, [string]>("SELECT params_json FROM approvals WHERE thread_id=? AND status='pending' ORDER BY created_at,id").all(threadId).map(r => JSON.parse(r.params_json)); }
  snapshot(threadId: string, sinceSeq = 0): AttachResult {
    const thread = this.thread(threadId);
    const all = this.readItems(threadId);
    // In-progress items reconcile already-seen identities after a disconnect.
    const items = all.filter(i => Math.max(i.seq, i.completedSeq ?? 0) > sinceSeq || i.status === "inProgress");
    const nextSeq = this.db.query<{ next_seq: number }, [string]>("SELECT next_seq FROM threads WHERE id=?").get(threadId)!.next_seq;
    return { thread, items, nextSeq, queue: this.queue(threadId), pendingRequests: this.pendingRequests(threadId) };
  }
  subscribe(threadId: string, listener: NotificationListener): () => void {
    this.thread(threadId);
    let group = this.listeners.get(threadId); if (!group) this.listeners.set(threadId, group = new Set());
    group.add(listener);
    return () => { group!.delete(listener); if (!group!.size) this.listeners.delete(threadId); };
  }
  attach(threadId: string, listener: NotificationListener, sinceSeq = 0): { snapshot: AttachResult; detach: () => void } {
    const detach = this.subscribe(threadId, listener);
    // No await between subscription and snapshot: JS and sqlite run in one owner.
    return { snapshot: this.snapshot(threadId, sinceSeq), detach };
  }
  publish(notification: ServerNotification): void {
    this.broadcasts.push(structuredClone(notification));
    if (this.broadcasting) return;
    this.broadcasting = true;
    try {
      for (let next = this.broadcasts.shift(); next; next = this.broadcasts.shift()) {
        const threadId = "threadId" in next.params ? next.params.threadId : undefined;
        if (!threadId) continue;
        for (const listener of [...(this.listeners.get(threadId) ?? [])]) {
          try { listener(structuredClone(next)); } catch { /* A disconnected consumer cannot roll back a committed event. */ }
        }
      }
    } finally { this.broadcasting = false; }
  }
  approval(id: string): ApprovalRow | null { return this.db.query<ApprovalRow, [string]>("SELECT * FROM approvals WHERE id=?").get(id); }
  close(): void { this.listeners.clear(); this.partial.clear(); this.db.close(); }
}

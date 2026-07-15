/**
 * 领域表 CRUD —— 全部 SQL 收口在这一层，行(snake_case) ↔ 领域类型(camelCase) 映射也在这。
 * 上层（rest/ws/scheduler/statemachine）只见领域类型。
 */

import type { Database } from "bun:sqlite";
import type { AgentEvent, Cost } from "@sm/agent";
import type {
  BackendKind,
  Conversation,
  ConversationKind,
  ConversationStatus,
  Device,
  DeviceCapabilities,
  HarborAgent,
  IsolationKind,
  Origin,
  Run,
  RunEventRow,
  RunStatus,
} from "../protocol.js";
import type { PermissionPolicy } from "@sm/agent";
import { newId } from "../ids.js";

// ── 行类型（SQLite 返回形状） ───────────────────────────

interface DeviceRow {
  id: string;
  name: string;
  token_hash: string;
  capabilities: string;
  last_seen_at: number | null;
  created_at: number;
}

interface AgentRow {
  id: string;
  name: string;
  description: string | null;
  device_id: string;
  backend: string;
  model: string | null;
  permission: string;
  workdir: string;
  isolation: string;
  instruction: string | null;
  created_at: number;
  archived_at: number | null;
}

interface ConversationRow {
  id: string;
  kind: string;
  title: string | null;
  agent_id: string;
  status: string;
  worktree_path: string | null;
  claude_session_id: string | null;
  origin: string;
  origin_ref: string | null;
  created_at: number;
  updated_at: number;
}

interface RunRow {
  id: string;
  conversation_id: string;
  agent_id: string;
  device_id: string;
  prompt: string;
  status: string;
  claude_session_id: string | null;
  error: string | null;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  queued_at: number;
  started_at: number | null;
  finished_at: number | null;
}

interface RunEventDbRow {
  run_id: string;
  seq: number;
  type: string;
  data: string;
  ts: number;
}

// ── 映射 ────────────────────────────────────────────────

function toDevice(r: DeviceRow, online: boolean): Device {
  return {
    id: r.id,
    name: r.name,
    capabilities: JSON.parse(r.capabilities) as DeviceCapabilities,
    online,
    lastSeenAt: r.last_seen_at,
    createdAt: r.created_at,
  };
}

function toAgent(r: AgentRow): HarborAgent {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    deviceId: r.device_id,
    backend: r.backend as BackendKind,
    model: r.model,
    permission: r.permission as PermissionPolicy,
    workdir: r.workdir,
    isolation: r.isolation as IsolationKind,
    instruction: r.instruction,
    createdAt: r.created_at,
    archivedAt: r.archived_at,
  };
}

function toConversation(r: ConversationRow): Conversation {
  return {
    id: r.id,
    kind: r.kind as ConversationKind,
    title: r.title,
    agentId: r.agent_id,
    status: r.status as ConversationStatus,
    worktreePath: r.worktree_path,
    claudeSessionId: r.claude_session_id,
    origin: r.origin as Origin,
    originRef: r.origin_ref,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toRun(r: RunRow): Run {
  const hasCost =
    r.cost_usd !== null || r.input_tokens !== null || r.output_tokens !== null || r.cached_tokens !== null;
  return {
    id: r.id,
    conversationId: r.conversation_id,
    agentId: r.agent_id,
    deviceId: r.device_id,
    prompt: r.prompt,
    status: r.status as RunStatus,
    claudeSessionId: r.claude_session_id,
    error: r.error,
    cost: hasCost
      ? {
          usd: r.cost_usd,
          inputTokens: r.input_tokens ?? 0,
          outputTokens: r.output_tokens ?? 0,
          cachedTokens: r.cached_tokens ?? 0,
        }
      : null,
    queuedAt: r.queued_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

function toRunEvent(r: RunEventDbRow): RunEventRow {
  return { runId: r.run_id, seq: r.seq, type: r.type, event: JSON.parse(r.data) as AgentEvent, ts: r.ts };
}

// ── Store ───────────────────────────────────────────────

export class HarborStore {
  constructor(private db: Database) {}

  // ---- devices ----

  /** hello 幂等注册：按 name upsert，刷新 capabilities/last_seen/token_hash */
  upsertDevice(name: string, tokenHash: string, capabilities: DeviceCapabilities, now: number): Device {
    const existing = this.db
      .query<DeviceRow, [string]>("SELECT * FROM devices WHERE name = ?")
      .get(name);
    if (existing) {
      this.db.run(
        "UPDATE devices SET token_hash = ?, capabilities = ?, last_seen_at = ? WHERE id = ?",
        [tokenHash, JSON.stringify(capabilities), now, existing.id],
      );
      return toDevice({ ...existing, capabilities: JSON.stringify(capabilities), last_seen_at: now }, true);
    }
    const id = newId("device");
    this.db.run(
      "INSERT INTO devices (id, name, token_hash, capabilities, last_seen_at, created_at) VALUES (?,?,?,?,?,?)",
      [id, name, tokenHash, JSON.stringify(capabilities), now, now],
    );
    return this.getDevice(id, true)!;
  }

  touchDevice(id: string, now: number): void {
    this.db.run("UPDATE devices SET last_seen_at = ? WHERE id = ?", [now, id]);
  }

  getDevice(id: string, online: boolean): Device | null {
    const r = this.db.query<DeviceRow, [string]>("SELECT * FROM devices WHERE id = ?").get(id);
    return r ? toDevice(r, online) : null;
  }

  getDeviceByName(name: string, online: boolean): Device | null {
    const r = this.db.query<DeviceRow, [string]>("SELECT * FROM devices WHERE name = ?").get(name);
    return r ? toDevice(r, online) : null;
  }

  listDevices(onlineIds: Set<string>): Device[] {
    return this.db
      .query<DeviceRow, []>("SELECT * FROM devices ORDER BY created_at")
      .all()
      .map((r) => toDevice(r, onlineIds.has(r.id)));
  }

  // ---- agents ----

  createAgent(a: {
    name: string;
    description?: string | null;
    deviceId: string;
    backend: BackendKind;
    model?: string | null;
    permission?: PermissionPolicy;
    workdir: string;
    isolation?: IsolationKind;
    instruction?: string | null;
  }, now: number): HarborAgent {
    const id = newId("agent");
    this.db.run(
      `INSERT INTO agents (id, name, description, device_id, backend, model, permission, workdir, isolation, instruction, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        a.name,
        a.description ?? null,
        a.deviceId,
        a.backend,
        a.model ?? null,
        a.permission ?? "auto-edit",
        a.workdir,
        a.isolation ?? "none",
        a.instruction ?? null,
        now,
      ],
    );
    return this.getAgent(id)!;
  }

  getAgent(id: string): HarborAgent | null {
    const r = this.db.query<AgentRow, [string]>("SELECT * FROM agents WHERE id = ?").get(id);
    return r ? toAgent(r) : null;
  }

  getAgentByName(name: string): HarborAgent | null {
    const r = this.db.query<AgentRow, [string]>("SELECT * FROM agents WHERE name = ?").get(name);
    return r ? toAgent(r) : null;
  }

  listAgents(includeArchived = false): HarborAgent[] {
    const sql = includeArchived
      ? "SELECT * FROM agents ORDER BY created_at"
      : "SELECT * FROM agents WHERE archived_at IS NULL ORDER BY created_at";
    return this.db.query<AgentRow, []>(sql).all().map(toAgent);
  }

  // ---- conversations ----

  createConversation(c: {
    kind: ConversationKind;
    title?: string | null;
    agentId: string;
    origin?: Origin;
    originRef?: string | null;
  }, now: number): Conversation {
    const id = newId("conversation");
    const status: ConversationStatus = c.kind === "chat" ? "open" : "backlog";
    this.db.run(
      `INSERT INTO conversations (id, kind, title, agent_id, status, origin, origin_ref, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, c.kind, c.title ?? null, c.agentId, status, c.origin ?? "cli", c.originRef ?? null, now, now],
    );
    return this.getConversation(id)!;
  }

  getConversation(id: string): Conversation | null {
    const r = this.db
      .query<ConversationRow, [string]>("SELECT * FROM conversations WHERE id = ?")
      .get(id);
    return r ? toConversation(r) : null;
  }

  /** CLI 短 id：前缀唯一匹配；0 命中 → null，多命中 → throw */
  resolveConversationPrefix(prefix: string): Conversation | null {
    const rows = this.db
      .query<ConversationRow, [string]>("SELECT * FROM conversations WHERE id LIKE ? || '%' LIMIT 2")
      .all(prefix);
    if (rows.length > 1) throw new Error(`conversation id 前缀 "${prefix}" 有多个匹配，请给更长前缀`);
    return rows[0] ? toConversation(rows[0]) : null;
  }

  listConversations(filter: { kind?: ConversationKind; status?: ConversationStatus }): Conversation[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.kind) {
      clauses.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .query<ConversationRow, string[]>(`SELECT * FROM conversations ${where} ORDER BY updated_at DESC`)
      .all(...params)
      .map(toConversation);
  }

  setConversationStatus(id: string, status: ConversationStatus, now: number): void {
    this.db.run("UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?", [status, now, id]);
  }

  setConversationClaudeSessionId(id: string, sid: string, now: number): void {
    this.db.run("UPDATE conversations SET claude_session_id = ?, updated_at = ? WHERE id = ?", [
      sid,
      now,
      id,
    ]);
  }

  appendStatusLog(
    conversationId: string,
    from: ConversationStatus | null,
    to: ConversationStatus,
    actor: "human" | "system" | "agent",
    now: number,
  ): void {
    this.db.run(
      "INSERT INTO status_log (conversation_id, from_status, to_status, actor, ts) VALUES (?,?,?,?,?)",
      [conversationId, from, to, actor, now],
    );
  }

  // ---- runs ----

  createRun(r: { conversationId: string; agentId: string; deviceId: string; prompt: string }, now: number): Run {
    const id = newId("run");
    this.db.run(
      `INSERT INTO runs (id, conversation_id, agent_id, device_id, prompt, status, queued_at)
       VALUES (?,?,?,?,?,'queued',?)`,
      [id, r.conversationId, r.agentId, r.deviceId, r.prompt, now],
    );
    this.db.run("UPDATE conversations SET updated_at = ? WHERE id = ?", [now, r.conversationId]);
    return this.getRun(id)!;
  }

  getRun(id: string): Run | null {
    const r = this.db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(id);
    return r ? toRun(r) : null;
  }

  resolveRunPrefix(prefix: string): Run | null {
    const rows = this.db
      .query<RunRow, [string]>("SELECT * FROM runs WHERE id LIKE ? || '%' LIMIT 2")
      .all(prefix);
    if (rows.length > 1) throw new Error(`run id 前缀 "${prefix}" 有多个匹配，请给更长前缀`);
    return rows[0] ? toRun(rows[0]) : null;
  }

  listRunsByConversation(conversationId: string): Run[] {
    return this.db
      .query<RunRow, [string]>("SELECT * FROM runs WHERE conversation_id = ? ORDER BY queued_at")
      .all(conversationId)
      .map(toRun);
  }

  /** 该设备最老的一条 queued run（FIFO 调度） */
  oldestQueuedForDevice(deviceId: string): Run | null {
    const r = this.db
      .query<RunRow, [string]>(
        "SELECT * FROM runs WHERE device_id = ? AND status = 'queued' ORDER BY queued_at LIMIT 1",
      )
      .get(deviceId);
    return r ? toRun(r) : null;
  }

  countRunning(deviceId: string): number {
    const r = this.db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM runs WHERE device_id = ? AND status = 'running'",
      )
      .get(deviceId);
    return r?.n ?? 0;
  }

  runningRunsForDevice(deviceId: string): Run[] {
    return this.db
      .query<RunRow, [string]>("SELECT * FROM runs WHERE device_id = ? AND status = 'running'")
      .all(deviceId)
      .map(toRun);
  }

  markRunRunning(id: string, now: number): void {
    this.db.run("UPDATE runs SET status = 'running', started_at = ? WHERE id = ?", [now, id]);
  }

  finishRun(
    id: string,
    status: "succeeded" | "failed" | "canceled",
    fields: { claudeSessionId: string | null; cost: Cost | null; error: string | null },
    now: number,
  ): void {
    this.db.run(
      `UPDATE runs SET status = ?, claude_session_id = ?, error = ?,
       cost_usd = ?, input_tokens = ?, output_tokens = ?, cached_tokens = ?, finished_at = ?
       WHERE id = ?`,
      [
        status,
        fields.claudeSessionId,
        fields.error,
        fields.cost?.usd ?? null,
        fields.cost?.inputTokens ?? null,
        fields.cost?.outputTokens ?? null,
        fields.cost?.cachedTokens ?? null,
        now,
        id,
      ],
    );
  }

  // ---- run_events ----

  /** seq 幂等插入（daemon 断线重发不重复） */
  insertRunEvents(events: { runId: string; seq: number; event: AgentEvent }[], now: number): void {
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO run_events (run_id, seq, type, data, ts) VALUES (?,?,?,?,?)",
    );
    this.db.transaction(() => {
      for (const e of events) {
        stmt.run(e.runId, e.seq, e.event.type, JSON.stringify(e.event), now);
      }
    })();
  }

  listRunEvents(runId: string, afterSeq = 0): RunEventRow[] {
    return this.db
      .query<RunEventDbRow, [string, number]>(
        "SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq",
      )
      .all(runId, afterSeq)
      .map(toRunEvent);
  }
}

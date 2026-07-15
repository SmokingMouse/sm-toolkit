/**
 * 领域表 CRUD —— 全部 SQL 收口在这一层，行(snake_case) ↔ 领域类型(camelCase) 映射也在这。
 * 上层（rest/ws/scheduler/statemachine）只见领域类型。
 */

import type { Database } from "bun:sqlite";
import type { AgentEvent, Cost } from "@sm/agent";
import type {
  Approval,
  ApprovalStatus,
  Automation,
  AutomationLogRow,
  AutomationMode,
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
  UsageRow,
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

interface ApprovalRow {
  id: string;
  run_id: string;
  request_id: string;
  tool_name: string;
  input: string;
  status: string;
  decided_by: string | null;
  feishu_message_id: string | null;
  decided_at: number | null;
  created_at: number;
}

interface AutomationRow {
  id: string;
  name: string;
  agent_id: string;
  cron: string;
  prompt: string;
  mode: string;
  target_conversation_id: string | null;
  notify_chat_id: string | null;
  enabled: number;
  last_fired_at: number | null;
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

function toApproval(r: ApprovalRow): Approval {
  return {
    id: r.id,
    runId: r.run_id,
    requestId: r.request_id,
    toolName: r.tool_name,
    input: JSON.parse(r.input) as unknown,
    status: r.status as ApprovalStatus,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    createdAt: r.created_at,
  };
}

function toAutomation(r: AutomationRow): Automation {
  return {
    id: r.id,
    name: r.name,
    agentId: r.agent_id,
    cron: r.cron,
    prompt: r.prompt,
    mode: r.mode as AutomationMode,
    targetConversationId: r.target_conversation_id,
    notifyChatId: r.notify_chat_id,
    enabled: r.enabled === 1,
    lastFiredAt: r.last_fired_at,
  };
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

  /** 归档 = 软删除（不出现在派活下拉，历史 run/conversation 引用不悬空）；archived=false 可恢复 */
  setAgentArchived(id: string, archived: boolean, now: number): void {
    this.db.run("UPDATE agents SET archived_at = ? WHERE id = ?", [archived ? now : null, id]);
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

  setConversationWorktreePath(id: string, path: string | null, now: number): void {
    this.db.run("UPDATE conversations SET worktree_path = ?, updated_at = ? WHERE id = ?", [
      path,
      now,
      id,
    ]);
  }

  /** 入口路由映射（飞书话题 → conversation）：同 origin+origin_ref 取最近一条 */
  getConversationByOrigin(origin: Origin, originRef: string): Conversation | null {
    const r = this.db
      .query<ConversationRow, [string, string]>(
        "SELECT * FROM conversations WHERE origin = ? AND origin_ref = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(origin, originRef);
    return r ? toConversation(r) : null;
  }

  /** 该设备上「已终结但 worktree 还挂着」的 issue（设备离线时 cleanup 丢失 → 重连补发） */
  listWorktreeCleanupsForDevice(deviceId: string): { conversation: Conversation; agent: HarborAgent }[] {
    const rows = this.db
      .query<ConversationRow, [string]>(
        `SELECT c.* FROM conversations c JOIN agents a ON a.id = c.agent_id
         WHERE a.device_id = ? AND c.worktree_path IS NOT NULL AND c.status IN ('done','canceled')`,
      )
      .all(deviceId);
    return rows.map((r) => {
      const conv = toConversation(r);
      return { conversation: conv, agent: this.getAgent(conv.agentId)! };
    });
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

  /** conversation 内未终态的 run（issue 多轮线性：同会话禁止并行 run，防 resume 分叉） */
  activeRunForConversation(conversationId: string): Run | null {
    const r = this.db
      .query<RunRow, [string]>(
        "SELECT * FROM runs WHERE conversation_id = ? AND status IN ('queued','running') LIMIT 1",
      )
      .get(conversationId);
    return r ? toRun(r) : null;
  }

  /** run 的最终回复文本（result 事件的 data.text；事件被 prune 后为 null） */
  getRunResultText(runId: string): string | null {
    const r = this.db
      .query<{ data: string }, [string]>(
        "SELECT data FROM run_events WHERE run_id = ? AND type = 'result' ORDER BY seq DESC LIMIT 1",
      )
      .get(runId);
    if (!r) return null;
    try {
      const ev = JSON.parse(r.data) as { data?: { text?: unknown } };
      return typeof ev.data?.text === "string" ? ev.data.text : null;
    } catch {
      return null;
    }
  }

  listStatusLog(conversationId: string): { fromStatus: string | null; toStatus: string; actor: string; ts: number }[] {
    return this.db
      .query<{ from_status: string | null; to_status: string; actor: string; ts: number }, [string]>(
        "SELECT from_status, to_status, actor, ts FROM status_log WHERE conversation_id = ? ORDER BY ts",
      )
      .all(conversationId)
      .map((r) => ({ fromStatus: r.from_status, toStatus: r.to_status, actor: r.actor, ts: r.ts }));
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

  /** 7 天滚动清理（P3）；result/cost 永久留 runs 表，不受影响 */
  pruneRunEvents(beforeTs: number): number {
    const r = this.db.run("DELETE FROM run_events WHERE ts < ?", [beforeTs]);
    return r.changes;
  }

  // ---- approvals（P2 审批链路） ----

  createApproval(
    a: { runId: string; requestId: string; toolName: string; input: unknown },
    now: number,
  ): Approval {
    const id = newId("approval");
    this.db.run(
      `INSERT INTO approvals (id, run_id, request_id, tool_name, input, status, created_at)
       VALUES (?,?,?,?,?,'pending',?)`,
      [id, a.runId, a.requestId, a.toolName, JSON.stringify(a.input ?? null), now],
    );
    return this.getApproval(id)!;
  }

  getApproval(id: string): Approval | null {
    const r = this.db.query<ApprovalRow, [string]>("SELECT * FROM approvals WHERE id = ?").get(id);
    return r ? toApproval(r) : null;
  }

  resolveApprovalPrefix(prefix: string): Approval | null {
    const rows = this.db
      .query<ApprovalRow, [string]>("SELECT * FROM approvals WHERE id LIKE ? || '%' LIMIT 2")
      .all(prefix);
    if (rows.length > 1) throw new Error(`approval id 前缀 "${prefix}" 有多个匹配，请给更长前缀`);
    return rows[0] ? toApproval(rows[0]) : null;
  }

  listApprovals(status?: ApprovalStatus): Approval[] {
    const sql = status
      ? "SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT 100"
      : "SELECT * FROM approvals ORDER BY created_at DESC LIMIT 100";
    const rows = status
      ? this.db.query<ApprovalRow, [string]>(sql).all(status)
      : this.db.query<ApprovalRow, []>(sql).all();
    return rows.map(toApproval);
  }

  pendingApprovalsForRun(runId: string): Approval[] {
    return this.db
      .query<ApprovalRow, [string]>("SELECT * FROM approvals WHERE run_id = ? AND status = 'pending'")
      .all(runId)
      .map(toApproval);
  }

  approvalsForRun(runId: string): Approval[] {
    return this.db
      .query<ApprovalRow, [string]>("SELECT * FROM approvals WHERE run_id = ?")
      .all(runId)
      .map(toApproval);
  }

  pendingApprovalsOlderThan(ts: number): Approval[] {
    return this.db
      .query<ApprovalRow, [number]>("SELECT * FROM approvals WHERE status = 'pending' AND created_at < ?")
      .all(ts)
      .map(toApproval);
  }

  /** 决议（幂等闸在调用方：仅 pending 可决议） */
  markApprovalDecided(id: string, status: Exclude<ApprovalStatus, "pending">, decidedBy: string, now: number): void {
    this.db.run("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?", [
      status,
      decidedBy,
      now,
      id,
    ]);
  }

  setApprovalFeishuMessageId(id: string, messageId: string): void {
    this.db.run("UPDATE approvals SET feishu_message_id = ? WHERE id = ?", [messageId, id]);
  }

  getApprovalFeishuMessageId(id: string): string | null {
    const r = this.db
      .query<{ feishu_message_id: string | null }, [string]>(
        "SELECT feishu_message_id FROM approvals WHERE id = ?",
      )
      .get(id);
    return r?.feishu_message_id ?? null;
  }

  // ---- automations（P3 cron） ----

  createAutomation(
    a: {
      name: string;
      agentId: string;
      cron: string;
      prompt: string;
      mode: AutomationMode;
      targetConversationId?: string | null;
      notifyChatId?: string | null;
    },
    _now: number,
  ): Automation {
    const id = newId("automation");
    this.db.run(
      `INSERT INTO automations (id, name, agent_id, cron, prompt, mode, target_conversation_id, notify_chat_id, enabled)
       VALUES (?,?,?,?,?,?,?,?,1)`,
      [id, a.name, a.agentId, a.cron, a.prompt, a.mode, a.targetConversationId ?? null, a.notifyChatId ?? null],
    );
    return this.getAutomation(id)!;
  }

  getAutomation(id: string): Automation | null {
    const r = this.db.query<AutomationRow, [string]>("SELECT * FROM automations WHERE id = ?").get(id);
    return r ? toAutomation(r) : null;
  }

  resolveAutomationPrefix(prefix: string): Automation | null {
    const rows = this.db
      .query<AutomationRow, [string, string]>(
        "SELECT * FROM automations WHERE id LIKE ? || '%' OR name = ? LIMIT 2",
      )
      .all(prefix, prefix);
    if (rows.length > 1) throw new Error(`automation "${prefix}" 有多个匹配，请给更长前缀或用完整 id`);
    return rows[0] ? toAutomation(rows[0]) : null;
  }

  listAutomations(): Automation[] {
    return this.db.query<AutomationRow, []>("SELECT * FROM automations ORDER BY name").all().map(toAutomation);
  }

  setAutomationEnabled(id: string, enabled: boolean): void {
    this.db.run("UPDATE automations SET enabled = ? WHERE id = ?", [enabled ? 1 : 0, id]);
  }

  deleteAutomation(id: string): void {
    this.db.run("DELETE FROM automations WHERE id = ?", [id]);
  }

  markAutomationFired(id: string, now: number): void {
    this.db.run("UPDATE automations SET last_fired_at = ? WHERE id = ?", [now, id]);
  }

  appendAutomationLog(l: { automationId: string; kind: "fired" | "missed"; runId?: string | null; note?: string | null }, now: number): void {
    this.db.run("INSERT INTO automation_log (automation_id, kind, ts, run_id, note) VALUES (?,?,?,?,?)", [
      l.automationId,
      l.kind,
      now,
      l.runId ?? null,
      l.note ?? null,
    ]);
  }

  listAutomationLog(automationId: string, limit = 50): AutomationLogRow[] {
    return this.db
      .query<{ automation_id: string; kind: string; ts: number; run_id: string | null; note: string | null }, [string, number]>(
        "SELECT * FROM automation_log WHERE automation_id = ? ORDER BY ts DESC LIMIT ?",
      )
      .all(automationId, limit)
      .map((r) => ({
        automationId: r.automation_id,
        kind: r.kind as "fired" | "missed",
        ts: r.ts,
        runId: r.run_id,
        note: r.note,
      }));
  }

  // ---- chat_bindings（飞书群 → 默认 agent） ----

  setChatBinding(chatId: string, agentId: string, now: number): void {
    this.db.run(
      `INSERT INTO chat_bindings (chat_id, agent_id, created_at) VALUES (?,?,?)
       ON CONFLICT(chat_id) DO UPDATE SET agent_id = excluded.agent_id`,
      [chatId, agentId, now],
    );
  }

  getChatBinding(chatId: string): string | null {
    const r = this.db
      .query<{ agent_id: string }, [string]>("SELECT agent_id FROM chat_bindings WHERE chat_id = ?")
      .get(chatId);
    return r?.agent_id ?? null;
  }

  // ---- usage（P3 报表） ----

  /** agent × model × 日 聚合（server 本地时区），只统计有终态的 run */
  usageAggregate(fromTs: number): UsageRow[] {
    return this.db
      .query<
        {
          day: string;
          agent_name: string;
          model: string | null;
          runs: number;
          usd: number | null;
          input_tokens: number | null;
          output_tokens: number | null;
          cached_tokens: number | null;
        },
        [number]
      >(
        `SELECT date(r.queued_at / 1000, 'unixepoch', 'localtime') AS day,
                a.name AS agent_name, a.model AS model,
                COUNT(*) AS runs,
                SUM(COALESCE(r.cost_usd, 0)) AS usd,
                SUM(COALESCE(r.input_tokens, 0)) AS input_tokens,
                SUM(COALESCE(r.output_tokens, 0)) AS output_tokens,
                SUM(COALESCE(r.cached_tokens, 0)) AS cached_tokens
         FROM runs r JOIN agents a ON a.id = r.agent_id
         WHERE r.queued_at >= ? AND r.status IN ('succeeded','failed','canceled')
         GROUP BY day, a.name, a.model
         ORDER BY day DESC, usd DESC`,
      )
      .all(fromTs)
      .map((r) => ({
        day: r.day,
        agentName: r.agent_name,
        model: r.model ?? "(CLI 默认)",
        runs: r.runs,
        usd: r.usd ?? 0,
        inputTokens: r.input_tokens ?? 0,
        outputTokens: r.output_tokens ?? 0,
        cachedTokens: r.cached_tokens ?? 0,
      }));
  }

  /** usage 下钻：某 agent（可选）某日（可选）的逐 run 明细 */
  listRunsForUsage(filter: { agentId?: string; day?: string; fromTs: number }): Run[] {
    const clauses = ["r.queued_at >= ?", "r.status IN ('succeeded','failed','canceled')"];
    const params: (string | number)[] = [filter.fromTs];
    if (filter.agentId) {
      clauses.push("r.agent_id = ?");
      params.push(filter.agentId);
    }
    if (filter.day) {
      clauses.push("date(r.queued_at / 1000, 'unixepoch', 'localtime') = ?");
      params.push(filter.day);
    }
    return this.db
      .query<RunRow, (string | number)[]>(
        `SELECT r.* FROM runs r WHERE ${clauses.join(" AND ")} ORDER BY r.queued_at DESC LIMIT 200`,
      )
      .all(...params)
      .map(toRun);
  }
}

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
  Delivery,
  DeliveryCheckStatus,
  DeliveryDeploymentStatus,
  DeliveryEvent,
  DeliveryMergeStatus,
  DeliveryProviderKind,
  DeliveryReviewStatus,
  DeliveryStatus,
  Device,
  DeviceCapabilities,
  HarborAgent,
  HarborSkill,
  IsolationKind,
  IssuePriority,
  Origin,
  PromptBlockKey,
  PromptEventBlockKey,
  Run,
  RunEventRow,
  RunPurpose,
  RunStatus,
  SkillSource,
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

interface SkillRow {
  id: string;
  name: string;
  description: string;
  source: string;
  instruction: string;
  device_id: string | null;
  source_path: string | null;
  runtimes: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

interface ConversationRow {
  id: string;
  kind: string;
  title: string | null;
  agent_id: string | null;
  description: string | null;
  priority: string;
  status: string;
  worktree_path: string | null;
  claude_session_id: string | null;
  origin: string;
  origin_ref: string | null;
  created_at: number;
  updated_at: number;
}

interface DeliveryRow {
  id: string;
  conversation_id: string;
  provider: string;
  change_url: string | null;
  external_id: string | null;
  head_branch: string | null;
  base_branch: string | null;
  review_status: string;
  check_status: string;
  merge_status: string;
  deployment_status: string;
  review_approved_at: number | null;
  merged_at: number | null;
  deployed_at: number | null;
  created_at: number;
  updated_at: number;
}

interface DeliveryEventRow {
  delivery_id: string;
  kind: string;
  data: string;
  actor: string;
  ts: number;
}

interface RunRow {
  id: string;
  conversation_id: string;
  agent_id: string;
  device_id: string;
  prompt: string;
  purpose: string;
  prompt_event: string;
  trigger_ref: string | null;
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

interface PromptBlockRow {
  block_key: string;
  enabled: number;
  template: string;
  updated_at: number;
}

export interface PromptBlockOverride {
  key: PromptBlockKey;
  enabled: boolean;
  template: string;
  updatedAt: number;
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
    skillIds: [],
    createdAt: r.created_at,
    archivedAt: r.archived_at,
  };
}

function toSkill(r: SkillRow): HarborSkill {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    source: r.source as SkillSource,
    instruction: r.instruction,
    deviceId: r.device_id,
    sourcePath: r.source_path,
    runtimes: JSON.parse(r.runtimes) as BackendKind[],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    archivedAt: r.archived_at,
  };
}

function toConversation(r: ConversationRow): Conversation {
  return {
    id: r.id,
    kind: r.kind as ConversationKind,
    title: r.title,
    agentId: r.agent_id,
    description: r.description,
    priority: r.priority as IssuePriority,
    status: r.status as ConversationStatus,
    worktreePath: r.worktree_path,
    claudeSessionId: r.claude_session_id,
    origin: r.origin as Origin,
    originRef: r.origin_ref,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function deliveryStatus(r: DeliveryRow): DeliveryStatus {
  if (r.merge_status === "merged") {
    if (r.deployment_status === "failed") return "failed";
    if (r.deployment_status === "running") return "deploying";
    if (r.deployment_status === "pending") return "merged";
    return "succeeded";
  }
  if (!r.change_url) return "awaiting_change";
  if (r.check_status === "failed") return "blocked";
  if (r.review_status !== "approved") return "review_pending";
  if (r.check_status !== "passed") return "checks_pending";
  return "merge_ready";
}

function toDelivery(r: DeliveryRow): Delivery {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    provider: r.provider as DeliveryProviderKind,
    changeUrl: r.change_url,
    externalId: r.external_id,
    headBranch: r.head_branch,
    baseBranch: r.base_branch,
    reviewStatus: r.review_status as DeliveryReviewStatus,
    checkStatus: r.check_status as DeliveryCheckStatus,
    mergeStatus: r.merge_status as DeliveryMergeStatus,
    deploymentStatus: r.deployment_status as DeliveryDeploymentStatus,
    status: deliveryStatus(r),
    reviewApprovedAt: r.review_approved_at,
    mergedAt: r.merged_at,
    deployedAt: r.deployed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toDeliveryEvent(r: DeliveryEventRow): DeliveryEvent {
  let data: unknown = {};
  try {
    data = JSON.parse(r.data);
  } catch {
    data = { raw: r.data };
  }
  return {
    deliveryId: r.delivery_id,
    kind: r.kind,
    data,
    actor: r.actor as DeliveryEvent["actor"],
    ts: r.ts,
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
    purpose: r.purpose as RunPurpose,
    promptEvent: r.prompt_event as PromptEventBlockKey,
    triggerRef: r.trigger_ref,
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
    return r ? this.withAgentSkills(toAgent(r)) : null;
  }

  getAgentByName(name: string): HarborAgent | null {
    const r = this.db.query<AgentRow, [string]>("SELECT * FROM agents WHERE name = ?").get(name);
    return r ? this.withAgentSkills(toAgent(r)) : null;
  }

  /** 归档 = 软删除（不出现在派活下拉，历史 run/conversation 引用不悬空）；archived=false 可恢复 */
  setAgentArchived(id: string, archived: boolean, now: number): void {
    this.db.run("UPDATE agents SET archived_at = ? WHERE id = ?", [archived ? now : null, id]);
  }

  listAgents(includeArchived = false): HarborAgent[] {
    const sql = includeArchived
      ? "SELECT * FROM agents ORDER BY created_at"
      : "SELECT * FROM agents WHERE archived_at IS NULL ORDER BY created_at";
    return this.db.query<AgentRow, []>(sql).all().map((row) => this.withAgentSkills(toAgent(row)));
  }

  private withAgentSkills(agent: HarborAgent): HarborAgent {
    agent.skillIds = this.db
      .query<{ skill_id: string }, [string]>(
        "SELECT skill_id FROM agent_skills WHERE agent_id = ? ORDER BY position, created_at",
      )
      .all(agent.id)
      .map((row) => row.skill_id);
    return agent;
  }

  /** 绑定是 Agent 当前配置，不写进历史 Run；dispatch 时 scheduler 解析最新值。 */
  setAgentSkills(agentId: string, skillIds: string[], now: number): void {
    this.db.transaction(() => {
      this.db.run("DELETE FROM agent_skills WHERE agent_id = ?", [agentId]);
      const insert = this.db.prepare(
        "INSERT INTO agent_skills (agent_id, skill_id, position, created_at) VALUES (?,?,?,?)",
      );
      skillIds.forEach((skillId, position) => insert.run(agentId, skillId, position, now));
    })();
  }

  // ---- skills ----

  createSkill(
    skill: {
      name: string;
      description?: string;
      source: SkillSource;
      instruction: string;
      deviceId?: string | null;
      sourcePath?: string | null;
      runtimes?: BackendKind[];
    },
    now: number,
  ): HarborSkill {
    const id = newId("skill");
    this.db.run(
      `INSERT INTO skills
       (id, name, description, source, instruction, device_id, source_path, runtimes, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        skill.name,
        skill.description ?? "",
        skill.source,
        skill.instruction,
        skill.deviceId ?? null,
        skill.sourcePath ?? null,
        JSON.stringify(skill.runtimes ?? ["claude", "codex"]),
        now,
        now,
      ],
    );
    return this.getSkill(id)!;
  }

  getSkill(id: string): HarborSkill | null {
    const row = this.db.query<SkillRow, [string]>("SELECT * FROM skills WHERE id = ?").get(id);
    return row ? toSkill(row) : null;
  }

  getSkillByName(name: string): HarborSkill | null {
    const row = this.db.query<SkillRow, [string]>("SELECT * FROM skills WHERE name = ?").get(name);
    return row ? toSkill(row) : null;
  }

  getRuntimeSkill(deviceId: string, sourcePath: string): HarborSkill | null {
    const row = this.db
      .query<SkillRow, [string, string]>(
        "SELECT * FROM skills WHERE source = 'runtime' AND device_id = ? AND source_path = ?",
      )
      .get(deviceId, sourcePath);
    return row ? toSkill(row) : null;
  }

  listSkills(includeArchived = false): HarborSkill[] {
    const sql = includeArchived
      ? "SELECT * FROM skills ORDER BY updated_at DESC, name"
      : "SELECT * FROM skills WHERE archived_at IS NULL ORDER BY updated_at DESC, name";
    return this.db.query<SkillRow, []>(sql).all().map(toSkill);
  }

  listSkillsForAgent(agentId: string): HarborSkill[] {
    return this.db
      .query<SkillRow, [string]>(
        `SELECT s.* FROM agent_skills a
         JOIN skills s ON s.id = a.skill_id
         WHERE a.agent_id = ? AND s.archived_at IS NULL
         ORDER BY a.position, a.created_at`,
      )
      .all(agentId)
      .map(toSkill);
  }

  listAgentsForSkill(skillId: string): HarborAgent[] {
    return this.db
      .query<AgentRow, [string]>(
        `SELECT a.* FROM agent_skills x
         JOIN agents a ON a.id = x.agent_id
         WHERE x.skill_id = ? AND a.archived_at IS NULL
         ORDER BY a.name`,
      )
      .all(skillId)
      .map((row) => this.withAgentSkills(toAgent(row)));
  }

  updateSkill(
    id: string,
    patch: { name?: string; description?: string; instruction?: string; runtimes?: BackendKind[] },
    now: number,
  ): void {
    const sets: string[] = [];
    const params: (string | number)[] = [];
    if (patch.name !== undefined) {
      sets.push("name = ?");
      params.push(patch.name);
    }
    if (patch.description !== undefined) {
      sets.push("description = ?");
      params.push(patch.description);
    }
    if (patch.instruction !== undefined) {
      sets.push("instruction = ?");
      params.push(patch.instruction);
    }
    if (patch.runtimes !== undefined) {
      sets.push("runtimes = ?");
      params.push(JSON.stringify(patch.runtimes));
    }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    params.push(now, id);
    this.db.run(`UPDATE skills SET ${sets.join(", ")} WHERE id = ?`, params);
  }

  /** 归档即停止生效并解除全部 Agent 绑定；恢复不会隐式重新绑定。 */
  setSkillArchived(id: string, archived: boolean, now: number): void {
    this.db.transaction(() => {
      if (archived) this.db.run("DELETE FROM agent_skills WHERE skill_id = ?", [id]);
      this.db.run("UPDATE skills SET archived_at = ?, updated_at = ? WHERE id = ?", [
        archived ? now : null,
        now,
        id,
      ]);
    })();
  }

  // ---- conversations ----

  createConversation(c: {
    kind: ConversationKind;
    title?: string | null;
    agentId?: string | null;
    description?: string | null;
    priority?: IssuePriority;
    origin?: Origin;
    originRef?: string | null;
  }, now: number): Conversation {
    const id = newId("conversation");
    const status: ConversationStatus = c.kind === "issue" ? "backlog" : "open";
    this.db.run(
      `INSERT INTO conversations
       (id, kind, title, agent_id, description, priority, status, origin, origin_ref, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        c.kind,
        c.title ?? null,
        c.agentId ?? null,
        c.description ?? null,
        c.priority ?? "medium",
        status,
        c.origin ?? "cli",
        c.originRef ?? null,
        now,
        now,
      ],
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

  updateConversation(
    id: string,
    patch: { title?: string | null; description?: string | null; priority?: IssuePriority },
    now: number,
  ): void {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if ("title" in patch) {
      sets.push("title = ?");
      params.push(patch.title ?? null);
    }
    if ("description" in patch) {
      sets.push("description = ?");
      params.push(patch.description ?? null);
    }
    if ("priority" in patch) {
      sets.push("priority = ?");
      params.push(patch.priority ?? "medium");
    }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    params.push(now, id);
    this.db.run(`UPDATE conversations SET ${sets.join(", ")} WHERE id = ?`, params);
  }

  /** AI 分诊草稿在人工确认时才进入 Issue 看板；保留 triage Run 与 session 作为来源证据。 */
  publishIssueDraft(
    id: string,
    patch: { title: string; description: string; priority: IssuePriority; status: "backlog" | "todo" },
    now: number,
  ): Conversation {
    const current = this.getConversation(id);
    if (!current || current.kind !== "issue_draft") throw new Error(`issue draft "${id}" 不存在`);
    this.db.run(
      `UPDATE conversations
       SET kind = 'issue', title = ?, description = ?, priority = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      [patch.title, patch.description, patch.priority, patch.status, now, id],
    );
    this.appendStatusLog(id, null, patch.status, "human", now);
    return this.getConversation(id)!;
  }

  /** Assignee 变化时清空旧 Agent 的 resume session；Review Agent 不走这里。 */
  setConversationAssignee(id: string, agentId: string | null, now: number): void {
    const current = this.getConversation(id);
    if (!current || current.agentId === agentId) return;
    this.db.run(
      "UPDATE conversations SET agent_id = ?, claude_session_id = NULL, updated_at = ? WHERE id = ?",
      [agentId, now, id],
    );
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
    return rows.flatMap((r) => {
      const conv = toConversation(r);
      const agent = conv.agentId ? this.getAgent(conv.agentId) : null;
      return agent ? [{ conversation: conv, agent }] : [];
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

  // ---- delivery ----

  createDelivery(
    input: {
      conversationId: string;
      provider: DeliveryProviderKind;
      changeUrl?: string | null;
      externalId?: string | null;
      headBranch?: string | null;
      baseBranch?: string | null;
      deploymentRequired?: boolean;
    },
    now: number,
  ): Delivery {
    const id = newId("delivery");
    this.db.run(
      `INSERT INTO deliveries
       (id, conversation_id, provider, change_url, external_id, head_branch, base_branch, deployment_status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?, ?,?,?)`,
      [
        id,
        input.conversationId,
        input.provider,
        input.changeUrl ?? null,
        input.externalId ?? null,
        input.headBranch ?? null,
        input.baseBranch ?? null,
        input.deploymentRequired ? "pending" : "not_required",
        now,
        now,
      ],
    );
    this.db.run("UPDATE conversations SET updated_at = ? WHERE id = ?", [now, input.conversationId]);
    return this.getDelivery(id)!;
  }

  getDelivery(id: string): Delivery | null {
    const row = this.db.query<DeliveryRow, [string]>("SELECT * FROM deliveries WHERE id = ?").get(id);
    return row ? toDelivery(row) : null;
  }

  getDeliveryForConversation(conversationId: string): Delivery | null {
    const row = this.db
      .query<DeliveryRow, [string]>("SELECT * FROM deliveries WHERE conversation_id = ?")
      .get(conversationId);
    return row ? toDelivery(row) : null;
  }

  updateDeliveryMetadata(
    id: string,
    patch: { changeUrl?: string | null; externalId?: string | null; headBranch?: string | null; baseBranch?: string | null },
    now: number,
  ): void {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    const fields: [keyof typeof patch, string][] = [
      ["changeUrl", "change_url"],
      ["externalId", "external_id"],
      ["headBranch", "head_branch"],
      ["baseBranch", "base_branch"],
    ];
    for (const [key, column] of fields) {
      if (!(key in patch)) continue;
      sets.push(`${column} = ?`);
      params.push(patch[key] ?? null);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    params.push(now, id);
    this.db.run(`UPDATE deliveries SET ${sets.join(", ")} WHERE id = ?`, params);
    this.touchDeliveryConversation(id, now);
  }

  updateDeliveryState(
    id: string,
    patch: {
      reviewStatus?: DeliveryReviewStatus;
      checkStatus?: DeliveryCheckStatus;
      mergeStatus?: DeliveryMergeStatus;
      deploymentStatus?: DeliveryDeploymentStatus;
      reviewApprovedAt?: number | null;
      mergedAt?: number | null;
      deployedAt?: number | null;
    },
    now: number,
  ): void {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    const fields: [keyof typeof patch, string][] = [
      ["reviewStatus", "review_status"],
      ["checkStatus", "check_status"],
      ["mergeStatus", "merge_status"],
      ["deploymentStatus", "deployment_status"],
      ["reviewApprovedAt", "review_approved_at"],
      ["mergedAt", "merged_at"],
      ["deployedAt", "deployed_at"],
    ];
    for (const [key, column] of fields) {
      if (!(key in patch)) continue;
      sets.push(`${column} = ?`);
      params.push(patch[key] ?? null);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    params.push(now, id);
    this.db.run(`UPDATE deliveries SET ${sets.join(", ")} WHERE id = ?`, params);
    this.touchDeliveryConversation(id, now);
  }

  appendDeliveryEvent(
    deliveryId: string,
    kind: string,
    data: unknown,
    actor: DeliveryEvent["actor"],
    now: number,
  ): void {
    this.db.run(
      "INSERT INTO delivery_events (delivery_id, kind, data, actor, ts) VALUES (?,?,?,?,?)",
      [deliveryId, kind, JSON.stringify(data ?? {}), actor, now],
    );
  }

  listDeliveryEvents(deliveryId: string): DeliveryEvent[] {
    return this.db
      .query<DeliveryEventRow, [string]>("SELECT * FROM delivery_events WHERE delivery_id = ? ORDER BY ts, rowid")
      .all(deliveryId)
      .map(toDeliveryEvent);
  }

  private touchDeliveryConversation(deliveryId: string, now: number): void {
    this.db.run(
      `UPDATE conversations SET updated_at = ?
       WHERE id = (SELECT conversation_id FROM deliveries WHERE id = ?)`,
      [now, deliveryId],
    );
  }

  // ---- runs ----

  createRun(
    r: {
      conversationId: string;
      agentId: string;
      deviceId: string;
      prompt: string;
      purpose?: RunPurpose;
      promptEvent: PromptEventBlockKey;
      triggerRef?: string | null;
    },
    now: number,
  ): Run {
    const id = newId("run");
    this.db.run(
      `INSERT INTO runs (id, conversation_id, agent_id, device_id, prompt, purpose, prompt_event, trigger_ref, status, queued_at)
       VALUES (?,?,?,?,?,?,?,?,'queued',?)`,
      [id, r.conversationId, r.agentId, r.deviceId, r.prompt, r.purpose ?? "implementation", r.promptEvent, r.triggerRef ?? null, now],
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

  latestRunForConversation(conversationId: string): Run | null {
    const r = this.db
      .query<RunRow, [string]>("SELECT * FROM runs WHERE conversation_id = ? ORDER BY queued_at DESC LIMIT 1")
      .get(conversationId);
    return r ? toRun(r) : null;
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

  // ---- prompt_blocks（session context + event trigger） ----

  getPromptBlock(key: PromptBlockKey): PromptBlockOverride | null {
    const r = this.db
      .query<PromptBlockRow, [string]>("SELECT * FROM prompt_blocks WHERE block_key = ?")
      .get(key);
    return r
      ? {
          key: r.block_key as PromptBlockKey,
          enabled: r.enabled === 1,
          template: r.template,
          updatedAt: r.updated_at,
        }
      : null;
  }

  setPromptBlock(key: PromptBlockKey, enabled: boolean, template: string, now: number): void {
    this.db.run(
      `INSERT INTO prompt_blocks (block_key, enabled, template, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(block_key) DO UPDATE SET enabled = excluded.enabled, template = excluded.template, updated_at = excluded.updated_at`,
      [key, enabled ? 1 : 0, template, now],
    );
  }

  resetPromptBlock(key: PromptBlockKey): void {
    this.db.run("DELETE FROM prompt_blocks WHERE block_key = ?", [key]);
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

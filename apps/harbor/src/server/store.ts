/**
 * 领域表 CRUD —— 全部 SQL 收口在这一层，行(snake_case) ↔ 领域类型(camelCase) 映射也在这。
 * 上层（rest/ws/scheduler/statemachine）只见领域类型。
 */

import type { Database } from "bun:sqlite";
import type { AgentEvent, Cost } from "@sm/agent";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import type {
  Approval,
  ApprovalStatus,
  Automation,
  AutomationLogRow,
  AutomationMode,
  AutomationOutputMode,
  AutomationOverlapMode,
  AutomationTrigger,
  AutomationTriggerType,
  AutomationWebhookFilter,
  BackendKind,
  Conversation,
  ConversationKind,
  ConversationMessage,
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
  HarborRepository,
  HarborSkill,
  HarborWorkspace,
  IsolationKind,
  IssuePriority,
  IssueLabel,
  LarkWorkspaceBinding,
  Origin,
  PromptBlockKey,
  PromptEventBlockKey,
  Run,
  RunAttachment,
  RunEventRow,
  RunPurpose,
  RunSourceType,
  RunStatus,
  RepositoryMount,
  ScmEvent,
  ScmExternalObject,
  ScmObjectKind,
  SkillDependency,
  SkillFile,
  SkillGroup,
  SkillSource,
  UsageRow,
  WorkspaceMember,
  WorkspaceRole,
} from "../protocol.js";
import { DEFAULT_WORKSPACE_ID } from "../protocol.js";
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
  workspace_id: string;
  name: string;
  description: string | null;
  device_id: string;
  backend: string;
  model: string | null;
  permission: string;
  repository_id: string;
  isolation: string;
  instruction: string | null;
  concurrency: number;
  visibility: string;
  environment: string;
  setup_script: string | null;
  reuse_device_cli: number;
  created_by_member_id: string | null;
  created_at: number;
  archived_at: number | null;
}

interface SkillRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  source: string;
  instruction: string;
  device_id: string | null;
  source_path: string | null;
  runtimes: string;
  group_id: string | null;
  origin_url: string | null;
  source_ref: string | null;
  entry_hash: string;
  bundle_hash: string;
  auto_sync: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

interface ConversationRow {
  id: string;
  workspace_id: string;
  kind: string;
  title: string | null;
  agent_id: string | null;
  description: string | null;
  priority: string;
  status: string;
  repository_id: string | null;
  worktree_path: string | null;
  worktree_mount_id: string | null;
  claude_session_id: string | null;
  origin: string;
  origin_ref: string | null;
  creator_member_id: string | null;
  owner_member_id: string | null;
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
  workspace_id: string;
  source_type: string;
  source_id: string;
  conversation_id: string | null;
  agent_id: string;
  device_id: string;
  repository_id: string | null;
  repository_mount_id: string | null;
  execution_root: string | null;
  prompt: string;
  purpose: string;
  prompt_event: string;
  trigger_ref: string | null;
  trigger_context: string;
  concurrency_key: string | null;
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
  workspace_id: string;
  name: string;
  agent_id: string;
  repository_id: string | null;
  prompt: string;
  output_mode: string;
  overlap_mode: string;
  target_conversation_id: string | null;
  notify_chat_id: string | null;
  enabled: number;
  last_fired_at: number | null;
  created_at: number;
  updated_at: number;
}

interface AutomationTriggerRow {
  id: string;
  automation_id: string;
  type: string;
  enabled: number;
  cron: string | null;
  provider: string | null;
  events: string;
  filters: string;
  secret_hash: string | null;
  last_fired_at: number | null;
  created_at: number;
  updated_at: number;
}

interface PromptBlockRow {
  workspace_id: string;
  block_key: string;
  enabled: number;
  template: string;
  updated_at: number;
}

interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  created_at: number;
  archived_at: number | null;
}

interface RepositoryRow {
  id: string;
  workspace_id: string;
  name: string;
  remote_url: string | null;
  default_branch: string;
  scm_provider: string;
  scm_repository: string | null;
  scm_agent_id: string | null;
  scm_auto_dispatch: number;
  created_at: number;
  archived_at: number | null;
}

interface RepositoryMountRow {
  id: string;
  repository_id: string;
  device_id: string;
  path: string;
  created_at: number;
}

function parseStringRecord(value: string): Record<string, string> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeSkillFiles(instruction: string, files?: { path: string; content: string }[]): SkillFile[] {
  const source = files?.length ? files : [{ path: "SKILL.md", content: instruction }];
  return source.map((file) => ({ ...file, sha256: sha256(file.content) }));
}

function hashSkillBundle(files: SkillFile[]): string {
  return sha256(files.map((file) => `${file.path}\0${file.sha256}`).join("\n"));
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

function toWorkspace(r: WorkspaceRow): HarborWorkspace {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    description: r.description,
    createdAt: r.created_at,
    archivedAt: r.archived_at,
  };
}

function toRepository(r: RepositoryRow): HarborRepository {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    remoteUrl: r.remote_url,
    defaultBranch: r.default_branch,
    scmProvider: r.scm_provider as HarborRepository["scmProvider"],
    scmRepository: r.scm_repository,
    scmAgentId: r.scm_agent_id,
    scmAutoDispatch: r.scm_auto_dispatch === 1,
    createdAt: r.created_at,
    archivedAt: r.archived_at,
  };
}

function toRepositoryMount(r: RepositoryMountRow): RepositoryMount {
  return {
    id: r.id,
    repositoryId: r.repository_id,
    deviceId: r.device_id,
    path: r.path,
    createdAt: r.created_at,
  };
}

function toAgent(r: AgentRow): HarborAgent {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    description: r.description,
    deviceId: r.device_id,
    backend: r.backend as BackendKind,
    model: r.model,
    permission: r.permission as PermissionPolicy,
    repositoryId: r.repository_id,
    repositoryIds: [],
    isolation: r.isolation as IsolationKind,
    concurrency: r.concurrency,
    visibility: r.visibility as HarborAgent["visibility"],
    environment: parseStringRecord(r.environment),
    setupScript: r.setup_script,
    reuseDeviceCli: r.reuse_device_cli === 1,
    createdByMemberId: r.created_by_member_id,
    instruction: r.instruction,
    skillIds: [],
    createdAt: r.created_at,
    archivedAt: r.archived_at,
  };
}

function toSkill(r: SkillRow): HarborSkill {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    description: r.description,
    source: r.source as SkillSource,
    instruction: r.instruction,
    deviceId: r.device_id,
    sourcePath: r.source_path,
    runtimes: JSON.parse(r.runtimes) as BackendKind[],
    groupId: r.group_id,
    originUrl: r.origin_url,
    sourceRef: r.source_ref,
    entryHash: r.entry_hash,
    bundleHash: r.bundle_hash,
    autoSync: r.auto_sync === 1,
    files: [],
    dependencies: [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    archivedAt: r.archived_at,
  };
}

function toConversation(r: ConversationRow): Conversation {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    kind: r.kind as ConversationKind,
    title: r.title,
    agentId: r.agent_id,
    description: r.description,
    priority: r.priority as IssuePriority,
    status: r.status as ConversationStatus,
    repositoryId: r.repository_id,
    worktreePath: r.worktree_path,
    worktreeMountId: r.worktree_mount_id,
    claudeSessionId: r.claude_session_id,
    origin: r.origin as Origin,
    originRef: r.origin_ref,
    creatorMemberId: r.creator_member_id,
    ownerMemberId: r.owner_member_id,
    labelIds: [],
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
    workspaceId: r.workspace_id,
    sourceType: r.source_type as RunSourceType,
    sourceId: r.source_id,
    conversationId: r.conversation_id,
    agentId: r.agent_id,
    deviceId: r.device_id,
    repositoryId: r.repository_id,
    repositoryMountId: r.repository_mount_id,
    executionRoot: r.execution_root,
    prompt: r.prompt,
    purpose: r.purpose as RunPurpose,
    promptEvent: r.prompt_event as PromptEventBlockKey,
    triggerRef: r.trigger_ref,
    triggerContext: parseJsonRecord(r.trigger_context),
    concurrencyKey: r.concurrency_key,
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

function toAutomationTrigger(r: AutomationTriggerRow): AutomationTrigger {
  return {
    id: r.id,
    automationId: r.automation_id,
    type: r.type as AutomationTriggerType,
    enabled: r.enabled === 1,
    cron: r.cron,
    provider: r.provider,
    events: parseJsonArray<string>(r.events),
    filters: parseJsonArray<AutomationWebhookFilter>(r.filters),
    webhookPath: r.type === "webhook" ? `/hooks/automations/${r.id}` : null,
    lastFiredAt: r.last_fired_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toAutomation(r: AutomationRow, triggers: AutomationTrigger[]): Automation {
  const outputMode = r.output_mode as AutomationOutputMode;
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    agentId: r.agent_id,
    repositoryId: r.repository_id,
    prompt: r.prompt,
    outputMode,
    overlapMode: r.overlap_mode as AutomationOverlapMode,
    targetConversationId: r.target_conversation_id,
    notifyChatId: r.notify_chat_id,
    enabled: r.enabled === 1,
    lastFiredAt: r.last_fired_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    triggers,
    cron: triggers.find((trigger) => trigger.type === "schedule")?.cron ?? null,
    mode: outputMode === "append" ? "append" : "new_issue",
  };
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseJsonArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

// ── Store ───────────────────────────────────────────────

export class HarborStore {
  constructor(private db: Database) {}

  // ---- workspaces / repositories ----

  defaultWorkspace(): HarborWorkspace {
    const workspace = this.getWorkspace(DEFAULT_WORKSPACE_ID);
    if (!workspace) throw new Error("默认 Workspace 不存在；SQLite migration 未完成");
    return workspace;
  }

  createWorkspace(
    input: { name: string; slug: string; description?: string | null; ownerName?: string },
    now: number,
  ): HarborWorkspace {
    const id = newId("workspace");
    this.db.transaction(() => {
      this.db.run(
        "INSERT INTO workspaces (id, name, slug, description, created_at) VALUES (?,?,?,?,?)",
        [id, input.name, input.slug, input.description ?? null, now],
      );
      this.createWorkspaceMember({
        workspaceId: id,
        name: input.ownerName ?? "Local owner",
        role: "owner",
        externalProvider: "local",
      }, now);
    })();
    return this.getWorkspace(id)!;
  }

  createWorkspaceMember(input: {
    workspaceId: string;
    name: string;
    email?: string | null;
    externalProvider?: WorkspaceMember["externalProvider"];
    externalId?: string | null;
    role?: WorkspaceRole;
    status?: WorkspaceMember["status"];
  }, now: number): WorkspaceMember {
    const id = newId("member");
    this.db.run(
      `INSERT INTO workspace_members
       (id, workspace_id, name, email, external_provider, external_id, role, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, input.workspaceId, input.name, input.email ?? null, input.externalProvider ?? "local",
       input.externalId ?? null, input.role ?? "member", input.status ?? "active", now],
    );
    return this.getWorkspaceMember(id)!;
  }

  getWorkspaceMember(id: string): WorkspaceMember | null {
    const row = this.db.query<{
      id: string; workspace_id: string; name: string; email: string | null; external_provider: string;
      external_id: string | null; role: string; status: string; created_at: number;
    }, [string]>("SELECT * FROM workspace_members WHERE id = ?").get(id);
    return row ? {
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      email: row.email,
      externalProvider: row.external_provider as WorkspaceMember["externalProvider"],
      externalId: row.external_id,
      role: row.role as WorkspaceRole,
      status: row.status as WorkspaceMember["status"],
      createdAt: row.created_at,
    } : null;
  }

  listWorkspaceMembers(workspaceId: string): WorkspaceMember[] {
    return this.db.query<{ id: string }, [string]>(
      "SELECT id FROM workspace_members WHERE workspace_id = ? ORDER BY created_at",
    ).all(workspaceId).map((row) => this.getWorkspaceMember(row.id)!);
  }

  updateWorkspaceMember(id: string, patch: { role?: WorkspaceRole; status?: WorkspaceMember["status"] }): void {
    const sets: string[] = [];
    const params: string[] = [];
    if (patch.role !== undefined) { sets.push("role = ?"); params.push(patch.role); }
    if (patch.status !== undefined) { sets.push("status = ?"); params.push(patch.status); }
    if (!sets.length) return;
    params.push(id);
    this.db.run(`UPDATE workspace_members SET ${sets.join(", ")} WHERE id = ?`, params);
  }

  createWorkspaceApiToken(workspaceId: string, memberId: string, label: string, tokenHash: string, now: number): string {
    const id = newId("token");
    this.db.run(
      `INSERT INTO workspace_api_tokens
       (id, workspace_id, member_id, label, token_hash, created_at) VALUES (?,?,?,?,?,?)`,
      [id, workspaceId, memberId, label, tokenHash, now],
    );
    return id;
  }

  memberForApiToken(tokenHash: string, now: number): WorkspaceMember | null {
    const row = this.db.query<{ id: string }, [string]>(
      `SELECT m.id FROM workspace_api_tokens t JOIN workspace_members m ON m.id = t.member_id
       WHERE t.token_hash = ? AND t.revoked_at IS NULL AND m.status = 'active'`,
    ).get(tokenHash);
    if (!row) return null;
    this.db.run("UPDATE workspace_api_tokens SET last_used_at = ? WHERE token_hash = ?", [now, tokenHash]);
    return this.getWorkspaceMember(row.id);
  }

  revokeWorkspaceApiToken(id: string, now: number): void {
    this.db.run("UPDATE workspace_api_tokens SET revoked_at = ? WHERE id = ?", [now, id]);
  }

  listWorkspaceApiTokens(workspaceId: string): {
    id: string;
    workspaceId: string;
    memberId: string;
    label: string;
    createdAt: number;
    lastUsedAt: number | null;
    revokedAt: number | null;
  }[] {
    return this.db.query<{
      id: string; workspace_id: string; member_id: string; label: string;
      created_at: number; last_used_at: number | null; revoked_at: number | null;
    }, [string]>(
      "SELECT id, workspace_id, member_id, label, created_at, last_used_at, revoked_at FROM workspace_api_tokens WHERE workspace_id = ? ORDER BY created_at DESC",
    ).all(workspaceId).map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      memberId: row.member_id,
      label: row.label,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at,
    }));
  }

  countActiveWorkspaceOwners(workspaceId: string): number {
    return this.db.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id = ? AND role = 'owner' AND status = 'active'",
    ).get(workspaceId)?.count ?? 0;
  }

  getWorkspace(id: string): HarborWorkspace | null {
    const row = this.db.query<WorkspaceRow, [string]>("SELECT * FROM workspaces WHERE id = ?").get(id);
    return row ? toWorkspace(row) : null;
  }

  resolveWorkspace(key: string): HarborWorkspace | null {
    const rows = this.db
      .query<WorkspaceRow, [string, string, string]>(
        "SELECT * FROM workspaces WHERE id = ? OR slug = ? OR name = ? LIMIT 2",
      )
      .all(key, key, key);
    if (rows.length > 1) throw new Error(`workspace "${key}" 有多个匹配，请使用 id`);
    return rows[0] ? toWorkspace(rows[0]) : null;
  }

  listWorkspaces(includeArchived = false): HarborWorkspace[] {
    const sql = includeArchived
      ? "SELECT * FROM workspaces ORDER BY created_at"
      : "SELECT * FROM workspaces WHERE archived_at IS NULL ORDER BY created_at";
    return this.db.query<WorkspaceRow, []>(sql).all().map(toWorkspace);
  }

  updateWorkspace(
    id: string,
    patch: { name?: string; slug?: string; description?: string | null; archived?: boolean },
    now: number,
  ): void {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.name !== undefined) { sets.push("name = ?"); params.push(patch.name); }
    if (patch.slug !== undefined) { sets.push("slug = ?"); params.push(patch.slug); }
    if (patch.description !== undefined) { sets.push("description = ?"); params.push(patch.description); }
    if (patch.archived !== undefined) { sets.push("archived_at = ?"); params.push(patch.archived ? now : null); }
    if (sets.length === 0) return;
    params.push(id);
    this.db.run(`UPDATE workspaces SET ${sets.join(", ")} WHERE id = ?`, params);
  }

  createRepository(
    input: {
      workspaceId: string;
      name: string;
      remoteUrl?: string | null;
      defaultBranch?: string;
      scmProvider?: HarborRepository["scmProvider"];
      scmRepository?: string | null;
      scmAgentId?: string | null;
      scmAutoDispatch?: boolean;
    },
    now: number,
  ): HarborRepository {
    const id = newId("repository");
    this.db.run(
      `INSERT INTO repositories
       (id, workspace_id, name, remote_url, default_branch, scm_provider, scm_repository,
        scm_agent_id, scm_auto_dispatch, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        input.workspaceId,
        input.name,
        input.remoteUrl ?? null,
        input.defaultBranch ?? "main",
        input.scmProvider ?? "local",
        input.scmRepository ?? null,
        input.scmAgentId ?? null,
        input.scmAutoDispatch ? 1 : 0,
        now,
      ],
    );
    return this.getRepository(id)!;
  }

  getRepository(id: string): HarborRepository | null {
    const row = this.db.query<RepositoryRow, [string]>("SELECT * FROM repositories WHERE id = ?").get(id);
    return row ? toRepository(row) : null;
  }

  getRepositoryByName(workspaceId: string, name: string): HarborRepository | null {
    const row = this.db
      .query<RepositoryRow, [string, string]>("SELECT * FROM repositories WHERE workspace_id = ? AND name = ?")
      .get(workspaceId, name);
    return row ? toRepository(row) : null;
  }

  resolveRepository(workspaceId: string, key: string): HarborRepository | null {
    const rows = this.db
      .query<RepositoryRow, [string, string, string]>(
        "SELECT * FROM repositories WHERE workspace_id = ? AND (id = ? OR name = ?) LIMIT 2",
      )
      .all(workspaceId, key, key);
    if (rows.length > 1) throw new Error(`repository "${key}" 有多个匹配，请使用 id`);
    return rows[0] ? toRepository(rows[0]) : null;
  }

  listRepositories(workspaceId: string, includeArchived = false): HarborRepository[] {
    const sql = includeArchived
      ? "SELECT * FROM repositories WHERE workspace_id = ? ORDER BY name"
      : "SELECT * FROM repositories WHERE workspace_id = ? AND archived_at IS NULL ORDER BY name";
    return this.db.query<RepositoryRow, [string]>(sql).all(workspaceId).map(toRepository);
  }

  updateRepository(
    id: string,
    patch: {
      name?: string;
      remoteUrl?: string | null;
      defaultBranch?: string;
      scmProvider?: HarborRepository["scmProvider"];
      scmRepository?: string | null;
      scmAgentId?: string | null;
      scmAutoDispatch?: boolean;
      archived?: boolean;
    },
    now: number,
  ): void {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.name !== undefined) { sets.push("name = ?"); params.push(patch.name); }
    if (patch.remoteUrl !== undefined) { sets.push("remote_url = ?"); params.push(patch.remoteUrl); }
    if (patch.defaultBranch !== undefined) { sets.push("default_branch = ?"); params.push(patch.defaultBranch); }
    if (patch.scmProvider !== undefined) { sets.push("scm_provider = ?"); params.push(patch.scmProvider); }
    if (patch.scmRepository !== undefined) { sets.push("scm_repository = ?"); params.push(patch.scmRepository); }
    if (patch.scmAgentId !== undefined) { sets.push("scm_agent_id = ?"); params.push(patch.scmAgentId); }
    if (patch.scmAutoDispatch !== undefined) { sets.push("scm_auto_dispatch = ?"); params.push(patch.scmAutoDispatch ? 1 : 0); }
    if (patch.archived !== undefined) { sets.push("archived_at = ?"); params.push(patch.archived ? now : null); }
    if (sets.length === 0) return;
    params.push(id);
    this.db.run(`UPDATE repositories SET ${sets.join(", ")} WHERE id = ?`, params);
  }

  listRepositoryMounts(repositoryId: string): RepositoryMount[] {
    return this.db
      .query<RepositoryMountRow, [string]>("SELECT * FROM repository_mounts WHERE repository_id = ? ORDER BY created_at")
      .all(repositoryId)
      .map(toRepositoryMount);
  }

  getRepositoryMount(id: string): RepositoryMount | null {
    const row = this.db.query<RepositoryMountRow, [string]>("SELECT * FROM repository_mounts WHERE id = ?").get(id);
    return row ? toRepositoryMount(row) : null;
  }

  getRepositoryMountForDevice(repositoryId: string, deviceId: string): RepositoryMount | null {
    const row = this.db
      .query<RepositoryMountRow, [string, string]>(
        "SELECT * FROM repository_mounts WHERE repository_id = ? AND device_id = ?",
      )
      .get(repositoryId, deviceId);
    return row ? toRepositoryMount(row) : null;
  }

  setRepositoryMount(repositoryId: string, deviceId: string, path: string, now: number): RepositoryMount {
    const existing = this.getRepositoryMountForDevice(repositoryId, deviceId);
    if (existing) {
      this.db.run("UPDATE repository_mounts SET path = ? WHERE id = ?", [path, existing.id]);
      return this.getRepositoryMount(existing.id)!;
    }
    const id = newId("repositoryMount");
    this.db.run(
      "INSERT INTO repository_mounts (id, repository_id, device_id, path, created_at) VALUES (?,?,?,?,?)",
      [id, repositoryId, deviceId, path, now],
    );
    return this.getRepositoryMount(id)!;
  }

  deleteRepositoryMount(id: string): void {
    this.db.run("DELETE FROM repository_mounts WHERE id = ?", [id]);
  }

  repositoryMountUsage(id: string): { runs: number; activeRuns: number; worktrees: number; agents: number; conversations: number } {
    const mount = this.getRepositoryMount(id);
    if (!mount) return { runs: 0, activeRuns: 0, worktrees: 0, agents: 0, conversations: 0 };
    const runs = this.db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM runs WHERE repository_mount_id = ?").get(id)?.count ?? 0;
    const activeRuns = this.db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM runs WHERE repository_mount_id = ? AND status IN ('queued','running')").get(id)?.count ?? 0;
    const worktrees = this.db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM conversations WHERE worktree_mount_id = ?").get(id)?.count ?? 0;
    const agents = this.db.query<{ count: number }, [string, string]>(
      "SELECT COUNT(*) AS count FROM agents WHERE repository_id = ? AND device_id = ? AND archived_at IS NULL",
    ).get(mount.repositoryId, mount.deviceId)?.count ?? 0;
    const conversations = this.db.query<{ count: number }, [string, string]>(
      `SELECT COUNT(*) AS count FROM conversations c JOIN agents a ON a.id = c.agent_id
       WHERE c.repository_id = ? AND a.device_id = ? AND c.status NOT IN ('done','canceled')`,
    ).get(mount.repositoryId, mount.deviceId)?.count ?? 0;
    return { runs, activeRuns, worktrees, agents, conversations };
  }

  /** 旧 CLI --workdir 兼容：同 Workspace + Device + path 复用 mount，否则注册 Repository。 */
  ensureRepositoryForPath(workspaceId: string, deviceId: string, path: string, now: number): HarborRepository {
    const existing = this.db
      .query<RepositoryRow, [string, string, string]>(
        `SELECT r.* FROM repositories r JOIN repository_mounts m ON m.repository_id = r.id
         WHERE r.workspace_id = ? AND m.device_id = ? AND m.path = ? LIMIT 1`,
      )
      .get(workspaceId, deviceId, path);
    if (existing) return toRepository(existing);
    const base = basename(path.replace(/\/$/, "")) || "repository";
    let name = base;
    let n = 2;
    while (this.getRepositoryByName(workspaceId, name)) name = `${base} (${n++})`;
    const repository = this.createRepository({ workspaceId, name }, now);
    this.setRepositoryMount(repository.id, deviceId, path, now);
    return repository;
  }

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
      const device = toDevice({ ...existing, capabilities: JSON.stringify(capabilities), last_seen_at: now }, true);
      this.autoSyncRuntimeSkills(device, now);
      return device;
    }
    const id = newId("device");
    this.db.run(
      "INSERT INTO devices (id, name, token_hash, capabilities, last_seen_at, created_at) VALUES (?,?,?,?,?,?)",
      [id, name, tokenHash, JSON.stringify(capabilities), now, now],
    );
    const device = this.getDevice(id, true)!;
    this.autoSyncRuntimeSkills(device, now);
    return device;
  }

  private autoSyncRuntimeSkills(device: Device, now: number): void {
    for (const local of device.capabilities.installedSkills ?? []) {
      const rows = this.db.query<SkillRow, [string, string]>(
        `SELECT * FROM skills WHERE source = 'runtime' AND device_id = ? AND source_path = ?
         AND auto_sync = 1 AND archived_at IS NULL`,
      ).all(device.id, local.path);
      for (const row of rows) {
        this.updateSkill(row.id, {
          name: local.name,
          description: local.description,
          instruction: local.instruction ?? row.instruction,
          runtimes: local.runtimes,
          files: local.files,
          dependencies: local.dependencies ?? [],
        }, now);
      }
    }
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
    workspaceId?: string;
    name: string;
    description?: string | null;
    deviceId: string;
    backend: BackendKind;
    model?: string | null;
    permission?: PermissionPolicy;
    repositoryId?: string;
    /** @deprecated REST/CLI compatibility; converted to Repository + mount immediately. */
    workdir?: string;
    isolation?: IsolationKind;
    instruction?: string | null;
    repositoryIds?: string[];
    concurrency?: number;
    visibility?: HarborAgent["visibility"];
    environment?: Record<string, string>;
    setupScript?: string | null;
    reuseDeviceCli?: boolean;
    createdByMemberId?: string | null;
  }, now: number): HarborAgent {
    const id = newId("agent");
    const workspaceId = a.workspaceId ?? DEFAULT_WORKSPACE_ID;
    const repositoryId =
      a.repositoryId === undefined && a.workdir
        ? this.ensureRepositoryForPath(workspaceId, a.deviceId, a.workdir, now).id
        : a.repositoryId;
    if (!repositoryId) throw new Error(`Agent "${a.name}" 必须绑定 Repository`);
    const repositoryIds = [...new Set([repositoryId, ...(a.repositoryIds ?? [])])];
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO agents
         (id, workspace_id, name, description, device_id, backend, model, permission, repository_id,
          isolation, instruction, concurrency, visibility, environment, setup_script, reuse_device_cli,
          created_by_member_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          workspaceId,
          a.name,
          a.description ?? null,
          a.deviceId,
          a.backend,
          a.model ?? null,
          a.permission ?? "auto-edit",
          repositoryId,
          a.isolation ?? "none",
          a.instruction ?? null,
          a.concurrency ?? 1,
          a.visibility ?? "workspace",
          JSON.stringify(a.environment ?? {}),
          a.setupScript ?? null,
          a.reuseDeviceCli === false ? 0 : 1,
          a.createdByMemberId ?? null,
          now,
        ],
      );
      const insert = this.db.prepare(
        "INSERT INTO agent_repositories (agent_id, repository_id, position, is_primary, created_at) VALUES (?,?,?,?,?)",
      );
      repositoryIds.forEach((candidate, position) => insert.run(id, candidate, position, candidate === repositoryId ? 1 : 0, now));
    })();
    return this.getAgent(id)!;
  }

  getAgent(id: string): HarborAgent | null {
    const r = this.db.query<AgentRow, [string]>("SELECT * FROM agents WHERE id = ?").get(id);
    return r ? this.withAgentSkills(toAgent(r)) : null;
  }

  getAgentByName(name: string): HarborAgent | null {
    const rows = this.db.query<AgentRow, [string]>("SELECT * FROM agents WHERE name = ? LIMIT 2").all(name);
    if (rows.length > 1) throw new Error(`agent 名 "${name}" 存在于多个 Workspace，请使用 id`);
    return rows[0] ? this.withAgentSkills(toAgent(rows[0])) : null;
  }

  getAgentByNameInWorkspace(workspaceId: string, name: string): HarborAgent | null {
    const r = this.db
      .query<AgentRow, [string, string]>("SELECT * FROM agents WHERE workspace_id = ? AND name = ?")
      .get(workspaceId, name);
    return r ? this.withAgentSkills(toAgent(r)) : null;
  }

  /** 归档 = 软删除（不出现在派活下拉，历史 run/conversation 引用不悬空）；archived=false 可恢复 */
  setAgentArchived(id: string, archived: boolean, now: number): void {
    this.db.run("UPDATE agents SET archived_at = ? WHERE id = ?", [archived ? now : null, id]);
  }

  setAgentRepository(id: string, repositoryId: string): void {
    this.db.transaction(() => {
      this.db.run("UPDATE agents SET repository_id = ? WHERE id = ?", [repositoryId, id]);
      this.db.run("UPDATE agent_repositories SET is_primary = 0 WHERE agent_id = ?", [id]);
      this.db.run(
        `INSERT INTO agent_repositories (agent_id, repository_id, position, is_primary, created_at)
         VALUES (?, ?, COALESCE((SELECT MAX(position) + 1 FROM agent_repositories WHERE agent_id = ?), 0), 1,
                 CAST(strftime('%s','now') AS INTEGER) * 1000)
         ON CONFLICT(agent_id, repository_id) DO UPDATE SET is_primary = 1`,
        [id, repositoryId, id],
      );
    })();
  }

  setAgentRepositories(id: string, repositoryIds: string[], primaryRepositoryId: string, now: number): void {
    const ids = [...new Set([primaryRepositoryId, ...repositoryIds])];
    this.db.transaction(() => {
      this.db.run("UPDATE agents SET repository_id = ? WHERE id = ?", [primaryRepositoryId, id]);
      this.db.run("DELETE FROM agent_repositories WHERE agent_id = ?", [id]);
      const insert = this.db.prepare(
        "INSERT INTO agent_repositories (agent_id, repository_id, position, is_primary, created_at) VALUES (?,?,?,?,?)",
      );
      ids.forEach((repositoryId, position) =>
        insert.run(id, repositoryId, position, repositoryId === primaryRepositoryId ? 1 : 0, now));
    })();
  }

  updateAgentConfig(
    id: string,
    patch: {
      description?: string | null;
      model?: string | null;
      permission?: PermissionPolicy;
      isolation?: IsolationKind;
      instruction?: string | null;
      concurrency?: number;
      visibility?: HarborAgent["visibility"];
      environment?: Record<string, string>;
      setupScript?: string | null;
      reuseDeviceCli?: boolean;
    },
  ): void {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    const add = (column: string, value: string | number | null) => { sets.push(`${column} = ?`); params.push(value); };
    if (patch.description !== undefined) add("description", patch.description);
    if (patch.model !== undefined) add("model", patch.model);
    if (patch.permission !== undefined) add("permission", patch.permission);
    if (patch.isolation !== undefined) add("isolation", patch.isolation);
    if (patch.instruction !== undefined) add("instruction", patch.instruction);
    if (patch.concurrency !== undefined) add("concurrency", patch.concurrency);
    if (patch.visibility !== undefined) add("visibility", patch.visibility);
    if (patch.environment !== undefined) add("environment", JSON.stringify(patch.environment));
    if (patch.setupScript !== undefined) add("setup_script", patch.setupScript);
    if (patch.reuseDeviceCli !== undefined) add("reuse_device_cli", patch.reuseDeviceCli ? 1 : 0);
    if (sets.length === 0) return;
    params.push(id);
    this.db.run(`UPDATE agents SET ${sets.join(", ")} WHERE id = ?`, params);
  }

  agentRepositoryChangeBlocker(agentId: string): string | null {
    const run = this.db
      .query<{ id: string }, [string]>(
        "SELECT id FROM runs WHERE agent_id = ? AND status IN ('queued','running') LIMIT 1",
      )
      .get(agentId);
    if (run) return `Agent 仍有 active Run（${run.id}）`;
    const conversation = this.db
      .query<{ id: string }, [string]>(
        `SELECT id FROM conversations
         WHERE agent_id = ? AND worktree_path IS NOT NULL AND status NOT IN ('done','canceled') LIMIT 1`,
      )
      .get(agentId);
    return conversation ? `Issue ${conversation.id} 仍持有 worktree` : null;
  }

  listAgents(includeArchived = false, workspaceId?: string): HarborAgent[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (!includeArchived) clauses.push("archived_at IS NULL");
    if (workspaceId) { clauses.push("workspace_id = ?"); params.push(workspaceId); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .query<AgentRow, string[]>(`SELECT * FROM agents ${where} ORDER BY created_at`)
      .all(...params)
      .map((row) => this.withAgentSkills(toAgent(row)));
  }

  private withAgentSkills(agent: HarborAgent): HarborAgent {
    agent.skillIds = this.db
      .query<{ skill_id: string }, [string]>(
        "SELECT skill_id FROM agent_skills WHERE agent_id = ? ORDER BY position, created_at",
      )
      .all(agent.id)
      .map((row) => row.skill_id);
    agent.repositoryIds = this.db
      .query<{ repository_id: string }, [string]>(
        "SELECT repository_id FROM agent_repositories WHERE agent_id = ? ORDER BY position, created_at",
      )
      .all(agent.id)
      .map((row) => row.repository_id);
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

  createSkillGroup(workspaceId: string, name: string, position: number, now: number): SkillGroup {
    const id = newId("skillGroup");
    this.db.run(
      "INSERT INTO skill_groups (id, workspace_id, name, position, created_at) VALUES (?,?,?,?,?)",
      [id, workspaceId, name, position, now],
    );
    return this.getSkillGroup(id)!;
  }

  getSkillGroup(id: string): SkillGroup | null {
    const row = this.db.query<{ id: string; workspace_id: string; name: string; position: number; created_at: number }, [string]>(
      "SELECT * FROM skill_groups WHERE id = ?",
    ).get(id);
    return row ? { id: row.id, workspaceId: row.workspace_id, name: row.name, position: row.position, createdAt: row.created_at } : null;
  }

  listSkillGroups(workspaceId: string): SkillGroup[] {
    return this.db.query<{ id: string }, [string]>(
      "SELECT id FROM skill_groups WHERE workspace_id = ? ORDER BY position, created_at",
    ).all(workspaceId).map((row) => this.getSkillGroup(row.id)!);
  }

  updateSkillGroup(id: string, patch: { name?: string; position?: number }): void {
    const sets: string[] = [];
    const params: (string | number)[] = [];
    if (patch.name !== undefined) { sets.push("name = ?"); params.push(patch.name); }
    if (patch.position !== undefined) { sets.push("position = ?"); params.push(patch.position); }
    if (!sets.length) return;
    params.push(id);
    this.db.run(`UPDATE skill_groups SET ${sets.join(", ")} WHERE id = ?`, params);
  }

  deleteSkillGroup(id: string): void {
    this.db.run("DELETE FROM skill_groups WHERE id = ?", [id]);
  }

  createSkill(
    skill: {
      workspaceId?: string;
      name: string;
      description?: string;
      source: SkillSource;
      instruction: string;
      deviceId?: string | null;
      sourcePath?: string | null;
      runtimes?: BackendKind[];
      groupId?: string | null;
      originUrl?: string | null;
      sourceRef?: string | null;
      autoSync?: boolean;
      files?: { path: string; content: string }[];
      dependencies?: SkillDependency[];
    },
    now: number,
  ): HarborSkill {
    const id = newId("skill");
    const files = normalizeSkillFiles(skill.instruction, skill.files);
    const entry = files.find((file) => file.path === "SKILL.md") ?? files[0]!;
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO skills
         (id, workspace_id, name, description, source, instruction, device_id, source_path, runtimes,
          group_id, origin_url, source_ref, entry_hash, bundle_hash, auto_sync, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          skill.workspaceId ?? DEFAULT_WORKSPACE_ID,
          skill.name,
          skill.description ?? "",
          skill.source,
          skill.instruction,
          skill.deviceId ?? null,
          skill.sourcePath ?? null,
          JSON.stringify(skill.runtimes ?? ["claude", "codex"]),
          skill.groupId ?? null,
          skill.originUrl ?? null,
          skill.sourceRef ?? null,
          entry.sha256,
          hashSkillBundle(files),
          skill.autoSync ? 1 : 0,
          now,
          now,
        ],
      );
      this.replaceSkillFiles(id, files);
      this.replaceSkillDependencies(id, skill.dependencies ?? []);
    })();
    return this.getSkill(id)!;
  }

  getSkill(id: string): HarborSkill | null {
    const row = this.db.query<SkillRow, [string]>("SELECT * FROM skills WHERE id = ?").get(id);
    return row ? this.withSkillBundle(toSkill(row)) : null;
  }

  getSkillByName(name: string, workspaceId = DEFAULT_WORKSPACE_ID): HarborSkill | null {
    const row = this.db
      .query<SkillRow, [string, string]>("SELECT * FROM skills WHERE workspace_id = ? AND name = ?")
      .get(workspaceId, name);
    return row ? this.withSkillBundle(toSkill(row)) : null;
  }

  getRuntimeSkill(workspaceId: string, deviceId: string, sourcePath: string): HarborSkill | null {
    const row = this.db
      .query<SkillRow, [string, string, string]>(
        "SELECT * FROM skills WHERE workspace_id = ? AND source = 'runtime' AND device_id = ? AND source_path = ?",
      )
      .get(workspaceId, deviceId, sourcePath);
    return row ? this.withSkillBundle(toSkill(row)) : null;
  }

  listSkills(includeArchived = false, workspaceId?: string): HarborSkill[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (!includeArchived) clauses.push("archived_at IS NULL");
    if (workspaceId) { clauses.push("workspace_id = ?"); params.push(workspaceId); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .query<SkillRow, string[]>(`SELECT * FROM skills ${where} ORDER BY updated_at DESC, name`)
      .all(...params)
      .map((row) => this.withSkillBundle(toSkill(row)));
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
      .map((row) => this.withSkillBundle(toSkill(row)));
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
    patch: {
      name?: string;
      description?: string;
      instruction?: string;
      runtimes?: BackendKind[];
      groupId?: string | null;
      originUrl?: string | null;
      sourceRef?: string | null;
      autoSync?: boolean;
      files?: { path: string; content: string }[];
      dependencies?: SkillDependency[];
    },
    now: number,
  ): void {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
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
    if (patch.groupId !== undefined) { sets.push("group_id = ?"); params.push(patch.groupId); }
    if (patch.originUrl !== undefined) { sets.push("origin_url = ?"); params.push(patch.originUrl); }
    if (patch.sourceRef !== undefined) { sets.push("source_ref = ?"); params.push(patch.sourceRef); }
    if (patch.autoSync !== undefined) { sets.push("auto_sync = ?"); params.push(patch.autoSync ? 1 : 0); }
    const current = this.getSkill(id);
    const files = patch.files !== undefined
      ? normalizeSkillFiles(patch.instruction ?? current?.instruction ?? "", patch.files)
      : patch.instruction !== undefined
        ? normalizeSkillFiles(patch.instruction, current?.files.map((file) => ({
            path: file.path,
            content: file.path === "SKILL.md" ? patch.instruction! : file.content,
          })))
        : null;
    if (files) {
      const entry = files.find((file) => file.path === "SKILL.md") ?? files[0]!;
      sets.push("entry_hash = ?", "bundle_hash = ?");
      params.push(entry.sha256, hashSkillBundle(files));
    }
    if (sets.length === 0 && patch.dependencies === undefined) return;
    sets.push("updated_at = ?");
    params.push(now, id);
    this.db.transaction(() => {
      this.db.run(`UPDATE skills SET ${sets.join(", ")} WHERE id = ?`, params);
      if (files) this.replaceSkillFiles(id, files);
      if (patch.dependencies !== undefined) this.replaceSkillDependencies(id, patch.dependencies);
    })();
  }

  private withSkillBundle(skill: HarborSkill): HarborSkill {
    skill.files = this.db
      .query<{ path: string; content: string; sha256: string }, [string]>(
        "SELECT path, content, sha256 FROM skill_files WHERE skill_id = ? ORDER BY position, path",
      )
      .all(skill.id);
    skill.dependencies = this.db
      .query<{ name: string; spec: string | null; required: number }, [string]>(
        "SELECT name, spec, required FROM skill_dependencies WHERE skill_id = ? ORDER BY name",
      )
      .all(skill.id)
      .map((row) => ({ name: row.name, spec: row.spec, required: row.required === 1 }));
    return skill;
  }

  private replaceSkillFiles(skillId: string, files: SkillFile[]): void {
    this.db.run("DELETE FROM skill_files WHERE skill_id = ?", [skillId]);
    const insert = this.db.prepare(
      "INSERT INTO skill_files (skill_id, path, content, sha256, position) VALUES (?,?,?,?,?)",
    );
    files.forEach((file, position) => insert.run(skillId, file.path, file.content, file.sha256, position));
  }

  private replaceSkillDependencies(skillId: string, dependencies: SkillDependency[]): void {
    this.db.run("DELETE FROM skill_dependencies WHERE skill_id = ?", [skillId]);
    const insert = this.db.prepare(
      "INSERT INTO skill_dependencies (skill_id, name, spec, required) VALUES (?,?,?,?)",
    );
    dependencies.forEach((dependency) =>
      insert.run(skillId, dependency.name, dependency.spec, dependency.required ? 1 : 0));
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
    workspaceId?: string;
    kind: ConversationKind;
    title?: string | null;
    agentId?: string | null;
    description?: string | null;
    priority?: IssuePriority;
    repositoryId?: string | null;
    origin?: Origin;
    originRef?: string | null;
    creatorMemberId?: string | null;
    ownerMemberId?: string | null;
    labelIds?: string[];
  }, now: number): Conversation {
    const id = newId("conversation");
    const status: ConversationStatus = c.kind === "issue" ? "backlog" : "open";
    const agent = c.agentId ? this.getAgent(c.agentId) : null;
    const workspaceId = c.workspaceId ?? agent?.workspaceId ?? DEFAULT_WORKSPACE_ID;
    const repositoryId = c.repositoryId === undefined ? (agent?.repositoryId ?? null) : c.repositoryId;
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO conversations
         (id, workspace_id, kind, title, agent_id, description, priority, status, repository_id, origin,
          origin_ref, creator_member_id, owner_member_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          workspaceId,
          c.kind,
          c.title ?? null,
          c.agentId ?? null,
          c.description ?? null,
          c.priority ?? "medium",
          status,
          repositoryId,
          c.origin ?? "cli",
          c.originRef ?? null,
          c.creatorMemberId ?? null,
          c.ownerMemberId ?? null,
          now,
          now,
        ],
      );
      this.setConversationLabels(id, c.labelIds ?? [], now);
    })();
    return this.getConversation(id)!;
  }

  getConversation(id: string): Conversation | null {
    const r = this.db
      .query<ConversationRow, [string]>("SELECT * FROM conversations WHERE id = ?")
      .get(id);
    return r ? this.withConversationMetadata(toConversation(r)) : null;
  }

  /** CLI 短 id：前缀唯一匹配；0 命中 → null，多命中 → throw */
  resolveConversationPrefix(prefix: string): Conversation | null {
    const rows = this.db
      .query<ConversationRow, [string]>("SELECT * FROM conversations WHERE id LIKE ? || '%' LIMIT 2")
      .all(prefix);
    if (rows.length > 1) throw new Error(`conversation id 前缀 "${prefix}" 有多个匹配，请给更长前缀`);
    return rows[0] ? this.withConversationMetadata(toConversation(rows[0])) : null;
  }

  listConversations(filter: { workspaceId?: string; kind?: ConversationKind; status?: ConversationStatus }): Conversation[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.workspaceId) {
      clauses.push("workspace_id = ?");
      params.push(filter.workspaceId);
    }
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
      .map((row) => this.withConversationMetadata(toConversation(row)));
  }

  setConversationStatus(id: string, status: ConversationStatus, now: number): void {
    this.db.run("UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?", [status, now, id]);
  }

  updateConversation(
    id: string,
    patch: {
      title?: string | null;
      description?: string | null;
      priority?: IssuePriority;
      ownerMemberId?: string | null;
      labelIds?: string[];
    },
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
    if ("ownerMemberId" in patch) {
      sets.push("owner_member_id = ?");
      params.push(patch.ownerMemberId ?? null);
    }
    if (sets.length === 0 && patch.labelIds === undefined) return;
    this.db.transaction(() => {
      if (sets.length > 0) {
        sets.push("updated_at = ?");
        params.push(now, id);
        this.db.run(`UPDATE conversations SET ${sets.join(", ")} WHERE id = ?`, params);
      }
      if (patch.labelIds !== undefined) this.setConversationLabels(id, patch.labelIds, now);
    })();
  }

  private withConversationMetadata(conversation: Conversation): Conversation {
    conversation.labelIds = this.db
      .query<{ label_id: string }, [string]>(
        "SELECT label_id FROM conversation_labels WHERE conversation_id = ? ORDER BY created_at, label_id",
      )
      .all(conversation.id)
      .map((row) => row.label_id);
    return conversation;
  }

  setConversationLabels(conversationId: string, labelIds: string[], now: number): void {
    this.db.run("DELETE FROM conversation_labels WHERE conversation_id = ?", [conversationId]);
    const insert = this.db.prepare(
      "INSERT INTO conversation_labels (conversation_id, label_id, created_at) VALUES (?,?,?)",
    );
    [...new Set(labelIds)].forEach((labelId) => insert.run(conversationId, labelId, now));
  }

  createIssueLabel(workspaceId: string, name: string, color: string): IssueLabel {
    const id = newId("label");
    this.db.run("INSERT INTO issue_labels (id, workspace_id, name, color) VALUES (?,?,?,?)", [id, workspaceId, name, color]);
    return { id, workspaceId, name, color };
  }

  listIssueLabels(workspaceId: string): IssueLabel[] {
    return this.db
      .query<{ id: string; workspace_id: string; name: string; color: string }, [string]>(
        "SELECT * FROM issue_labels WHERE workspace_id = ? ORDER BY name",
      )
      .all(workspaceId)
      .map((row) => ({ id: row.id, workspaceId: row.workspace_id, name: row.name, color: row.color }));
  }

  getIssueLabel(id: string): IssueLabel | null {
    const row = this.db.query<{ id: string; workspace_id: string; name: string; color: string }, [string]>(
      "SELECT * FROM issue_labels WHERE id = ?",
    ).get(id);
    return row ? { id: row.id, workspaceId: row.workspace_id, name: row.name, color: row.color } : null;
  }

  appendConversationMessage(
    conversationId: string,
    input: Omit<ConversationMessage, "id" | "conversationId" | "createdAt">,
    now: number,
  ): ConversationMessage {
    const existing = input.externalId
      ? this.db.query<{ id: string }, [string, string]>(
          "SELECT id FROM conversation_messages WHERE conversation_id = ? AND external_id = ?",
        ).get(conversationId, input.externalId)
      : null;
    if (existing) return this.getConversationMessage(existing.id)!;
    const id = newId("message");
    this.db.run(
      `INSERT INTO conversation_messages
       (id, conversation_id, author_type, author_id, author_name, body, external_id, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, conversationId, input.authorType, input.authorId, input.authorName, input.body, input.externalId, now],
    );
    this.db.run("UPDATE conversations SET updated_at = ? WHERE id = ?", [now, conversationId]);
    return this.getConversationMessage(id)!;
  }

  getConversationMessage(id: string): ConversationMessage | null {
    const row = this.db.query<{
      id: string; conversation_id: string; author_type: string; author_id: string | null;
      author_name: string | null; body: string; external_id: string | null; created_at: number;
    }, [string]>("SELECT * FROM conversation_messages WHERE id = ?").get(id);
    return row ? {
      id: row.id,
      conversationId: row.conversation_id,
      authorType: row.author_type as ConversationMessage["authorType"],
      authorId: row.author_id,
      authorName: row.author_name,
      body: row.body,
      externalId: row.external_id,
      createdAt: row.created_at,
    } : null;
  }

  listConversationMessages(conversationId: string): ConversationMessage[] {
    return this.db.query<{ id: string }, [string]>(
      "SELECT id FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at, rowid",
    ).all(conversationId).map((row) => this.getConversationMessage(row.id)!);
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

  /** Assignee 变化时同步继承 Agent Repository，并清空旧 session；Review Agent 不走这里。 */
  setConversationAssignee(id: string, agentId: string | null, now: number): void {
    const current = this.getConversation(id);
    if (!current || current.agentId === agentId) return;
    const repositoryId = agentId ? this.getAgent(agentId)?.repositoryId ?? null : null;
    this.db.run(
      "UPDATE conversations SET agent_id = ?, repository_id = ?, claude_session_id = NULL, updated_at = ? WHERE id = ?",
      [agentId, repositoryId, now, id],
    );
  }

  /** Repository 变化会使旧 session 失效；已有 worktree 时由上层禁止切换。 */
  setConversationRepository(id: string, repositoryId: string | null, now: number): void {
    const current = this.getConversation(id);
    if (!current || current.repositoryId === repositoryId) return;
    this.db.run(
      "UPDATE conversations SET repository_id = ?, claude_session_id = NULL, updated_at = ? WHERE id = ?",
      [repositoryId, now, id],
    );
  }

  setConversationClaudeSessionId(id: string, sid: string, now: number): void {
    this.db.run("UPDATE conversations SET claude_session_id = ?, updated_at = ? WHERE id = ?", [
      sid,
      now,
      id,
    ]);
  }

  setConversationWorktreePath(
    id: string,
    path: string | null,
    mountIdOrNow: string | number | null,
    explicitNow?: number,
  ): void {
    const legacyCall = typeof mountIdOrNow === "number";
    const mountId = legacyCall ? (this.getConversation(id)?.worktreeMountId ?? null) : mountIdOrNow;
    const now = legacyCall ? mountIdOrNow : explicitNow!;
    this.db.run("UPDATE conversations SET worktree_path = ?, worktree_mount_id = ?, updated_at = ? WHERE id = ?", [
      path,
      mountId,
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
    return r ? this.withConversationMetadata(toConversation(r)) : null;
  }

  /** 该设备上「已终结但 worktree 还挂着」的 issue（设备离线时 cleanup 丢失 → 重连补发） */
  listWorktreeCleanupsForDevice(deviceId: string): { conversation: Conversation; mount: RepositoryMount }[] {
    const rows = this.db
      .query<ConversationRow, [string]>(
        `SELECT c.* FROM conversations c JOIN repository_mounts m ON m.id = c.worktree_mount_id
         WHERE m.device_id = ? AND c.worktree_path IS NOT NULL AND c.status IN ('done','canceled')`,
      )
      .all(deviceId);
    return rows.flatMap((r) => {
      const conv = this.withConversationMetadata(toConversation(r));
      const mount = conv.worktreeMountId ? this.getRepositoryMount(conv.worktreeMountId) : null;
      return mount ? [{ conversation: conv, mount }] : [];
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

  // ---- SCM / workspace integrations ----

  findRepositoryByScm(provider: HarborRepository["scmProvider"], scmRepository: string): HarborRepository | null {
    const row = this.db.query<RepositoryRow, [string, string]>(
      "SELECT * FROM repositories WHERE scm_provider = ? AND scm_repository = ?",
    ).get(provider, scmRepository);
    return row ? toRepository(row) : null;
  }

  insertScmEvent(input: {
    id: string;
    provider: "codebase";
    workspaceId: string;
    repositoryId?: string | null;
    eventType: string;
    action?: string | null;
    objectKind?: ScmObjectKind | null;
    externalId?: string | null;
    payload: unknown;
  }, now: number): boolean {
    const result = this.db.run(
      `INSERT OR IGNORE INTO scm_events
       (id, provider, workspace_id, repository_id, event_type, action, object_kind, external_id, payload, received_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [input.id, input.provider, input.workspaceId, input.repositoryId ?? null, input.eventType,
       input.action ?? null, input.objectKind ?? null, input.externalId ?? null, JSON.stringify(input.payload), now],
    );
    return result.changes > 0;
  }

  finishScmEvent(id: string, outcome: ScmEvent["outcome"], error: string | null, now: number): void {
    this.db.run(
      "UPDATE scm_events SET outcome = ?, error = ?, processed_at = ? WHERE id = ?",
      [outcome, error, now, id],
    );
  }

  getScmEvent(id: string): ScmEvent | null {
    const row = this.db.query<{
      id: string; provider: string; workspace_id: string; repository_id: string | null; event_type: string;
      action: string | null; object_kind: string | null; external_id: string | null; outcome: string;
      error: string | null; received_at: number; processed_at: number | null;
    }, [string]>("SELECT * FROM scm_events WHERE id = ?").get(id);
    return row ? {
      id: row.id,
      provider: row.provider as "codebase",
      workspaceId: row.workspace_id,
      repositoryId: row.repository_id,
      eventType: row.event_type,
      action: row.action,
      objectKind: row.object_kind as ScmObjectKind | null,
      externalId: row.external_id,
      outcome: row.outcome as ScmEvent["outcome"],
      error: row.error,
      receivedAt: row.received_at,
      processedAt: row.processed_at,
    } : null;
  }

  listScmEvents(workspaceId: string, limit = 100): ScmEvent[] {
    return this.db.query<{ id: string }, [string, number]>(
      "SELECT id FROM scm_events WHERE workspace_id = ? ORDER BY received_at DESC LIMIT ?",
    ).all(workspaceId, limit).map((row) => this.getScmEvent(row.id)!);
  }

  upsertScmExternalObject(input: {
    workspaceId: string;
    repositoryId: string;
    provider: "codebase";
    kind: ScmObjectKind;
    externalId: string;
    url?: string | null;
    title: string;
    description?: string | null;
    authorId?: string | null;
    authorName?: string | null;
    state: string;
    payload?: unknown;
  }, now: number): ScmExternalObject {
    const existing = this.getScmExternalObject(input.provider, input.repositoryId, input.kind, input.externalId);
    if (existing) {
      this.db.run(
        `UPDATE scm_external_objects SET url = ?, title = ?, description = ?, author_id = ?, author_name = ?,
         state = ?, payload = ?, updated_at = ? WHERE id = ?`,
        [input.url ?? null, input.title, input.description ?? null, input.authorId ?? null, input.authorName ?? null,
         input.state, JSON.stringify(input.payload ?? {}), now, existing.id],
      );
      return this.getScmExternalObjectById(existing.id)!;
    }
    const id = newId("external");
    this.db.run(
      `INSERT INTO scm_external_objects
       (id, workspace_id, repository_id, provider, kind, external_id, url, title, description,
        author_id, author_name, state, payload, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, input.workspaceId, input.repositoryId, input.provider, input.kind, input.externalId,
       input.url ?? null, input.title, input.description ?? null, input.authorId ?? null, input.authorName ?? null,
       input.state, JSON.stringify(input.payload ?? {}), now, now],
    );
    return this.getScmExternalObjectById(id)!;
  }

  getScmExternalObject(
    provider: "codebase",
    repositoryId: string,
    kind: ScmObjectKind,
    externalId: string,
  ): ScmExternalObject | null {
    const row = this.db.query<{ id: string }, [string, string, string, string]>(
      `SELECT id FROM scm_external_objects
       WHERE provider = ? AND repository_id = ? AND kind = ? AND external_id = ?`,
    ).get(provider, repositoryId, kind, externalId);
    return row ? this.getScmExternalObjectById(row.id) : null;
  }

  getScmExternalObjectById(id: string): ScmExternalObject | null {
    const row = this.db.query<{
      id: string; workspace_id: string; repository_id: string; provider: string; kind: string;
      external_id: string; url: string | null; title: string; description: string | null;
      author_id: string | null; author_name: string | null; state: string; conversation_id: string | null;
      delivery_id: string | null; created_at: number; updated_at: number;
    }, [string]>("SELECT * FROM scm_external_objects WHERE id = ?").get(id);
    return row ? {
      id: row.id,
      workspaceId: row.workspace_id,
      repositoryId: row.repository_id,
      provider: row.provider as "codebase",
      kind: row.kind as ScmObjectKind,
      externalId: row.external_id,
      url: row.url,
      title: row.title,
      description: row.description,
      authorId: row.author_id,
      authorName: row.author_name,
      state: row.state,
      conversationId: row.conversation_id,
      deliveryId: row.delivery_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    } : null;
  }

  linkScmExternalObject(id: string, links: { conversationId?: string | null; deliveryId?: string | null }, now: number): void {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (links.conversationId !== undefined) { sets.push("conversation_id = ?"); params.push(links.conversationId); }
    if (links.deliveryId !== undefined) { sets.push("delivery_id = ?"); params.push(links.deliveryId); }
    if (!sets.length) return;
    sets.push("updated_at = ?");
    params.push(now, id);
    this.db.run(`UPDATE scm_external_objects SET ${sets.join(", ")} WHERE id = ?`, params);
  }

  listScmExternalObjects(workspaceId: string, kind?: ScmObjectKind): ScmExternalObject[] {
    const rows = kind
      ? this.db.query<{ id: string }, [string, string]>(
          "SELECT id FROM scm_external_objects WHERE workspace_id = ? AND kind = ? ORDER BY updated_at DESC",
        ).all(workspaceId, kind)
      : this.db.query<{ id: string }, [string]>(
          "SELECT id FROM scm_external_objects WHERE workspace_id = ? ORDER BY updated_at DESC",
        ).all(workspaceId);
    return rows.map((row) => this.getScmExternalObjectById(row.id)!);
  }

  getScmExternalObjectForConversation(conversationId: string): ScmExternalObject | null {
    const row = this.db.query<{ id: string }, [string]>(
      `SELECT id FROM scm_external_objects WHERE conversation_id = ?
       ORDER BY CASE kind WHEN 'issue' THEN 0 ELSE 1 END, updated_at DESC LIMIT 1`,
    ).get(conversationId);
    return row ? this.getScmExternalObjectById(row.id) : null;
  }

  upsertLarkWorkspaceBinding(input: {
    workspaceId: string;
    chatId: string;
    defaultAgentId: string;
    responseMode?: LarkWorkspaceBinding["responseMode"];
    listenMode?: LarkWorkspaceBinding["listenMode"];
    botMode?: LarkWorkspaceBinding["botMode"];
    enabled?: boolean;
  }, now: number): LarkWorkspaceBinding {
    const existing = this.getLarkWorkspaceBinding(input.chatId);
    const id = existing?.id ?? newId("larkBinding");
    this.db.run(
      `INSERT INTO lark_workspace_bindings
       (id, workspace_id, chat_id, default_agent_id, response_mode, listen_mode, bot_mode, enabled, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(chat_id) DO UPDATE SET workspace_id = excluded.workspace_id,
         default_agent_id = excluded.default_agent_id, response_mode = excluded.response_mode,
         listen_mode = excluded.listen_mode, bot_mode = excluded.bot_mode, enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
      [id, input.workspaceId, input.chatId, input.defaultAgentId, input.responseMode ?? "thread",
       input.listenMode ?? "mention", input.botMode ?? "global", input.enabled === false ? 0 : 1,
       existing?.createdAt ?? now, now],
    );
    return this.getLarkWorkspaceBinding(input.chatId)!;
  }

  getLarkWorkspaceBinding(chatId: string): LarkWorkspaceBinding | null {
    const row = this.db.query<{
      id: string; workspace_id: string; chat_id: string; default_agent_id: string; response_mode: string;
      listen_mode: string; bot_mode: string; enabled: number; created_at: number; updated_at: number;
    }, [string]>("SELECT * FROM lark_workspace_bindings WHERE chat_id = ?").get(chatId);
    return row ? {
      id: row.id,
      workspaceId: row.workspace_id,
      chatId: row.chat_id,
      defaultAgentId: row.default_agent_id,
      responseMode: row.response_mode as LarkWorkspaceBinding["responseMode"],
      listenMode: row.listen_mode as LarkWorkspaceBinding["listenMode"],
      botMode: row.bot_mode as LarkWorkspaceBinding["botMode"],
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    } : null;
  }

  listLarkWorkspaceBindings(workspaceId: string): LarkWorkspaceBinding[] {
    return this.db.query<{ chat_id: string }, [string]>(
      "SELECT chat_id FROM lark_workspace_bindings WHERE workspace_id = ? ORDER BY created_at",
    ).all(workspaceId).map((row) => this.getLarkWorkspaceBinding(row.chat_id)!);
  }

  deleteLarkWorkspaceBinding(id: string): void {
    this.db.run("DELETE FROM lark_workspace_bindings WHERE id = ?", [id]);
  }

  linkLarkMessage(messageId: string, conversationId: string, now: number): void {
    this.db.run(
      `INSERT INTO lark_message_links (message_id, conversation_id, created_at) VALUES (?,?,?)
       ON CONFLICT(message_id) DO UPDATE SET conversation_id = excluded.conversation_id`,
      [messageId, conversationId, now],
    );
  }

  getConversationForLarkMessage(messageId: string): Conversation | null {
    const row = this.db.query<{ conversation_id: string }, [string]>(
      "SELECT conversation_id FROM lark_message_links WHERE message_id = ?",
    ).get(messageId);
    return row ? this.getConversation(row.conversation_id) : null;
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
      .query<DeliveryEventRow, [string]>("SELECT * FROM delivery_events WHERE delivery_id = ? ORDER BY ts")
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
      workspaceId?: string;
      sourceType?: RunSourceType;
      sourceId?: string;
      conversationId?: string | null;
      agentId: string;
      deviceId: string;
      repositoryId?: string | null;
      repositoryMountId?: string | null;
      executionRoot?: string | null;
      prompt: string;
      purpose?: RunPurpose;
      promptEvent: PromptEventBlockKey;
      triggerRef?: string | null;
      triggerContext?: Record<string, unknown>;
      concurrencyKey?: string | null;
      attachments?: RunAttachment[];
    },
    now: number,
  ): Run {
    const id = newId("run");
    const conversation = r.conversationId ? this.getConversation(r.conversationId) : null;
    const workspaceId = r.workspaceId ?? conversation?.workspaceId ?? DEFAULT_WORKSPACE_ID;
    const sourceType = r.sourceType ?? (conversation?.kind === "chat" ? "chat" : "issue");
    const sourceId = r.sourceId ?? conversation?.id;
    if (!sourceId) throw new Error("Run sourceId 不能为空");
    if (sourceType === "automation" && r.conversationId) {
      throw new Error("Automation-source Run 不能绑定 Conversation");
    }
    if (sourceType !== "automation" && !conversation) {
      throw new Error(`${sourceType}-source Run 必须绑定 Conversation`);
    }
    this.db.run(
      `INSERT INTO runs
       (id, workspace_id, source_type, source_id, conversation_id, agent_id, device_id, repository_id,
        repository_mount_id, execution_root, prompt, purpose, prompt_event, trigger_ref, trigger_context,
        concurrency_key, status, queued_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?)`,
      [
        id,
        workspaceId,
        sourceType,
        sourceId,
        r.conversationId ?? null,
        r.agentId,
        r.deviceId,
        r.repositoryId ?? null,
        r.repositoryMountId ?? null,
        r.executionRoot ?? null,
        r.prompt,
        r.purpose ?? "implementation",
        r.promptEvent,
        r.triggerRef ?? null,
        JSON.stringify(r.triggerContext ?? {}),
        r.concurrencyKey ?? null,
        now,
      ],
    );
    const insertAttachment = this.db.prepare(
      `INSERT INTO run_attachments (run_id, position, name, mime, data_base64) VALUES (?,?,?,?,?)`,
    );
    (r.attachments ?? []).forEach((attachment, position) => {
      insertAttachment.run(id, position, attachment.name, attachment.mime, attachment.dataBase64);
    });
    if (r.conversationId) {
      this.db.run("UPDATE conversations SET updated_at = ? WHERE id = ?", [now, r.conversationId]);
    }
    return this.getRun(id)!;
  }

  listRunAttachments(runId: string): RunAttachment[] {
    return this.db
      .query<{
        name: string;
        mime: string;
        data_base64: string;
      }, [string]>(
        "SELECT name, mime, data_base64 FROM run_attachments WHERE run_id = ? ORDER BY position",
      )
      .all(runId)
      .map((row) => ({ name: row.name, mime: row.mime, dataBase64: row.data_base64 }));
  }

  createRunActionToken(runId: string, tokenHash: string, expiresAt: number, now: number): string {
    const id = newId("runActionToken");
    this.db.run(
      `INSERT INTO run_action_tokens (id, run_id, token_hash, expires_at, created_at)
       VALUES (?,?,?,?,?)`,
      [id, runId, tokenHash, expiresAt, now],
    );
    return id;
  }

  runForActionToken(tokenHash: string, now: number): Run | null {
    const row = this.db
      .query<{ run_id: string }, [string, number]>(
        `SELECT run_id FROM run_action_tokens
         WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(tokenHash, now);
    return row ? this.getRun(row.run_id) : null;
  }

  revokeRunActionTokens(runId: string, now: number): void {
    this.db.run(
      "UPDATE run_action_tokens SET revoked_at = ? WHERE run_id = ? AND revoked_at IS NULL",
      [now, runId],
    );
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

  listRunsBySource(sourceType: RunSourceType, sourceId: string): Run[] {
    return this.db
      .query<RunRow, [string, string]>(
        "SELECT * FROM runs WHERE source_type = ? AND source_id = ? ORDER BY queued_at",
      )
      .all(sourceType, sourceId)
      .map(toRun);
  }

  latestRunForConversation(conversationId: string): Run | null {
    const r = this.db
      .query<RunRow, [string]>("SELECT * FROM runs WHERE conversation_id = ? ORDER BY queued_at DESC LIMIT 1")
      .get(conversationId);
    return r ? toRun(r) : null;
  }

  /** 该设备最老且未撞 Agent/Automation 并发闸的 queued run（避免单个 Agent 阻塞整台 Device）。 */
  oldestQueuedForDevice(deviceId: string): Run | null {
    const r = this.db
      .query<RunRow, [string]>(
        `SELECT queued.* FROM runs queued
         WHERE queued.device_id = ? AND queued.status = 'queued'
           AND (
             queued.concurrency_key IS NULL OR NOT EXISTS (
               SELECT 1 FROM runs running
               WHERE running.status = 'running' AND running.concurrency_key = queued.concurrency_key
             )
           )
           AND (
             SELECT COUNT(*) FROM runs agent_running
             WHERE agent_running.agent_id = queued.agent_id AND agent_running.status = 'running'
           ) < COALESCE((SELECT concurrency FROM agents WHERE id = queued.agent_id), 1)
         ORDER BY queued.queued_at LIMIT 1`,
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

  countRunningForAgent(agentId: string): number {
    return this.db.query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM runs WHERE agent_id = ? AND status = 'running'",
    ).get(agentId)?.n ?? 0;
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

  activeRunForTriggerRef(triggerRef: string): Run | null {
    const r = this.db
      .query<RunRow, [string]>(
        "SELECT * FROM runs WHERE trigger_ref = ? AND status IN ('queued','running') ORDER BY queued_at LIMIT 1",
      )
      .get(triggerRef);
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

  setRunExecutionRoot(id: string, executionRoot: string): void {
    this.db.run("UPDATE runs SET execution_root = ? WHERE id = ?", [executionRoot, id]);
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
      workspaceId?: string;
      name: string;
      agentId: string;
      repositoryId?: string | null;
      prompt: string;
      outputMode?: AutomationOutputMode;
      overlapMode?: AutomationOverlapMode;
      /** 旧调用兼容：new_issue → issue。 */
      mode?: AutomationMode;
      /** 旧调用兼容：自动创建一个 schedule Trigger。 */
      cron?: string;
      triggers?: {
        type: AutomationTriggerType;
        cron?: string | null;
        provider?: string | null;
        events?: string[];
        filters?: AutomationWebhookFilter[];
        secretHash?: string | null;
      }[];
      targetConversationId?: string | null;
      notifyChatId?: string | null;
    },
    now: number,
  ): Automation {
    const id = newId("automation");
    const outputMode = a.outputMode ?? (a.mode === "append" ? "append" : "issue");
    const triggers = a.triggers ?? (a.cron ? [{ type: "schedule" as const, cron: a.cron }] : []);
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO automations
         (id, workspace_id, name, agent_id, repository_id, prompt, output_mode, overlap_mode,
          target_conversation_id, notify_chat_id, enabled, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)`,
        [
          id,
          a.workspaceId ?? DEFAULT_WORKSPACE_ID,
          a.name,
          a.agentId,
          a.repositoryId ?? null,
          a.prompt,
          outputMode,
          a.overlapMode ?? "skip",
          a.targetConversationId ?? null,
          a.notifyChatId ?? null,
          now,
          now,
        ],
      );
      for (const trigger of triggers) this.insertAutomationTrigger(id, trigger, now);
    })();
    return this.getAutomation(id)!;
  }

  getAutomation(id: string): Automation | null {
    const r = this.db.query<AutomationRow, [string]>("SELECT * FROM automations WHERE id = ?").get(id);
    return r ? toAutomation(r, this.listAutomationTriggers(id)) : null;
  }

  resolveAutomationPrefix(prefix: string, workspaceId?: string): Automation | null {
    const rows = workspaceId
      ? this.db.query<AutomationRow, [string, string, string]>(
        "SELECT * FROM automations WHERE workspace_id = ? AND (id LIKE ? || '%' OR name = ?) LIMIT 2",
      ).all(workspaceId, prefix, prefix)
      : this.db.query<AutomationRow, [string, string]>(
        "SELECT * FROM automations WHERE id LIKE ? || '%' OR name = ? LIMIT 2",
      ).all(prefix, prefix);
    if (rows.length > 1) throw new Error(`automation "${prefix}" 有多个匹配，请给更长前缀或用完整 id`);
    return rows[0] ? toAutomation(rows[0], this.listAutomationTriggers(rows[0].id)) : null;
  }

  listAutomations(workspaceId?: string): Automation[] {
    const rows = !workspaceId
      ? this.db.query<AutomationRow, []>("SELECT * FROM automations ORDER BY name").all()
      : this.db
      .query<AutomationRow, [string]>("SELECT * FROM automations WHERE workspace_id = ? ORDER BY name")
      .all(workspaceId);
    return rows.map((row) => toAutomation(row, this.listAutomationTriggers(row.id)));
  }

  setAutomationEnabled(id: string, enabled: boolean): void {
    this.db.run("UPDATE automations SET enabled = ?, updated_at = ? WHERE id = ?", [enabled ? 1 : 0, Date.now(), id]);
  }

  deleteAutomation(id: string): void {
    this.db.transaction(() => {
      this.db.run("DELETE FROM automation_log WHERE automation_id = ?", [id]);
      this.db.run("DELETE FROM automations WHERE id = ?", [id]);
    })();
  }

  markAutomationFired(id: string, now: number): void {
    this.db.run("UPDATE automations SET last_fired_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
  }

  appendAutomationLog(
    l: {
      automationId: string;
      kind: AutomationLogRow["kind"];
      runId?: string | null;
      triggerId?: string | null;
      eventId?: string | null;
      note?: string | null;
    },
    now: number,
  ): void {
    this.db.run(
      `INSERT INTO automation_log
       (automation_id, kind, ts, run_id, trigger_id, event_id, note) VALUES (?,?,?,?,?,?,?)`, [
      l.automationId,
      l.kind,
      now,
      l.runId ?? null,
      l.triggerId ?? null,
      l.eventId ?? null,
      l.note ?? null,
    ]);
  }

  listAutomationLog(automationId: string, limit = 50): AutomationLogRow[] {
    return this.db
      .query<{
        automation_id: string;
        kind: string;
        ts: number;
        run_id: string | null;
        trigger_id: string | null;
        event_id: string | null;
        note: string | null;
      }, [string, number]>(
        "SELECT * FROM automation_log WHERE automation_id = ? ORDER BY ts DESC LIMIT ?",
      )
      .all(automationId, limit)
      .map((r) => ({
        automationId: r.automation_id,
        kind: r.kind as AutomationLogRow["kind"],
        ts: r.ts,
        runId: r.run_id,
        triggerId: r.trigger_id,
        eventId: r.event_id,
        note: r.note,
      }));
  }

  createAutomationTrigger(
    automationId: string,
    input: {
      type: AutomationTriggerType;
      cron?: string | null;
      provider?: string | null;
      events?: string[];
      filters?: AutomationWebhookFilter[];
      secretHash?: string | null;
    },
    now: number,
  ): AutomationTrigger {
    const id = this.insertAutomationTrigger(automationId, input, now);
    return this.getAutomationTrigger(id)!;
  }

  private insertAutomationTrigger(
    automationId: string,
    input: {
      type: AutomationTriggerType;
      cron?: string | null;
      provider?: string | null;
      events?: string[];
      filters?: AutomationWebhookFilter[];
      secretHash?: string | null;
    },
    now: number,
  ): string {
    const id = newId("automationTrigger");
    this.db.run(
      `INSERT INTO automation_triggers
       (id, automation_id, type, cron, provider, events, filters, secret_hash, last_fired_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,NULL,?,?)`,
      [
        id,
        automationId,
        input.type,
        input.type === "schedule" ? input.cron ?? null : null,
        input.type === "webhook" ? input.provider ?? "generic" : null,
        JSON.stringify(input.events ?? []),
        JSON.stringify(input.filters ?? []),
        input.type === "webhook" ? input.secretHash ?? null : null,
        now,
        now,
      ],
    );
    return id;
  }

  getAutomationTrigger(id: string): AutomationTrigger | null {
    const row = this.db
      .query<AutomationTriggerRow, [string]>("SELECT * FROM automation_triggers WHERE id = ?")
      .get(id);
    return row ? toAutomationTrigger(row) : null;
  }

  getAutomationTriggerSecretHash(id: string): string | null {
    const row = this.db
      .query<{ secret_hash: string | null }, [string]>(
        "SELECT secret_hash FROM automation_triggers WHERE id = ? AND type = 'webhook'",
      )
      .get(id);
    return row?.secret_hash ?? null;
  }

  listAutomationTriggers(automationId: string): AutomationTrigger[] {
    return this.db
      .query<AutomationTriggerRow, [string]>(
        "SELECT * FROM automation_triggers WHERE automation_id = ? ORDER BY created_at, id",
      )
      .all(automationId)
      .map(toAutomationTrigger);
  }

  setAutomationTriggerEnabled(id: string, enabled: boolean, now: number): void {
    this.db.run("UPDATE automation_triggers SET enabled = ?, updated_at = ? WHERE id = ?", [enabled ? 1 : 0, now, id]);
  }

  markAutomationTriggerFired(id: string, now: number): void {
    this.db.run("UPDATE automation_triggers SET last_fired_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
  }

  deleteAutomationTrigger(id: string): void {
    this.db.run("DELETE FROM automation_triggers WHERE id = ?", [id]);
  }

  /** deliveryId 在同一 webhook Trigger 下只接收一次；true 表示本次首次登记。 */
  recordAutomationWebhookDelivery(triggerId: string, deliveryId: string, now: number): boolean {
    const result = this.db.run(
      `INSERT OR IGNORE INTO automation_webhook_deliveries (trigger_id, delivery_id, received_at)
       VALUES (?,?,?)`,
      [triggerId, deliveryId, now],
    );
    return result.changes === 1;
  }

  hasAutomationWebhookDelivery(triggerId: string, deliveryId: string): boolean {
    return Boolean(this.db.query<{ ok: number }, [string, string]>(
      "SELECT 1 AS ok FROM automation_webhook_deliveries WHERE trigger_id = ? AND delivery_id = ?",
    ).get(triggerId, deliveryId));
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

  getPromptBlock(workspaceId: string, key: PromptBlockKey): PromptBlockOverride | null {
    const r = this.db
      .query<PromptBlockRow, [string, string]>(
        "SELECT * FROM workspace_prompt_blocks WHERE workspace_id = ? AND block_key = ?",
      )
      .get(workspaceId, key);
    return r
      ? {
          key: r.block_key as PromptBlockKey,
          enabled: r.enabled === 1,
          template: r.template,
          updatedAt: r.updated_at,
        }
      : null;
  }

  setPromptBlock(workspaceId: string, key: PromptBlockKey, enabled: boolean, template: string, now: number): void {
    this.db.run(
      `INSERT INTO workspace_prompt_blocks (workspace_id, block_key, enabled, template, updated_at) VALUES (?,?,?,?,?)
       ON CONFLICT(workspace_id, block_key) DO UPDATE SET enabled = excluded.enabled, template = excluded.template, updated_at = excluded.updated_at`,
      [workspaceId, key, enabled ? 1 : 0, template, now],
    );
  }

  resetPromptBlock(workspaceId: string, key: PromptBlockKey): void {
    this.db.run("DELETE FROM workspace_prompt_blocks WHERE workspace_id = ? AND block_key = ?", [workspaceId, key]);
  }

  // ---- usage（P3 报表） ----

  /** agent × model × 日 聚合（server 本地时区），只统计有终态的 run */
  usageAggregate(fromTs: number, workspaceId?: string): UsageRow[] {
    const workspaceClause = workspaceId ? "AND r.workspace_id = ?" : "";
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
        (number | string)[]
      >(
        `SELECT date(r.queued_at / 1000, 'unixepoch', 'localtime') AS day,
                a.name AS agent_name, a.model AS model,
                COUNT(*) AS runs,
                SUM(COALESCE(r.cost_usd, 0)) AS usd,
                SUM(COALESCE(r.input_tokens, 0)) AS input_tokens,
                SUM(COALESCE(r.output_tokens, 0)) AS output_tokens,
                SUM(COALESCE(r.cached_tokens, 0)) AS cached_tokens
         FROM runs r JOIN agents a ON a.id = r.agent_id
         WHERE r.queued_at >= ? AND r.status IN ('succeeded','failed','canceled') ${workspaceClause}
         GROUP BY day, a.name, a.model
         ORDER BY day DESC, usd DESC`,
      )
      .all(...(workspaceId ? [fromTs, workspaceId] : [fromTs]))
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
  listRunsForUsage(filter: { workspaceId?: string; agentId?: string; day?: string; fromTs: number }): Run[] {
    const clauses = ["r.queued_at >= ?", "r.status IN ('succeeded','failed','canceled')"];
    const params: (string | number)[] = [filter.fromTs];
    if (filter.workspaceId) {
      clauses.push("r.workspace_id = ?");
      params.push(filter.workspaceId);
    }
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

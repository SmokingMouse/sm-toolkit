/**
 * 领域表 CRUD —— 全部 SQL 收口在这一层，行(snake_case) ↔ 领域类型(camelCase) 映射也在这。
 * 上层（rest/ws/scheduler/statemachine）只见领域类型。
 */

import type { Database } from "bun:sqlite";
import type { AgentEvent, Cost } from "@sm/agent";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import type {
  Account,
  Approval,
  ApprovalStatus,
  AuthIdentity,
  Automation,
  AutomationLogRow,
  AutomationOutput,
  AutomationTrigger,
  AutomationTriggerType,
  BackendKind,
  Conversation,
  ConversationKind,
  ConversationMessage,
  ConversationStatus,
  CodebaseAutomationEvent,
  Delivery,
  DeliveryCheckStatus,
  DeliveryEvent,
  DeploymentJob,
  DeploymentJobView,
  DeploymentFailureKind,
  DeploymentFence,
  DeploymentJobStatus,
  DeploymentMaintenanceGate,
  DeploymentMaintenancePhase,
  DomainEvent,
  DeliveryMergeStatus,
  DeliveryProviderKind,
  DeliveryReviewStatus,
  DeliveryStatus,
  Device,
  DeviceSummary,
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
  PersonalAccessToken,
  PersonalAccessTokenScope,
  Run,
  RunAttachment,
  RunEventRow,
  RunPurpose,
  RunSourceType,
  RunStatus,
  ReviewCheckout,
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
  WorkspaceInvitation,
  WorkspaceRole,
} from "../protocol.js";
import { DEFAULT_WORKSPACE_ID } from "../protocol.js";
import type { PermissionPolicy } from "@sm/agent";
import { newId } from "../ids.js";
import { redactStructured } from "../deployment-worker/redaction.js";
import { summarizeDevice, summarizeDeviceCapabilities } from "../device-summary.js";

// ── 行类型（SQLite 返回形状） ───────────────────────────

interface DeviceRow {
  id: string;
  name: string;
  token_hash: string;
  capabilities: string;
  capabilities_summary?: string;
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
  latest_head_sha: string | null;
  approved_head_sha: string | null;
  review_status: string;
  check_status: string;
  merge_status: string;
  merged_revision: string | null;
  review_approved_at: number | null;
  merged_at: number | null;
  revision: number;
  created_at: number;
  updated_at: number;
}

interface DeploymentJobRow {
  id: string;
  source_run_id: string;
  request_key: string;
  repository_id: string;
  generation: number;
  target_id: string;
  revision: string;
  target_fingerprint: string;
  target_manifest_hash: string;
  status: string;
  attempt: number;
  fence_epoch: number | null;
  fence_nonce: string | null;
  lease_token: string | null;
  lease_expires_at: number | null;
  checkpoint: string;
  log: string | null;
  error: string | null;
  failure_kind: string | null;
  rollback_complete: number | null;
  rollback_attempt: number | null;
  baseline_revision: string | null;
  baseline_fingerprint: string | null;
  baseline_manifest_hash: string | null;
  baseline_health_fingerprint: string | null;
  database_backup_created: number;
  new_service_pids: string;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  updated_at: number;
}

interface DeploymentMaintenanceRow {
  lock_id: number;
  fence_epoch: number;
  fence_nonce: string;
  target_id: string;
  job_id: string;
  source_run_id: string;
  generation: number;
  revision: string;
  target_fingerprint: string;
  target_manifest_hash: string;
  rollback_attempt: number;
  baseline_revision: string;
  baseline_fingerprint: string;
  baseline_manifest_hash: string;
  baseline_health_fingerprint: string;
  expected_revision: string;
  expected_fingerprint: string;
  phase: string;
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
  parent_run_id: string | null;
  root_run_id: string;
  dispatch_depth: number;
  dispatch_key: string | null;
  review_delivery_id: string | null;
  review_revision: string | null;
  review_ref: string | null;
  review_remote_url: string | null;
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

interface DomainEventRow {
  id: string;
  workspace_id: string;
  event_type: string;
  source_type: string;
  source_id: string;
  payload: string;
  created_at: number;
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
  prompt: string;
  output_mode: string;
  enabled: number;
  last_fired_at: number | null;
  created_at: number;
  updated_at: number;
}

interface AutomationTriggerRow {
  id: string;
  automation_id: string;
  type: string;
  cron: string | null;
  timezone: string | null;
  repository_id: string | null;
  codebase_event: string | null;
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
  kind: string;
  created_by_account_id: string;
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

function toDeviceSummary(r: DeviceRow, online: boolean): DeviceSummary {
  if (!r.capabilities_summary) return summarizeDevice(toDevice(r, online));
  return {
    id: r.id,
    name: r.name,
    capabilities: JSON.parse(r.capabilities_summary) as DeviceSummary["capabilities"],
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
    kind: r.kind as HarborWorkspace["kind"],
    createdByAccountId: r.created_by_account_id,
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
    // GitHub sync 可以发现 Harbor 外部已经合并的 PR；仍需补齐 Harbor 自己的人工验收与 CI 闸。
    if (r.review_status !== "approved") return "review_pending";
    if (r.check_status === "failed") return "blocked";
    if (r.check_status !== "passed") return "checks_pending";
    return "succeeded";
  }
  if (!r.change_url) return "awaiting_change";
  if (r.merge_status === "closed") return "blocked";
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
    latestHeadSha: r.latest_head_sha,
    approvedHeadSha: r.approved_head_sha,
    reviewStatus: r.review_status as DeliveryReviewStatus,
    checkStatus: r.check_status as DeliveryCheckStatus,
    mergeStatus: r.merge_status as DeliveryMergeStatus,
    mergedRevision: r.merged_revision,
    status: deliveryStatus(r),
    reviewApprovedAt: r.review_approved_at,
    mergedAt: r.merged_at,
    revision: r.revision,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toDeploymentJob(r: DeploymentJobRow): DeploymentJob {
  return {
    id: r.id,
    sourceRunId: r.source_run_id,
    requestKey: r.request_key,
    repositoryId: r.repository_id,
    generation: r.generation,
    targetId: r.target_id,
    revision: r.revision,
    targetFingerprint: r.target_fingerprint,
    targetManifestHash: r.target_manifest_hash,
    status: r.status as DeploymentJobStatus,
    attempt: r.attempt,
    fenceEpoch: r.fence_epoch,
    fenceNonce: r.fence_nonce,
    leaseToken: r.lease_token,
    leaseExpiresAt: r.lease_expires_at,
    checkpoint: r.checkpoint,
    log: r.log,
    error: r.error,
    failureKind: r.failure_kind as DeploymentFailureKind | null,
    rollbackComplete: r.rollback_complete === null ? null : r.rollback_complete === 1,
    rollbackAttempt: r.rollback_attempt,
    baselineRevision: r.baseline_revision,
    baselineFingerprint: r.baseline_fingerprint,
    baselineManifestHash: r.baseline_manifest_hash,
    baselineHealthFingerprint: r.baseline_health_fingerprint,
    databaseBackupCreated: r.database_backup_created === 1,
    newServicePids: parsePidMap(r.new_service_pids),
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    updatedAt: r.updated_at,
  };
}

function toDeploymentMaintenance(r: DeploymentMaintenanceRow): DeploymentMaintenanceGate {
  return {
    version: 3,
    fenceEpoch: r.fence_epoch,
    fenceNonce: r.fence_nonce,
    targetId: r.target_id,
    jobId: r.job_id,
    sourceRunId: r.source_run_id,
    generation: r.generation,
    revision: r.revision,
    targetFingerprint: r.target_fingerprint,
    targetManifestHash: r.target_manifest_hash,
    rollbackAttempt: r.rollback_attempt,
    baselineRevision: r.baseline_revision,
    baselineFingerprint: r.baseline_fingerprint,
    baselineManifestHash: r.baseline_manifest_hash,
    baselineHealthFingerprint: r.baseline_health_fingerprint,
    expectedRevision: r.expected_revision,
    expectedFingerprint: r.expected_fingerprint,
    phase: r.phase as DeploymentMaintenancePhase,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function sameMaintenanceIdentity(left: DeploymentMaintenanceGate, right: DeploymentMaintenanceGate): boolean {
  return left.targetId === right.targetId
    && left.jobId === right.jobId
    && left.sourceRunId === right.sourceRunId
    && left.generation === right.generation
    && left.revision === right.revision
    && left.targetFingerprint === right.targetFingerprint
    && left.targetManifestHash === right.targetManifestHash
    && left.fenceEpoch === right.fenceEpoch
    && left.fenceNonce === right.fenceNonce
    && left.rollbackAttempt === right.rollbackAttempt
    && left.baselineRevision === right.baselineRevision
    && left.baselineFingerprint === right.baselineFingerprint
    && left.baselineManifestHash === right.baselineManifestHash
    && left.baselineHealthFingerprint === right.baselineHealthFingerprint;
}

function sameRollbackIdentity(left: DeploymentMaintenanceGate, right: DeploymentMaintenanceGate): boolean {
  return left.targetId === right.targetId
    && left.jobId === right.jobId
    && left.sourceRunId === right.sourceRunId
    && left.generation === right.generation
    && left.revision === right.revision
    && left.targetFingerprint === right.targetFingerprint
    && left.targetManifestHash === right.targetManifestHash
    && left.rollbackAttempt === right.rollbackAttempt
    && left.baselineRevision === right.baselineRevision
    && left.baselineFingerprint === right.baselineFingerprint
    && left.baselineManifestHash === right.baselineManifestHash
    && left.baselineHealthFingerprint === right.baselineHealthFingerprint;
}

function sameMaintenanceState(left: DeploymentMaintenanceGate, right: DeploymentMaintenanceGate): boolean {
  return sameMaintenanceIdentity(left, right)
    && left.expectedRevision === right.expectedRevision
    && left.expectedFingerprint === right.expectedFingerprint
    && left.phase === right.phase;
}

function parsePidMap(value: string): Record<string, number> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => Number.isInteger(entry[1]) && entry[1] > 0));
  } catch {
    return {};
  }
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
    parentRunId: r.parent_run_id,
    rootRunId: r.root_run_id,
    dispatchDepth: r.dispatch_depth,
    dispatchKey: r.dispatch_key,
    reviewCheckout: r.review_delivery_id && r.review_revision && r.review_ref && r.review_remote_url
      ? {
          deliveryId: r.review_delivery_id,
          revision: r.review_revision,
          ref: r.review_ref,
          remoteUrl: r.review_remote_url,
        }
      : null,
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

function toDomainEvent(r: DomainEventRow): DomainEvent {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    type: r.event_type as DomainEvent["type"],
    sourceType: r.source_type as DomainEvent["sourceType"],
    sourceId: r.source_id,
    payload: parseJsonRecord(r.payload),
    createdAt: r.created_at,
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
    cron: r.cron,
    timezone: r.timezone,
    repositoryId: r.repository_id,
    codebaseEvent: r.codebase_event as CodebaseAutomationEvent | null,
    lastFiredAt: r.last_fired_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toAutomation(r: AutomationRow, trigger: AutomationTrigger): Automation {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    agentId: r.agent_id,
    prompt: r.prompt,
    output: r.output_mode as AutomationOutput,
    enabled: r.enabled === 1,
    lastFiredAt: r.last_fired_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    trigger,
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
  private domainEventListener: ((event: DomainEvent) => void) | null = null;
  private readonly hasDeviceSummaryColumn: boolean;
  private readonly hasMessageAttachmentsTable: boolean;

  constructor(private db: Database) {
    this.hasDeviceSummaryColumn = db
      .query<{ name: string }, []>("PRAGMA table_info(devices)")
      .all()
      .some((column) => column.name === "capabilities_summary");
    this.hasMessageAttachmentsTable = !!db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message_attachments'",
    ).get();
  }

  setDomainEventListener(listener: ((event: DomainEvent) => void) | null): void {
    this.domainEventListener = listener;
  }

  private notifyDomainEvent(event: DomainEvent | null): void {
    if (!event || !this.domainEventListener) return;
    try {
      this.domainEventListener(event);
    } catch (error) {
      // 领域事实已经提交；Automation 消费失败由启动重放补偿，不能回滚业务事务。
      console.error(`[domain-event] dispatch failed for ${event.id}:`, error);
    }
  }

  // ---- workspaces / repositories ----

  createAccount(input: {
    id?: string;
    displayName: string;
    primaryEmail?: string | null;
    status?: Account["status"];
  }, now: number): Account {
    const id = input.id ?? newId("account");
    const primaryEmail = input.primaryEmail?.trim() || null;
    let normalized = primaryEmail?.toLowerCase() ?? null;
    if (normalized && this.db.query<{ id: string }, [string]>(
      "SELECT id FROM accounts WHERE primary_email_normalized = ?",
    ).get(normalized)) normalized = null;
    this.db.run(
      `INSERT INTO accounts
       (id, display_name, primary_email, primary_email_normalized, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
      [id, input.displayName.trim(), primaryEmail, normalized, input.status ?? "active", now, now],
    );
    return this.getAccount(id)!;
  }

  getAccount(id: string): Account | null {
    const row = this.db.query<{
      id: string; display_name: string; primary_email: string | null; status: string;
      created_at: number; updated_at: number;
    }, [string]>(
      "SELECT id, display_name, primary_email, status, created_at, updated_at FROM accounts WHERE id = ?",
    ).get(id);
    return row ? {
      id: row.id,
      displayName: row.display_name,
      primaryEmail: row.primary_email,
      status: row.status as Account["status"],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    } : null;
  }

  hasActiveAccountWithEmail(email: string): boolean {
    return !!this.db.query<{ found: number }, [string]>(
      "SELECT 1 AS found FROM accounts WHERE status = 'active' AND lower(trim(primary_email)) = ? LIMIT 1",
    ).get(email.trim().toLowerCase());
  }

  updateAccountDisplayName(id: string, displayName: string, now: number): void {
    if (!displayName.trim()) throw new Error("Account displayName 不能为空");
    this.db.run(
      "UPDATE accounts SET display_name = ?, updated_at = ? WHERE id = ?",
      [displayName.trim(), now, id],
    );
  }

  getAuthIdentity(provider: string, subject: string): AuthIdentity | null {
    const row = this.db.query<{
      id: string; account_id: string; provider: string; subject: string; email: string | null;
      verified_at: number | null; created_at: number;
    }, [string, string]>(
      "SELECT * FROM auth_identities WHERE provider = ? AND subject = ?",
    ).get(provider, subject);
    return row ? {
      id: row.id,
      accountId: row.account_id,
      provider: row.provider,
      subject: row.subject,
      email: row.email,
      verifiedAt: row.verified_at,
      createdAt: row.created_at,
    } : null;
  }

  createAuthIdentity(input: {
    accountId: string;
    provider: string;
    subject: string;
    email?: string | null;
    verifiedAt?: number | null;
  }, now: number): AuthIdentity {
    const id = newId("authIdentity");
    this.db.run(
      `INSERT INTO auth_identities
       (id, account_id, provider, subject, email, verified_at, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [id, input.accountId, input.provider, input.subject, input.email?.trim() || null, input.verifiedAt ?? null, now],
    );
    return this.getAuthIdentity(input.provider, input.subject)!;
  }

  defaultWorkspace(): HarborWorkspace {
    const workspace = this.getWorkspace(DEFAULT_WORKSPACE_ID);
    if (!workspace) throw new Error("默认 Workspace 不存在；SQLite migration 未完成");
    return workspace;
  }

  createWorkspace(
    input: {
      name: string;
      slug: string;
      description?: string | null;
      ownerName?: string;
      ownerAccountId?: string;
      kind?: "personal" | "team";
    },
    now: number,
  ): HarborWorkspace {
    const id = newId("workspace");
    const ownerAccountId = input.ownerAccountId ?? "acc_bootstrap";
    const owner = this.getAccount(ownerAccountId);
    if (!owner || owner.status !== "active") throw new Error("Workspace owner Account 不存在或不可用");
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO workspaces
         (id, name, slug, description, created_at, kind, created_by_account_id)
         VALUES (?,?,?,?,?,?,?)`,
        [id, input.name, input.slug, input.description ?? null, now, input.kind ?? "team", ownerAccountId],
      );
      this.createWorkspaceMember({
        workspaceId: id,
        accountId: ownerAccountId,
        name: input.ownerName ?? owner.displayName,
        role: "owner",
      }, now);
    })();
    return this.getWorkspace(id)!;
  }

  createWorkspaceMember(input: {
    workspaceId: string;
    accountId?: string;
    name: string;
    email?: string | null;
    externalProvider?: WorkspaceMember["externalProvider"];
    externalId?: string | null;
    role?: WorkspaceRole;
    status?: WorkspaceMember["status"];
  }, now: number): WorkspaceMember {
    const id = newId("member");
    this.db.transaction(() => {
      let accountId = input.accountId;
      const provider = input.externalProvider ?? "local";
      if (!accountId && provider !== "local" && input.externalId) {
        accountId = this.getAuthIdentity(provider, input.externalId)?.accountId;
      }
      if (!accountId) {
        accountId = this.createAccount({
          displayName: input.name,
          primaryEmail: input.email ?? null,
          status: input.status === "disabled" ? "suspended" : "active",
        }, now).id;
        if (provider !== "local" && input.externalId) {
          this.createAuthIdentity({
            accountId,
            provider,
            subject: input.externalId,
            email: input.email ?? null,
            verifiedAt: now,
          }, now);
        }
      }
      const account = this.getAccount(accountId);
      if (!account) throw new Error("Membership Account 不存在");
      this.db.run(
        `INSERT INTO workspace_members
         (id, workspace_id, name, email, external_provider, external_id, role, status, created_at, account_id)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [id, input.workspaceId, account.displayName, account.primaryEmail, provider,
         input.externalId ?? null, input.role ?? "member", input.status ?? "active", now, accountId],
      );
    })();
    return this.getWorkspaceMember(id)!;
  }

  getWorkspaceMember(id: string): WorkspaceMember | null {
    const row = this.db.query<{
      id: string; workspace_id: string; account_id: string; name: string; email: string | null;
      external_provider: string; external_id: string | null; role: string; status: string; created_at: number;
    }, [string]>(
      `SELECT m.id, m.workspace_id, m.account_id,
              a.display_name AS name, a.primary_email AS email,
              COALESCE((SELECT i.provider FROM auth_identities i WHERE i.account_id = a.id ORDER BY i.verified_at DESC, i.created_at LIMIT 1), 'local') AS external_provider,
              (SELECT i.subject FROM auth_identities i WHERE i.account_id = a.id ORDER BY i.verified_at DESC, i.created_at LIMIT 1) AS external_id,
              m.role, m.status, m.created_at
       FROM workspace_members m JOIN accounts a ON a.id = m.account_id
       WHERE m.id = ?`,
    ).get(id);
    return row ? {
      id: row.id,
      workspaceId: row.workspace_id,
      accountId: row.account_id,
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
    const member = this.getWorkspaceMember(memberId);
    if (!member || member.workspaceId !== workspaceId || member.status !== "active") {
      throw new Error("只能给 active Membership 创建 PAT");
    }
    const id = newId("personalAccessToken");
    const scopes: PersonalAccessTokenScope[] = [
      "workspace:read", "workspace:write", "agent:run", "agent:manage", "device:manage",
    ];
    this.db.run(
      `INSERT INTO personal_access_tokens
       (id, account_id, workspace_id, label, prefix, token_hash, scopes, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, member.accountId, workspaceId, label, "harbor_legacy", tokenHash, JSON.stringify(scopes), now],
    );
    return id;
  }

  memberForApiToken(tokenHash: string, now: number): WorkspaceMember | null {
    const resolved = this.accountForPersonalAccessToken(tokenHash, now);
    if (!resolved?.token.workspaceId) return null;
    return this.membershipForAccount(resolved.account.id, resolved.token.workspaceId);
  }

  revokeWorkspaceApiToken(id: string, now: number): void {
    this.db.run("UPDATE personal_access_tokens SET revoked_at = ? WHERE id = ?", [now, id]);
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
      `SELECT t.id, t.workspace_id, m.id AS member_id, t.label, t.created_at, t.last_used_at, t.revoked_at
       FROM personal_access_tokens t
       JOIN workspace_members m ON m.workspace_id = t.workspace_id AND m.account_id = t.account_id
       WHERE t.workspace_id = ? ORDER BY t.created_at DESC`,
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

  membershipForAccount(accountId: string, workspaceId: string): WorkspaceMember | null {
    const row = this.db.query<{ id: string }, [string, string]>(
      `SELECT id FROM workspace_members
       WHERE account_id = ? AND workspace_id = ? AND status = 'active'`,
    ).get(accountId, workspaceId);
    return row ? this.getWorkspaceMember(row.id) : null;
  }

  listMembershipsForAccount(accountId: string, activeOnly = true): WorkspaceMember[] {
    const rows = this.db.query<{ id: string }, [string]>(
      `SELECT id FROM workspace_members WHERE account_id = ? ${activeOnly ? "AND status = 'active'" : ""}
       ORDER BY created_at, id`,
    ).all(accountId);
    return rows.map((row) => this.getWorkspaceMember(row.id)!).filter(Boolean);
  }

  hasLoginOwner(): boolean {
    return !!this.db.query<{ found: number }, []>(
      `SELECT 1 AS found
       FROM passkey_credentials p
       JOIN accounts a ON a.id = p.account_id
       JOIN workspace_members m ON m.account_id = a.id
       WHERE p.revoked_at IS NULL AND a.status = 'active'
         AND m.status = 'active' AND m.role = 'owner'
       LIMIT 1`,
    ).get();
  }

  listPasskeys(accountId: string): {
    id: string;
    accountId: string;
    credentialId: string;
    publicKey: Uint8Array;
    signCount: number;
    transports: string[];
    label: string | null;
    createdAt: number;
    lastUsedAt: number | null;
    revokedAt: number | null;
  }[] {
    return this.db.query<{
      id: string; account_id: string; credential_id: string; public_key: Uint8Array; sign_count: number;
      transports: string; label: string | null; created_at: number; last_used_at: number | null; revoked_at: number | null;
    }, [string]>(
      "SELECT * FROM passkey_credentials WHERE account_id = ? ORDER BY created_at, id",
    ).all(accountId).map((row) => ({
      id: row.id,
      accountId: row.account_id,
      credentialId: row.credential_id,
      publicKey: new Uint8Array(row.public_key),
      signCount: row.sign_count,
      transports: parseJsonArray<string>(row.transports),
      label: row.label,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at,
    }));
  }

  getPasskeyByCredentialId(credentialId: string) {
    const row = this.db.query<{ account_id: string }, [string]>(
      "SELECT account_id FROM passkey_credentials WHERE credential_id = ? AND revoked_at IS NULL",
    ).get(credentialId);
    return row ? this.listPasskeys(row.account_id).find((passkey) => passkey.credentialId === credentialId && !passkey.revokedAt) ?? null : null;
  }

  createPasskey(input: {
    accountId: string;
    credentialId: string;
    publicKey: Uint8Array;
    signCount: number;
    transports?: string[];
    label?: string | null;
  }, now: number): string {
    const id = newId("passkey");
    this.db.run(
      `INSERT INTO passkey_credentials
       (id, account_id, credential_id, public_key, sign_count, transports, label, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, input.accountId, input.credentialId, input.publicKey, input.signCount,
       JSON.stringify(input.transports ?? []), input.label ?? null, now],
    );
    return id;
  }

  updatePasskeyCounter(credentialId: string, signCount: number, now: number): void {
    this.db.run(
      "UPDATE passkey_credentials SET sign_count = ?, last_used_at = ? WHERE credential_id = ? AND revoked_at IS NULL",
      [signCount, now, credentialId],
    );
  }

  createAuthChallenge(input: {
    tokenHash: string;
    flow: "bootstrap" | "register" | "invite" | "authenticate";
    accountId?: string | null;
    invitationId?: string | null;
    displayName?: string | null;
    challenge: string;
    expiresAt: number;
  }, now: number): string {
    const id = newId("authChallenge");
    this.db.run(
      `INSERT INTO webauthn_challenges
       (id, token_hash, flow, account_id, invitation_id, display_name, challenge, expires_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, input.tokenHash, input.flow, input.accountId ?? null, input.invitationId ?? null,
       input.displayName?.trim() || null, input.challenge, input.expiresAt, now],
    );
    return id;
  }

  consumeAuthChallenge(tokenHash: string, flow: "bootstrap" | "register" | "invite" | "authenticate", now: number): {
    id: string; flow: string; accountId: string | null; invitationId: string | null; displayName: string | null; challenge: string;
  } | null {
    return this.db.transaction(() => {
      const row = this.db.query<{
        id: string; flow: string; account_id: string | null; invitation_id: string | null; display_name: string | null; challenge: string;
      }, [string, string, number]>(
        `SELECT id, flow, account_id, invitation_id, display_name, challenge FROM webauthn_challenges
         WHERE token_hash = ? AND flow = ? AND consumed_at IS NULL AND expires_at > ?`,
      ).get(tokenHash, flow, now);
      if (!row) return null;
      const changed = this.db.run(
        "UPDATE webauthn_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL",
        [now, row.id],
      ).changes;
      return changed === 1 ? {
        id: row.id, flow: row.flow, accountId: row.account_id,
        invitationId: row.invitation_id, displayName: row.display_name, challenge: row.challenge,
      } : null;
    })();
  }

  createSession(input: {
    accountId: string;
    tokenHash: string;
    csrfTokenHash: string;
    expiresAt: number;
  }, now: number): string {
    const id = newId("session");
    this.db.run(
      `INSERT INTO account_sessions
       (id, account_id, token_hash, csrf_token_hash, expires_at, created_at)
       VALUES (?,?,?,?,?,?)`,
      [id, input.accountId, input.tokenHash, input.csrfTokenHash, input.expiresAt, now],
    );
    return id;
  }

  accountForSession(tokenHash: string, now: number): { account: Account; csrfTokenHash: string; sessionId: string } | null {
    const row = this.db.query<{ id: string; account_id: string; csrf_token_hash: string }, [string, number]>(
      `SELECT id, account_id, csrf_token_hash FROM account_sessions
       WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
    ).get(tokenHash, now);
    if (!row) return null;
    const account = this.getAccount(row.account_id);
    if (!account || account.status !== "active") return null;
    this.db.run("UPDATE account_sessions SET last_used_at = ? WHERE id = ?", [now, row.id]);
    return { account, csrfTokenHash: row.csrf_token_hash, sessionId: row.id };
  }

  revokeSession(id: string, now: number): void {
    this.db.run("UPDATE account_sessions SET revoked_at = ? WHERE id = ?", [now, id]);
  }

  createRecoveryCodes(accountId: string, codeHashes: string[], now: number): void {
    const insert = this.db.prepare(
      "INSERT INTO account_recovery_codes (account_id, code_hash, created_at) VALUES (?,?,?)",
    );
    this.db.transaction(() => {
      for (const codeHash of codeHashes) insert.run(accountId, codeHash, now);
    })();
  }

  consumeRecoveryCode(accountId: string, codeHash: string, now: number): boolean {
    return this.db.run(
      `UPDATE account_recovery_codes SET used_at = ?
       WHERE account_id = ? AND code_hash = ? AND used_at IS NULL`,
      [now, accountId, codeHash],
    ).changes === 1;
  }

  createPersonalAccessToken(input: {
    accountId: string;
    workspaceId?: string | null;
    label: string;
    prefix: string;
    tokenHash: string;
    scopes: PersonalAccessTokenScope[];
    expiresAt?: number | null;
  }, now: number): PersonalAccessToken {
    if (input.workspaceId && !this.membershipForAccount(input.accountId, input.workspaceId)) {
      throw new Error("PAT workspace binding 需要 active Membership");
    }
    const id = newId("personalAccessToken");
    this.db.run(
      `INSERT INTO personal_access_tokens
       (id, account_id, workspace_id, label, prefix, token_hash, scopes, created_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, input.accountId, input.workspaceId ?? null, input.label, input.prefix, input.tokenHash,
       JSON.stringify(input.scopes), now, input.expiresAt ?? null],
    );
    return this.getPersonalAccessToken(id)!;
  }

  getPersonalAccessToken(id: string): PersonalAccessToken | null {
    const row = this.db.query<{
      id: string; account_id: string; workspace_id: string | null; label: string; prefix: string;
      scopes: string; created_at: number; expires_at: number | null; last_used_at: number | null; revoked_at: number | null;
    }, [string]>(
      `SELECT id, account_id, workspace_id, label, prefix, scopes, created_at, expires_at, last_used_at, revoked_at
       FROM personal_access_tokens WHERE id = ?`,
    ).get(id);
    return row ? {
      id: row.id,
      accountId: row.account_id,
      workspaceId: row.workspace_id,
      label: row.label,
      prefix: row.prefix,
      scopes: parseJsonArray<PersonalAccessTokenScope>(row.scopes),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at,
    } : null;
  }

  listPersonalAccessTokens(accountId: string): PersonalAccessToken[] {
    return this.db.query<{ id: string }, [string]>(
      "SELECT id FROM personal_access_tokens WHERE account_id = ? ORDER BY created_at DESC",
    ).all(accountId).map((row) => this.getPersonalAccessToken(row.id)!);
  }

  accountForPersonalAccessToken(tokenHash: string, now: number): { account: Account; token: PersonalAccessToken } | null {
    const row = this.db.query<{ id: string; account_id: string }, [string, number]>(
      `SELECT id, account_id FROM personal_access_tokens
       WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
    ).get(tokenHash, now);
    if (!row) return null;
    const account = this.getAccount(row.account_id);
    const token = this.getPersonalAccessToken(row.id);
    if (!account || account.status !== "active" || !token) return null;
    this.db.run("UPDATE personal_access_tokens SET last_used_at = ? WHERE id = ?", [now, row.id]);
    token.lastUsedAt = now;
    return { account, token };
  }

  revokePersonalAccessToken(id: string, accountId: string, now: number): boolean {
    return this.db.run(
      "UPDATE personal_access_tokens SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL",
      [now, id, accountId],
    ).changes === 1;
  }

  createWorkspaceInvitation(input: {
    workspaceId: string;
    email?: string | null;
    role: WorkspaceRole;
    tokenHash: string;
    invitedByAccountId: string;
    expiresAt: number;
  }, now: number): WorkspaceInvitation {
    const id = newId("invitation");
    this.db.run(
      `INSERT INTO workspace_invitations
       (id, workspace_id, email, role, token_hash, status, invited_by_account_id, expires_at, created_at)
       VALUES (?,?,?,?,?,'pending',?,?,?)`,
      [id, input.workspaceId, input.email?.trim() || null, input.role, input.tokenHash,
       input.invitedByAccountId, input.expiresAt, now],
    );
    return this.getWorkspaceInvitation(id)!;
  }

  getWorkspaceInvitation(id: string): WorkspaceInvitation | null {
    const row = this.db.query<{
      id: string; workspace_id: string; email: string | null; role: string; status: string;
      invited_by_account_id: string; expires_at: number; created_at: number; accepted_at: number | null;
    }, [string]>(
      `SELECT id, workspace_id, email, role, status, invited_by_account_id, expires_at, created_at, accepted_at
       FROM workspace_invitations WHERE id = ?`,
    ).get(id);
    return row ? {
      id: row.id,
      workspaceId: row.workspace_id,
      email: row.email,
      role: row.role as WorkspaceRole,
      status: row.status as WorkspaceInvitation["status"],
      invitedByAccountId: row.invited_by_account_id,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      acceptedAt: row.accepted_at,
    } : null;
  }

  listWorkspaceInvitations(workspaceId: string): WorkspaceInvitation[] {
    return this.db.query<{ id: string }, [string]>(
      "SELECT id FROM workspace_invitations WHERE workspace_id = ? ORDER BY created_at DESC",
    ).all(workspaceId).map((row) => this.getWorkspaceInvitation(row.id)!);
  }

  workspaceInvitationForToken(tokenHash: string, now: number): WorkspaceInvitation | null {
    const row = this.db.query<{ id: string }, [string, number]>(
      `SELECT id FROM workspace_invitations
       WHERE token_hash = ? AND status = 'pending' AND expires_at > ?`,
    ).get(tokenHash, now);
    return row ? this.getWorkspaceInvitation(row.id) : null;
  }

  invitationRegistrationAccount(invitationId: string): Account | null {
    const row = this.db.query<{ account_id: string }, [string]>(
      `SELECT c.account_id
       FROM webauthn_challenges c
       JOIN accounts a ON a.id = c.account_id
       WHERE c.invitation_id = ? AND c.flow = 'invite' AND a.status = 'suspended'
       ORDER BY c.created_at DESC LIMIT 1`,
    ).get(invitationId);
    return row ? this.getAccount(row.account_id) : null;
  }

  completeInvitationRegistration(input: {
    invitationId: string;
    accountId: string;
    credential: {
      id: string;
      publicKey: Uint8Array;
      counter: number;
      transports: string[];
    };
    passkeyLabel?: string | null;
    recoveryCodeHashes: string[];
  }, now: number): { account: Account; membership: WorkspaceMember; personalWorkspace: HarborWorkspace } {
    return this.db.transaction(() => {
      const invitation = this.getWorkspaceInvitation(input.invitationId);
      if (!invitation || invitation.status !== "pending" || invitation.expiresAt <= now) {
        throw new Error("Invitation 不存在、已过期或已结束");
      }
      const account = this.getAccount(input.accountId);
      if (!account || account.status !== "suspended") throw new Error("Invitation registration Account 不可用");
      if (invitation.email && invitation.email.trim().toLowerCase() !== account.primaryEmail?.trim().toLowerCase()) {
        throw new Error("Invitation email 与注册 Account 不匹配");
      }
      this.createPasskey({
        accountId: account.id,
        credentialId: input.credential.id,
        publicKey: input.credential.publicKey,
        signCount: input.credential.counter,
        transports: input.credential.transports,
        label: input.passkeyLabel ?? null,
      }, now);
      this.createRecoveryCodes(account.id, input.recoveryCodeHashes, now);
      this.db.run("UPDATE accounts SET status = 'active', updated_at = ? WHERE id = ? AND status = 'suspended'", [now, account.id]);
      const personalWorkspace = this.createWorkspace({
        name: `${account.displayName}'s Harbor`,
        slug: `personal-${account.id.replace(/[^a-z0-9]/gi, "").slice(-12).toLowerCase()}`,
        description: "Personal Workspace",
        ownerAccountId: account.id,
        kind: "personal",
      }, now);
      const membership = this.acceptWorkspaceInvitation(invitation.id, account.id, now);
      return { account: this.getAccount(account.id)!, membership, personalWorkspace };
    })();
  }

  acceptWorkspaceInvitation(id: string, accountId: string, now: number): WorkspaceMember {
    return this.db.transaction(() => {
      const invitation = this.getWorkspaceInvitation(id);
      if (!invitation || invitation.status !== "pending" || invitation.expiresAt <= now) {
        throw new Error("Invitation 不存在、已过期或已结束");
      }
      const account = this.getAccount(accountId);
      if (!account || account.status !== "active") throw new Error("Account 不存在或不可用");
      if (invitation.email && invitation.email.trim().toLowerCase() !== account.primaryEmail?.trim().toLowerCase()) {
        throw new Error("Invitation email 与当前 Account 不匹配");
      }
      if (this.membershipForAccount(accountId, invitation.workspaceId)) {
        throw new Error("Account 已是该 Workspace 的 active member");
      }
      const member = this.createWorkspaceMember({
        workspaceId: invitation.workspaceId,
        accountId,
        name: account.displayName,
        role: invitation.role,
      }, now);
      this.db.run(
        "UPDATE workspace_invitations SET status = 'accepted', accepted_at = ? WHERE id = ? AND status = 'pending'",
        [now, id],
      );
      return member;
    })();
  }

  revokeWorkspaceInvitation(id: string, workspaceId: string, now: number): boolean {
    return this.db.run(
      `UPDATE workspace_invitations SET status = 'revoked'
       WHERE id = ? AND workspace_id = ? AND status = 'pending'`,
      [id, workspaceId],
    ).changes === 1;
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
      const serialized = JSON.stringify(capabilities);
      if (this.hasDeviceSummaryColumn) {
        this.db.run(
          "UPDATE devices SET token_hash = ?, capabilities = ?, capabilities_summary = ?, last_seen_at = ? WHERE id = ?",
          [tokenHash, serialized, JSON.stringify(summarizeDeviceCapabilities(capabilities)), now, existing.id],
        );
      } else {
        this.db.run(
          "UPDATE devices SET token_hash = ?, capabilities = ?, last_seen_at = ? WHERE id = ?",
          [tokenHash, serialized, now, existing.id],
        );
      }
      const device = toDevice({ ...existing, capabilities: JSON.stringify(capabilities), last_seen_at: now }, true);
      this.autoSyncRuntimeSkills(device, now);
      return device;
    }
    const id = newId("device");
    if (this.hasDeviceSummaryColumn) {
      this.db.run(
        "INSERT INTO devices (id, name, token_hash, capabilities, capabilities_summary, last_seen_at, created_at) VALUES (?,?,?,?,?,?,?)",
        [id, name, tokenHash, JSON.stringify(capabilities), JSON.stringify(summarizeDeviceCapabilities(capabilities)), now, now],
      );
    } else {
      this.db.run(
        "INSERT INTO devices (id, name, token_hash, capabilities, last_seen_at, created_at) VALUES (?,?,?,?,?,?)",
        [id, name, tokenHash, JSON.stringify(capabilities), now, now],
      );
    }
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

  /** 只读展示名时不得解析可能包含完整 runtime Skill bundles 的 capabilities。 */
  getDeviceName(id: string): string | null {
    return this.db.query<{ name: string }, [string]>("SELECT name FROM devices WHERE id = ?").get(id)?.name ?? null;
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

  /** 高频列表只读取持久化 summary，避免每次反序列化完整 runtime Skill bundle。 */
  listDeviceSummaries(onlineIds: Set<string>): DeviceSummary[] {
    if (!this.hasDeviceSummaryColumn) return this.listDevices(onlineIds).map(summarizeDevice);
    return this.db
      .query<DeviceRow, []>(
        "SELECT id, name, capabilities_summary, last_seen_at, created_at FROM devices ORDER BY created_at",
      )
      .all()
      .map((row) => toDeviceSummary(row, onlineIds.has(row.id)));
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
      name?: string;
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
    if (patch.name !== undefined) add("name", patch.name);
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

  /**
   * Device 是 Agent 的当前执行位置，不是历史 Run 的可变引用。
   * 迁移只更新未来派发，并解除旧 Device 独占的 runtime Skills；历史 Run 快照保持原样。
   */
  moveAgentToDevice(id: string, deviceId: string, repositoryId: string): void {
    this.db.transaction(() => {
      this.db.run("UPDATE agents SET device_id = ?, repository_id = ? WHERE id = ?", [deviceId, repositoryId, id]);
      this.db.run(
        `DELETE FROM agent_skills
         WHERE agent_id = ? AND skill_id IN (
           SELECT id FROM skills WHERE source = 'runtime' AND (device_id IS NULL OR device_id <> ?)
         )`,
        [id, deviceId],
      );
    })();
  }

  /** Repository 或 Device 会共同改变未来 Run 的 execution binding，使用同一安全闸。 */
  agentExecutionBindingChangeBlocker(agentId: string): string | null {
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

  agentRepositoryChangeBlocker(agentId: string): string | null {
    return this.agentExecutionBindingChangeBlocker(agentId);
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
    let createdEvent: DomainEvent | null = null;
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
      if (c.kind === "issue") {
        createdEvent = this.insertDomainEvent({
          id: `issue.created:${id}`,
          workspaceId,
          type: "issue.created",
          sourceType: "issue",
          sourceId: id,
          payload: {
            conversationId: id,
            repositoryId,
            status,
            title: c.title ?? null,
          },
        }, now);
      }
    })();
    this.notifyDomainEvent(createdEvent);
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
    let readyEvent: DomainEvent | null = null;
    this.db.transaction(() => {
      this.db.run("UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?", [status, now, id]);
      if (status === "todo") {
        const conversation = this.getConversation(id);
        if (conversation?.kind === "issue") {
          readyEvent = this.insertDomainEvent({
            id: `issue.ready:${id}`,
            workspaceId: conversation.workspaceId,
            type: "issue.ready",
            sourceType: "issue",
            sourceId: id,
            payload: {
              conversationId: id,
              repositoryId: conversation.repositoryId,
              status,
              title: conversation.title,
            },
          }, now);
        }
      }
    })();
    this.notifyDomainEvent(readyEvent);
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
    attachments: RunAttachment[] = [],
  ): ConversationMessage {
    const existing = input.externalId
      ? this.db.query<{ id: string }, [string, string]>(
          "SELECT id FROM conversation_messages WHERE conversation_id = ? AND external_id = ?",
        ).get(conversationId, input.externalId)
      : null;
    if (existing) return this.getConversationMessage(existing.id)!;
    const id = newId("message");
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO conversation_messages
         (id, conversation_id, author_type, author_id, author_name, body, external_id, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [id, conversationId, input.authorType, input.authorId, input.authorName, input.body, input.externalId, now],
      );
      if (attachments.length > 0) {
        const insert = this.db.prepare(
          "INSERT INTO message_attachments (message_id, position, name, mime, data_base64) VALUES (?,?,?,?,?)",
        );
        attachments.forEach((attachment, position) =>
          insert.run(id, position, attachment.name, attachment.mime, attachment.dataBase64));
      }
      this.db.run("UPDATE conversations SET updated_at = ? WHERE id = ?", [now, conversationId]);
    })();
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
      attachments: this.listMessageAttachmentMeta(row.id),
      createdAt: row.created_at,
    } : null;
  }

  listConversationMessages(conversationId: string): ConversationMessage[] {
    return this.db.query<{ id: string }, [string]>(
      "SELECT id FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at, rowid",
    ).all(conversationId).map((row) => this.getConversationMessage(row.id)!);
  }

  listMessageAttachmentMeta(messageId: string): { name: string; mime: string }[] {
    if (!this.hasMessageAttachmentsTable) return [];
    return this.db.query<{ name: string; mime: string }, [string]>(
      "SELECT name, mime FROM message_attachments WHERE message_id = ? ORDER BY position",
    ).all(messageId);
  }

  getMessageAttachment(messageId: string, position: number): RunAttachment | null {
    const row = this.db.query<{ name: string; mime: string; data_base64: string }, [string, number]>(
      "SELECT name, mime, data_base64 FROM message_attachments WHERE message_id = ? AND position = ?",
    ).get(messageId, position);
    return row ? { name: row.name, mime: row.mime, dataBase64: row.data_base64 } : null;
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
      latestHeadSha?: string | null;
      checkStatus?: DeliveryCheckStatus;
    },
    now: number,
  ): Delivery {
    const id = newId("delivery");
    this.db.run(
      `INSERT INTO deliveries
       (id, conversation_id, provider, change_url, external_id, head_branch, base_branch, latest_head_sha, check_status,
        created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?, ?,?)`,
      [
        id,
        input.conversationId,
        input.provider,
        input.changeUrl ?? null,
        input.externalId ?? null,
        input.headBranch ?? null,
        input.baseBranch ?? null,
        input.latestHeadSha?.toLowerCase() ?? null,
        input.checkStatus ?? "unknown",
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
    patch: {
      changeUrl?: string | null;
      externalId?: string | null;
      headBranch?: string | null;
      baseBranch?: string | null;
      latestHeadSha?: string | null;
      mergedRevision?: string | null;
    },
    now: number,
  ): void {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    const fields: [keyof typeof patch, string][] = [
      ["changeUrl", "change_url"],
      ["externalId", "external_id"],
      ["headBranch", "head_branch"],
      ["baseBranch", "base_branch"],
      ["latestHeadSha", "latest_head_sha"],
      ["mergedRevision", "merged_revision"],
    ];
    for (const [key, column] of fields) {
      if (!(key in patch)) continue;
      sets.push(`${column} = ?`);
      params.push(patch[key] ?? null);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = ?", "revision = revision + 1");
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
      reviewApprovedAt?: number | null;
      approvedHeadSha?: string | null;
      mergedAt?: number | null;
      mergedRevision?: string | null;
    },
    now: number,
  ): void {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    const fields: [keyof typeof patch, string][] = [
      ["reviewStatus", "review_status"],
      ["checkStatus", "check_status"],
      ["mergeStatus", "merge_status"],
      ["reviewApprovedAt", "review_approved_at"],
      ["approvedHeadSha", "approved_head_sha"],
      ["mergedAt", "merged_at"],
      ["mergedRevision", "merged_revision"],
    ];
    for (const [key, column] of fields) {
      if (!(key in patch)) continue;
      sets.push(`${column} = ?`);
      params.push(patch[key] ?? null);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = ?", "revision = revision + 1");
    params.push(now, id);
    this.db.run(`UPDATE deliveries SET ${sets.join(", ")} WHERE id = ?`, params);
    this.touchDeliveryConversation(id, now);
  }

  /**
   * Provider HTTP 返回后只在证据版本未变化时原子落库，并把对应 audit event 放进同一事务。
   * 这防止 implementation/request-changes 在 HTTP 等待期间失效证据后，旧结果仍覆盖新状态。
   */
  compareAndSetDelivery(
    id: string,
    expectedRevision: number,
    patch: {
      changeUrl?: string | null;
      externalId?: string | null;
      headBranch?: string | null;
      baseBranch?: string | null;
      latestHeadSha?: string | null;
      approvedHeadSha?: string | null;
      reviewStatus?: DeliveryReviewStatus;
      checkStatus?: DeliveryCheckStatus;
      mergeStatus?: DeliveryMergeStatus;
      reviewApprovedAt?: number | null;
      mergedAt?: number | null;
      mergedRevision?: string | null;
    },
    events: { kind: string; data: unknown; actor: DeliveryEvent["actor"] }[],
    now: number,
  ): boolean {
    const columns: [keyof typeof patch, string][] = [
      ["changeUrl", "change_url"],
      ["externalId", "external_id"],
      ["headBranch", "head_branch"],
      ["baseBranch", "base_branch"],
      ["latestHeadSha", "latest_head_sha"],
      ["approvedHeadSha", "approved_head_sha"],
      ["reviewStatus", "review_status"],
      ["checkStatus", "check_status"],
      ["mergeStatus", "merge_status"],
      ["reviewApprovedAt", "review_approved_at"],
      ["mergedAt", "merged_at"],
      ["mergedRevision", "merged_revision"],
    ];
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    for (const [key, column] of columns) {
      if (!(key in patch)) continue;
      sets.push(`${column} = ?`);
      params.push(patch[key] ?? null);
    }
    if (sets.length === 0) return true;
    return this.db.transaction(() => {
      const updated = this.db.run(
        `UPDATE deliveries SET ${sets.join(", ")}, updated_at = ?, revision = revision + 1
         WHERE id = ? AND revision = ?`,
        [...params, now, id, expectedRevision],
      );
      if (updated.changes !== 1) return false;
      for (const event of events) {
        this.db.run(
          "INSERT INTO delivery_events (delivery_id, kind, data, actor, ts) VALUES (?,?,?,?,?)",
          [id, event.kind, JSON.stringify(event.data ?? {}), event.actor, now],
        );
      }
      this.touchDeliveryConversation(id, now);
      return true;
    })();
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

  /** Release Agent 提交 exact revision；幂等键归 source Run，generation 归 Harbor host target。 */
  enqueueDeploymentJob(
    sourceRunId: string,
    requestKey: string,
    repositoryId: string,
    targetId: string,
    revision: string,
    targetFingerprint: string,
    targetManifestHash: string,
    now: number,
  ): { job: DeploymentJob; created: boolean } {
    if (!/^[a-f0-9]{40,64}$/i.test(revision)) throw new Error("deployment revision 必须是完整十六进制 commit id");
    if (!/^[a-f0-9]{64}$/.test(targetFingerprint)) throw new Error("deployment target fingerprint 无效");
    if (!/^[a-f0-9]{64}$/.test(targetManifestHash)) throw new Error("deployment target manifest hash 无效");
    if (!requestKey || requestKey.length > 128) throw new Error("self deployment request key 需要 1–128 字符");
    return this.db.transaction(() => {
      const run = this.db.query<{ repository_id: string | null }, [string]>(
        "SELECT repository_id FROM runs WHERE id = ?",
      ).get(sourceRunId);
      if (!run || run.repository_id !== repositoryId) throw new Error("self deployment source Run/Repository identity 不匹配");
      const existing = this.db.query<DeploymentJobRow, [string, string]>(
        "SELECT * FROM self_deploy_jobs WHERE source_run_id = ? AND request_key = ?",
      ).get(sourceRunId, requestKey);
      if (existing) {
        if (existing.repository_id !== repositoryId || existing.target_id !== targetId
          || existing.revision !== revision.toLowerCase() || existing.target_fingerprint !== targetFingerprint
          || existing.target_manifest_hash !== targetManifestHash) {
          throw new Error("self deployment idempotencyKey 已绑定到不同请求");
        }
        return { job: toDeploymentJob(existing), created: false };
      }
      const active = this.db.query<{ id: string }, [string]>(
        "SELECT id FROM self_deploy_jobs WHERE target_id = ? AND status IN ('queued','running','recovering','needs_recovery') LIMIT 1",
      ).get(targetId);
      if (active) throw new Error(`Harbor self deployment 已有未完成 job ${active.id}`);
      const generation = (this.db.query<{ generation: number }, [string]>(
        "SELECT COALESCE(MAX(generation), 0) AS generation FROM self_deploy_jobs WHERE target_id = ?",
      ).get(targetId)?.generation ?? 0) + 1;
      const id = newId("deploymentJob");
      this.db.run(
        `INSERT INTO self_deploy_jobs
         (id, source_run_id, request_key, repository_id, generation, target_id, revision, target_fingerprint, target_manifest_hash,
          status, attempt, checkpoint, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,'queued',0,'queued',?,?)`,
        [id, sourceRunId, requestKey, repositoryId, generation, targetId, revision.toLowerCase(),
          targetFingerprint, targetManifestHash, now, now],
      );
      return { job: toDeploymentJob(this.db.query<DeploymentJobRow, [string]>("SELECT * FROM self_deploy_jobs WHERE id = ?").get(id)!), created: true };
    })();
  }

  getDeploymentJob(id: string): DeploymentJob | null {
    const row = this.db.query<DeploymentJobRow, [string]>("SELECT * FROM self_deploy_jobs WHERE id = ?").get(id);
    return row ? toDeploymentJob(row) : null;
  }

  getDeploymentJobView(id: string): DeploymentJobView | null {
    const job = this.getDeploymentJob(id);
    if (!job) return null;
    return {
      id: job.id,
      sourceRunId: job.sourceRunId,
      repositoryId: job.repositoryId,
      generation: job.generation,
      targetId: job.targetId,
      revision: job.revision,
      status: job.status,
      attempt: job.attempt,
      checkpoint: job.checkpoint,
      log: job.log === null ? null : redactStructured(job.log).slice(0, 32_000),
      error: job.error === null ? null : redactStructured(job.error).slice(0, 4_000),
      failureKind: job.failureKind,
      rollbackComplete: job.rollbackComplete,
      fenceEpoch: job.fenceEpoch,
      recoveryRequired: job.status === "needs_recovery",
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      updatedAt: job.updatedAt,
    };
  }

  listDeploymentJobs(sourceRunId: string): DeploymentJob[] {
    return this.db
      .query<DeploymentJobRow, [string]>("SELECT * FROM self_deploy_jobs WHERE source_run_id = ? ORDER BY generation")
      .all(sourceRunId)
      .map(toDeploymentJob);
  }

  /** queued 或 lease 已过期的 running job 才能领取；新 token fencing 旧 worker。 */
  claimDeploymentJob(targets: { id: string; fingerprint: string; manifestHash: string }[], now: number, leaseMs: number): DeploymentJob | null {
    if (targets.length === 0) return null;
    return this.db.transaction(() => {
      // Release Agent 必须先成功结束，sidecar 才能停止承载该 Run 的 daemon。
      // source Run 失败/取消则在任何 host mutation 前把请求原子终止，避免 queued job 永久占位。
      this.db.run(
        `UPDATE self_deploy_jobs
         SET status = 'failed', failure_kind = 'deployment_failed', rollback_complete = 1,
             checkpoint = 'source_run_failed', error = 'source Release Agent Run did not succeed',
             finished_at = ?, updated_at = ?
         WHERE status = 'queued' AND EXISTS (
           SELECT 1 FROM runs source
           WHERE source.id = self_deploy_jobs.source_run_id AND source.status IN ('failed','canceled')
         )`,
        [now, now],
      );
      const targetPredicate = targets.map(() => "(j.target_id = ? AND j.target_fingerprint = ? AND j.target_manifest_hash = ?)").join(" OR ");
      const row = this.db
        .query<DeploymentJobRow, (string | number)[]>(
          `SELECT j.* FROM self_deploy_jobs j
           JOIN runs source ON source.id = j.source_run_id
           WHERE (${targetPredicate}) AND source.status = 'succeeded'
             AND (j.status = 'queued' OR (j.status = 'running' AND j.lease_expires_at IS NOT NULL AND j.lease_expires_at <= ?))
           ORDER BY j.created_at, j.generation LIMIT 1`,
        )
        .get(...targets.flatMap((target) => [target.id, target.fingerprint, target.manifestHash]), now);
      if (!row) return null;
      const leaseToken = newId("deploymentLease");
      const fenceNonce = newId("deploymentLease");
      this.db.run("UPDATE self_deploy_host_fence SET epoch = epoch + 1 WHERE lock_id = 1");
      const fenceEpoch = this.db.query<{ epoch: number }, []>("SELECT epoch FROM self_deploy_host_fence WHERE lock_id = 1").get()!.epoch;
      const updated = this.db.run(
        `UPDATE self_deploy_jobs
         SET status = 'running', attempt = attempt + 1, lease_token = ?, lease_expires_at = ?,
             fence_epoch = ?, fence_nonce = ?,
             started_at = COALESCE(started_at, ?), updated_at = ?
         WHERE id = ? AND EXISTS (
           SELECT 1 FROM runs source WHERE source.id = self_deploy_jobs.source_run_id AND source.status = 'succeeded'
         ) AND (status = 'queued' OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?))`,
        [leaseToken, now + leaseMs, fenceEpoch, fenceNonce, now, now, row.id, now],
      );
      if (updated.changes !== 1) return null;
      this.db.run(
        `UPDATE self_deploy_maintenance SET fence_epoch = ?, fence_nonce = ?, updated_at = ?
         WHERE lock_id = 1 AND job_id = ?`,
        [fenceEpoch, fenceNonce, now, row.id],
      );
      const claimed = this.db.query<DeploymentJobRow, [string]>("SELECT * FROM self_deploy_jobs WHERE id = ?").get(row.id)!;
      return toDeploymentJob(claimed);
    })();
  }

  /** 配置删除/漂移不能让 queued job 永久饥饿；maintenance 中的漂移则必须管理员恢复。 */
  failDeploymentConfigDrift(
    targets: { id: string; fingerprint: string; manifestHash: string }[],
    now: number,
  ): number {
    const configured = new Map(targets.map((target) => [target.id, target]));
    return this.db.transaction(() => {
      let changed = 0;
      const globalGate = this.db.query<{ job_id: string }, []>(
        "SELECT job_id FROM self_deploy_maintenance WHERE lock_id = 1",
      ).get();
      const rows = this.db.query<DeploymentJobRow, []>(
        "SELECT * FROM self_deploy_jobs WHERE status IN ('queued','running')",
      ).all();
      for (const row of rows) {
        const target = configured.get(row.target_id);
        if (target && target.fingerprint === row.target_fingerprint && target.manifestHash === row.target_manifest_hash) continue;
        const gate = this.db.query<DeploymentMaintenanceRow, [string]>("SELECT * FROM self_deploy_maintenance WHERE job_id = ?").get(row.id);
        // 另一target正处于全局maintenance时，application-table trigger禁止投影
        // Delivery failure。先保留queued/running，放闸后的下一轮会显式落
        // config_drift，避免一次worker扫描被trigger中断或产生半终态。
        if (!gate && globalGate) continue;
        const status = gate ? "needs_recovery" : "failed";
        const failureKind = gate ? "rollback_incomplete" : "config_drift";
        const error = gate
          ? "deployment target config drifted while host maintenance is active; administrator recovery required"
          : "deployment target config drifted or was removed before cutover";
        this.db.run(
          `UPDATE self_deploy_jobs SET status = ?, failure_kind = ?, error = ?, rollback_complete = ?,
             checkpoint = ?, lease_token = NULL, lease_expires_at = NULL, finished_at = ?, updated_at = ? WHERE id = ?`,
          [status, failureKind, error, gate ? 0 : 1, gate ? "rollback_incomplete" : "failed", now, now, row.id],
        );
        if (gate) this.db.run("UPDATE self_deploy_maintenance SET phase = 'needs_recovery', updated_at = ? WHERE job_id = ?", [now, row.id]);
        changed++;
      }
      return changed;
    })();
  }

  renewDeploymentJob(id: string, fence: DeploymentFence, now: number, leaseMs: number): boolean {
    return this.db.transaction(() => {
      const job = this.db.query<DeploymentJobRow, [string]>("SELECT * FROM self_deploy_jobs WHERE id = ?").get(id);
      if (!job || !(job.status === "running" || job.status === "recovering")
        || job.lease_token !== fence.leaseToken || job.fence_epoch !== fence.fenceEpoch || job.fence_nonce !== fence.fenceNonce) return false;
      return this.db.run(
        `UPDATE self_deploy_jobs SET lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status IN ('running','recovering') AND lease_token = ? AND fence_epoch = ? AND fence_nonce = ?`,
        [now + leaseMs, now, id, fence.leaseToken, fence.fenceEpoch, fence.fenceNonce],
      ).changes === 1;
    })();
  }

  updateDeploymentCheckpoint(
    id: string,
    fence: DeploymentFence,
    checkpoint: string,
    now: number,
    metadata: { newServicePids?: Record<string, number>; databaseBackupCreated?: boolean; log?: string } = {},
  ): boolean {
    const safeLog = Object.hasOwn(metadata, "log") ? redactStructured(metadata.log ?? "").slice(0, 32_000) : null;
    return this.db.run(
      `UPDATE self_deploy_jobs SET checkpoint = ?,
         new_service_pids = CASE WHEN ? = 1 THEN ? ELSE new_service_pids END,
         database_backup_created = CASE WHEN ? = 1 THEN ? ELSE database_backup_created END,
         log = CASE WHEN ? = 1 THEN ? ELSE log END,
         updated_at = ?
       WHERE id = ? AND status IN ('running','recovering') AND lease_token = ? AND fence_epoch = ? AND fence_nonce = ?`,
      [checkpoint, Object.hasOwn(metadata, "newServicePids") ? 1 : 0, JSON.stringify(metadata.newServicePids ?? {}),
        Object.hasOwn(metadata, "databaseBackupCreated") ? 1 : 0, metadata.databaseBackupCreated ? 1 : 0,
        Object.hasOwn(metadata, "log") ? 1 : 0, safeLog, now,
        id, fence.leaseToken, fence.fenceEpoch, fence.fenceNonce],
    ).changes === 1;
  }

  getDeploymentMaintenance(targetId?: string): DeploymentMaintenanceGate | null {
    const row = this.db.query<DeploymentMaintenanceRow, []>("SELECT * FROM self_deploy_maintenance WHERE lock_id = 1").get();
    if (targetId && row?.target_id !== targetId) return null;
    return row ? toDeploymentMaintenance(row) : null;
  }

  listDeploymentMaintenance(): DeploymentMaintenanceGate[] {
    return this.db.query<DeploymentMaintenanceRow, []>("SELECT * FROM self_deploy_maintenance WHERE lock_id = 1").all().map(toDeploymentMaintenance);
  }

  assertDeploymentFence(id: string, fence: DeploymentFence): boolean {
    return !!this.db.query<{ id: string }, [string, string, number, string]>(
      `SELECT id FROM self_deploy_jobs WHERE id = ? AND status IN ('running','recovering')
       AND lease_token = ? AND fence_epoch = ? AND fence_nonce = ?`,
    ).get(id, fence.leaseToken, fence.fenceEpoch, fence.fenceNonce);
  }

  assertDeploymentReleaseFence(gate: DeploymentMaintenanceGate): boolean {
    const maintenanceRow = this.db.query<DeploymentMaintenanceRow, []>("SELECT * FROM self_deploy_maintenance WHERE lock_id = 1").get();
    if (!maintenanceRow || !sameMaintenanceState(toDeploymentMaintenance(maintenanceRow), gate) || gate.phase !== "releasing") return false;
    const job = this.db.query<DeploymentJobRow, [string]>("SELECT * FROM self_deploy_jobs WHERE id = ?").get(gate.jobId);
    if (!job || job.source_run_id !== gate.sourceRunId || job.generation !== gate.generation || job.revision !== gate.revision) return false;
    return job.status === "succeeded" || (job.status === "failed" && job.rollback_complete === 1);
  }

  /**
   * 必须在 host-global sentinel lock 内、紧邻真实 SQLite replace 调用。
   * 较新的并行 build claim 会推进 DB high-water；旧 rollback 宁可进入
   * needs_recovery，也不能用旧 backup 覆盖该 fence truth。
   */
  assertDeploymentRestoreFence(gate: DeploymentMaintenanceGate): boolean {
    const maintenanceRow = this.db.query<DeploymentMaintenanceRow, []>(
      "SELECT * FROM self_deploy_maintenance WHERE lock_id = 1",
    ).get();
    const highWater = this.db.query<{ epoch: number }, []>(
      "SELECT epoch FROM self_deploy_host_fence WHERE lock_id = 1",
    ).get()?.epoch ?? 0;
    return !!maintenanceRow
      && sameMaintenanceIdentity(toDeploymentMaintenance(maintenanceRow), gate)
      && highWater === gate.fenceEpoch;
  }

  activateDeploymentMaintenance(
    id: string,
    fence: DeploymentFence,
    input: {
      rollbackAttempt: number;
      baselineRevision: string;
      baselineFingerprint: string;
      baselineManifestHash: string;
      baselineHealthFingerprint: string;
    },
    now: number,
  ): DeploymentMaintenanceGate {
    return this.db.transaction(() => {
      const job = this.db.query<DeploymentJobRow, [string]>("SELECT * FROM self_deploy_jobs WHERE id = ?").get(id);
      if (!job || !(["running", "recovering"] as string[]).includes(job.status)
        || job.lease_token !== fence.leaseToken || job.fence_epoch !== fence.fenceEpoch || job.fence_nonce !== fence.fenceNonce) {
        throw new Error("deployment job fence 已失效");
      }
      if (!/^[a-f0-9]{40,64}$/i.test(input.baselineRevision)) throw new Error("baseline revision 不是完整 commit id");
      if (job.rollback_attempt !== null && job.rollback_attempt !== input.rollbackAttempt) {
        throw new Error("deployment rollback anchor 已冻结，不能被新 attempt 覆盖");
      }
      if (job.rollback_attempt === null && input.rollbackAttempt !== job.attempt) {
        throw new Error("deployment rollback attempt 必须等于首次进入 maintenance 的当前 attempt");
      }
      if (job.rollback_attempt !== null && (
        job.baseline_revision !== input.baselineRevision.toLowerCase()
        || job.baseline_fingerprint !== input.baselineFingerprint
        || job.baseline_manifest_hash !== input.baselineManifestHash
        || job.baseline_health_fingerprint !== input.baselineHealthFingerprint
      )) {
        throw new Error("deployment rollback baseline identity 已冻结，不能被同 attempt 改写");
      }
      for (const [label, hash] of Object.entries({
        baselineFingerprint: input.baselineFingerprint,
        baselineManifestHash: input.baselineManifestHash,
        baselineHealthFingerprint: input.baselineHealthFingerprint,
      })) {
        if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`${label} 无效`);
      }
      const existing = this.db.query<DeploymentMaintenanceRow, []>("SELECT * FROM self_deploy_maintenance WHERE lock_id = 1").get();
      if (existing && (existing.job_id !== job.id || existing.fence_epoch !== fence.fenceEpoch || existing.fence_nonce !== fence.fenceNonce)) {
        throw new Error("Harbor host 已被另一个 target/job maintenance gate 占用");
      }
      const gateChanged = this.db.run(
        `INSERT INTO self_deploy_maintenance
         (lock_id, fence_epoch, fence_nonce, target_id, job_id, source_run_id, generation, revision,
          target_fingerprint, target_manifest_hash, rollback_attempt, baseline_revision, baseline_fingerprint,
          baseline_manifest_hash, baseline_health_fingerprint, expected_revision, expected_fingerprint, phase, created_at, updated_at)
         VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'deploying',?,?)
         ON CONFLICT(lock_id) DO UPDATE SET updated_at = excluded.updated_at`,
        [fence.fenceEpoch, fence.fenceNonce, job.target_id, job.id, job.source_run_id, job.generation, job.revision,
          job.target_fingerprint, job.target_manifest_hash, input.rollbackAttempt, input.baselineRevision.toLowerCase(),
          input.baselineFingerprint, input.baselineManifestHash, input.baselineHealthFingerprint,
          job.revision, job.target_fingerprint, now, now],
      );
      if (gateChanged.changes !== 1) throw new Error("deployment maintenance gate CAS 失败");
      const jobChanged = this.db.run(
        `UPDATE self_deploy_jobs SET rollback_attempt = ?, baseline_revision = ?, baseline_fingerprint = ?,
           baseline_manifest_hash = ?, baseline_health_fingerprint = ?, checkpoint = 'maintenance', updated_at = ?
         WHERE id = ? AND status IN ('running','recovering') AND lease_token = ? AND fence_epoch = ? AND fence_nonce = ?`,
        [input.rollbackAttempt, input.baselineRevision.toLowerCase(), input.baselineFingerprint,
          input.baselineManifestHash, input.baselineHealthFingerprint, now, id,
          fence.leaseToken, fence.fenceEpoch, fence.fenceNonce],
      );
      if (jobChanged.changes !== 1) throw new Error("deployment rollback anchor job CAS 失败");
      return toDeploymentMaintenance(this.db.query<DeploymentMaintenanceRow, []>("SELECT * FROM self_deploy_maintenance WHERE lock_id = 1").get()!);
    })();
  }

  updateDeploymentMaintenance(
    id: string,
    fence: DeploymentFence,
    phase: DeploymentMaintenancePhase,
    expectedRevision: string,
    expectedFingerprint: string,
    now: number,
    metadata: { checkpoint?: string; newServicePids?: Record<string, number>; log?: string } = {},
  ): DeploymentMaintenanceGate {
    return this.db.transaction(() => {
      const job = this.db.query<DeploymentJobRow, [string]>("SELECT * FROM self_deploy_jobs WHERE id = ?").get(id);
      if (!job || !(["running", "recovering"] as string[]).includes(job.status)
        || job.lease_token !== fence.leaseToken || job.fence_epoch !== fence.fenceEpoch || job.fence_nonce !== fence.fenceNonce) {
        throw new Error("deployment job fence 已失效");
      }
      const changed = this.db.run(
        `UPDATE self_deploy_maintenance SET phase = ?, expected_revision = ?, expected_fingerprint = ?, updated_at = ?
         WHERE lock_id = 1 AND job_id = ? AND generation = ? AND revision = ? AND target_fingerprint = ?
           AND fence_epoch = ? AND fence_nonce = ?`,
        [phase, expectedRevision.toLowerCase(), expectedFingerprint, now, job.id, job.generation, job.revision, job.target_fingerprint,
          fence.fenceEpoch, fence.fenceNonce],
      );
      if (changed.changes !== 1) throw new Error("maintenance gate 缺失或与当前 job identity 不一致");
      const jobChanged = this.db.run(
        `UPDATE self_deploy_jobs SET checkpoint = COALESCE(?, checkpoint),
           new_service_pids = CASE WHEN ? = 1 THEN ? ELSE new_service_pids END,
           log = CASE WHEN ? = 1 THEN ? ELSE log END, updated_at = ?
         WHERE id = ? AND status IN ('running','recovering') AND lease_token = ? AND fence_epoch = ? AND fence_nonce = ?`,
        [metadata.checkpoint ?? null, Object.hasOwn(metadata, "newServicePids") ? 1 : 0,
          JSON.stringify(metadata.newServicePids ?? {}), Object.hasOwn(metadata, "log") ? 1 : 0,
          Object.hasOwn(metadata, "log") ? redactStructured(metadata.log ?? "").slice(0, 32_000) : null, now, id,
          fence.leaseToken, fence.fenceEpoch, fence.fenceNonce],
      );
      if (jobChanged.changes !== 1) throw new Error("maintenance checkpoint job CAS 失败");
      return toDeploymentMaintenance(this.db.query<DeploymentMaintenanceRow, [string]>("SELECT * FROM self_deploy_maintenance WHERE job_id = ?").get(id)!);
    })();
  }

  /** SQLite restore 后只允许 host sentinel 的冻结 identity/epoch 重建 DB gate，epoch 永不回退。 */
  restoreDeploymentMaintenance(
    gate: DeploymentMaintenanceGate,
    fence: DeploymentFence,
    phase: DeploymentMaintenancePhase,
    expectedRevision: string,
    expectedFingerprint: string,
    now: number,
  ): DeploymentMaintenanceGate {
    return this.db.transaction(() => {
      if (gate.fenceEpoch !== fence.fenceEpoch || gate.fenceNonce !== fence.fenceNonce) throw new Error("host sentinel/fence identity 不匹配");
      const highWater = this.db.query<{ epoch: number }, []>("SELECT epoch FROM self_deploy_host_fence WHERE lock_id = 1").get()?.epoch ?? 0;
      if (highWater > gate.fenceEpoch) throw new Error("restored DB fence 高于 host sentinel；拒绝回退 epoch");
      this.db.run("UPDATE self_deploy_host_fence SET epoch = ? WHERE lock_id = 1", [gate.fenceEpoch]);
      const row = this.db.query<DeploymentMaintenanceRow, []>("SELECT * FROM self_deploy_maintenance WHERE lock_id = 1").get();
      if (row) {
        const restoredGate = toDeploymentMaintenance(row);
        if (!sameRollbackIdentity(restoredGate, gate) || restoredGate.fenceEpoch > gate.fenceEpoch
          || (restoredGate.fenceEpoch === gate.fenceEpoch && restoredGate.fenceNonce !== gate.fenceNonce)) {
          throw new Error("restored DB maintenance rollback identity/fence 不匹配");
        }
      }
      const job = this.db.query<DeploymentJobRow, [string]>("SELECT * FROM self_deploy_jobs WHERE id = ?").get(gate.jobId);
      if (!job || job.source_run_id !== gate.sourceRunId || job.generation !== gate.generation || job.revision !== gate.revision) {
        throw new Error("restored DB 的 self deployment job identity 不匹配");
      }
      this.db.run(
        `INSERT INTO self_deploy_maintenance
         (lock_id, fence_epoch, fence_nonce, target_id, job_id, source_run_id, generation, revision,
          target_fingerprint, target_manifest_hash, rollback_attempt, baseline_revision, baseline_fingerprint,
          baseline_manifest_hash, baseline_health_fingerprint, expected_revision, expected_fingerprint, phase, created_at, updated_at)
         VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(lock_id) DO UPDATE SET fence_epoch = excluded.fence_epoch, fence_nonce = excluded.fence_nonce,
           target_id = excluded.target_id, job_id = excluded.job_id, source_run_id = excluded.source_run_id,
           generation = excluded.generation, revision = excluded.revision,
           target_fingerprint = excluded.target_fingerprint, target_manifest_hash = excluded.target_manifest_hash,
           rollback_attempt = excluded.rollback_attempt, baseline_revision = excluded.baseline_revision,
           baseline_fingerprint = excluded.baseline_fingerprint, baseline_manifest_hash = excluded.baseline_manifest_hash,
           baseline_health_fingerprint = excluded.baseline_health_fingerprint,
           created_at = excluded.created_at, phase = excluded.phase,
           expected_revision = excluded.expected_revision, expected_fingerprint = excluded.expected_fingerprint,
           updated_at = excluded.updated_at`,
        [gate.fenceEpoch, gate.fenceNonce, gate.targetId, gate.jobId, gate.sourceRunId, gate.generation, gate.revision,
          gate.targetFingerprint, gate.targetManifestHash, gate.rollbackAttempt, gate.baselineRevision,
          gate.baselineFingerprint, gate.baselineManifestHash, gate.baselineHealthFingerprint,
          expectedRevision.toLowerCase(), expectedFingerprint, phase, gate.createdAt, now],
      );
      const jobChanged = this.db.run(
        `UPDATE self_deploy_jobs SET status = 'recovering', lease_token = ?, fence_epoch = ?, fence_nonce = ?,
           rollback_attempt = ?, baseline_revision = ?, baseline_fingerprint = ?, baseline_manifest_hash = ?,
           baseline_health_fingerprint = ?, database_backup_created = 1, checkpoint = 'rolling_back', updated_at = ?
         WHERE id = ? AND generation = ? AND revision = ?`,
        [fence.leaseToken, fence.fenceEpoch, fence.fenceNonce, gate.rollbackAttempt, gate.baselineRevision,
          gate.baselineFingerprint, gate.baselineManifestHash, gate.baselineHealthFingerprint,
          now, gate.jobId, gate.generation, gate.revision],
      );
      if (jobChanged.changes !== 1) throw new Error("restored DB deployment job identity 不匹配");
      return toDeploymentMaintenance(this.db.query<DeploymentMaintenanceRow, []>("SELECT * FROM self_deploy_maintenance WHERE lock_id = 1").get()!);
    })();
  }

  claimDeploymentRecovery(
    id: string,
    targetId: string,
    targetFingerprint: string,
    targetManifestHash: string,
    now: number,
    leaseMs: number,
  ): DeploymentJob {
    return this.db.transaction(() => {
      const row = this.db.query<DeploymentJobRow, [string]>("SELECT * FROM self_deploy_jobs WHERE id = ?").get(id);
      if (!row || row.target_id !== targetId || row.target_fingerprint !== targetFingerprint
        || row.target_manifest_hash !== targetManifestHash) throw new Error("recovery job/target identity 不匹配");
      if (row.rollback_attempt === null || !row.baseline_revision || !row.baseline_fingerprint
        || !row.baseline_manifest_hash || !row.baseline_health_fingerprint) {
        throw new Error("recovery job 缺少原始 rollback anchor，不能自动恢复");
      }
      const reclaimable = row.status === "needs_recovery" || (row.status === "recovering" && row.lease_expires_at !== null && row.lease_expires_at <= now);
      if (!reclaimable) throw new Error(`deployment job 状态 ${row.status} 不能进入管理员 recovery`);
      const gate = this.db.query<DeploymentMaintenanceRow, [string]>("SELECT * FROM self_deploy_maintenance WHERE job_id = ?").get(id);
      if (!gate || gate.target_fingerprint !== targetFingerprint || gate.rollback_attempt !== row.rollback_attempt) throw new Error("recovery maintenance gate/rollback anchor 不匹配");
      const leaseToken = newId("deploymentLease");
      const fenceNonce = newId("deploymentLease");
      this.db.run("UPDATE self_deploy_host_fence SET epoch = epoch + 1 WHERE lock_id = 1");
      const fenceEpoch = this.db.query<{ epoch: number }, []>("SELECT epoch FROM self_deploy_host_fence WHERE lock_id = 1").get()!.epoch;
      this.db.run(
        `UPDATE self_deploy_jobs SET status = 'recovering', attempt = attempt + 1, lease_token = ?, lease_expires_at = ?,
           fence_epoch = ?, fence_nonce = ?, updated_at = ?
         WHERE id = ?`,
        [leaseToken, now + leaseMs, fenceEpoch, fenceNonce, now, id],
      );
      const gateChanged = this.db.run(
        `UPDATE self_deploy_maintenance SET fence_epoch = ?, fence_nonce = ?, phase = 'rolling_back', updated_at = ?
         WHERE lock_id = 1 AND job_id = ? AND target_fingerprint = ? AND target_manifest_hash = ?`,
        [fenceEpoch, fenceNonce, now, id, targetFingerprint, targetManifestHash],
      );
      if (gateChanged.changes !== 1) throw new Error("recovery global maintenance gate/rollback anchor 不匹配");
      return toDeploymentJob(this.db.query<DeploymentJobRow, [string]>("SELECT * FROM self_deploy_jobs WHERE id = ?").get(id)!);
    })();
  }

  completeDeploymentJob(
    id: string,
    fence: DeploymentFence,
    result: { status: "succeeded" | "failed" | "needs_recovery"; log: string; error?: string | null; failureKind?: DeploymentFailureKind | null; rollbackComplete: boolean },
    now: number,
  ): { job: DeploymentJob; applied: boolean; duplicate: boolean } {
    return this.finishDeploymentJob(id, result, now, { fence });
  }

  /** rollback restore 后 lease 可能来自 backup；只允许冻结 maintenance identity 完成，供 host worker/recovery CLI 使用。 */
  completeRecoveredDeploymentJob(
    gate: DeploymentMaintenanceGate,
    fence: DeploymentFence,
    result: { status: "failed" | "needs_recovery"; log: string; error?: string | null; failureKind?: DeploymentFailureKind | null; rollbackComplete: boolean },
    now: number,
  ): { job: DeploymentJob; applied: boolean; duplicate: boolean } {
    return this.finishDeploymentJob(gate.jobId, result, now, { gate, fence });
  }

  private finishDeploymentJob(
    id: string,
    result: { status: "succeeded" | "failed" | "needs_recovery"; log: string; error?: string | null; failureKind?: DeploymentFailureKind | null; rollbackComplete: boolean },
    now: number,
    proof: { fence: DeploymentFence; gate?: DeploymentMaintenanceGate },
  ): { job: DeploymentJob; applied: boolean; duplicate: boolean } {
    return this.db.transaction(() => {
      const row = this.db.query<DeploymentJobRow, [string]>("SELECT * FROM self_deploy_jobs WHERE id = ?").get(id);
      if (!row) throw new Error(`deployment job "${id}" 不存在`);
      if (row.status === "succeeded" || row.status === "failed") {
        return { job: toDeploymentJob(row), applied: false, duplicate: true };
      }
      if (!result.rollbackComplete && result.status !== "needs_recovery") {
        throw new Error("rollbackComplete=false 必须落为 needs_recovery");
      }
      if (result.rollbackComplete && result.status === "needs_recovery") {
        throw new Error("needs_recovery 不能声称 rollbackComplete=true");
      }
      const maintenanceRow = this.db.query<DeploymentMaintenanceRow, [string]>("SELECT * FROM self_deploy_maintenance WHERE job_id = ?").get(id);
      const maintenance = maintenanceRow ? toDeploymentMaintenance(maintenanceRow) : null;
      if (proof.gate) {
        if (!maintenance || !sameMaintenanceState(maintenance, proof.gate)) throw new Error("recovery completion 的 maintenance state/fence 不匹配");
        if (!(["running", "recovering", "needs_recovery"] as string[]).includes(row.status)) throw new Error(`deployment job 状态 ${row.status} 不能 recovery complete`);
      }
      if (row.lease_token !== proof.fence.leaseToken || row.fence_epoch !== proof.fence.fenceEpoch || row.fence_nonce !== proof.fence.fenceNonce) {
        throw new Error("deployment job fence 已失效；旧 worker 结果已拒绝");
      }
      if (result.status === "succeeded") {
        if (!maintenance || maintenance.phase !== "healthy" || maintenance.expectedRevision !== row.revision
          || maintenance.expectedFingerprint !== row.target_fingerprint) {
          throw new Error("deployment success 缺少 exact revision healthy maintenance proof");
        }
      }
      if (result.status === "failed" && result.rollbackComplete && maintenance
        && (maintenance.phase !== "rolling_back" || maintenance.expectedRevision !== maintenance.baselineRevision
          || maintenance.expectedFingerprint !== maintenance.baselineFingerprint)) {
        throw new Error("deployment failure 声称 rollbackComplete 但缺少 exact baseline maintenance proof");
      }
      const safeLog = redactStructured(result.log).slice(0, 32_000);
      const safeError = redactStructured(
        result.error ?? (result.status === "needs_recovery" ? "rollback incomplete; host administrator recovery required" : ""),
      ).slice(0, 4_000) || null;
      const checkpoint = result.status === "succeeded" ? "healthy" : result.status === "needs_recovery" ? "rollback_incomplete" : "failed";
      const failureKind = result.status === "succeeded" ? null
        : result.failureKind ?? (result.status === "needs_recovery" ? "rollback_incomplete" : "deployment_failed");
      this.db.run(
        `UPDATE self_deploy_jobs
         SET status = ?, log = ?, error = ?, failure_kind = ?, rollback_complete = ?, checkpoint = ?,
             lease_token = NULL, lease_expires_at = NULL, finished_at = ?, updated_at = ?
         WHERE id = ?`,
        [result.status, safeLog, safeError, failureKind, result.rollbackComplete ? 1 : 0, checkpoint, now, now, id],
      );
      if (maintenance) {
        const gateChanged = this.db.run(
          "UPDATE self_deploy_maintenance SET phase = ?, updated_at = ? WHERE lock_id = 1 AND job_id = ? AND fence_epoch = ? AND fence_nonce = ?",
          [result.status === "needs_recovery" ? "needs_recovery" : "releasing", now, row.id,
            proof.fence.fenceEpoch, proof.fence.fenceNonce],
        );
        if (gateChanged.changes !== 1) throw new Error("terminal maintenance phase CAS 失败");
      }
      const fresh = this.db.query<DeploymentJobRow, [string]>("SELECT * FROM self_deploy_jobs WHERE id = ?").get(id)!;
      return { job: toDeploymentJob(fresh), applied: true, duplicate: false };
    })();
  }

  /** host sentinel 已清除并确认、daemon 已 bootstrap 后，最后 CAS 删除 DB gate。 */
  releaseDeploymentMaintenance(gate: DeploymentMaintenanceGate, now: number): { job: DeploymentJob; applied: boolean } {
    return this.db.transaction(() => {
      const row = this.db.query<DeploymentMaintenanceRow, []>("SELECT * FROM self_deploy_maintenance WHERE lock_id = 1").get();
      if (!row || !sameMaintenanceState(toDeploymentMaintenance(row), gate) || gate.phase !== "releasing") {
        throw new Error("release maintenance gate/fence identity 不匹配");
      }
      const jobRow = this.db.query<DeploymentJobRow, [string]>("SELECT * FROM self_deploy_jobs WHERE id = ?").get(gate.jobId);
      if (!jobRow || !(jobRow.status === "succeeded" || (jobRow.status === "failed" && jobRow.rollback_complete === 1))) {
        throw new Error("release maintenance 缺少 terminal + rollback proof");
      }
      const deleted = this.db.run(
        "DELETE FROM self_deploy_maintenance WHERE lock_id = 1 AND job_id = ? AND fence_epoch = ? AND fence_nonce = ? AND phase = 'releasing'",
        [gate.jobId, gate.fenceEpoch, gate.fenceNonce],
      );
      if (deleted.changes !== 1) throw new Error("release maintenance CAS 失败");
      return { job: toDeploymentJob(jobRow), applied: true };
    })();
  }

  failDeploymentRelease(gate: DeploymentMaintenanceGate, error: string, now: number): DeploymentJob {
    return this.db.transaction(() => {
      const row = this.db.query<DeploymentMaintenanceRow, []>("SELECT * FROM self_deploy_maintenance WHERE lock_id = 1").get();
      if (!row || !sameMaintenanceState(toDeploymentMaintenance(row), gate) || gate.phase !== "releasing") {
        throw new Error("release failure gate/fence identity 不匹配");
      }
      const safeError = redactStructured(error).slice(0, 4_000);
      this.db.run(
        `UPDATE self_deploy_jobs SET status = 'needs_recovery', failure_kind = 'rollback_incomplete',
           rollback_complete = 0, checkpoint = 'rollback_incomplete', error = ?, updated_at = ? WHERE id = ?`,
        [safeError, now, gate.jobId],
      );
      this.db.run("UPDATE self_deploy_maintenance SET phase = 'needs_recovery', updated_at = ? WHERE lock_id = 1", [now]);
      return toDeploymentJob(this.db.query<DeploymentJobRow, [string]>("SELECT * FROM self_deploy_jobs WHERE id = ?").get(gate.jobId)!);
    })();
  }

  listDeliveriesReadyToFinalize(): Delivery[] {
    return this.db
      .query<DeliveryRow, []>(
        `SELECT d.* FROM deliveries d JOIN conversations c ON c.id = d.conversation_id
         WHERE d.merge_status = 'merged' AND d.review_status = 'approved' AND d.check_status = 'passed'
           AND c.kind = 'issue' AND c.status = 'review'`,
      )
      .all()
      .map(toDelivery);
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
      parentRunId?: string | null;
      rootRunId?: string;
      dispatchDepth?: number;
      dispatchKey?: string | null;
      reviewCheckout?: ReviewCheckout | null;
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
    const parent = r.parentRunId ? this.getRun(r.parentRunId) : null;
    if (r.parentRunId && !parent) throw new Error("parent Run 不存在");
    const rootRunId = r.rootRunId ?? parent?.rootRunId ?? id;
    const dispatchDepth = r.dispatchDepth ?? (parent ? parent.dispatchDepth + 1 : 0);
    if (parent && (parent.workspaceId !== workspaceId || parent.sourceType !== sourceType || parent.sourceId !== sourceId)) {
      throw new Error("派生 Run 必须与 parent Run 保持相同 Workspace 和 source");
    }
    if (parent && rootRunId !== parent.rootRunId) throw new Error("派生 Run rootRunId 与 parent 不一致");
    this.db.run(
      `INSERT INTO runs
       (id, workspace_id, source_type, source_id, conversation_id, agent_id, device_id, repository_id,
        repository_mount_id, execution_root, prompt, purpose, prompt_event, trigger_ref, trigger_context,
        concurrency_key, parent_run_id, root_run_id, dispatch_depth, dispatch_key,
        review_delivery_id, review_revision, review_ref, review_remote_url, status, queued_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?)`,
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
        r.parentRunId ?? null,
        rootRunId,
        dispatchDepth,
        r.dispatchKey ?? null,
        r.reviewCheckout?.deliveryId ?? null,
        r.reviewCheckout?.revision.toLowerCase() ?? null,
        r.reviewCheckout?.ref ?? null,
        r.reviewCheckout?.remoteUrl ?? null,
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

  listRunAttachmentMeta(runId: string): { name: string; mime: string }[] {
    return this.db.query<{ name: string; mime: string }, [string]>(
      "SELECT name, mime FROM run_attachments WHERE run_id = ? ORDER BY position",
    ).all(runId);
  }

  getRunAttachment(runId: string, position: number): RunAttachment | null {
    const row = this.db.query<{ name: string; mime: string; data_base64: string }, [string, number]>(
      "SELECT name, mime, data_base64 FROM run_attachments WHERE run_id = ? AND position = ?",
    ).get(runId, position);
    return row ? { name: row.name, mime: row.mime, dataBase64: row.data_base64 } : null;
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

  getRunByDispatchKey(rootRunId: string, dispatchKey: string): Run | null {
    const row = this.db.query<RunRow, [string, string]>(
      "SELECT * FROM runs WHERE root_run_id = ? AND dispatch_key = ?",
    ).get(rootRunId, dispatchKey);
    return row ? toRun(row) : null;
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
             queued.conversation_id IS NULL OR NOT EXISTS (
               SELECT 1 FROM runs conversation_running
               WHERE conversation_running.conversation_id = queued.conversation_id
                 AND conversation_running.status = 'running'
             )
           )
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

  // ---- durable domain events ----

  private insertDomainEvent(
    event: Omit<DomainEvent, "createdAt">,
    now: number,
  ): DomainEvent | null {
    const result = this.db.run(
      `INSERT OR IGNORE INTO domain_events
       (id, workspace_id, event_type, source_type, source_id, payload, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [
        event.id,
        event.workspaceId,
        event.type,
        event.sourceType,
        event.sourceId,
        JSON.stringify(event.payload),
        now,
      ],
    );
    return result.changes === 1
      ? { ...event, createdAt: now }
      : null;
  }

  /** 以稳定 event ID 写入；首次写入才通知消费者，重放由 listDomainEvents 驱动。 */
  recordDomainEvent(event: Omit<DomainEvent, "createdAt">, now: number): DomainEvent {
    const inserted = this.insertDomainEvent(event, now);
    const durable = inserted ?? this.getDomainEvent(event.id);
    if (!durable) throw new Error(`领域事件 ${event.id} 写入失败`);
    this.notifyDomainEvent(inserted);
    return durable;
  }

  getDomainEvent(id: string): DomainEvent | null {
    const row = this.db.query<DomainEventRow, [string]>(
      "SELECT * FROM domain_events WHERE id = ?",
    ).get(id);
    return row ? toDomainEvent(row) : null;
  }

  listDomainEvents(workspaceId?: string): DomainEvent[] {
    const rows = workspaceId
      ? this.db.query<DomainEventRow, [string]>(
        "SELECT * FROM domain_events WHERE workspace_id = ? ORDER BY created_at, id",
      ).all(workspaceId)
      : this.db.query<DomainEventRow, []>(
        "SELECT * FROM domain_events ORDER BY created_at, id",
      ).all();
    return rows.map(toDomainEvent);
  }

  listUndeliveredDomainEvents(
    triggerId: string,
    workspaceId: string,
    createdAtOrAfter: number,
  ): DomainEvent[] {
    return this.db.query<DomainEventRow, [string, string, number]>(
      `SELECT event.* FROM domain_events event
       LEFT JOIN automation_trigger_deliveries delivery
         ON delivery.trigger_id = ? AND delivery.delivery_id = event.id
       WHERE event.workspace_id = ? AND event.created_at >= ? AND delivery.delivery_id IS NULL
       ORDER BY event.created_at, event.id`,
    ).all(triggerId, workspaceId, createdAtOrAfter).map(toDomainEvent);
  }

  // ---- automations（Mew: one Output + one Schedule/Codebase Trigger） ----

  createAutomation(
    a: {
      workspaceId?: string;
      name: string;
      agentId: string;
      prompt: string;
      output?: AutomationOutput;
      trigger:
        | { type: "schedule"; cron: string; timezone: string }
        | { type: "codebase"; repositoryId: string; codebaseEvent: CodebaseAutomationEvent };
    },
    now: number,
  ): Automation {
    const id = newId("automation");
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO automations
         (id, workspace_id, name, agent_id, prompt, output_mode, enabled, created_at, updated_at)
         VALUES (?,?,?,?,?,?,1,?,?)`,
        [
          id,
          a.workspaceId ?? DEFAULT_WORKSPACE_ID,
          a.name,
          a.agentId,
          a.prompt,
          a.output ?? "run",
          now,
          now,
        ],
      );
      this.insertAutomationTrigger(id, a.trigger, now);
    })();
    return this.getAutomation(id)!;
  }

  getAutomation(id: string): Automation | null {
    const r = this.db.query<AutomationRow, [string]>("SELECT * FROM automations WHERE id = ?").get(id);
    if (!r) return null;
    const trigger = this.getAutomationTriggerForAutomation(id);
    if (!trigger) throw new Error(`automation "${id}" 缺少唯一 Trigger`);
    return toAutomation(r, trigger);
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
    if (!rows[0]) return null;
    const trigger = this.getAutomationTriggerForAutomation(rows[0].id);
    if (!trigger) throw new Error(`automation "${rows[0].id}" 缺少唯一 Trigger`);
    return toAutomation(rows[0], trigger);
  }

  listAutomations(workspaceId?: string): Automation[] {
    const rows = !workspaceId
      ? this.db.query<AutomationRow, []>("SELECT * FROM automations ORDER BY name").all()
      : this.db
      .query<AutomationRow, [string]>("SELECT * FROM automations WHERE workspace_id = ? ORDER BY name")
      .all(workspaceId);
    return rows.map((row) => {
      const trigger = this.getAutomationTriggerForAutomation(row.id);
      if (!trigger) throw new Error(`automation "${row.id}" 缺少唯一 Trigger`);
      return toAutomation(row, trigger);
    });
  }

  setAutomationEnabled(id: string, enabled: boolean): void {
    this.db.run("UPDATE automations SET enabled = ?, updated_at = ? WHERE id = ?", [enabled ? 1 : 0, Date.now(), id]);
  }

  updateAutomation(
    id: string,
    patch: {
      name?: string;
      agentId?: string;
      prompt?: string;
      output?: AutomationOutput;
      enabled?: boolean;
    },
    now: number,
  ): Automation {
    const fields: string[] = [];
    const values: (string | number | null)[] = [];
    const add = (field: string, value: string | number | null) => {
      fields.push(`${field} = ?`);
      values.push(value);
    };
    if (patch.name !== undefined) add("name", patch.name);
    if (patch.agentId !== undefined) add("agent_id", patch.agentId);
    if (patch.prompt !== undefined) add("prompt", patch.prompt);
    if (patch.output !== undefined) add("output_mode", patch.output);
    if (patch.enabled !== undefined) add("enabled", patch.enabled ? 1 : 0);
    if (fields.length > 0) {
      add("updated_at", now);
      values.push(id);
      this.db.run(`UPDATE automations SET ${fields.join(", ")} WHERE id = ?`, values);
    }
    const automation = this.getAutomation(id);
    if (!automation) throw new Error(`automation "${id}" 不存在`);
    return automation;
  }

  updateAutomationDefinition(
    id: string,
    patch: {
      name?: string;
      agentId?: string;
      prompt?: string;
      output?: AutomationOutput;
      enabled?: boolean;
    },
    trigger:
      | { type: "schedule"; cron: string; timezone: string }
      | { type: "codebase"; repositoryId: string; codebaseEvent: CodebaseAutomationEvent },
    now: number,
  ): Automation {
    this.db.transaction(() => {
      this.updateAutomation(id, patch, now);
      const current = this.getAutomationTriggerForAutomation(id);
      if (!current) throw new Error(`automation "${id}" 缺少唯一 Trigger`);
      this.updateAutomationTrigger(current.id, trigger, now);
    })();
    return this.getAutomation(id)!;
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

  private insertAutomationTrigger(
    automationId: string,
    input:
      | { type: "schedule"; cron: string; timezone: string }
      | { type: "codebase"; repositoryId: string; codebaseEvent: CodebaseAutomationEvent },
    now: number,
  ): string {
    const id = newId("automationTrigger");
    this.db.run(
      `INSERT INTO automation_triggers
       (id, automation_id, type, cron, timezone, repository_id, codebase_event,
        last_fired_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,NULL,?,?)`,
      [
        id,
        automationId,
        input.type,
        input.type === "schedule" ? input.cron : null,
        input.type === "schedule" ? input.timezone : null,
        input.type === "codebase" ? input.repositoryId : null,
        input.type === "codebase" ? input.codebaseEvent : null,
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

  getAutomationTriggerForAutomation(automationId: string): AutomationTrigger | null {
    const row = this.db
      .query<AutomationTriggerRow, [string]>(
        "SELECT * FROM automation_triggers WHERE automation_id = ?",
      )
      .get(automationId);
    return row ? toAutomationTrigger(row) : null;
  }

  updateAutomationTrigger(
    id: string,
    input:
      | { type: "schedule"; cron: string; timezone: string }
      | { type: "codebase"; repositoryId: string; codebaseEvent: CodebaseAutomationEvent },
    now: number,
  ): AutomationTrigger {
    const trigger = this.getAutomationTrigger(id);
    if (!trigger) throw new Error(`automation trigger "${id}" 不存在`);
    this.db.run(
      `UPDATE automation_triggers
       SET type = ?, cron = ?, timezone = ?, repository_id = ?, codebase_event = ?, updated_at = ?
       WHERE id = ?`,
      [
        input.type,
        input.type === "schedule" ? input.cron : null,
        input.type === "schedule" ? input.timezone : null,
        input.type === "codebase" ? input.repositoryId : null,
        input.type === "codebase" ? input.codebaseEvent : null,
        now,
        id,
      ],
    );
    return this.getAutomationTrigger(id)!;
  }

  markAutomationTriggerFired(id: string, now: number): void {
    this.db.run("UPDATE automation_triggers SET last_fired_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
  }

  /** eventId 在同一 Codebase Trigger 下只接收一次；true 表示本次首次登记。 */
  recordAutomationTriggerDelivery(triggerId: string, deliveryId: string, now: number): boolean {
    const result = this.db.run(
      `INSERT OR IGNORE INTO automation_trigger_deliveries (trigger_id, delivery_id, received_at)
       VALUES (?,?,?)`,
      [triggerId, deliveryId, now],
    );
    return result.changes === 1;
  }

  hasAutomationTriggerDelivery(triggerId: string, deliveryId: string): boolean {
    return Boolean(this.db.query<{ ok: number }, [string, string]>(
      "SELECT 1 AS ok FROM automation_trigger_deliveries WHERE trigger_id = ? AND delivery_id = ?",
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

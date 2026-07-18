/**
 * Harbor 协议 —— server / daemon / CLI 三端共享的领域类型 + WS 消息类型。
 * 单一真相源：领域定义对齐 progress/harbor.md §2（glossary），改这里必须三端同步审视。
 *
 * 命名注意：Harbor 的 Agent 与 Claude Code 的 subagent、@sm/agent 包名语义不同，
 * 统一用 HarborAgent 规避碰撞；claude_session_id 全称，不简写 session。
 * id 一律 string（19 位整数 JSON 精度坑，见 harbor.md §8）。
 */

import type { AgentEvent, Cost, PermissionPolicy } from "@sm/agent";

// ── 领域类型 ────────────────────────────────────────────

export type BackendKind = "claude" | "codex";
export type IsolationKind = "none" | "worktree";
/** issue_draft 是 AI 提单的隐藏草稿；Agent 分诊完成、人工确认后才发布为 issue。 */
export type ConversationKind = "chat" | "issue" | "issue_draft";
/** chat 恒为 open；Issue 阶段与 Run 状态分离，doing/review 主要由系统推进。 */
export type ConversationStatus = "open" | "backlog" | "todo" | "doing" | "review" | "done" | "canceled";
export const ISSUE_STATUSES: ConversationStatus[] = ["backlog", "todo", "doing", "review", "done", "canceled"];
export type IssuePriority = "none" | "low" | "medium" | "high" | "urgent";
export const ISSUE_PRIORITIES: IssuePriority[] = ["none", "low", "medium", "high", "urgent"];
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";
/** implementation 推进 Issue；triage 只读分诊草稿；review/verification 不覆盖 Assignee。 */
export type RunPurpose = "implementation" | "triage" | "review" | "verification";
export const RUN_PURPOSES: RunPurpose[] = ["implementation", "triage", "review", "verification"];
export type Origin = "cli" | "feishu" | "web" | "automation" | "codebase" | "agent";
export type PromptSource = "issue" | "chat" | "automation";
export type PromptBlockPhase = "context" | "event";
export type PromptContextBlockKey = "session.issue.context" | "session.chat.context";
export type PromptEventBlockKey =
  | "event.issue.assigned"
  | "event.issue.mentioned"
  | "event.issue.message_created"
  | "event.chat.message_created"
  | "event.automation.schedule"
  | "event.automation.manual"
  | "event.automation.webhook";
export type PromptBlockKey = PromptContextBlockKey | PromptEventBlockKey;

/** daemon 从本机 Runtime 配置目录发现、可同步进 Workspace 的 Skill。 */
export interface InstalledSkillCapability {
  name: string;
  description: string;
  /** SKILL.md 所在目录的真实路径。 */
  path: string;
  runtimes: BackendKind[];
  /** 仅 daemon → server hello 携带；GET /api/devices 会移除正文，避免列表接口膨胀。 */
  instruction?: string;
  /** SKILL.md 及其同目录文本资源；仅 daemon → server hello 携带。 */
  files?: { path: string; content: string }[];
  dependencies?: SkillDependency[];
}

/** 某个 coding runtime 真正可执行的模型路由（claude 来自 endpoints.yaml，codex 来自本机 models cache）。 */
export interface ModelRouteCapability {
  /** 始终使用 provider-qualified id，避免同名模型跨 provider 歧义。 */
  id: string;
  provider: string;
  model: string;
  /** UI 展示名（如 codex display_name）；传给 CLI 的始终是 model。 */
  label?: string;
  runtime: BackendKind;
  kind: "native" | "anthropic";
  /** native 依赖 CLI 登录态；代理 route 依赖 endpoints.yaml 的 key env。 */
  ready: boolean;
}

export interface DeviceCapabilities {
  /** 已装 CLI 及版本，如 {claude: "2.1.207"} */
  clis: Record<string, string>;
  /** 旧兼容清单；新 UI / 校验优先使用 modelRoutes。 */
  endpoints: string[];
  /** 本机 sm-toolkit 配置解析出的结构化、runtime-compatible 路由。 */
  modelRoutes?: ModelRouteCapability[];
  /** 本机 Claude Code / Codex / shared skills 目录发现的可导入 Skill。 */
  installedSkills?: InstalledSkillCapability[];
}

export interface Device {
  id: string;
  name: string;
  capabilities: DeviceCapabilities;
  online: boolean;
  lastSeenAt: number | null;
  createdAt: number;
}

/** Harbor 的一级逻辑作用域；不是租户，也不是代码目录。 */
export interface HarborWorkspace {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  createdAt: number;
  archivedAt: number | null;
}

/** 可复用的逻辑代码仓库；workspaceId 只做可见性作用域，不代表 Workspace 默认仓库。 */
export interface HarborRepository {
  id: string;
  workspaceId: string;
  name: string;
  remoteUrl: string | null;
  defaultBranch: string;
  /** local 只有 checkout；codebase 同时接收 Issue/MR/CI 事件并可执行交付动作。 */
  scmProvider: "local" | "codebase";
  /** Codebase 项目标识（项目名、路径或服务端可解析的 repository id）。 */
  scmRepository: string | null;
  /** 外部 Issue/评论进入时使用的默认 Agent；null = 只同步不派活。 */
  scmAgentId: string | null;
  scmAutoDispatch: boolean;
  createdAt: number;
  archivedAt: number | null;
}

/** 一个 Repository 在某台 Device 上的 checkout。每台设备至多一个主 mount。 */
export interface RepositoryMount {
  id: string;
  repositoryId: string;
  deviceId: string;
  path: string;
  createdAt: number;
}

export interface HarborAgent {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  deviceId: string;
  backend: BackendKind;
  /** endpoints.yaml 名 / 裸 tier / 透传；null = 该 CLI 自己的默认模型 */
  model: string | null;
  permission: PermissionPolicy;
  /** 必选主 Repository；Issue / Chat 指派给 Agent 后继承它，不单独选择。 */
  repositoryId: string;
  /** Agent 可见的仓库集合；repositoryId 始终是本次默认执行仓库。 */
  repositoryIds: string[];
  isolation: IsolationKind;
  /** Agent 自身并发闸；Device 仍有独立的总并发上限。 */
  concurrency: number;
  visibility: "workspace" | "private";
  /** 仅在 daemon 下发时作为进程 env，绝不进入 prompt/run event。 */
  environment: Record<string, string>;
  /** checkout/worktree 第一次使用该版本配置前执行；成功后由 daemon 按 hash 缓存。 */
  setupScript: string | null;
  reuseDeviceCli: boolean;
  createdByMemberId: string | null;
  /** systemPrompt 注入 */
  instruction: string | null;
  /** 当前绑定的 Workspace Skill，顺序即 system prompt 注入顺序。 */
  skillIds: string[];
  createdAt: number;
  archivedAt: number | null;
}

export type SkillSource = "manual" | "runtime" | "codebase" | "github" | "upload";

export interface SkillFile {
  path: string;
  content: string;
  sha256: string;
}

export interface SkillDependency {
  name: string;
  spec: string | null;
  required: boolean;
}

export interface SkillGroup {
  id: string;
  workspaceId: string;
  name: string;
  position: number;
  createdAt: number;
}

/** Workspace 级 Skill 配置；manual 可跨设备，runtime 绑定其来源 Device。 */
export interface HarborSkill {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  source: SkillSource;
  /** 导入/编辑时保存的 SKILL.md 正文快照；Run 只消费这份显式配置。 */
  instruction: string;
  deviceId: string | null;
  sourcePath: string | null;
  /** runtime 来源可执行的 Runtime；manual 默认 claude + codex。 */
  runtimes: BackendKind[];
  groupId: string | null;
  originUrl: string | null;
  sourceRef: string | null;
  entryHash: string;
  bundleHash: string;
  autoSync: boolean;
  files: SkillFile[];
  dependencies: SkillDependency[];
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface Conversation {
  id: string;
  workspaceId: string;
  kind: ConversationKind;
  title: string | null;
  /** Issue 的当前实现 Assignee；Issue 可为空，Chat 始终有值。 */
  agentId: string | null;
  description: string | null;
  priority: IssuePriority;
  status: ConversationStatus;
  /** 当前执行仓库快照；未指派的 Inbox Issue 可为空，指派后由 Agent 派生。 */
  repositoryId: string | null;
  worktreePath: string | null;
  /** worktree 属于哪个物理 mount，防止跨设备/仓库误复用。 */
  worktreeMountId: string | null;
  /** 最新一轮的 claude session id，resume 用 */
  claudeSessionId: string | null;
  origin: Origin;
  originRef: string | null;
  creatorMemberId: string | null;
  ownerMemberId: string | null;
  labelIds: string[];
  createdAt: number;
  updatedAt: number;
}

/** Delivery Provider 共享同一 review/check/merge policy；manual 与 Codebase 只负责外部事实和动作适配。 */
export type DeliveryProviderKind = "manual" | "codebase";
export type DeliveryReviewStatus = "pending" | "approved";
export type DeliveryCheckStatus = "unknown" | "pending" | "passed" | "failed";
export const DELIVERY_CHECK_STATUSES: DeliveryCheckStatus[] = ["unknown", "pending", "passed", "failed"];
export type DeliveryMergeStatus = "open" | "merged";
export type DeliveryDeploymentStatus = "not_required" | "pending" | "running" | "succeeded" | "failed";
/** 只读派生状态；调用方更新正交事实，不能直接写这个字段。 */
export type DeliveryStatus =
  | "awaiting_change"
  | "review_pending"
  | "checks_pending"
  | "blocked"
  | "merge_ready"
  | "merged"
  | "deploying"
  | "succeeded"
  | "failed";

/** Issue 的主代码交付记录。当前与 Issue 是 0..1，非代码 Issue 可以没有。 */
export interface Delivery {
  id: string;
  conversationId: string;
  provider: DeliveryProviderKind;
  changeUrl: string | null;
  externalId: string | null;
  headBranch: string | null;
  baseBranch: string | null;
  reviewStatus: DeliveryReviewStatus;
  checkStatus: DeliveryCheckStatus;
  mergeStatus: DeliveryMergeStatus;
  deploymentStatus: DeliveryDeploymentStatus;
  /** 根据四组事实派生，不在 DB 单独存储。 */
  status: DeliveryStatus;
  reviewApprovedAt: number | null;
  mergedAt: number | null;
  deployedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface DeliveryEvent {
  deliveryId: string;
  kind: string;
  data: unknown;
  actor: "human" | "system" | "provider";
  ts: number;
}

export type WorkspaceRole = "owner" | "admin" | "member";

export interface WorkspaceMember {
  id: string;
  workspaceId: string;
  name: string;
  email: string | null;
  externalProvider: "local" | "feishu" | "codebase";
  externalId: string | null;
  role: WorkspaceRole;
  status: "active" | "invited" | "disabled";
  createdAt: number;
}

export interface IssueLabel {
  id: string;
  workspaceId: string;
  name: string;
  color: string;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  authorType: "member" | "agent" | "external" | "system";
  authorId: string | null;
  authorName: string | null;
  body: string;
  externalId: string | null;
  createdAt: number;
}

export type ScmObjectKind = "issue" | "change";

export interface ScmExternalObject {
  id: string;
  workspaceId: string;
  repositoryId: string;
  provider: "codebase";
  kind: ScmObjectKind;
  externalId: string;
  url: string | null;
  title: string;
  description: string | null;
  authorId: string | null;
  authorName: string | null;
  state: string;
  conversationId: string | null;
  deliveryId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ScmEvent {
  id: string;
  provider: "codebase";
  workspaceId: string;
  repositoryId: string | null;
  eventType: string;
  action: string | null;
  objectKind: ScmObjectKind | null;
  externalId: string | null;
  outcome: "received" | "applied" | "ignored" | "failed";
  error: string | null;
  receivedAt: number;
  processedAt: number | null;
}

export interface LarkWorkspaceBinding {
  id: string;
  workspaceId: string;
  chatId: string;
  defaultAgentId: string;
  responseMode: "thread" | "message";
  listenMode: "mention" | "all";
  botMode: "global" | "custom";
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface RunCost {
  usd: number | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export interface Run {
  id: string;
  workspaceId: string;
  /** Run 的一等来源。Issue/Chat 指向 Conversation；Automation 直跑不伪造 Conversation。 */
  sourceType: RunSourceType;
  sourceId: string;
  /** 仅 sourceType=issue/chat 时有值；保留独立字段方便既有 Conversation 查询。 */
  conversationId: string | null;
  /** 快照，不 FK 约束（agent 可归档） */
  agentId: string;
  deviceId: string;
  repositoryId: string | null;
  repositoryMountId: string | null;
  /** 下发时快照；worktree ready 后更新为实际 worktree 路径。 */
  executionRoot: string | null;
  prompt: string;
  purpose: RunPurpose;
  /** 本次 Run 的触发原因；与 purpose（执行意图）正交，用于选择 event Prompt block。 */
  promptEvent: PromptEventBlockKey;
  /** 触发对象引用（如 Automation ID）；append 到既有会话时不能从 Conversation 反推。 */
  triggerRef: string | null;
  /** webhook/schedule/manual 的规范化触发上下文；执行时快照，不从外部事件事后重建。 */
  triggerContext: Record<string, unknown>;
  /** 非空时同 key 的 Run 串行；Automation overlap=queue 用它防并发启动。 */
  concurrencyKey: string | null;
  status: RunStatus;
  claudeSessionId: string | null;
  error: string | null;
  cost: RunCost | null;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface RunEventRow {
  runId: string;
  seq: number;
  type: string;
  event: AgentEvent;
  ts: number;
}

export interface StatusLogRow {
  conversationId: string;
  fromStatus: ConversationStatus | null;
  toStatus: ConversationStatus;
  actor: "human" | "system" | "agent";
  ts: number;
}

export type ApprovalStatus = "pending" | "allowed" | "denied" | "expired";

/** permission=default 的 agent 执行中上抛的工具授权请求（P2） */
export interface Approval {
  id: string;
  runId: string;
  /** claude control protocol 的 request_id（daemon resolve 用，run 内唯一） */
  requestId: string;
  toolName: string;
  input: unknown;
  status: ApprovalStatus;
  /** 决策者标注：cli|feishu|sweep(过期)|system */
  decidedBy: string | null;
  decidedAt: number | null;
  createdAt: number;
}

export type RunSourceType = "issue" | "chat" | "automation";
export type AutomationOutputMode = "run" | "chat" | "issue" | "append";
export type AutomationOverlapMode = "skip" | "queue";
export type AutomationTriggerType = "schedule" | "webhook";
export type AutomationWebhookScalar = string | number | boolean | null;

/** webhook filter 同一 Trigger 内按 OR 语义匹配；path 使用点号读取 JSON 字段。 */
export interface AutomationWebhookFilter {
  path: string;
  equals: AutomationWebhookScalar;
}

export interface AutomationTrigger {
  id: string;
  automationId: string;
  type: AutomationTriggerType;
  enabled: boolean;
  /** type=schedule 时必填。 */
  cron: string | null;
  /** type=webhook 时标记来源适配器；首期 generic/codebase 共用规范化入口。 */
  provider: string | null;
  /** 空数组接受任意事件；非空时匹配规范化 eventType。 */
  events: string[];
  filters: AutomationWebhookFilter[];
  /** 仅创建/轮换时返回明文；持久化对象永不包含 secret。 */
  webhookPath: string | null;
  lastFiredAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** 旧 CLI/API create body 的兼容输入；领域对象使用 AutomationOutputMode。 */
export type AutomationMode = "new_issue" | "append";

export interface Automation {
  id: string;
  workspaceId: string;
  name: string;
  agentId: string;
  /** 兼容/审计快照；不是配置项，触发时以 Agent 当前 Repository 为准。 */
  repositoryId: string | null;
  prompt: string;
  outputMode: AutomationOutputMode;
  overlapMode: AutomationOverlapMode;
  /** outputMode=append 时必填：追加到的固定 conversation */
  targetConversationId: string | null;
  /** 完成播报的飞书群（须在 server 白名单内才真正发送） */
  notifyChatId: string | null;
  enabled: boolean;
  lastFiredAt: number | null;
  createdAt: number;
  updatedAt: number;
  triggers: AutomationTrigger[];
  /** 旧客户端展示兼容；等于首个 schedule Trigger 的 cron。 */
  cron: string | null;
  /** 旧客户端展示兼容；issue 映射为 new_issue。 */
  mode: AutomationMode;
}

export interface AutomationLogRow {
  automationId: string;
  kind: "fired" | "missed" | "skipped" | "rejected";
  ts: number;
  runId: string | null;
  triggerId: string | null;
  eventId: string | null;
  note: string | null;
}

/** usage 聚合行：agent × model × 日 */
export interface UsageRow {
  day: string; // YYYY-MM-DD（server 本地时区）
  agentName: string;
  model: string;
  runs: number;
  usd: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export interface PromptVariableDefinition {
  name: string;
  description: string;
}

/** server 级 Prompt block 配置；context 与 event 在 dispatch 时按 Run 组合。 */
export interface PromptBlockConfig {
  key: PromptBlockKey;
  source: PromptSource;
  phase: PromptBlockPhase;
  label: string;
  description: string;
  enabled: boolean;
  template: string;
  isDefault: boolean;
  updatedAt: number | null;
  variables: PromptVariableDefinition[];
}

// ── Run 下发规格（server → daemon） ─────────────────────

export interface RunSpec {
  backend: BackendKind;
  model: string | null;
  prompt: string;
  /** Repository 在目标 Device 上的 checkout；非代码 Run 可为空。 */
  repositoryRoot: string | null;
  additionalRepositoryRoots?: string[];
  permission: PermissionPolicy;
  systemPrompt: string | null;
  /** 上一轮 claude_session_id，多轮续接 */
  resume: string | null;
  /** 所属 conversation；Automation 直跑为 null，且当前只允许 isolation=none。 */
  conversationId: string | null;
  isolation: IsolationKind;
  /** issue 已有 worktree 则复用（conversations.worktree_path 回填值）；null = daemon 首跑时创建 */
  worktreePath: string | null;
  envOverrides?: Record<string, string>;
  setupScript?: string | null;
  setupKey?: string | null;
  /** 飞书等入口随本次 Run 下发的附件；server 只保存受限快照，daemon 落临时文件。 */
  attachments?: RunAttachment[];
  /** 仅允许当前 Run 创建 follow-up Issue 的短期凭证，不进入 Agent 配置或 prompt。 */
  agentActionToken?: string;
}

export interface RunAttachment {
  name: string;
  mime: string;
  dataBase64: string;
}

// ── WS 协议（JSON 行；daemon 主动外连 server） ──────────

export type DaemonMsg =
  | {
      type: "hello";
      deviceName: string;
      token: string;
      capabilities: DeviceCapabilities;
      /** 重连对账：daemon 侧仍在跑的 run。server 侧 running 但不在此列 → 判 failed */
      runningRunIds: string[];
    }
  | { type: "heartbeat"; ts: number }
  | { type: "run_event"; events: { runId: string; seq: number; event: AgentEvent }[] }
  | {
      type: "run_done";
      runId: string;
      status: "succeeded" | "failed" | "canceled";
      claudeSessionId: string | null;
      cost: Cost | null;
      error?: string;
    }
  // 审批链路（P2）
  | { type: "approval_req"; runId: string; requestId: string; toolName: string; input: unknown }
  // worktree 生命周期（P2）：daemon 创建成功后回报路径（server 回填 conversations.worktree_path）
  | { type: "worktree_ready"; runId: string; conversationId: string; path: string }
  | { type: "worktree_cleanup_result"; conversationId: string; ok: boolean; message: string };

export type ServerMsg =
  | { type: "hello_ok"; deviceId: string }
  | { type: "hello_err"; message: string }
  | { type: "run_start"; runId: string; spec: RunSpec }
  | { type: "run_cancel"; runId: string }
  // 审批链路（P2）。runId 一起带上——同设备并发 run 的 request_id 可能撞号，联合键才唯一
  | {
      type: "approval_res";
      runId: string;
      requestId: string;
      behavior: "allow" | "deny";
      updatedInput?: unknown;
      message?: string;
    }
  // issue → done/canceled 后触发（默认保留分支删目录）；repositoryRoot 是 git 上下文
  | { type: "worktree_cleanup"; conversationId: string; repositoryRoot: string; worktreePath: string };

// ── SSE 帧（GET /api/runs/:id/events） ──────────────────

export type RunStreamFrame =
  | { kind: "event"; seq: number; event: AgentEvent }
  // 审批请求/决议实时插播（watch 端提示「等审批」并给出 approve 命令）
  | { kind: "approval"; approval: Approval }
  | { kind: "approval_decided"; approvalId: string; status: ApprovalStatus; decidedBy: string | null }
  | { kind: "done"; run: Run };

// ── 常量 ────────────────────────────────────────────────

export const HEARTBEAT_INTERVAL_MS = 30_000;
export const OFFLINE_AFTER_MS = 90_000;
export const DEFAULT_PORT = 7777;
export const DEFAULT_DEVICE_CONCURRENCY = 2;
/** 旧库与未显式选择 Workspace 的 CLI/API 都落到这里。 */
export const DEFAULT_WORKSPACE_ID = "ws_personal";
/** claude CLI 原生 tier 别名——不在 endpoints.yaml 也放行（agent create model 校验） */
export const NATIVE_TIER_ALIASES = ["opus", "sonnet", "haiku"];
/** 审批悬空上限：pending 超时标 expired 并回 deny（防 claude 进程无限挂） */
export const APPROVAL_TTL_MS = 30 * 60 * 1000;
/** run_events 流水保留期（result/cost 永久留 runs 表） */
export const RUN_EVENTS_RETENTION_MS = 7 * 24 * 3600 * 1000;

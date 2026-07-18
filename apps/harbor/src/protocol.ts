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
export type Origin = "cli" | "feishu" | "web" | "automation";
export type PromptSource = "issue" | "chat" | "automation";
export type PromptBlockPhase = "context" | "event";
export type PromptContextBlockKey = "session.issue.context" | "session.chat.context";
export type PromptEventBlockKey =
  | "event.issue.assigned"
  | "event.issue.mentioned"
  | "event.issue.message_created"
  | "event.chat.message_created"
  | "event.automation.schedule"
  | "event.automation.manual";
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
  isolation: IsolationKind;
  /** systemPrompt 注入 */
  instruction: string | null;
  /** 当前绑定的 Workspace Skill，顺序即 system prompt 注入顺序。 */
  skillIds: string[];
  createdAt: number;
  archivedAt: number | null;
}

export type SkillSource = "manual" | "runtime";

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
  createdAt: number;
  updatedAt: number;
}

/** Delivery policy 与外部 SCM 适配分离；manual 始终作为无 API 系统的诚实 fallback。 */
export type DeliveryProviderKind = "manual" | "github";
export type DeliveryReviewStatus = "pending" | "approved";
export type DeliveryCheckStatus = "unknown" | "pending" | "passed" | "failed";
export const DELIVERY_CHECK_STATUSES: DeliveryCheckStatus[] = ["unknown", "pending", "passed", "failed"];
export type DeliveryMergeStatus = "open" | "closed" | "merged";
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
  /** 最近一次成功 Provider sync 观察到的 GitHub PR head SHA。 */
  latestHeadSha: string | null;
  /** 人工验收实际审查的 head SHA；manual provider 不使用。 */
  approvedHeadSha: string | null;
  reviewStatus: DeliveryReviewStatus;
  checkStatus: DeliveryCheckStatus;
  mergeStatus: DeliveryMergeStatus;
  deploymentStatus: DeliveryDeploymentStatus;
  /** 根据四组事实派生，不在 DB 单独存储。 */
  status: DeliveryStatus;
  reviewApprovedAt: number | null;
  mergedAt: number | null;
  deployedAt: number | null;
  /** 异步 Provider 动作完成时的 compare-and-set 版本。 */
  revision: number;
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

export interface RunCost {
  usd: number | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export interface Run {
  id: string;
  workspaceId: string;
  conversationId: string;
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

export type AutomationMode = "new_issue" | "append";

export interface Automation {
  id: string;
  workspaceId: string;
  name: string;
  agentId: string;
  /** 兼容/审计快照；不是配置项，触发时以 Agent 当前 Repository 为准。 */
  repositoryId: string | null;
  cron: string;
  prompt: string;
  mode: AutomationMode;
  /** mode=append 时必填：追加到的固定 conversation */
  targetConversationId: string | null;
  /** 完成播报的飞书群（须在 server 白名单内才真正发送） */
  notifyChatId: string | null;
  enabled: boolean;
  lastFiredAt: number | null;
}

export interface AutomationLogRow {
  automationId: string;
  kind: "fired" | "missed";
  ts: number;
  runId: string | null;
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
  /** 权限派生必须使用的执行意图快照；daemon 不从 prompt/permission 反推。 */
  purpose: RunPurpose;
  /** Run 绑定的 Repository mount 根目录；worktree 多轮续跑时也不得替换为 worktreePath。 */
  repositoryRoot: string | null;
  /** 本轮实际执行目录快照；worktree ready 后指向 linked worktree，与 Repository mount 独立。 */
  executionRoot: string | null;
  permission: PermissionPolicy;
  systemPrompt: string | null;
  /** 上一轮 claude_session_id，多轮续接 */
  resume: string | null;
  /** 所属 conversation（worktree 按 issue 粒度建，daemon 需要 id 派生路径/分支名） */
  conversationId: string;
  isolation: IsolationKind;
  /** issue 已有 worktree 则复用（conversations.worktree_path 回填值）；null = daemon 首跑时创建 */
  worktreePath: string | null;
  envOverrides?: Record<string, string>;
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

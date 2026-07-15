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
export type ConversationKind = "chat" | "issue";
/** chat 恒为 open；issue 走 backlog→doing→review→done/canceled（允许任意回退） */
export type ConversationStatus = "open" | "backlog" | "doing" | "review" | "done" | "canceled";
export const ISSUE_STATUSES: ConversationStatus[] = ["backlog", "doing", "review", "done", "canceled"];
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";
export type Origin = "cli" | "feishu" | "web" | "automation";

export interface DeviceCapabilities {
  /** 已装 CLI 及版本，如 {claude: "2.1.207"} */
  clis: Record<string, string>;
  /** 本机 endpoints.yaml 可用模型清单（含 "provider:model" 限定 id 两种形式） */
  endpoints: string[];
}

export interface Device {
  id: string;
  name: string;
  capabilities: DeviceCapabilities;
  online: boolean;
  lastSeenAt: number | null;
  createdAt: number;
}

export interface HarborAgent {
  id: string;
  name: string;
  description: string | null;
  deviceId: string;
  backend: BackendKind;
  /** endpoints.yaml 名 / 裸 tier / 透传；null = 该 CLI 自己的默认模型 */
  model: string | null;
  permission: PermissionPolicy;
  /** device 上的绝对路径 */
  workdir: string;
  isolation: IsolationKind;
  /** systemPrompt 注入 */
  instruction: string | null;
  createdAt: number;
  archivedAt: number | null;
}

export interface Conversation {
  id: string;
  kind: ConversationKind;
  title: string | null;
  agentId: string;
  status: ConversationStatus;
  worktreePath: string | null;
  /** 最新一轮的 claude session id，resume 用 */
  claudeSessionId: string | null;
  origin: Origin;
  originRef: string | null;
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
  conversationId: string;
  /** 快照，不 FK 约束（agent 可归档） */
  agentId: string;
  deviceId: string;
  prompt: string;
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

// ── Run 下发规格（server → daemon） ─────────────────────

export interface RunSpec {
  backend: BackendKind;
  model: string | null;
  prompt: string;
  workdir: string;
  permission: PermissionPolicy;
  systemPrompt: string | null;
  /** 上一轮 claude_session_id，多轮续接 */
  resume: string | null;
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
  // P2 审批链路（协议先行，P1 不实现流转）
  | { type: "approval_req"; runId: string; requestId: string; toolName: string; input: unknown };

export type ServerMsg =
  | { type: "hello_ok"; deviceId: string }
  | { type: "hello_err"; message: string }
  | { type: "run_start"; runId: string; spec: RunSpec }
  | { type: "run_cancel"; runId: string }
  // P2 审批链路（协议先行）
  | {
      type: "approval_res";
      requestId: string;
      behavior: "allow" | "deny";
      updatedInput?: unknown;
      message?: string;
    };

// ── SSE 帧（GET /api/runs/:id/events） ──────────────────

export type RunStreamFrame =
  | { kind: "event"; seq: number; event: AgentEvent }
  | { kind: "done"; run: Run };

// ── 常量 ────────────────────────────────────────────────

export const HEARTBEAT_INTERVAL_MS = 30_000;
export const OFFLINE_AFTER_MS = 90_000;
export const DEFAULT_PORT = 7777;
export const DEFAULT_DEVICE_CONCURRENCY = 2;
/** claude CLI 原生 tier 别名——不在 endpoints.yaml 也放行（agent create model 校验） */
export const NATIVE_TIER_ALIASES = ["opus", "sonnet", "haiku"];

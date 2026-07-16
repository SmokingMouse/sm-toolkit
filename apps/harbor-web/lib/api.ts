/**
 * harbor-server REST/SSE 客户端。领域类型从 apps/harbor 的 protocol 直接 import type
 * （零运行时依赖，harbor-web 不进根 tsconfig references）；运行时常量本地复制。
 * dev 走 next rewrites 代理 7777；生产静态产物由 harbor-server 同源 serve。
 */

import type {
  Approval,
  ApprovalStatus,
  Automation,
  AutomationLogRow,
  BackendKind,
  Conversation,
  ConversationStatus,
  Device,
  HarborAgent,
  PromptSource,
  PromptWrapperConfig,
  Run,
  RunStreamFrame,
  UsageRow,
} from "../../harbor/src/protocol";

export type {
  Approval,
  ApprovalStatus,
  Automation,
  AutomationLogRow,
  BackendKind,
  Conversation,
  ConversationStatus,
  Device,
  HarborAgent,
  PromptSource,
  PromptWrapperConfig,
  Run,
  RunStreamFrame,
  UsageRow,
};

/** = protocol.ISSUE_STATUSES（运行时值不能 import type，本地复制） */
export const ISSUE_STATUSES = ["backlog", "doing", "review", "done", "canceled"] as const;
/** = protocol.NATIVE_TIER_ALIASES */
export const NATIVE_TIER_ALIASES = ["opus", "sonnet", "haiku"];
export const PERMISSIONS = ["readonly", "auto-edit", "full", "default"] as const;

export type ConversationWithAgent = Conversation & { agentName: string };
export type AutomationWithAgent = Automation & { agentName: string };
export type RunWithResult = Run & { resultText: string | null };
export interface ConversationDetail {
  conversation: Conversation;
  agent: HarborAgent | null;
  runs: RunWithResult[];
  statusLog: { fromStatus: string | null; toStatus: string; actor: string; ts: number }[];
}

// ── token（localStorage） ───────────────────────────────

const TOKEN_KEY = "harbor_token";

export function getToken(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function setToken(t: string): void {
  localStorage.setItem(TOKEN_KEY, t);
}

// ── fetch 封装 ──────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${getToken()}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError(`无法连接 harbor-server：${e instanceof Error ? e.message : e}`, 0);
  }
  if (res.status === 401) {
    // token 门：未授权一律引到 Settings 输 token
    if (typeof window !== "undefined" && !location.pathname.startsWith("/settings")) {
      location.href = "/settings";
    }
    throw new ApiError("unauthorized（去 Settings 配置 token）", 401);
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {}
    throw new ApiError(msg, res.status);
  }
  return res.json() as Promise<T>;
}

// ── 域 API ──────────────────────────────────────────────

export const listDevices = () => req<Device[]>("GET", "/api/devices");

export const listAgents = () => req<HarborAgent[]>("GET", "/api/agents");
export const createAgent = (body: Record<string, unknown>) => req<HarborAgent>("POST", "/api/agents", body);
export const setAgentArchived = (id: string, archived: boolean) =>
  req<HarborAgent>("PATCH", `/api/agents/${encodeURIComponent(id)}`, { archived });

export const listConversations = (q: { kind?: "chat" | "issue"; status?: ConversationStatus }) => {
  const params = new URLSearchParams();
  if (q.kind) params.set("kind", q.kind);
  if (q.status) params.set("status", q.status);
  const qs = params.toString();
  return req<ConversationWithAgent[]>("GET", `/api/conversations${qs ? `?${qs}` : ""}`);
};
export const createConversation = (body: {
  kind: "chat" | "issue";
  agent: string;
  title?: string;
  origin?: string;
}) => req<Conversation>("POST", "/api/conversations", body);
export const getConversation = (id: string) =>
  req<ConversationDetail>("GET", `/api/conversations/${encodeURIComponent(id)}`);
export const setConversationStatus = (id: string, status: ConversationStatus) =>
  req<Conversation>("PATCH", `/api/conversations/${encodeURIComponent(id)}`, { status });
export const createRun = (conversationId: string, prompt: string) =>
  req<Run>("POST", `/api/conversations/${encodeURIComponent(conversationId)}/runs`, { prompt });
export const cancelRun = (runId: string) =>
  req<Run>("POST", `/api/runs/${encodeURIComponent(runId)}/cancel`);

export const listApprovals = (status?: ApprovalStatus) =>
  req<Approval[]>("GET", `/api/approvals${status ? `?status=${status}` : ""}`);
export const decideApproval = (id: string, behavior: "allow" | "deny") =>
  req<Approval>("POST", `/api/approvals/${encodeURIComponent(id)}`, { behavior });

export const listAutomations = () => req<AutomationWithAgent[]>("GET", "/api/automations");
export const createAutomation = (body: Record<string, unknown>) =>
  req<Automation>("POST", "/api/automations", body);
export const setAutomationEnabled = (id: string, enabled: boolean) =>
  req<Automation>("PATCH", `/api/automations/${encodeURIComponent(id)}`, { enabled });
export const deleteAutomation = (id: string) =>
  req<{ ok: boolean }>("DELETE", `/api/automations/${encodeURIComponent(id)}`);
export const automationLog = (id: string) =>
  req<AutomationLogRow[]>("GET", `/api/automations/${encodeURIComponent(id)}/log`);

export const usage = (days: number) => req<UsageRow[]>("GET", `/api/usage?days=${days}`);

export const health = () => req<{ ok: boolean }>("GET", "/api/health");

export interface PromptWrapperSettings {
  wrappers: PromptWrapperConfig[];
  variables: string[];
}

export const promptWrapperSettings = () =>
  req<PromptWrapperSettings>("GET", "/api/settings/prompt-wrappers");
export const savePromptWrapper = (body: { source: PromptSource; enabled: boolean; template: string }) =>
  req<PromptWrapperConfig>("PATCH", "/api/settings/prompt-wrappers", body);
export const resetPromptWrapper = (source: PromptSource) =>
  req<PromptWrapperConfig>("DELETE", `/api/settings/prompt-wrappers/${encodeURIComponent(source)}`);

// ── SSE：run 事件流（EventSource 带不了 Authorization header → fetch 手解） ──

export async function* watchRun(runId: string, signal?: AbortSignal): AsyncGenerator<RunStreamFrame> {
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/events`, {
    headers: { Authorization: `Bearer ${getToken()}` },
    signal,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {}
    throw new ApiError(msg, res.status);
  }
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of chunk.split("\n")) {
        // ": ping" 保活注释帧忽略
        if (line.startsWith("data: ")) yield JSON.parse(line.slice(6)) as RunStreamFrame;
      }
    }
  }
}

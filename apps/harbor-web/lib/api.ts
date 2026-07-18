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
  Delivery,
  DeliveryCheckStatus,
  DeliveryEvent,
  DeliveryProviderKind,
  DeliveryStatus,
  Device,
  HarborAgent,
  HarborRepository,
  HarborSkill,
  HarborWorkspace,
  IssuePriority,
  ModelRouteCapability,
  PromptBlockConfig,
  PromptBlockKey,
  PromptSource,
  Run,
  RunStreamFrame,
  RepositoryMount,
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
  Delivery,
  DeliveryCheckStatus,
  DeliveryEvent,
  DeliveryProviderKind,
  DeliveryStatus,
  Device,
  HarborAgent,
  HarborRepository,
  HarborSkill,
  HarborWorkspace,
  IssuePriority,
  ModelRouteCapability,
  PromptBlockConfig,
  PromptBlockKey,
  PromptSource,
  Run,
  RunStreamFrame,
  RepositoryMount,
  UsageRow,
};

/** = protocol.ISSUE_STATUSES（运行时值不能 import type，本地复制） */
export const ISSUE_STATUSES = ["backlog", "todo", "doing", "review", "done", "canceled"] as const;
export const BOARD_STATUSES = ["backlog", "todo", "doing", "review", "done"] as const;
export const ISSUE_PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;
/** = protocol.NATIVE_TIER_ALIASES */
export const NATIVE_TIER_ALIASES = ["opus", "sonnet", "haiku"];
export const PERMISSIONS = ["readonly", "auto-edit", "full", "default"] as const;

export type ConversationWithAgent = Conversation & { agentName: string | null; latestRun: Run | null };
export type AutomationWithAgent = Automation & { agentName: string };
export type RunWithResult = Run & { resultText: string | null };
export type SkillWithAgents = HarborSkill & { agents: { id: string; name: string }[] };
export type RepositoryWithMounts = HarborRepository & {
  mounts: (RepositoryMount & { deviceName: string })[];
};
export interface ConversationDetail {
  conversation: Conversation;
  agent: HarborAgent | null;
  repository: HarborRepository | null;
  runs: RunWithResult[];
  statusLog: { fromStatus: string | null; toStatus: string; actor: string; ts: number }[];
  delivery: Delivery | null;
  deliveryEvents: DeliveryEvent[];
}

// ── token（localStorage） ───────────────────────────────

const TOKEN_KEY = "harbor_token";
const WORKSPACE_KEY = "harbor_workspace";

export function getToken(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function setToken(t: string): void {
  localStorage.setItem(TOKEN_KEY, t);
}

export function getActiveWorkspace(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(WORKSPACE_KEY) ?? "";
}

export function setActiveWorkspace(id: string): void {
  localStorage.setItem(WORKSPACE_KEY, id);
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
        ...(getActiveWorkspace() ? { "X-Harbor-Workspace": getActiveWorkspace() } : {}),
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

export const listWorkspaces = () => req<HarborWorkspace[]>("GET", "/api/workspaces");
export const createWorkspace = (body: { name: string; slug?: string; description?: string }) =>
  req<HarborWorkspace>("POST", "/api/workspaces", body);
export const updateWorkspace = (id: string, body: Record<string, unknown>) =>
  req<HarborWorkspace>("PATCH", `/api/workspaces/${encodeURIComponent(id)}`, body);

export const listRepositories = () => req<RepositoryWithMounts[]>("GET", "/api/repositories");
export const createRepository = (body: {
  name: string;
  remoteUrl?: string;
  defaultBranch?: string;
  device?: string;
  path?: string;
}) => req<RepositoryWithMounts>("POST", "/api/repositories", body);
export const updateRepository = (id: string, body: Record<string, unknown>) =>
  req<RepositoryWithMounts>("PATCH", `/api/repositories/${encodeURIComponent(id)}`, body);
export const setRepositoryMount = (id: string, body: { device: string; path: string }) =>
  req<RepositoryWithMounts>("POST", `/api/repositories/${encodeURIComponent(id)}/mounts`, body);
export const deleteRepositoryMount = (repositoryId: string, mountId: string) =>
  req<{ ok: boolean }>("DELETE", `/api/repositories/${encodeURIComponent(repositoryId)}/mounts/${encodeURIComponent(mountId)}`);

export const listAgents = () => req<HarborAgent[]>("GET", "/api/agents");
export const createAgent = (body: Record<string, unknown>) => req<HarborAgent>("POST", "/api/agents", body);
export const setAgentArchived = (id: string, archived: boolean) =>
  req<HarborAgent>("PATCH", `/api/agents/${encodeURIComponent(id)}`, { archived });
export const setAgentSkills = (id: string, skills: string[]) =>
  req<HarborAgent>("PATCH", `/api/agents/${encodeURIComponent(id)}`, { skills });
export const setAgentRepository = (id: string, repository: string) =>
  req<HarborAgent>("PATCH", `/api/agents/${encodeURIComponent(id)}`, { repository });

export const listSkills = () => req<SkillWithAgents[]>("GET", "/api/skills");
export const createSkill = (body: { name: string; description?: string; instruction: string }) =>
  req<SkillWithAgents>("POST", "/api/skills", body);
export const importRuntimeSkills = (body: { device: string; paths: string[] }) =>
  req<{ imported: SkillWithAgents[] }>("POST", "/api/skills/import", body);
export const updateSkill = (id: string, body: { name?: string; description?: string; instruction?: string; archived?: boolean }) =>
  req<SkillWithAgents>("PATCH", `/api/skills/${encodeURIComponent(id)}`, body);

export const listConversations = (q: { kind?: "chat" | "issue"; status?: ConversationStatus }) => {
  const params = new URLSearchParams();
  if (q.kind) params.set("kind", q.kind);
  if (q.status) params.set("status", q.status);
  const qs = params.toString();
  return req<ConversationWithAgent[]>("GET", `/api/conversations${qs ? `?${qs}` : ""}`);
};
export const createConversation = (body: {
  kind: "chat" | "issue";
  agent?: string;
  title?: string;
  description?: string;
  priority?: IssuePriority;
  origin?: string;
  originRef?: string;
}) => req<Conversation>("POST", "/api/conversations", body);
export const createIssueDraft = (body: { request: string; agent: string; priority: IssuePriority }) =>
  req<{ conversation: Conversation; run: Run }>("POST", "/api/issue-drafts", body);
export const publishIssueDraft = (
  id: string,
  body: { title: string; description: string; priority: IssuePriority; status: "backlog" | "todo" },
) => req<Conversation>("POST", `/api/issue-drafts/${encodeURIComponent(id)}/publish`, body);
export const getConversation = (id: string) =>
  req<ConversationDetail>("GET", `/api/conversations/${encodeURIComponent(id)}`);
export const setConversationStatus = (id: string, status: ConversationStatus) =>
  req<Conversation>("PATCH", `/api/conversations/${encodeURIComponent(id)}`, { status });
export const updateConversation = (id: string, body: Record<string, unknown>) =>
  req<Conversation>("PATCH", `/api/conversations/${encodeURIComponent(id)}`, body);
export const createRun = (conversationId: string, prompt: string, options?: { agent?: string; purpose?: string }) =>
  req<Run>("POST", `/api/conversations/${encodeURIComponent(conversationId)}/runs`, { prompt, ...options });
export const dispatchIssue = (id: string, body: { agent?: string; prompt?: string }) =>
  req<Run>("POST", `/api/conversations/${encodeURIComponent(id)}/dispatch`, body);
export const requestIssueChanges = (id: string, body: { feedback: string; agent?: string }) =>
  req<Run>("POST", `/api/conversations/${encodeURIComponent(id)}/request-changes`, body);
export const reviewIssue = (id: string, body: { agent: string; prompt?: string }) =>
  req<Run>("POST", `/api/conversations/${encodeURIComponent(id)}/review`, body);
export const approveIssue = (id: string) =>
  req<Conversation>("POST", `/api/conversations/${encodeURIComponent(id)}/approve`);
export const createDelivery = (
  id: string,
  body: { provider: DeliveryProviderKind; changeUrl: string; deploymentRequired: boolean },
) => req<Delivery>("POST", `/api/conversations/${encodeURIComponent(id)}/delivery`, body);
export const updateDelivery = (
  id: string,
  body: { changeUrl?: string; externalId?: string; headBranch?: string; baseBranch?: string; checkStatus?: DeliveryCheckStatus },
) => req<Delivery>("PATCH", `/api/deliveries/${encodeURIComponent(id)}`, body);
export const mergeDelivery = (id: string) =>
  req<Delivery>("POST", `/api/deliveries/${encodeURIComponent(id)}/merge`, { confirmed: true });
export const syncDelivery = (id: string) =>
  req<Delivery>("POST", `/api/deliveries/${encodeURIComponent(id)}/sync`, {});
export const startDeliveryDeployment = (id: string) =>
  req<Delivery>("POST", `/api/deliveries/${encodeURIComponent(id)}/deploy`, { confirmed: true });
export const finishDeliveryDeployment = (id: string, status: "succeeded" | "failed") =>
  req<Delivery>("POST", `/api/deliveries/${encodeURIComponent(id)}/deployment-result`, { status });
export const cancelIssue = (id: string) =>
  req<Conversation>("POST", `/api/conversations/${encodeURIComponent(id)}/cancel`);
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
export const runAutomation = (id: string) =>
  req<Run>("POST", `/api/automations/${encodeURIComponent(id)}/run`);
export const deleteAutomation = (id: string) =>
  req<{ ok: boolean }>("DELETE", `/api/automations/${encodeURIComponent(id)}`);
export const automationLog = (id: string) =>
  req<AutomationLogRow[]>("GET", `/api/automations/${encodeURIComponent(id)}/log`);

export const usage = (days: number) => req<UsageRow[]>("GET", `/api/usage?days=${days}`);

export const health = () => req<{ ok: boolean }>("GET", "/api/health");

export interface PromptBlockSettings {
  blocks: PromptBlockConfig[];
}

export const promptBlockSettings = () =>
  req<PromptBlockSettings>("GET", "/api/settings/prompt-blocks");
export const savePromptBlock = (body: { key: PromptBlockKey; enabled: boolean; template: string }) =>
  req<PromptBlockConfig>("PATCH", "/api/settings/prompt-blocks", body);
export const resetPromptBlock = (key: PromptBlockKey) =>
  req<PromptBlockConfig>("DELETE", `/api/settings/prompt-blocks/${encodeURIComponent(key)}`);

// ── SSE：run 事件流（EventSource 带不了 Authorization header → fetch 手解） ──

export async function* watchRun(runId: string, signal?: AbortSignal): AsyncGenerator<RunStreamFrame> {
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/events`, {
    headers: {
      Authorization: `Bearer ${getToken()}`,
      ...(getActiveWorkspace() ? { "X-Harbor-Workspace": getActiveWorkspace() } : {}),
    },
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

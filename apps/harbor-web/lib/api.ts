/**
 * harbor-server REST/SSE 客户端。领域类型从 apps/harbor 的 protocol 直接 import type
 * （零运行时依赖，harbor-web 不进根 tsconfig references）；运行时常量本地复制。
 * dev 走 next rewrites 代理 7777；生产静态产物由 harbor-server 同源 serve。
 */

import type {
  Approval,
  ApprovalStatus,
  Account,
  AuthIdentity,
  Automation,
  AutomationLogRow,
  BackendKind,
  Conversation,
  ConversationMessage,
  ConversationStatus,
  Delivery,
  DeliveryCheckStatus,
  DeliveryEvent,
  DeliveryProviderKind,
  DeliveryStatus,
  DeviceSummary,
  HarborAgent,
  HarborRepository,
  HarborSkill,
  HarborWorkspace,
  GitHubInstallation,
  GitHubAccountAuthorization,
  GitHubRepositoryConnection,
  GitHubWorkspaceInstallation,
  IssueLabel,
  IssuePriority,
  ModelRouteCapability,
  PromptBlockConfig,
  PromptBlockKey,
  PromptSource,
  PasskeyCredential,
  PersonalAccessToken,
  PersonalAccessTokenScope,
  Run,
  RunStreamFrame,
  RepositoryMount,
  ScmEvent,
  ScmExternalObject,
  SkillDependency,
  SkillFile,
  SkillGroup,
  SkillSource,
  LarkWorkspaceBinding,
  UsageRow,
  WorkspaceMember,
  WorkspaceInvitation,
  WorkspaceRole,
} from "../../harbor/src/protocol";

export type {
  Approval,
  ApprovalStatus,
  Account,
  AuthIdentity,
  Automation,
  AutomationLogRow,
  BackendKind,
  Conversation,
  ConversationMessage,
  ConversationStatus,
  Delivery,
  DeliveryCheckStatus,
  DeliveryEvent,
  DeliveryProviderKind,
  DeliveryStatus,
  DeviceSummary,
  HarborAgent,
  HarborRepository,
  HarborSkill,
  HarborWorkspace,
  GitHubInstallation,
  GitHubAccountAuthorization,
  GitHubRepositoryConnection,
  GitHubWorkspaceInstallation,
  IssueLabel,
  IssuePriority,
  ModelRouteCapability,
  PromptBlockConfig,
  PromptBlockKey,
  PromptSource,
  PasskeyCredential,
  PersonalAccessToken,
  PersonalAccessTokenScope,
  Run,
  RunStreamFrame,
  RepositoryMount,
  ScmEvent,
  ScmExternalObject,
  SkillDependency,
  SkillFile,
  SkillGroup,
  SkillSource,
  LarkWorkspaceBinding,
  UsageRow,
  WorkspaceMember,
  WorkspaceInvitation,
  WorkspaceRole,
};

/** Web 永远消费轻量 Device 列表投影，不持有 runtime Skill 正文。 */
export type Device = DeviceSummary;

/** = protocol.ISSUE_STATUSES（运行时值不能 import type，本地复制） */
export const ISSUE_STATUSES = [
  "backlog",
  "todo",
  "doing",
  "review",
  "done",
  "canceled",
] as const;
export const BOARD_STATUSES = [
  "backlog",
  "todo",
  "doing",
  "review",
  "done",
] as const;
export const ISSUE_PRIORITIES = [
  "none",
  "low",
  "medium",
  "high",
  "urgent",
] as const;
/** = protocol.NATIVE_TIER_ALIASES */
export const NATIVE_TIER_ALIASES = ["opus", "sonnet", "haiku"];
export const PERMISSIONS = [
  "readonly",
  "auto-edit",
  "full",
  "default",
] as const;

export type ConversationWithAgent = Conversation & {
  agentName: string | null;
  latestRun: Run | null;
};
export type AutomationWithAgent = Automation & { agentName: string };
export type RunWithResult = Run & { resultText: string | null };
export type SkillWithAgents = HarborSkill & {
  agents: { id: string; name: string }[];
};
export type RepositoryWithMounts = HarborRepository & {
  mounts: (RepositoryMount & { deviceName: string })[];
  githubConnection: GitHubRepositoryConnection | null;
};
export interface ConversationDetail {
  conversation: Conversation;
  agent: HarborAgent | null;
  repository: HarborRepository | null;
  runs: RunWithResult[];
  statusLog: {
    fromStatus: string | null;
    toStatus: string;
    actor: string;
    ts: number;
  }[];
  delivery: Delivery | null;
  deliveryEvents: DeliveryEvent[];
  messages: ConversationMessage[];
  labels: IssueLabel[];
  creator: WorkspaceMember | null;
  owner: WorkspaceMember | null;
}

export type CurrentActor =
  | { kind: "system"; role: "owner" }
  | {
      kind: "account";
      account: Account;
      memberships: WorkspaceMember[];
      credential: "session" | "pat";
    };

// ── browser session / Workspace selection ─────────────

const WORKSPACE_KEY = "harbor_workspace";

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

function cookie(name: string): string {
  if (typeof document === "undefined") return "";
  const encoded = `${encodeURIComponent(name)}=`;
  const item = document.cookie.split("; ").find((part) => part.startsWith(encoded));
  return item ? decodeURIComponent(item.slice(encoded.length)) : "";
}

async function requestJson<T>(
  method: string,
  path: string,
  body?: unknown,
  options: { bootstrapToken?: string; redirectOnUnauthorized?: boolean } = {},
): Promise<T> {
  let res: Response;
  const mutating = method !== "GET" && method !== "HEAD";
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: {
        ...(options.bootstrapToken ? { Authorization: `Bearer ${options.bootstrapToken}` } : {}),
        ...(getActiveWorkspace() ? { "X-Harbor-Workspace": getActiveWorkspace() } : {}),
        ...(mutating && cookie("harbor_csrf") ? { "X-Harbor-CSRF": cookie("harbor_csrf") } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    throw new ApiError(
      `无法连接 harbor-server：${error instanceof Error ? error.message : error}`,
      0,
    );
  }
  if (res.status === 401 && options.redirectOnUnauthorized !== false) {
    if (typeof window !== "undefined" && !location.pathname.startsWith("/login")) location.href = "/login";
    throw new ApiError("登录已失效，请重新使用 GitHub 或 Passkey 登录", 401);
  }
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {}
    throw new ApiError(message, res.status);
  }
  return res.json() as Promise<T>;
}

async function req<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  return requestJson<T>(method, path, body);
}

export const bootstrapStatus = () => requestJson<{ required: boolean }>(
  "GET", "/api/auth/bootstrap/status", undefined, { redirectOnUnauthorized: false },
);
export const githubAuthStatus = () => requestJson<{ configured: boolean; appSlug?: string }>(
  "GET", "/api/auth/github/status", undefined, { redirectOnUnauthorized: false },
);
export const beginGitHubLogin = (invitationToken?: string) =>
  requestJson<{ url: string }>(
    "POST", "/api/auth/github/login", invitationToken ? { invitationToken } : {},
    { redirectOnUnauthorized: false },
  );
export const beginBootstrap = (displayName: string, bootstrapToken: string) =>
  requestJson<unknown>("POST", "/api/auth/bootstrap/options", { displayName }, {
    bootstrapToken, redirectOnUnauthorized: false,
  });
export const finishBootstrap = (response: unknown, bootstrapToken: string, label?: string) =>
  requestJson<{ account: Account; recoveryCodes: string[]; csrfToken: string }>(
    "POST", "/api/auth/bootstrap/verify", { response, label }, {
      bootstrapToken, redirectOnUnauthorized: false,
    },
  );
export const beginLogin = () => requestJson<unknown>(
  "POST", "/api/auth/login/options", {}, { redirectOnUnauthorized: false },
);
export const finishLogin = (response: unknown) => requestJson<{ account: Account; csrfToken: string }>(
  "POST", "/api/auth/login/verify", { response }, { redirectOnUnauthorized: false },
);
export const beginInvitationRegistration = (token: string, displayName: string) =>
  requestJson<unknown>(
    "POST", "/api/auth/invitation/options", { token, displayName }, { redirectOnUnauthorized: false },
  );
export const finishInvitationRegistration = (response: unknown, label?: string) =>
  requestJson<{
    account: Account;
    membership: WorkspaceMember;
    personalWorkspace: HarborWorkspace;
    recoveryCodes: string[];
    csrfToken: string;
  }>("POST", "/api/auth/invitation/verify", { response, label }, { redirectOnUnauthorized: false });
export const recoverSession = (accountId: string, code: string) =>
  requestJson<{ account: Account; csrfToken: string }>(
    "POST", "/api/auth/recovery", { accountId, code }, { redirectOnUnauthorized: false },
  );
export const logout = () => req<{ ok: true }>("POST", "/api/auth/logout", {});

// ── 域 API ──────────────────────────────────────────────

export const listDevices = () => req<Device[]>("GET", "/api/devices");

export const listWorkspaces = () =>
  req<HarborWorkspace[]>("GET", "/api/workspaces");
export const currentActor = () => req<CurrentActor>("GET", "/api/me");
export const createWorkspace = (body: {
  name: string;
  slug?: string;
  description?: string;
}) => req<HarborWorkspace>("POST", "/api/workspaces", body);
export const updateWorkspace = (id: string, body: Record<string, unknown>) =>
  req<HarborWorkspace>(
    "PATCH",
    `/api/workspaces/${encodeURIComponent(id)}`,
    body,
  );

export const listRepositories = () =>
  req<RepositoryWithMounts[]>("GET", "/api/repositories");
export const createRepository = (body: {
  name: string;
  remoteUrl?: string;
  defaultBranch?: string;
  device?: string;
  path?: string;
  scmProvider?: "local" | "github" | "codebase";
  scmRepository?: string;
  scmAgent?: string;
  scmAutoDispatch?: boolean;
}) => req<RepositoryWithMounts>("POST", "/api/repositories", body);
export const updateRepository = (id: string, body: Record<string, unknown>) =>
  req<RepositoryWithMounts>(
    "PATCH",
    `/api/repositories/${encodeURIComponent(id)}`,
    body,
  );
export const setRepositoryMount = (
  id: string,
  body: { device: string; path: string },
) =>
  req<RepositoryWithMounts>(
    "POST",
    `/api/repositories/${encodeURIComponent(id)}/mounts`,
    body,
  );
export const deleteRepositoryMount = (repositoryId: string, mountId: string) =>
  req<{ ok: boolean }>(
    "DELETE",
    `/api/repositories/${encodeURIComponent(repositoryId)}/mounts/${encodeURIComponent(mountId)}`,
  );

export const listAgents = () => req<HarborAgent[]>("GET", "/api/agents");
export const createAgent = (body: Record<string, unknown>) =>
  req<HarborAgent>("POST", "/api/agents", body);
export const setAgentArchived = (id: string, archived: boolean) =>
  req<HarborAgent>("PATCH", `/api/agents/${encodeURIComponent(id)}`, {
    archived,
  });
export const setAgentSkills = (id: string, skills: string[]) =>
  req<HarborAgent>("PATCH", `/api/agents/${encodeURIComponent(id)}`, {
    skills,
  });
export const setAgentRepository = (id: string, repository: string) =>
  req<HarborAgent>("PATCH", `/api/agents/${encodeURIComponent(id)}`, {
    repository,
  });
export const updateAgent = (id: string, body: Record<string, unknown>) =>
  req<HarborAgent>("PATCH", `/api/agents/${encodeURIComponent(id)}`, body);
export const moveAgentToDevice = (
  id: string,
  device: string,
  dropIncompatibleSkills = false,
) =>
  req<HarborAgent>("PATCH", `/api/agents/${encodeURIComponent(id)}`, {
    device,
    dropIncompatibleSkills,
  });

export const listSkills = () => req<SkillWithAgents[]>("GET", "/api/skills");
export const createSkill = (body: {
  name: string;
  description?: string;
  instruction: string;
  groupId?: string | null;
  files?: { path: string; content: string }[];
  dependencies?: SkillDependency[];
}) => req<SkillWithAgents>("POST", "/api/skills", body);
export const importRuntimeSkills = (body: {
  device: string;
  paths: string[];
}) => req<{ imported: SkillWithAgents[] }>("POST", "/api/skills/import", body);
export const updateSkill = (
  id: string,
  body: {
    name?: string;
    description?: string;
    instruction?: string;
    archived?: boolean;
    groupId?: string | null;
    files?: { path: string; content: string }[];
    dependencies?: SkillDependency[];
    autoSync?: boolean;
  },
) =>
  req<SkillWithAgents>("PATCH", `/api/skills/${encodeURIComponent(id)}`, body);
export const listSkillGroups = () =>
  req<SkillGroup[]>("GET", "/api/skill-groups");
export const createSkillGroup = (body: { name: string; position?: number }) =>
  req<SkillGroup>("POST", "/api/skill-groups", body);
export const updateSkillGroup = (
  id: string,
  body: { name?: string; position?: number },
) =>
  req<SkillGroup>("PATCH", `/api/skill-groups/${encodeURIComponent(id)}`, body);
export const deleteSkillGroup = (id: string) =>
  req<{ ok: boolean }>("DELETE", `/api/skill-groups/${encodeURIComponent(id)}`);
export const importSkillSource = (body: Record<string, unknown>) =>
  req<SkillWithAgents>("POST", "/api/skills/import-source", body);
export const syncRemoteSkill = (id: string) =>
  req<SkillWithAgents>("POST", `/api/skills/${encodeURIComponent(id)}/sync`);

export const listConversations = (q: {
  kind?: "chat" | "issue";
  status?: ConversationStatus;
}) => {
  const params = new URLSearchParams();
  if (q.kind) params.set("kind", q.kind);
  if (q.status) params.set("status", q.status);
  const qs = params.toString();
  return req<ConversationWithAgent[]>(
    "GET",
    `/api/conversations${qs ? `?${qs}` : ""}`,
  );
};
export const createConversation = (body: {
  kind: "chat" | "issue";
  agent?: string;
  title?: string;
  description?: string;
  priority?: IssuePriority;
  origin?: string;
  originRef?: string;
  ownerMemberId?: string | null;
  labelIds?: string[];
}) => req<Conversation>("POST", "/api/conversations", body);
export const createIssueDraft = (body: {
  request: string;
  agent: string;
  priority: IssuePriority;
}) =>
  req<{ conversation: Conversation; run: Run }>(
    "POST",
    "/api/issue-drafts",
    body,
  );
export const publishIssueDraft = (
  id: string,
  body: {
    title: string;
    description: string;
    priority: IssuePriority;
    status: "backlog" | "todo";
  },
) =>
  req<Conversation>(
    "POST",
    `/api/issue-drafts/${encodeURIComponent(id)}/publish`,
    body,
  );
export const getConversation = (id: string) =>
  req<ConversationDetail>(
    "GET",
    `/api/conversations/${encodeURIComponent(id)}`,
  );
export const setConversationStatus = (id: string, status: ConversationStatus) =>
  req<Conversation>("PATCH", `/api/conversations/${encodeURIComponent(id)}`, {
    status,
  });
export const updateConversation = (id: string, body: Record<string, unknown>) =>
  req<Conversation>(
    "PATCH",
    `/api/conversations/${encodeURIComponent(id)}`,
    body,
  );
export const createRun = (
  conversationId: string,
  prompt: string,
  options?: { agent?: string; purpose?: string },
) =>
  req<Run>(
    "POST",
    `/api/conversations/${encodeURIComponent(conversationId)}/runs`,
    { prompt, ...options },
  );
export const dispatchIssue = (
  id: string,
  body: { agent?: string; prompt?: string },
) =>
  req<Run>(
    "POST",
    `/api/conversations/${encodeURIComponent(id)}/dispatch`,
    body,
  );
export const requestIssueChanges = (
  id: string,
  body: { feedback: string; agent?: string },
) =>
  req<Run>(
    "POST",
    `/api/conversations/${encodeURIComponent(id)}/request-changes`,
    body,
  );
export const reviewIssue = (
  id: string,
  body: { agent: string; prompt?: string },
) =>
  req<Run>("POST", `/api/conversations/${encodeURIComponent(id)}/review`, body);
export const approveIssue = (id: string) =>
  req<Conversation>(
    "POST",
    `/api/conversations/${encodeURIComponent(id)}/approve`,
  );
export const createDelivery = (
  id: string,
  body: {
    provider?: DeliveryProviderKind;
    changeUrl?: string;
    externalId?: string;
    headBranch?: string;
    baseBranch?: string;
  },
) =>
  req<Delivery>(
    "POST",
    `/api/conversations/${encodeURIComponent(id)}/delivery`,
    body,
  );
export const updateDelivery = (
  id: string,
  body: {
    changeUrl?: string;
    externalId?: string;
    headBranch?: string;
    baseBranch?: string;
    checkStatus?: DeliveryCheckStatus;
  },
) => req<Delivery>("PATCH", `/api/deliveries/${encodeURIComponent(id)}`, body);
export const mergeDelivery = (id: string, mergedRevision?: string) =>
  req<Delivery>("POST", `/api/deliveries/${encodeURIComponent(id)}/merge`, {
    confirmed: true,
    ...(mergedRevision ? { mergedRevision } : {}),
  });
export const syncDelivery = (id: string) =>
  req<Delivery>("POST", `/api/deliveries/${encodeURIComponent(id)}/sync`, {});
export const refreshDelivery = (id: string) =>
  req<Delivery>("POST", `/api/deliveries/${encodeURIComponent(id)}/refresh`);
export const cancelIssue = (id: string) =>
  req<Conversation>(
    "POST",
    `/api/conversations/${encodeURIComponent(id)}/cancel`,
  );
export const cancelRun = (runId: string) =>
  req<Run>("POST", `/api/runs/${encodeURIComponent(runId)}/cancel`);
export const createConversationMessage = (
  id: string,
  body: { body: string; agent?: string; dispatch?: boolean },
) =>
  req<{ message: ConversationMessage; run?: Run }>(
    "POST",
    `/api/conversations/${encodeURIComponent(id)}/messages`,
    body,
  );

export const listMembers = () => req<WorkspaceMember[]>("GET", "/api/members");
export const updateMember = (
  id: string,
  body: { role?: WorkspaceRole; status?: WorkspaceMember["status"] },
) =>
  req<WorkspaceMember>("PATCH", `/api/members/${encodeURIComponent(id)}`, body);
export const listInvitations = () => req<WorkspaceInvitation[]>("GET", "/api/invitations");
export const createInvitation = (body: { email?: string; role: WorkspaceRole; expiresAt?: number }) =>
  req<WorkspaceInvitation & { token: string }>("POST", "/api/invitations", body);
export const acceptInvitation = (token: string) =>
  req<WorkspaceMember>("POST", "/api/invitations/accept", { token });
export const revokeInvitation = (id: string) =>
  req<{ ok: boolean }>("DELETE", `/api/invitations/${encodeURIComponent(id)}`);

export const listPersonalAccessTokens = () =>
  req<PersonalAccessToken[]>("GET", "/api/accounts/me/pats");
export const createPersonalAccessToken = (body: {
  label?: string;
  workspaceId?: string | null;
  scopes?: PersonalAccessTokenScope[];
  expiresAt?: number | null;
}) => req<PersonalAccessToken & { token: string }>("POST", "/api/accounts/me/pats", body);
export const revokePersonalAccessToken = (id: string) =>
  req<{ ok: boolean }>("DELETE", `/api/accounts/me/pats/${encodeURIComponent(id)}`);

export const listAuthIdentities = () => req<AuthIdentity[]>("GET", "/api/accounts/me/identities");
export const beginGitHubLink = () => req<{ url: string }>("POST", "/api/accounts/me/github/link", {});
export const revokeGitHubAuthorization = () =>
  req<{ ok: boolean }>("DELETE", "/api/accounts/me/github/authorization");

export const listPasskeys = () => req<PasskeyCredential[]>("GET", "/api/accounts/me/passkeys");
export const beginPasskeyRegistration = () =>
  req<unknown>("POST", "/api/accounts/me/passkeys/options", {});
export const finishPasskeyRegistration = (response: unknown, label?: string) =>
  req<{ account: Account }>(
    "POST", "/api/accounts/me/passkeys/verify", { response, label },
  );

export type GitHubIntegrationView =
  | { configured: false }
  | {
      configured: true;
      appSlug: string;
      identity: AuthIdentity | null;
      authorization: Omit<GitHubAccountAuthorization, "credentialRef"> | null;
      installations: {
        installation: GitHubInstallation;
        connection: GitHubWorkspaceInstallation;
        repositories: GitHubRepositoryConnection[];
      }[];
    };

export const getGitHubIntegration = () =>
  req<GitHubIntegrationView>("GET", "/api/integrations/github");
export const beginGitHubInstallation = () =>
  req<{ url: string }>("POST", "/api/integrations/github/install", {});
export const syncGitHubInstallation = (installationId: string) =>
  req<{
    installationId: string;
    connected: number;
    created: number;
    reused: number;
    aliases: number;
    removed: number;
  }>("POST", `/api/integrations/github/installations/${encodeURIComponent(installationId)}/sync`, {});
export const disconnectGitHubInstallation = (installationId: string) =>
  req<{ ok: true }>("DELETE", `/api/integrations/github/installations/${encodeURIComponent(installationId)}`);

export const listLabels = () => req<IssueLabel[]>("GET", "/api/labels");
export const createLabel = (body: { name: string; color: string }) =>
  req<IssueLabel>("POST", "/api/labels", body);

export const listLarkBindings = () =>
  req<{ bindings: LarkWorkspaceBinding[]; customBotConfigured: boolean }>(
    "GET",
    "/api/integrations/lark",
  );
export const createLarkBinding = (body: {
  chatId: string;
  defaultAgent: string;
  responseMode: "thread" | "message";
  listenMode: "mention" | "all";
  botMode: "global" | "custom";
  enabled?: boolean;
}) =>
  req<LarkWorkspaceBinding>("POST", "/api/integrations/lark/bindings", body);
export const updateLarkBinding = (id: string, body: Record<string, unknown>) =>
  req<LarkWorkspaceBinding>(
    "PATCH",
    `/api/integrations/lark/bindings/${encodeURIComponent(id)}`,
    body,
  );
export const deleteLarkBinding = (id: string) =>
  req<{ ok: boolean }>(
    "DELETE",
    `/api/integrations/lark/bindings/${encodeURIComponent(id)}`,
  );

export const listScmEvents = () => req<ScmEvent[]>("GET", "/api/scm/events");
export const listScmObjects = (kind?: "issue" | "change") =>
  req<ScmExternalObject[]>(
    "GET",
    `/api/scm/objects${kind ? `?kind=${kind}` : ""}`,
  );

export const listApprovals = (status?: ApprovalStatus) =>
  req<Approval[]>("GET", `/api/approvals${status ? `?status=${status}` : ""}`);
export const decideApproval = (id: string, behavior: "allow" | "deny") =>
  req<Approval>("POST", `/api/approvals/${encodeURIComponent(id)}`, {
    behavior,
  });

export const listAutomations = () =>
  req<AutomationWithAgent[]>("GET", "/api/automations");
export const createAutomation = (body: Record<string, unknown>) =>
  req<Automation>(
    "POST",
    "/api/automations",
    body,
  );
export const setAutomationEnabled = (id: string, enabled: boolean) =>
  req<Automation>("PATCH", `/api/automations/${encodeURIComponent(id)}`, {
    enabled,
  });
export const updateAutomation = (id: string, body: Record<string, unknown>) =>
  req<Automation>("PATCH", `/api/automations/${encodeURIComponent(id)}`, body);
export const runAutomation = (id: string) =>
  req<Run>("POST", `/api/automations/${encodeURIComponent(id)}/run`);
export const deleteAutomation = (id: string) =>
  req<{ ok: boolean }>("DELETE", `/api/automations/${encodeURIComponent(id)}`);
export const automationLog = (id: string) =>
  req<AutomationLogRow[]>(
    "GET",
    `/api/automations/${encodeURIComponent(id)}/log`,
  );

export const usage = (days: number) =>
  req<UsageRow[]>("GET", `/api/usage?days=${days}`);

export const health = () => req<{ ok: boolean }>("GET", "/api/health");

export interface PromptBlockSettings {
  blocks: PromptBlockConfig[];
}

export const promptBlockSettings = () =>
  req<PromptBlockSettings>("GET", "/api/settings/prompt-blocks");
export const savePromptBlock = (body: {
  key: PromptBlockKey;
  enabled: boolean;
  template: string;
}) => req<PromptBlockConfig>("PATCH", "/api/settings/prompt-blocks", body);
export const resetPromptBlock = (key: PromptBlockKey) =>
  req<PromptBlockConfig>(
    "DELETE",
    `/api/settings/prompt-blocks/${encodeURIComponent(key)}`,
  );

// ── SSE：run 事件流（使用同源 HttpOnly Session Cookie） ──

export async function* watchRun(
  runId: string,
  signal?: AbortSignal,
): AsyncGenerator<RunStreamFrame> {
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/events`, {
    credentials: "same-origin",
    headers: {
      ...(getActiveWorkspace()
        ? { "X-Harbor-Workspace": getActiveWorkspace() }
        : {}),
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
        if (line.startsWith("data: "))
          yield JSON.parse(line.slice(6)) as RunStreamFrame;
      }
    }
  }
}

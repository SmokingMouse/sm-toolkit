/**
 * REST 入口层（Hono）：devices/agents/conversations/runs/approvals/automations/usage
 * CRUD + run 事件 SSE + Bearer token auth + 只读看板（GET /）。
 * 语义校验尽量前置到这一层（fail loudly at 配置时而非运行时）：
 *   - agent create 校验 model ∈ device 能力清单（harbor.md §8「endpoints.yaml 各机不一致」对策）
 *   - automation create 校验唯一 Schedule/Codebase Trigger 与 Agent/Repository binding
 */

import { existsSync } from "node:fs";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { join, resolve } from "node:path";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { HTTPException } from "hono/http-exception";
import { assertAgentEnvironmentSafe } from "../agent-environment.js";
import type {
  BackendKind,
  AutomationOutput,
  CodebaseAutomationEvent,
  ConversationKind,
  ConversationStatus,
  Delivery,
  DeliveryCheckStatus,
  DeliveryProviderKind,
  Device,
  IssuePriority,
  IsolationKind,
  Origin,
  PromptBlockKey,
  Run,
  RunPrincipal,
  RunPurpose,
  RunStreamFrame,
  Account,
  PersonalAccessToken,
  PersonalAccessTokenScope,
  WorkspaceMember,
  WorkspaceRole,
} from "../protocol.js";
import {
  CODEBASE_AUTOMATION_EVENTS,
  DELIVERY_CHECK_STATUSES,
  DEFAULT_WORKSPACE_ID,
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  NATIVE_TIER_ALIASES,
  RUN_PURPOSES,
} from "../protocol.js";
import type { HarborStore } from "./store.js";
import type { RunBus } from "./bus.js";
import type { DeviceHub } from "./ws.js";
import { RunCoordinator } from "./scheduler.js";
import type { ApprovalService } from "./approvals.js";
import { AutomationService } from "./automation.js";
import { inactiveMaintenanceGuard, matchesRevisionAwareHealth, type MaintenanceGuard } from "./maintenance.js";
import { AuthService } from "./auth.js";
import { transitionConversation } from "./statemachine.js";
import { DeliveryService } from "./delivery.js";
import type { ScmService } from "./scm.js";
import { importedSkillMetadata, SkillImportService } from "./skill-import.js";
import {
  ensureBuiltinHarborSkill,
  HARBOR_BUILTIN_SKILL_NAME,
} from "./builtin-skills.js";
import {
  getPromptBlockConfig,
  listPromptBlockConfigs,
  PROMPT_BLOCK_KEYS,
  validatePromptTemplate,
} from "./prompt-wrapper.js";
import type { DeploymentTargetConfig } from "../config.js";
import type { GitHubIntegrationService } from "./github-integration.js";
import type { GitHubCredentialBroker } from "./github-credential-broker.js";

const PERMISSIONS = ["readonly", "auto-edit", "full", "default"];
const MAX_SKILL_INSTRUCTION = 128 * 1024;
const MAX_AGENT_SETUP = 64 * 1024;
const ISSUE_TRIAGE_PROMPT = `You are triaging a request before an Issue is created.
Read the repository only as needed to replace ambiguity with concrete evidence. Do not edit files, create branches, commit, push, or implement the request.

Return one proposed Issue in Markdown using this exact shape:
# <concise outcome-oriented title>

## Context
<what is happening and why it matters>

## Scope
<specific implementation scope, relevant files or modules when known>

## Acceptance criteria
- <observable criterion>

## Risks / open questions
- <only real uncertainty; write "None" if there is none>

User request:
`;

/** Web 产物目录（Next.js 静态导出）。相对本源码定位仓库内路径，不依赖 cwd。 */
const WEB_OUT = resolve(import.meta.dir, "../../../harbor-web/out");

function bad(message: string): never {
  throw new HTTPException(400, { message });
}

function validateDeliveryUrl(value: string | null | undefined): void {
  if (!value?.trim()) return;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      bad("MR/PR URL 只支持 http/https");
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    bad("MR/PR URL 格式不正确");
  }
}

function safeSecretEqual(actual: string, expected: string): boolean {
  if (!actual || !expected) return false;
  const left = createHash("sha256").update(actual).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

function safeGitHubSignatureEqual(rawBody: string, signature: string, secret: string): boolean {
  if (!secret || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  const actual = Buffer.from(signature.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function objectField(value: unknown, key: string): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function githubNumericId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value) ? value : null;
}

function stringField(value: unknown, key: string): string | null {
  const candidate = objectField(value, key);
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

function githubAutomationEvent(
  githubEvent: string,
  payload: Record<string, unknown>,
): { eventType: CodebaseAutomationEvent; revision: string | null; occurredAt?: number } | null {
  const action = typeof payload.action === "string" ? payload.action : "";
  if (githubEvent === "pull_request") {
    const pullRequest = payload.pull_request;
    if (!pullRequest || typeof pullRequest !== "object" || Array.isArray(pullRequest)) return null;
    const merged = objectField(pullRequest, "merged") === true;
    if (action === "closed" && !merged) return null;
    const eventType: CodebaseAutomationEvent = action === "closed" && merged
      ? "merge_request_merged"
      : action === "opened" || action === "reopened"
        ? "merge_request_opened"
        : "merge_request_updated";
    const revision = eventType === "merge_request_merged"
      ? stringField(pullRequest, "merge_commit_sha")
      : stringField(objectField(pullRequest, "head"), "sha");
    if (eventType === "merge_request_merged" && (!revision || !/^[a-f0-9]{40,64}$/i.test(revision))) {
      throw new Error("GitHub merged pull request 缺少可信 merge_commit_sha");
    }
    const occurred = stringField(pullRequest, eventType === "merge_request_merged" ? "merged_at" : "updated_at");
    const occurredAt = occurred ? Date.parse(occurred) : Number.NaN;
    return {
      eventType,
      revision: revision?.toLowerCase() ?? null,
      ...(Number.isFinite(occurredAt) ? { occurredAt } : {}),
    };
  }
  if (githubEvent === "issues") {
    if (action === "closed" || action === "deleted") return null;
    const issue = payload.issue;
    if (!issue || typeof issue !== "object" || Array.isArray(issue)) return null;
    const occurred = stringField(issue, action === "opened" ? "created_at" : "updated_at");
    const occurredAt = occurred ? Date.parse(occurred) : Number.NaN;
    return {
      eventType: action === "opened" || action === "reopened" ? "issue_opened" : "issue_updated",
      revision: null,
      ...(Number.isFinite(occurredAt) ? { occurredAt } : {}),
    };
  }
  if (githubEvent === "issue_comment" && action === "created") {
    const comment = payload.comment;
    const occurred = stringField(comment, "created_at");
    const occurredAt = occurred ? Date.parse(occurred) : Number.NaN;
    return {
      eventType: "issue_commented",
      revision: null,
      ...(Number.isFinite(occurredAt) ? { occurredAt } : {}),
    };
  }
  return null;
}

function parseAgentEnvironment(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    bad("environment 需要是 key/value object");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 64) bad("environment 最多 64 项");
  const result: Record<string, string> = {};
  let bytes = 0;
  for (const [key, raw] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      bad(`environment key "${key}" 不是合法变量名`);
    if (typeof raw !== "string") bad(`environment.${key} 必须是 string`);
    bytes += key.length + raw.length;
    if (bytes > 64 * 1024) bad("environment 总大小不能超过 64KB");
    result[key] = raw;
  }
  try {
    assertAgentEnvironmentSafe(result);
  } catch (error) {
    bad(error instanceof Error ? error.message : String(error));
  }
  return result;
}

function parseSkillFiles(
  value: unknown,
  instruction: string,
): { path: string; content: string }[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 64)
    bad("files 需要是 1–64 个 Skill 文件");
  const files = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      bad("每个 Skill file 需要 path/content");
    const record = item as Record<string, unknown>;
    if (typeof record.path !== "string" || typeof record.content !== "string")
      bad("每个 Skill file 需要 string path/content");
    const path = record.path.replace(/\\/g, "/").replace(/^\.\//, "");
    if (
      !path ||
      path.startsWith("/") ||
      path.split("/").includes("..") ||
      path.includes("\0")
    )
      bad(`非法 Skill file path：${path}`);
    if (record.content.length > 128 * 1024)
      bad(`Skill file ${path} 不能超过 128KB`);
    return { path, content: record.content };
  });
  if (new Set(files.map((file) => file.path)).size !== files.length)
    bad("Skill file path 不能重复");
  if (files.reduce((sum, file) => sum + file.content.length, 0) > 512 * 1024)
    bad("Skill bundle 不能超过 512KB");
  if (!files.some((file) => file.path === "SKILL.md"))
    files.unshift({ path: "SKILL.md", content: instruction });
  return files;
}

function parseSkillDependencies(value: unknown) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 64)
    bad("dependencies 需要是最多 64 项的数组");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      bad("dependency 需要 name/spec/required");
    const record = item as Record<string, unknown>;
    if (typeof record.name !== "string" || !record.name.trim())
      bad("dependency.name 不能为空");
    if (
      record.spec !== undefined &&
      record.spec !== null &&
      typeof record.spec !== "string"
    )
      bad("dependency.spec 需要 string/null");
    return {
      name: record.name.trim(),
      spec: typeof record.spec === "string" ? record.spec : null,
      required: record.required !== false,
    };
  });
}

function rejectUnknownFields(body: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) bad(`不支持字段：${unknown.join(", ")}；部署命令、路径与 health 配置只能来自 server 管理员配置`);
}

export function buildRest(
  store: HarborStore,
  bus: RunBus,
  hub: DeviceHub,
  coordinator: RunCoordinator,
  approvals: ApprovalService,
  automations: AutomationService,
  expectedToken: string,
  deliveries = new DeliveryService(store),
  scm: ScmService | null = null,
  codebaseWebhookSecret = "",
  skillImports = new SkillImportService(),
  customLarkWorkspaceIds: ReadonlySet<string> = new Set(),
  maintenance: MaintenanceGuard = inactiveMaintenanceGuard,
  auth: AuthService = new AuthService(store, {
    origin: "http://localhost",
    rpId: "localhost",
    rpName: "Harbor Test",
    secureCookie: false,
  }),
  selfDeployTarget: DeploymentTargetConfig | null = null,
  githubWebhookSecret = "",
  githubIntegration: GitHubIntegrationService | null = null,
  githubCredentials: GitHubCredentialBroker | null = null,
): Hono {
  const app = new Hono();
  type ApiActor =
    | { kind: "system" }
    | {
        kind: "account";
        account: Account;
        credential: { kind: "session"; sessionId: string; csrfTokenHash: string }
          | { kind: "pat"; token: PersonalAccessToken };
      };
  const actors = new WeakMap<Request, ApiActor>();
  const requestActor = (c: Context): ApiActor =>
    actors.get(c.req.raw) ?? { kind: "system" };
  const challengeCookie = "harbor_auth_challenge";
  const sessionCookie = "harbor_session";
  const csrfCookie = "harbor_csrf";
  const githubStateCookie = "harbor_github_state";
  const cookieBase = {
    secure: auth.config.secureCookie,
    sameSite: "Lax" as const,
    path: "/",
  };
  const setSessionCookies = (c: Context, session: { sessionToken: string; csrfToken: string; expiresAt: number }) => {
    const maxAge = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1_000));
    setCookie(c, sessionCookie, session.sessionToken, { ...cookieBase, httpOnly: true, maxAge });
    setCookie(c, csrfCookie, session.csrfToken, { ...cookieBase, httpOnly: false, maxAge });
  };
  const clearSessionCookies = (c: Context) => {
    deleteCookie(c, sessionCookie, cookieBase);
    deleteCookie(c, csrfCookie, cookieBase);
  };
  const setGitHubStateCookie = (c: Context, state: string) => {
    setCookie(c, githubStateCookie, state, { ...cookieBase, httpOnly: true, maxAge: 600 });
  };
  const clearGitHubStateCookie = (c: Context) => deleteCookie(c, githubStateCookie, cookieBase);
  const githubFailurePath = (returnTo: string | null | undefined, message: string): string => {
    const fallback = returnTo?.startsWith("/settings") ? returnTo : "/login";
    const url = new URL(fallback, auth.config.origin);
    url.searchParams.set("github_error", message.slice(0, 300));
    return `${url.pathname}${url.search}`;
  };
  const bearer = (c: Context): string => {
    const value = c.req.header("Authorization") ?? "";
    return value.startsWith("Bearer ") ? value.slice(7) : "";
  };
  const requireBootstrapToken = (c: Context) => {
    if (bearer(c) !== expectedToken) throw new HTTPException(403, { message: "需要 system bootstrap token" });
  };

  // 调度冲突（已有 active Run、阶段不符、Reviewer 看不到 worktree）是可修正的请求错误，
  // 不应泄漏成 500。统一收口，保证 Web / CLI 都拿到可读的 400 提示。
  const enqueue = (...args: Parameters<RunCoordinator["enqueueRun"]>): Run => {
    try {
      return coordinator.enqueueRun(...args);
    } catch (error) {
      bad(error instanceof Error ? error.message : String(error));
    }
  };

  const currentWorkspace = (c: Context) => {
    const actor = requestActor(c);
    const memberships = actor.kind === "account"
      ? store.listMembershipsForAccount(actor.account.id)
      : [];
    const patWorkspace = actor.kind === "account" && actor.credential.kind === "pat"
      ? actor.credential.token.workspaceId
      : null;
    const key =
      c.req.header("X-Harbor-Workspace")?.trim() ||
      (actor.kind === "account"
        ? patWorkspace ?? memberships.find((membership) => store.getWorkspace(membership.workspaceId)?.kind === "personal")?.workspaceId ?? memberships[0]?.workspaceId
        : DEFAULT_WORKSPACE_ID);
    if (!key) throw new HTTPException(403, { message: "Account 没有 active Workspace Membership" });
    const workspace = store.resolveWorkspace(key);
    if (!workspace || workspace.archivedAt)
      bad(`workspace "${key}" 不存在或已归档`);
    if (actor.kind === "account" && !store.membershipForAccount(actor.account.id, workspace.id)) {
      throw new HTTPException(403, {
        message: "Account 不属于该 Workspace",
      });
    }
    if (patWorkspace && patWorkspace !== workspace.id) {
      throw new HTTPException(403, { message: "PAT 已绑定其他 Workspace" });
    }
    return workspace;
  };

  const currentMembership = (c: Context, workspaceId: string): WorkspaceMember | null => {
    const actor = requestActor(c);
    return actor.kind === "account" ? store.membershipForAccount(actor.account.id, workspaceId) : null;
  };

  const requestPrincipal = (c: Context, workspaceId: string): RunPrincipal => {
    const actor = requestActor(c);
    if (actor.kind === "system") {
      return { type: "system", id: null, membershipId: null, initiator: { kind: "system_token" } };
    }
    const membership = store.membershipForAccount(actor.account.id, workspaceId);
    if (!membership || membership.status !== "active") {
      throw new HTTPException(403, { message: "Account 没有当前 Workspace 的 active Membership" });
    }
    return {
      type: "account",
      id: actor.account.id,
      membershipId: membership.id,
      initiator: {
        kind: "api",
        credential: actor.credential.kind,
        accountId: actor.account.id,
        membershipId: membership.id,
      },
    };
  };

  const enqueueForRequest = (
    c: Context,
    ...args: Parameters<RunCoordinator["enqueueRun"]>
  ): Run => {
    const [conv, agent, prompt, purpose, promptEvent, triggerRef, options = {}] = args;
    return enqueue(conv, agent, prompt, purpose, promptEvent, triggerRef, {
      ...options,
      principal: requestPrincipal(c, conv.workspaceId),
    });
  };

  const requireRole = (
    c: Context,
    workspaceId: string,
    minimum: "member" | "admin" | "owner",
  ) => {
    const actor = requestActor(c);
    if (actor.kind === "system") return null;
    const member = store.membershipForAccount(actor.account.id, workspaceId);
    if (!member || member.status !== "active") {
      throw new HTTPException(403, { message: "Workspace 访问被拒绝" });
    }
    const rank: Record<WorkspaceRole, number> = {
      member: 1,
      admin: 2,
      owner: 3,
    };
    if (rank[member.role] < rank[minimum]) {
      throw new HTTPException(403, {
        message: `需要 ${minimum} 权限（当前 ${member.role}）`,
      });
    }
    return member;
  };

  const requireSystem = (c: Context) => {
    if (requestActor(c).kind !== "system") {
      throw new HTTPException(403, {
        message: "该操作只允许 Harbor server owner token",
      });
    }
  };

  const canSeeAgent = (
    c: Context,
    agent: NonNullable<ReturnType<HarborStore["getAgent"]>>,
  ) => {
    if (agent.visibility === "workspace") return true;
    const actor = requestActor(c);
    const member = actor.kind === "account"
      ? store.membershipForAccount(actor.account.id, agent.workspaceId)
      : null;
    return (
      actor.kind === "system" ||
      member?.role === "owner" ||
      member?.role === "admin" ||
      member?.id === agent.createdByMemberId
    );
  };
  const agentView = (
    agent: NonNullable<ReturnType<HarborStore["getAgent"]>>,
  ) => ({
    ...agent,
    // Environment value 是 secret；REST 永远只回 key 和掩码，真实值只在 server → daemon 下发。
    environment: Object.fromEntries(
      Object.keys(agent.environment).map((key) => [key, "••••••"]),
    ),
  });
  const appendRequestMessage = (
    c: Context,
    conversationId: string,
    body: string,
  ) => {
    const actor = requestActor(c);
    const conversation = store.getConversation(conversationId);
    const member = actor.kind === "account" && conversation
      ? store.membershipForAccount(actor.account.id, conversation.workspaceId)
      : null;
    return store.appendConversationMessage(
      conversationId,
      {
        authorType: member ? "member" : "system",
        authorId: member?.id ?? null,
        authorName: member?.name ?? "Local owner",
        body,
        externalId: null,
      },
      Date.now(),
    );
  };

  const scopedAgent = (
    c: Context,
    workspaceId: string,
    key: string | null | undefined,
  ) => {
    if (!key) return null;
    const agent =
      store.getAgent(key) ?? store.getAgentByNameInWorkspace(workspaceId, key);
    if (agent && agent.workspaceId !== workspaceId)
      bad(`agent "${key}" 不属于当前 Workspace`);
    if (agent && !canSeeAgent(c, agent))
      throw new HTTPException(404, { message: `agent "${key}" 不存在` });
    return agent;
  };

  const scopedRepository = (
    workspaceId: string,
    key: string | null | undefined,
  ) => {
    if (!key) return null;
    const repository = store.resolveRepository(workspaceId, key);
    if (!repository || repository.archivedAt)
      bad(`repository "${key}" 不存在或已归档`);
    return repository;
  };

  const assertConversationWorkspace = (workspaceId: string, id: string) => {
    const conversation = store.resolveConversationPrefix(id);
    if (!conversation)
      throw new HTTPException(404, { message: `conversation "${id}" 不存在` });
    if (conversation.workspaceId !== workspaceId)
      throw new HTTPException(404, {
        message: `conversation "${id}" 不存在于当前 Workspace`,
      });
    return conversation;
  };

  const assertRunWorkspace = (workspaceId: string, id: string) => {
    const run = store.resolveRunPrefix(id);
    if (!run || run.workspaceId !== workspaceId)
      throw new HTTPException(404, {
        message: `run "${id}" 不存在于当前 Workspace`,
      });
    return run;
  };

  const assertDeliveryWorkspace = (workspaceId: string, id: string) => {
    const delivery = store.getDelivery(id);
    const conversation = delivery
      ? store.getConversation(delivery.conversationId)
      : null;
    if (!delivery || conversation?.workspaceId !== workspaceId) {
      throw new HTTPException(404, {
        message: `delivery "${id}" 不存在于当前 Workspace`,
      });
    }
    return { delivery, conversation };
  };

  const deliveryAction = async <T>(
    action: () => T | Promise<T>,
  ): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      bad(error instanceof Error ? error.message : String(error));
    }
  };

  const finalizeDelivery = (delivery: Delivery): void => {
    if (!deliveries.isComplete(delivery)) return;
    const conv = store.getConversation(delivery.conversationId);
    if (
      !conv ||
      conv.kind !== "issue" ||
      conv.status === "done" ||
      conv.status === "canceled"
    )
      return;
    transitionConversation(store, conv, "done", "system", Date.now());
    coordinator.requestWorktreeCleanup(store.getConversation(conv.id)!);
  };

  app.onError((err, c) => {
    if (err instanceof HTTPException)
      return c.json({ error: err.message }, err.status);
    console.error("[rest]", err);
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  });

  /** Codebase 独立入口：Repository id 定作用域，独立 secret 定授权，event id 定幂等。 */
  app.post("/hooks/scm/codebase/:repositoryId", async (c) => {
    if (!scm || !codebaseWebhookSecret)
      return c.json({ error: "not found" }, 404);
    const authorization = c.req.header("authorization") ?? "";
    const secret =
      c.req.header("x-harbor-webhook-secret") ??
      c.req.header("x-codebase-token") ??
      (authorization.startsWith("Bearer ") ? authorization.slice(7) : "");
    if (!safeSecretEqual(secret, codebaseWebhookSecret))
      return c.json({ error: "webhook secret 不正确" }, 401);
    const contentLength = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > 512 * 1024) {
      return c.json({ error: "webhook payload 超过 512KB" }, 413);
    }
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: "webhook body 必须是 JSON object" }, 400);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return c.json({ error: "webhook body 必须是 JSON object" }, 400);
    }
    const eventType =
      c.req.header("x-codebase-event") ??
      c.req.header("x-harbor-event") ??
      String(
        (payload as Record<string, unknown>).event_type ??
          (payload as Record<string, unknown>).event ??
          "unknown",
      );
    const eventId =
      c.req.header("x-codebase-delivery") ??
      c.req.header("x-harbor-delivery") ??
      c.req.header("x-request-id") ??
      null;
    try {
      const result = scm.receiveCodebase(c.req.param("repositoryId"), {
        eventId,
        eventType,
        payload: payload as Record<string, unknown>,
      });
      return c.json(result, result.status === "applied" ? 202 : 200);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/不存在|未启用/.test(message)) return c.json({ error: message }, 404);
      return c.json({ error: message }, 400);
    }
  });

  /** GitHub App 全局 webhook：installation + repository id 定位显式 Workspace connection。 */
  app.post("/hooks/github/app", async (c) => {
    if (!githubWebhookSecret) return c.json({ error: "not found" }, 404);
    const declaredLength = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > 512 * 1024) {
      return c.json({ error: "webhook payload 超过 512KB" }, 413);
    }
    const rawBody = await c.req.text();
    if (Buffer.byteLength(rawBody, "utf8") > 512 * 1024) {
      return c.json({ error: "webhook payload 超过 512KB" }, 413);
    }
    if (!safeGitHubSignatureEqual(
      rawBody,
      c.req.header("x-hub-signature-256") ?? "",
      githubWebhookSecret,
    )) {
      return c.json({ error: "GitHub webhook signature 不正确" }, 401);
    }
    const githubEvent = (c.req.header("x-github-event") ?? "").trim().toLowerCase();
    const deliveryId = (c.req.header("x-github-delivery") ?? "").trim();
    if (!githubEvent || !/^[A-Za-z0-9._:-]{1,256}$/.test(deliveryId)) {
      return c.json({ error: "GitHub event/delivery header 缺失或格式不正确" }, 400);
    }
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawBody) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      payload = parsed as Record<string, unknown>;
    } catch {
      return c.json({ error: "webhook body 必须是 JSON object" }, 400);
    }
    if (githubEvent === "ping") {
      return c.json({ status: "pong" });
    }
    const installationId = githubNumericId(objectField(payload.installation, "id"));
    if (!installationId) {
      return c.json({ error: "GitHub App webhook 缺少 installation.id" }, 400);
    }
    const installation = store.getGitHubInstallation(installationId);
    if (!installation) {
      return c.json({ status: "ignored", reason: "installation_not_connected" });
    }
    const deliveredAppId = githubNumericId(objectField(payload.installation, "app_id"));
    if (deliveredAppId && deliveredAppId !== installation.appId) {
      return c.json({ error: "GitHub webhook installation 不属于当前 Harbor App" }, 400);
    }
    const action = typeof payload.action === "string" ? payload.action : "";
    if (githubEvent === "installation") {
      const status = action === "deleted"
        ? "deleted"
        : action === "suspend"
          ? "suspended"
          : action === "unsuspend"
            ? "active"
            : null;
      if (!status) return c.json({ status: "ignored", event: githubEvent, action });
      store.setGitHubInstallationStatus(installationId, status, Date.now());
      if (status !== "active") githubIntegration?.client.clearInstallationToken(installationId);
      return c.json({ status: "processed", event: githubEvent, action });
    }
    if (githubEvent === "installation_repositories" || githubEvent === "repository") {
      if (!githubIntegration) return c.json({ error: "GitHub App integration 未配置" }, 503);
      try {
        const results = await Promise.all(
          store.listGitHubWorkspacesForInstallation(installationId)
            .filter((connection) => connection.status === "active")
            .map((connection) => githubIntegration.syncInstallation(connection.workspaceId, installationId)),
        );
        return c.json({ status: "processed", event: githubEvent, results });
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
      }
    }
    const githubRepositoryId = githubNumericId(objectField(payload.repository, "id"));
    const deliveredName = stringField(payload.repository, "full_name")?.toLowerCase() ?? null;
    if (!githubRepositoryId || !deliveredName) {
      return c.json({ error: "GitHub App webhook 缺少 repository.id/full_name" }, 400);
    }
    const connections = store.githubConnectionsForWebhook(installationId, githubRepositoryId);
    if (connections.length === 0) {
      return c.json({ status: "ignored", reason: "repository_not_connected" });
    }
    if (connections.some((connection) => connection.fullName !== deliveredName)) {
      return c.json({ error: "GitHub payload Repository 与 Harbor connection 不匹配" }, 400);
    }
    let normalized;
    try {
      normalized = githubAutomationEvent(githubEvent, payload);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
    if (!normalized) return c.json({ status: "ignored", event: githubEvent });
    try {
      const snapshot = await maintenance.current();
      if (snapshot.active) {
        c.header("Retry-After", "5");
        return c.json({ error: "Harbor 正处于 deployment maintenance" }, 503);
      }
    } catch {
      c.header("Retry-After", "5");
      return c.json({ error: "deployment maintenance state 不可判定" }, 503);
    }
    const results = connections.flatMap((connection) => automations.receiveCodebase({
      workspaceId: connection.workspaceId,
      repositoryId: connection.repositoryId,
      eventType: normalized.eventType,
      eventId: `github:${deliveryId}`,
      payload,
      revision: normalized.revision,
      occurredAt: normalized.occurredAt,
    }));
    return c.json({ status: results.some((result) => result.status === "started") ? "accepted" : "processed", results },
      results.some((result) => result.status === "started") ? 202 : 200);
  });

  const runForRawActionToken = (raw: string): Run => {
    if (!raw || raw.length > 512) {
      throw new HTTPException(401, { message: "run action token 不正确" });
    }
    const run = store.runForActionToken(
      createHash("sha256").update(raw).digest("hex"),
      Date.now(),
    );
    if (!run || run.status !== "running") {
      throw new HTTPException(401, { message: "run action token 已失效" });
    }
    return run;
  };

  const runActionContext = (c: Context) => {
    const authorization = c.req.header("authorization") ?? "";
    const raw = authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";
    const run = runForRawActionToken(raw);
    const agent = store.getAgent(run.agentId);
    if (!agent || agent.workspaceId !== run.workspaceId) {
      throw new HTTPException(409, { message: "run agent 不存在" });
    }
    const conversation = run.conversationId
      ? store.getConversation(run.conversationId)
      : null;
    return { run, agent, conversation };
  };

  /** daemon-only credential handoff；GitHub token 从不返回给 Agent action credential。 */
  app.post("/hooks/daemon-actions/git/push-credential", async (c) => {
    requireBootstrapToken(c);
    if (!githubCredentials) return c.json({ error: "GitHub credential broker 未配置" }, 503);
    const body = await c.req.json() as { runActionToken?: string; forceRefresh?: boolean };
    const run = runForRawActionToken(body.runActionToken ?? "");
    if (run.purpose !== "implementation" || !run.conversationId || !run.repositoryId) {
      return c.json({ error: "只有 Repository Issue 的 implementation Run 可以请求 git push credential" }, 403);
    }
    const conversation = store.getConversation(run.conversationId);
    const repository = store.getRepository(run.repositoryId);
    if (!conversation || conversation.kind !== "issue" || conversation.repositoryId !== repository?.id) {
      return c.json({ error: "Run 的 Issue/Repository 绑定无效" }, 409);
    }
    const connection = store.githubRepositoryConnectionForRepository(repository.id);
    if (!connection || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(connection.fullName)) {
      return c.json({ error: "Repository 没有可信 GitHub connection" }, 409);
    }
    try {
      const token = await githubCredentials.tokenForRepository(repository, run.principal, body.forceRefresh === true);
      c.header("Cache-Control", "no-store");
      return c.json({
        token,
        remoteUrl: `https://github.com/${connection.fullName}.git`,
        refspec: `HEAD:refs/heads/harbor/${conversation.id}`,
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 403);
    }
  });

  /** Run-scoped 只读快照：给用户自定义的 routing Agent 足够信息，但不泄露凭证/环境/指令。 */
  app.get("/hooks/agent-actions/context", (c) => {
    const { run, agent, conversation } = runActionContext(c);
    const repository = run.repositoryId ? store.getRepository(run.repositoryId) : null;
    const delivery = conversation ? store.getDeliveryForConversation(conversation.id) : null;
    const agents = store.listAgents(false, run.workspaceId)
      .filter((candidate) => !candidate.archivedAt)
      .map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        description: candidate.description,
        deviceId: candidate.deviceId,
        backend: candidate.backend,
        repositoryIds: candidate.repositoryIds,
      }));
    const sourceRuns = store.listRunsBySource(run.sourceType, run.sourceId).map((candidate) => ({
      id: candidate.id,
      parentRunId: candidate.parentRunId,
      rootRunId: candidate.rootRunId,
      dispatchDepth: candidate.dispatchDepth,
      agentId: candidate.agentId,
      deviceId: candidate.deviceId,
      purpose: candidate.purpose,
      status: candidate.status,
      queuedAt: candidate.queuedAt,
      finishedAt: candidate.finishedAt,
      error: candidate.error,
    }));
    return c.json({
      run: {
        id: run.id,
        rootRunId: run.rootRunId,
        parentRunId: run.parentRunId,
        dispatchDepth: run.dispatchDepth,
        sourceType: run.sourceType,
        sourceId: run.sourceId,
        purpose: run.purpose,
        status: run.status,
        repositoryId: run.repositoryId,
        reviewCheckout: run.reviewCheckout,
      },
      agent: { id: agent.id, name: agent.name, deviceId: agent.deviceId, backend: agent.backend },
      conversation: conversation ? {
        id: conversation.id,
        kind: conversation.kind,
        title: conversation.title,
        description: conversation.description,
        priority: conversation.priority,
        status: conversation.status,
        agentId: conversation.agentId,
        repositoryId: conversation.repositoryId,
        origin: conversation.origin,
        originRef: conversation.originRef,
        ownerMemberId: conversation.ownerMemberId,
        labelIds: conversation.labelIds,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
      } : null,
      delivery,
      repository: repository ? {
        id: repository.id,
        name: repository.name,
        defaultBranch: repository.defaultBranch,
        scmProvider: repository.scmProvider,
      } : null,
      agents,
      sourceRuns,
      limits: { maxDispatchDepth: RunCoordinator.MAX_DISPATCH_DEPTH },
    });
  });

  /**
   * Release Agent 唯一可用的 Harbor 自部署动作。Agent 只提交 trusted exact revision；
   * target、路径、命令、health 与 rollback policy 全由 Harbor host 管理员冻结。
   */
  app.post("/hooks/agent-actions/self-deployments", async (c) => {
    const { run } = runActionContext(c);
    if (!selfDeployTarget) return c.json({ error: "Harbor self-deployer 未配置" }, 503);
    let body: Record<string, unknown>;
    try {
      const parsed = await c.req.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      body = parsed as Record<string, unknown>;
    } catch {
      return c.json({ error: "body 必须是 JSON object" }, 400);
    }
    rejectUnknownFields(body, ["revision", "idempotencyKey"]);
    const revision = typeof body.revision === "string" ? body.revision.trim().toLowerCase() : "";
    const requestKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
    if (!/^[a-f0-9]{40,64}$/.test(revision)) return c.json({ error: "revision 必须是完整十六进制 commit id" }, 400);
    if (!requestKey || requestKey.length > 128) return c.json({ error: "idempotencyKey 需要 1–128 字符" }, 400);
    const contextRevision = typeof run.triggerContext.revision === "string"
      ? run.triggerContext.revision.toLowerCase()
      : "";
    if (run.sourceType !== "automation" || run.purpose !== "coordination"
      || run.triggerContext.eventType !== "merge_request_merged") {
      return c.json({ error: "只有 merge_request_merged Codebase Automation Run 可以触发 Harbor self deployment" }, 403);
    }
    if (!run.repositoryId || run.repositoryId !== selfDeployTarget.repositoryId
      || run.triggerContext.repositoryId !== run.repositoryId) {
      return c.json({ error: "Automation/Run/self-deploy Repository identity 不匹配" }, 403);
    }
    if (!contextRevision || revision !== contextRevision) {
      return c.json({ error: "revision 必须与 Codebase merged commit 完全一致" }, 409);
    }
    try {
      const result = store.enqueueDeploymentJob(
        run.id,
        requestKey,
        run.repositoryId,
        selfDeployTarget.id,
        revision,
        selfDeployTarget.fingerprint,
        selfDeployTarget.manifestHash,
        Date.now(),
      );
      return c.json({ job: store.getDeploymentJobView(result.job.id), reused: !result.created }, result.created ? 202 : 200);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });

  app.get("/hooks/agent-actions/self-deployments/:id", (c) => {
    const { run } = runActionContext(c);
    const job = store.getDeploymentJob(c.req.param("id"));
    if (!job || job.sourceRunId !== run.id) return c.json({ error: "self deployment job 不存在" }, 404);
    return c.json(store.getDeploymentJobView(job.id));
  });

  /** 用户/Skill 明确给出目标 Agent；Harbor 只做 scope、mount、purpose、lineage 和幂等校验。 */
  app.post("/hooks/agent-actions/dispatch", async (c) => {
    const { run } = runActionContext(c);
    const body = (await c.req.json()) as {
      agent?: string;
      purpose?: RunPurpose;
      prompt?: string;
      idempotencyKey?: string;
    };
    const prompt = body.prompt?.trim() ?? "";
    const key = body.idempotencyKey?.trim() ?? "";
    if (!body.agent?.trim()) return c.json({ error: "缺少目标 agent id/name" }, 400);
    if (!prompt || prompt.length > 128 * 1024) return c.json({ error: "prompt 需要 1–128KB" }, 400);
    if (!key || key.length > 128) return c.json({ error: "idempotencyKey 需要 1–128 字符" }, 400);
    const purpose = body.purpose ?? "implementation";
    if (!RUN_PURPOSES.includes(purpose) || purpose === "triage") {
      return c.json({ error: `purpose 可选 ${RUN_PURPOSES.filter((value) => value !== "triage").join("/")}` }, 400);
    }
    const target = store.getAgent(body.agent) ?? store.getAgentByNameInWorkspace(run.workspaceId, body.agent);
    if (!target || target.workspaceId !== run.workspaceId || target.archivedAt) {
      return c.json({ error: `目标 Agent "${body.agent}" 不存在或已归档` }, 400);
    }
    const existing = store.getRunByDispatchKey(run.rootRunId, key);
    try {
      const child = coordinator.enqueueChildRun(run, target, prompt, purpose, key);
      return c.json({ run: child, reused: existing?.id === child.id }, existing ? 200 : 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  /**
   * Run-scoped control-plane action：创建同 Workspace Issue，可受控指派并立即派给目标 Agent。
   * 不复用 HARBOR_TOKEN；目标 Repository 仍完全由目标 Agent 决定。
   */
  app.post("/hooks/agent-actions/issues", async (c) => {
    const now = Date.now();
    const { run, agent, conversation: parent } = runActionContext(c);
    const body = (await c.req.json()) as {
      title?: string;
      description?: string;
      priority?: IssuePriority;
      assignee?: string;
      dispatch?: boolean;
      prompt?: string;
      labels?: unknown;
    };
    const title = body.title?.trim() ?? "";
    const description = body.description?.trim() ?? "";
    if (!title || title.length > 160)
      return c.json({ error: "title 需要 1–160 字符" }, 400);
    if (description.length > 64 * 1024)
      return c.json({ error: "description 不能超过 64KB" }, 400);
    if (
      body.priority !== undefined &&
      !ISSUE_PRIORITIES.includes(body.priority)
    ) {
      return c.json(
        { error: `priority 可选 ${ISSUE_PRIORITIES.join("/")}` },
        400,
      );
    }
    let assignee = null;
    if (body.assignee === "self") assignee = agent;
    else if (body.assignee && body.assignee !== "unassigned") {
      assignee =
        store.getAgent(body.assignee) ??
        store.getAgentByNameInWorkspace(run.workspaceId, body.assignee);
      if (!assignee || assignee.workspaceId !== run.workspaceId || assignee.archivedAt) {
        return c.json({ error: `assignee "${body.assignee}" 不存在或已归档` }, 400);
      }
    }
    if (body.dispatch === true && !assignee) {
      return c.json({ error: "dispatch=true 需要 assignee=self 或目标 Agent id/name" }, 400);
    }
    if (
      body.labels !== undefined &&
      (!Array.isArray(body.labels) ||
        body.labels.some((label) => typeof label !== "string"))
    ) {
      return c.json({ error: "labels 需要是现有 label name 数组" }, 400);
    }
    const labelsByName = new Map(
      store
        .listIssueLabels(run.workspaceId)
        .map((label) => [label.name, label]),
    );
    const requestedLabels = [
      ...new Set((body.labels as string[] | undefined) ?? []),
    ];
    const unknownLabels = requestedLabels.filter(
      (name) => !labelsByName.has(name),
    );
    if (unknownLabels.length)
      return c.json(
        { error: `label 不存在：${unknownLabels.join(", ")}` },
        400,
      );
    const issue = store.createConversation(
      {
        workspaceId: run.workspaceId,
        kind: "issue",
        title,
        description: description || null,
        priority: body.priority ?? "medium",
        agentId: assignee?.id ?? null,
        repositoryId: assignee?.repositoryId ?? null,
        origin: "agent",
        originRef: `run:${run.id}`,
        ownerMemberId: parent?.ownerMemberId ?? null,
        labelIds: requestedLabels.map((name) => labelsByName.get(name)!.id),
      },
      now,
    );
    store.appendConversationMessage(
      issue.id,
      {
        authorType: "agent",
        authorId: agent.id,
        authorName: agent.name,
        body: `Created as follow-up from run ${run.id}${parent ? ` on ${parent.id}` : ""}.`,
        externalId: null,
      },
      now,
    );
    if (parent) {
      store.appendConversationMessage(
        parent.id,
        {
          authorType: "agent",
          authorId: agent.id,
          authorName: agent.name,
          body: `Created follow-up Issue ${issue.id}: ${issue.title}`,
          externalId: null,
        },
        now,
      );
    }
    if (body.dispatch === true && assignee) {
      const prompt = body.prompt?.trim() || description || title;
      const dispatched = coordinator.enqueueRun(issue, assignee, prompt, "implementation", undefined, run.id, {
        principal: run.principal,
      });
      return c.json({ issue: store.getConversation(issue.id), run: dispatched }, 201);
    }
    return c.json(issue, 201);
  });

  /** implementation Agent：给当前 Issue 的固定 branch 创建/注册 Delivery。 */
  app.post("/hooks/agent-actions/deliveries", async (c) => {
    const now = Date.now();
    const { run, conversation } = runActionContext(c);
    if (!conversation) return c.json({ error: "当前 Run 没有 Conversation" }, 400);
    const body = (await c.req.json()) as {
      provider?: DeliveryProviderKind;
      changeUrl?: string;
      externalId?: string;
      headBranch?: string;
      baseBranch?: string;
      title?: string;
      body?: string;
    };
    if (body.provider && !["manual", "github", "codebase"].includes(body.provider)) {
      return c.json({ error: "provider 可选 manual/github/codebase" }, 400);
    }
    validateDeliveryUrl(body.changeUrl);
    try {
      const delivery = await deliveries.createFromImplementationRun(
        run,
        conversation,
        {
          provider: body.provider,
          changeUrl: body.changeUrl,
          externalId: body.externalId,
          headBranch: body.headBranch,
          baseBranch: body.baseBranch,
          title: body.title?.trim() || conversation.title || `Implement ${conversation.id}`,
          body: body.body?.trim() || conversation.description || "",
        },
        now,
      );
      return c.json(delivery, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  /** review Agent：只能对当前 Review Run 的 Delivery 做 approve/request-changes，并由 policy 决定能否 merge。 */
  app.post("/hooks/agent-actions/reviews", async (c) => {
    const now = Date.now();
    const { run, agent, conversation } = runActionContext(c);
    if (!conversation || conversation.kind !== "issue" || run.purpose !== "review") {
      return c.json({ error: "只有当前 Issue 的 review Run 可以提交 review decision" }, 400);
    }
    const body = (await c.req.json()) as {
      decision?: "approve" | "request_changes";
      feedback?: string;
      merge?: boolean;
      developer?: string;
    };
    if (body.decision !== "approve" && body.decision !== "request_changes") {
      return c.json({ error: "decision 可选 approve/request_changes" }, 400);
    }
    const feedback = body.feedback?.trim() ?? "";
    if (feedback.length > 64 * 1024) return c.json({ error: "feedback 不能超过 64KB" }, 400);
    if (feedback) {
      store.appendConversationMessage(conversation.id, {
        authorType: "agent",
        authorId: agent.id,
        authorName: agent.name,
        body: feedback,
        externalId: null,
      }, now);
    }

    if (body.decision === "request_changes") {
      const developer = body.developer
        ? store.getAgent(body.developer) ?? store.getAgentByNameInWorkspace(run.workspaceId, body.developer)
        : conversation.agentId
          ? store.getAgent(conversation.agentId)
          : null;
      if (!developer || developer.workspaceId !== run.workspaceId || developer.archivedAt) {
        return c.json({ error: "找不到可用的 Developer Agent" }, 400);
      }
      if (developer.id === agent.id) {
        return c.json({ error: "request_changes 必须派给独立的 Developer Agent" }, 400);
      }
      try {
        const next = coordinator.enqueueRun(
          conversation,
          developer,
          feedback || "Review 发现阻塞问题，请检查 review 结果并完成修复。",
          "implementation",
          undefined,
          run.id,
          {
            allowQueuedBehindConversation: true,
            concurrencyKey: `conversation:${conversation.id}`,
            principal: run.principal,
          },
        );
        return c.json({ decision: "request_changes", run: next }, 201);
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }

    let delivery = store.getDeliveryForConversation(conversation.id);
    if (!delivery) return c.json({ error: "当前 Issue 尚未注册 PR/MR Delivery" }, 400);
    try {
      if (delivery.provider === "github") {
        delivery = await deliveries.sync(delivery, conversation, now, run.id, run.principal);
      } else if (delivery.provider === "codebase") {
        delivery = await deliveries.refresh(delivery, now, run.principal);
      }
      if (
        run.reviewCheckout &&
        delivery.latestHeadSha?.toLowerCase() !== run.reviewCheckout.revision.toLowerCase()
      ) {
        return c.json({
          error: `Delivery head 已变化；本 Run 审查的是 ${run.reviewCheckout.revision}，当前为 ${delivery.latestHeadSha ?? "unknown"}`,
        }, 409);
      }
      delivery = deliveries.approve(delivery, conversation, now, run.id, "agent");
      let mergeDeferred: string | null = null;
      if (body.merge !== false) {
        if (delivery.provider === "manual") {
          mergeDeferred = "manual provider 不能由 Agent 伪造外部合并事实";
        } else if (delivery.checkStatus !== "passed") {
          mergeDeferred = `CI checks=${delivery.checkStatus}，保留 approval，等待 checks 通过后再合并`;
        } else {
          delivery = await deliveries.merge(
            delivery,
            conversation,
            { confirmed: delivery.provider === "codebase" },
            now,
            run.id,
            run.principal,
          );
        }
      }
      return c.json({ decision: "approve", delivery, mergeDeferred });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.use("*", async (c, next) => {
    let snapshot;
    try {
      snapshot = await maintenance.current();
    } catch {
      return c.json({ error: "deployment maintenance state 不可判定；Harbor 已 fail-closed" }, 503);
    }
    if (!snapshot.active) return next();
    const url = new URL(c.req.url);
    if (url.pathname === "/api/health" && matchesRevisionAwareHealth(url, snapshot)) return next();
    return c.json({
      error: "Harbor 正处于 deployment maintenance；仅允许 exact revision health probe",
      deploymentJobId: snapshot.gate?.jobId ?? null,
      phase: snapshot.gate?.phase ?? "ambiguous",
    }, 503);
  });

  // Auth ceremony endpoints 必须先于通用 /api bearer/session middleware 注册。
  // challenge cookie HttpOnly + DB 单次消费；Passkey RP/origin 只来自 HARBOR_PUBLIC_URL。
  app.get("/api/auth/bootstrap/status", (c) => c.json(auth.bootstrapState()));

  app.get("/api/auth/github/status", (c) => c.json(githubIntegration
    ? { configured: true, appSlug: githubIntegration.client.config.slug }
    : { configured: false }));

  app.post("/api/auth/github/login", async (c) => {
    if (!githubIntegration) return c.json({ error: "GitHub App 登录未配置" }, 503);
    try {
      const body = await c.req.json().catch(() => ({})) as { invitationToken?: string };
      const started = githubIntegration.beginLogin(body.invitationToken);
      setGitHubStateCookie(c, started.state);
      return c.json({ url: started.url });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.get("/api/auth/github/setup", (c) => {
    if (!githubIntegration) return c.json({ error: "GitHub App installation 未配置" }, 503);
    const state = c.req.query("state") ?? "";
    const installationId = c.req.query("installation_id") ?? "";
    const action = c.req.query("setup_action") ?? "";
    if (!safeSecretEqual(state, getCookie(c, githubStateCookie) ?? "")) {
      clearGitHubStateCookie(c);
      return c.redirect(githubFailurePath("/settings?tab=integrations", "GitHub setup state cookie 不匹配"));
    }
    if (!/^[1-9][0-9]*$/.test(installationId) || !["install", "update"].includes(action)) {
      clearGitHubStateCookie(c);
      return c.redirect(githubFailurePath("/settings?tab=integrations", "GitHub setup 回调参数不正确"));
    }
    try {
      return c.redirect(githubIntegration.continueInstallation(state, installationId));
    } catch (error) {
      clearGitHubStateCookie(c);
      return c.redirect(githubFailurePath("/settings?tab=integrations", error instanceof Error ? error.message : String(error)));
    }
  });

  app.get("/api/auth/github/callback", async (c) => {
    if (!githubIntegration) return c.json({ error: "GitHub App OAuth 未配置" }, 503);
    const state = c.req.query("state") ?? "";
    const stored = /^[A-Za-z0-9_-]{16,512}$/.test(state)
      ? store.githubOAuthState(createHash("sha256").update(state).digest("hex"), Date.now())
      : null;
    if (!safeSecretEqual(state, getCookie(c, githubStateCookie) ?? "")) {
      clearGitHubStateCookie(c);
      return c.redirect(githubFailurePath(stored?.returnTo, "GitHub OAuth state cookie 不匹配"));
    }
    const githubError = c.req.query("error");
    const code = c.req.query("code") ?? "";
    if (githubError || !code) {
      clearGitHubStateCookie(c);
      return c.redirect(githubFailurePath(stored?.returnTo, githubError ? `GitHub OAuth 已取消：${githubError}` : "GitHub OAuth code 缺失"));
    }
    try {
      const completed = await githubIntegration.complete(state, code);
      if (completed.personalWorkspace) ensureBuiltinHarborSkill(store, completed.personalWorkspace.id, Date.now());
      setSessionCookies(c, completed.session);
      clearGitHubStateCookie(c);
      return c.redirect(completed.returnTo);
    } catch (error) {
      clearGitHubStateCookie(c);
      return c.redirect(githubFailurePath(stored?.returnTo, error instanceof Error ? error.message : String(error)));
    }
  });

  app.post("/api/auth/bootstrap/options", async (c) => {
    requireBootstrapToken(c);
    try {
      const body = await c.req.json().catch(() => ({})) as { displayName?: string };
      const started = await auth.beginRegistration({ flow: "bootstrap", displayName: body.displayName });
      setCookie(c, challengeCookie, started.challengeToken, {
        ...cookieBase, httpOnly: true, maxAge: 300,
      });
      return c.json(started.options);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.post("/api/auth/bootstrap/verify", async (c) => {
    requireBootstrapToken(c);
    const challengeToken = getCookie(c, challengeCookie);
    if (!challengeToken) return c.json({ error: "bootstrap challenge cookie 缺失" }, 400);
    try {
      const body = await c.req.json() as { response?: RegistrationResponseJSON; label?: string };
      if (!body.response) return c.json({ error: "缺少 Passkey response" }, 400);
      const completed = await auth.finishRegistration({
        flow: "bootstrap",
        challengeToken,
        response: body.response,
        label: body.label,
      });
      if (!completed.session) throw new Error("bootstrap 未创建 Session");
      deleteCookie(c, challengeCookie, cookieBase);
      setSessionCookies(c, completed.session);
      return c.json({ account: completed.account, recoveryCodes: completed.recoveryCodes, csrfToken: completed.session.csrfToken });
    } catch (error) {
      deleteCookie(c, challengeCookie, cookieBase);
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.post("/api/auth/login/options", async (c) => {
    try {
      const started = await auth.beginAuthentication();
      setCookie(c, challengeCookie, started.challengeToken, {
        ...cookieBase, httpOnly: true, maxAge: 300,
      });
      return c.json(started.options);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.post("/api/auth/login/verify", async (c) => {
    const challengeToken = getCookie(c, challengeCookie);
    if (!challengeToken) return c.json({ error: "login challenge cookie 缺失" }, 400);
    try {
      const body = await c.req.json() as { response?: AuthenticationResponseJSON };
      if (!body.response) return c.json({ error: "缺少 Passkey response" }, 400);
      const completed = await auth.finishAuthentication({ challengeToken, response: body.response });
      deleteCookie(c, challengeCookie, cookieBase);
      setSessionCookies(c, completed.session);
      return c.json({ account: completed.account, csrfToken: completed.session.csrfToken });
    } catch (error) {
      deleteCookie(c, challengeCookie, cookieBase);
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 401);
    }
  });

  app.post("/api/auth/invitation/options", async (c) => {
    try {
      const body = await c.req.json() as { token?: string; displayName?: string };
      if (!body.token || !body.displayName?.trim()) return c.json({ error: "缺少 Invitation token/displayName" }, 400);
      const started = await auth.beginInvitationRegistration({
        invitationToken: body.token,
        displayName: body.displayName,
      });
      setCookie(c, challengeCookie, started.challengeToken, {
        ...cookieBase, httpOnly: true, maxAge: 300,
      });
      return c.json(started.options);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.post("/api/auth/invitation/verify", async (c) => {
    const challengeToken = getCookie(c, challengeCookie);
    if (!challengeToken) return c.json({ error: "Invitation registration challenge cookie 缺失" }, 400);
    try {
      const body = await c.req.json() as { response?: RegistrationResponseJSON; label?: string };
      if (!body.response) return c.json({ error: "缺少 Passkey response" }, 400);
      const now = Date.now();
      const completed = await auth.finishInvitationRegistration({
        challengeToken,
        response: body.response,
        label: body.label,
      }, now);
      ensureBuiltinHarborSkill(store, completed.personalWorkspace.id, now);
      deleteCookie(c, challengeCookie, cookieBase);
      setSessionCookies(c, completed.session);
      return c.json({
        account: completed.account,
        membership: completed.membership,
        personalWorkspace: completed.personalWorkspace,
        recoveryCodes: completed.recoveryCodes,
        csrfToken: completed.session.csrfToken,
      });
    } catch (error) {
      deleteCookie(c, challengeCookie, cookieBase);
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.post("/api/auth/recovery", async (c) => {
    try {
      const body = await c.req.json() as { accountId?: string; code?: string };
      if (!body.accountId || !body.code) return c.json({ error: "缺少 accountId/code" }, 400);
      const completed = auth.recover(body.accountId, body.code);
      setSessionCookies(c, completed.session);
      return c.json({ account: completed.account, csrfToken: completed.session.csrfToken });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 401);
    }
  });

  app.use("/api/*", async (c, next) => {
    const raw = bearer(c);
    if (raw === expectedToken) {
      actors.set(c.req.raw, { kind: "system" });
    } else {
      const pat = raw ? auth.pat(raw) : null;
      if (pat) {
        actors.set(c.req.raw, { kind: "account", account: pat.account, credential: { kind: "pat", token: pat.token } });
      } else {
        const rawSession = getCookie(c, sessionCookie);
        const session = rawSession ? auth.session(rawSession) : null;
        if (session) {
          actors.set(c.req.raw, {
            kind: "account",
            account: session.account,
            credential: { kind: "session", sessionId: session.sessionId, csrfTokenHash: session.csrfTokenHash },
          });
        }
      }
    }
    if (!actors.has(c.req.raw)) {
      return c.json(
        { error: "unauthorized（Passkey Session、PAT 或 system break-glass token）" },
        401,
      );
    }
    const actor = requestActor(c);
    if (actor.kind === "account" && actor.credential.kind === "session" && !["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      const origin = c.req.header("Origin");
      const headerCsrf = c.req.header("X-Harbor-CSRF") ?? "";
      const cookieCsrf = getCookie(c, csrfCookie) ?? "";
      if (origin !== auth.config.origin || !headerCsrf || headerCsrf !== cookieCsrf || !auth.verifyCsrf(actor.credential.csrfTokenHash, headerCsrf)) {
        return c.json({ error: "CSRF/Origin 校验失败" }, 403);
      }
    }
    if (actor.kind === "account" && actor.credential.kind === "pat") {
      const path = new URL(c.req.url).pathname;
      const required: PersonalAccessTokenScope = c.req.method === "GET" || c.req.method === "HEAD"
        ? "workspace:read"
        : path.startsWith("/api/agents")
          ? "agent:manage"
          : path.includes("/dispatch") || path.includes("/continue") || path.startsWith("/api/chats") || path.startsWith("/api/issues")
            ? "agent:run"
            : path.startsWith("/api/devices") || path.includes("/mount")
              ? "device:manage"
              : "workspace:write";
      if (!actor.credential.token.scopes.includes(required)) {
        return c.json({ error: `PAT 缺少 scope ${required}` }, 403);
      }
    }
    await next();
  });

  app.get("/api/health", async (c) => {
    const snapshot = await maintenance.current();
    return c.json({
      ok: true,
      revision: snapshot.runtimeRevision,
      targetFingerprint: snapshot.runtimeFingerprint,
      deploymentJobId: snapshot.gate?.jobId ?? null,
      maintenance: snapshot.active,
    });
  });

  app.get("/api/me", (c) => {
    const actor = requestActor(c);
    if (actor.kind === "system")
      return c.json({ kind: "system", role: "owner" });
    return c.json({
      kind: "account",
      account: actor.account,
      memberships: store.listMembershipsForAccount(actor.account.id),
      credential: actor.credential.kind,
    });
  });

  app.get("/api/members", (c) => {
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "member");
    return c.json(store.listWorkspaceMembers(workspace.id));
  });

  app.post("/api/members", async (c) => {
    return c.json({ error: "成员必须通过 Invitation 加入；请使用 POST /api/invitations" }, 410);
  });

  app.patch("/api/members/:id", async (c) => {
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    const member = store.getWorkspaceMember(c.req.param("id"));
    if (!member || member.workspaceId !== workspace.id)
      throw new HTTPException(404, { message: "member 不存在" });
    const b = (await c.req.json()) as {
      role?: WorkspaceRole;
      status?: WorkspaceMember["status"];
    };
    if (b.role !== undefined && !["owner", "admin", "member"].includes(b.role))
      bad("role 可选 owner/admin/member");
    if (
      b.status !== undefined &&
      !["active", "disabled"].includes(b.status)
    )
      bad("status 可选 active/disabled");
    const removesOwner =
      member.role === "owner" &&
      ((b.role && b.role !== "owner") || (b.status && b.status !== "active"));
    if (b.role === "owner" || removesOwner)
      requireRole(c, workspace.id, "owner");
    if (removesOwner && store.countActiveWorkspaceOwners(workspace.id) <= 1)
      bad("Workspace 必须保留至少一个 active owner");
    store.updateWorkspaceMember(member.id, b);
    return c.json(store.getWorkspaceMember(member.id));
  });

  app.get("/api/member-tokens", (c) => {
    return c.json({ error: "PAT 只能由 Account 自己管理；请使用 /api/accounts/me/pats" }, 410);
  });

  app.post("/api/members/:id/tokens", async (c) => {
    return c.json({ error: "管理员不能替其他 Account 铸造 PAT" }, 410);
  });

  app.delete("/api/member-tokens/:id", (c) => {
    return c.json({ error: "PAT 只能由 Account 自己撤销" }, 410);
  });

  app.get("/api/accounts/me/pats", (c) => {
    const actor = requestActor(c);
    if (actor.kind !== "account") bad("system token 没有 Account PAT");
    return c.json(store.listPersonalAccessTokens(actor.account.id));
  });

  app.post("/api/accounts/me/pats", async (c) => {
    const actor = requestActor(c);
    if (actor.kind !== "account" || actor.credential.kind !== "session") bad("只有登录 Session 可以创建 PAT");
    const body = await c.req.json() as {
      label?: string;
      workspaceId?: string | null;
      scopes?: PersonalAccessTokenScope[];
      expiresAt?: number | null;
    };
    const validScopes: PersonalAccessTokenScope[] = ["workspace:read", "workspace:write", "agent:run", "agent:manage", "device:manage"];
    const scopes = body.scopes ?? ["workspace:read", "agent:run"];
    if (!scopes.length || scopes.some((scope) => !validScopes.includes(scope))) bad("PAT scopes 非法或为空");
    if (body.expiresAt !== undefined && body.expiresAt !== null && body.expiresAt <= Date.now()) bad("PAT expiresAt 必须在未来");
    try {
      const issued = auth.issuePat({
        accountId: actor.account.id,
        workspaceId: body.workspaceId ?? null,
        label: body.label?.trim() || "Personal access token",
        scopes: [...new Set(scopes)],
        expiresAt: body.expiresAt ?? null,
      });
      return c.json({ ...issued.token, token: issued.raw }, 201);
    } catch (error) {
      bad(error instanceof Error ? error.message : String(error));
    }
  });

  app.delete("/api/accounts/me/pats/:id", (c) => {
    const actor = requestActor(c);
    if (actor.kind !== "account" || actor.credential.kind !== "session") bad("只有登录 Session 可以撤销 PAT");
    if (!store.revokePersonalAccessToken(c.req.param("id"), actor.account.id, Date.now())) {
      throw new HTTPException(404, { message: "PAT 不存在或已撤销" });
    }
    return c.json({ ok: true });
  });

  app.get("/api/accounts/me/identities", (c) => {
    const actor = requestActor(c);
    if (actor.kind !== "account") bad("system token 没有 Account identity");
    return c.json(store.listAuthIdentities(actor.account.id));
  });

  app.post("/api/accounts/me/github/link", (c) => {
    if (!githubIntegration) return c.json({ error: "GitHub App 登录未配置" }, 503);
    const actor = requestActor(c);
    if (actor.kind !== "account" || actor.credential.kind !== "session") bad("只有登录 Session 可以绑定 GitHub identity");
    try {
      const started = githubIntegration.beginLink(actor.account.id);
      setGitHubStateCookie(c, started.state);
      return c.json({ url: started.url });
    } catch (error) {
      bad(error instanceof Error ? error.message : String(error));
    }
  });

  app.delete("/api/accounts/me/github/authorization", (c) => {
    if (!githubIntegration) return c.json({ error: "GitHub App 登录未配置" }, 503);
    const actor = requestActor(c);
    if (actor.kind !== "account" || actor.credential.kind !== "session") {
      bad("只有登录 Session 可以撤销 GitHub authorization");
    }
    if (!githubIntegration.revokeUserAuthorization(actor.account.id)) {
      throw new HTTPException(404, { message: "GitHub authorization 不存在" });
    }
    return c.json({ ok: true });
  });

  app.get("/api/accounts/me/passkeys", (c) => {
    const actor = requestActor(c);
    if (actor.kind !== "account") bad("system token 没有 Account Passkey");
    return c.json(store.listPasskeys(actor.account.id).map((passkey) => ({
      id: passkey.id,
      accountId: passkey.accountId,
      label: passkey.label,
      createdAt: passkey.createdAt,
      lastUsedAt: passkey.lastUsedAt,
      revokedAt: passkey.revokedAt,
    })));
  });

  app.post("/api/accounts/me/passkeys/options", async (c) => {
    const actor = requestActor(c);
    if (actor.kind !== "account" || actor.credential.kind !== "session") bad("只有登录 Session 可以绑定 Passkey");
    try {
      const started = await auth.beginRegistration({ flow: "register", accountId: actor.account.id });
      setCookie(c, challengeCookie, started.challengeToken, {
        ...cookieBase, httpOnly: true, maxAge: 300,
      });
      return c.json(started.options);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.post("/api/accounts/me/passkeys/verify", async (c) => {
    const actor = requestActor(c);
    if (actor.kind !== "account" || actor.credential.kind !== "session") bad("只有登录 Session 可以绑定 Passkey");
    const challengeToken = getCookie(c, challengeCookie);
    if (!challengeToken) return c.json({ error: "Passkey registration challenge cookie 缺失" }, 400);
    try {
      const body = await c.req.json() as { response?: RegistrationResponseJSON; label?: string };
      if (!body.response) return c.json({ error: "缺少 Passkey response" }, 400);
      const completed = await auth.finishRegistration({
        flow: "register",
        accountId: actor.account.id,
        challengeToken,
        response: body.response,
        label: body.label,
      });
      deleteCookie(c, challengeCookie, cookieBase);
      return c.json({ account: completed.account });
    } catch (error) {
      deleteCookie(c, challengeCookie, cookieBase);
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.get("/api/invitations", (c) => {
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    return c.json(store.listWorkspaceInvitations(workspace.id));
  });

  app.post("/api/invitations", async (c) => {
    const workspace = currentWorkspace(c);
    const member = requireRole(c, workspace.id, "admin");
    const actor = requestActor(c);
    if (actor.kind !== "account" || !member) bad("Invitation 必须由登录 Account 创建");
    const body = await c.req.json() as { email?: string; role?: WorkspaceRole; expiresAt?: number };
    const role = body.role ?? "member";
    if (!["owner", "admin", "member"].includes(role)) bad("role 可选 owner/admin/member");
    if (role === "owner") requireRole(c, workspace.id, "owner");
    const expiresAt = body.expiresAt ?? Date.now() + 7 * 24 * 60 * 60_000;
    if (expiresAt <= Date.now()) bad("Invitation expiresAt 必须在未来");
    const raw = `hinv_${randomBytes(24).toString("base64url")}`;
    const invitation = store.createWorkspaceInvitation({
      workspaceId: workspace.id,
      email: body.email?.trim() || null,
      role,
      tokenHash: createHash("sha256").update(raw).digest("hex"),
      invitedByAccountId: actor.account.id,
      expiresAt,
    }, Date.now());
    return c.json({ ...invitation, token: raw }, 201);
  });

  app.post("/api/invitations/accept", async (c) => {
    const actor = requestActor(c);
    if (actor.kind !== "account" || actor.credential.kind !== "session") bad("接受 Invitation 需要登录 Session");
    const body = await c.req.json() as { token?: string };
    if (!body.token) bad("缺少 Invitation token");
    const invitation = store.workspaceInvitationForToken(createHash("sha256").update(body.token).digest("hex"), Date.now());
    if (!invitation) bad("Invitation 不存在、已过期或已结束");
    try {
      return c.json(store.acceptWorkspaceInvitation(invitation.id, actor.account.id, Date.now()));
    } catch (error) {
      bad(error instanceof Error ? error.message : String(error));
    }
  });

  app.delete("/api/invitations/:id", (c) => {
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    if (!store.revokeWorkspaceInvitation(c.req.param("id"), workspace.id, Date.now())) {
      throw new HTTPException(404, { message: "pending Invitation 不存在" });
    }
    return c.json({ ok: true });
  });

  app.post("/api/auth/logout", (c) => {
    const actor = requestActor(c);
    if (actor.kind !== "account" || actor.credential.kind !== "session") bad("当前不是 browser Session");
    auth.logout(actor.credential.sessionId);
    clearSessionCookies(c);
    return c.json({ ok: true });
  });

  app.get("/api/integrations/github", (c) => {
    const actor = requestActor(c);
    if (actor.kind !== "account") bad("system token 没有 GitHub Account integration");
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "member");
    return c.json(githubIntegration
      ? githubIntegration.view(actor.account.id, workspace.id)
      : { configured: false });
  });

  app.post("/api/integrations/github/install", (c) => {
    if (!githubIntegration) return c.json({ error: "GitHub App installation 未配置" }, 503);
    const actor = requestActor(c);
    if (actor.kind !== "account" || actor.credential.kind !== "session") bad("只有登录 Session 可以连接 GitHub App");
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    try {
      const started = githubIntegration.beginInstall(actor.account.id, workspace.id);
      setGitHubStateCookie(c, started.state);
      return c.json({ url: started.url });
    } catch (error) {
      bad(error instanceof Error ? error.message : String(error));
    }
  });

  app.post("/api/integrations/github/installations/:installationId/sync", async (c) => {
    if (!githubIntegration) return c.json({ error: "GitHub App installation 未配置" }, 503);
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    const installationId = c.req.param("installationId");
    if (!/^[1-9][0-9]*$/.test(installationId)) bad("GitHub installation id 格式不正确");
    try {
      return c.json(await githubIntegration.syncInstallation(workspace.id, installationId));
    } catch (error) {
      bad(error instanceof Error ? error.message : String(error));
    }
  });

  app.delete("/api/integrations/github/installations/:installationId", (c) => {
    if (!githubIntegration) return c.json({ error: "GitHub App installation 未配置" }, 503);
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    const installationId = c.req.param("installationId");
    if (!githubIntegration.disconnect(workspace.id, installationId)) {
      throw new HTTPException(404, { message: "GitHub installation connection 不存在或已断开" });
    }
    return c.json({ ok: true });
  });

  app.get("/api/integrations/lark", (c) => {
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "member");
    return c.json({
      bindings: store.listLarkWorkspaceBindings(workspace.id),
      customBotConfigured: customLarkWorkspaceIds.has(workspace.id),
    });
  });

  app.post("/api/integrations/lark/bindings", async (c) => {
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    const b = (await c.req.json()) as {
      chatId?: string;
      defaultAgent?: string;
      responseMode?: "thread" | "message";
      listenMode?: "mention" | "all";
      botMode?: "global" | "custom";
      enabled?: boolean;
    };
    if (!b.chatId?.trim()) bad("缺少 Lark chatId");
    const agent = scopedAgent(c, workspace.id, b.defaultAgent);
    if (!agent) bad("缺少有效 defaultAgent");
    if (
      b.responseMode !== undefined &&
      b.responseMode !== "thread" &&
      b.responseMode !== "message"
    )
      bad("responseMode 可选 thread/message");
    if (
      b.listenMode !== undefined &&
      b.listenMode !== "mention" &&
      b.listenMode !== "all"
    )
      bad("listenMode 可选 mention/all");
    if (
      b.botMode !== undefined &&
      b.botMode !== "global" &&
      b.botMode !== "custom"
    )
      bad("botMode 可选 global/custom");
    if (b.botMode === "custom" && !customLarkWorkspaceIds.has(workspace.id))
      bad("当前 Workspace 未在 ~/.harbor.yaml 配置 feishu.custom_bots profile");
    return c.json(
      store.upsertLarkWorkspaceBinding(
        {
          workspaceId: workspace.id,
          chatId: b.chatId.trim(),
          defaultAgentId: agent.id,
          responseMode: b.responseMode,
          listenMode: b.listenMode,
          botMode: b.botMode,
          enabled: b.enabled,
        },
        Date.now(),
      ),
      201,
    );
  });

  app.patch("/api/integrations/lark/bindings/:id", async (c) => {
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    const current = store
      .listLarkWorkspaceBindings(workspace.id)
      .find((binding) => binding.id === c.req.param("id"));
    if (!current)
      throw new HTTPException(404, { message: "Lark binding 不存在" });
    const b = (await c.req.json()) as {
      defaultAgent?: string;
      responseMode?: "thread" | "message";
      listenMode?: "mention" | "all";
      botMode?: "global" | "custom";
      enabled?: boolean;
    };
    const agent = b.defaultAgent
      ? scopedAgent(c, workspace.id, b.defaultAgent)
      : store.getAgent(current.defaultAgentId);
    if (!agent) bad("defaultAgent 不存在");
    if (b.botMode === "custom" && !customLarkWorkspaceIds.has(workspace.id))
      bad("当前 Workspace 未配置 custom Bot profile");
    return c.json(
      store.upsertLarkWorkspaceBinding(
        {
          workspaceId: workspace.id,
          chatId: current.chatId,
          defaultAgentId: agent.id,
          responseMode: b.responseMode ?? current.responseMode,
          listenMode: b.listenMode ?? current.listenMode,
          botMode: b.botMode ?? current.botMode,
          enabled: b.enabled ?? current.enabled,
        },
        Date.now(),
      ),
    );
  });

  app.delete("/api/integrations/lark/bindings/:id", (c) => {
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    const current = store
      .listLarkWorkspaceBindings(workspace.id)
      .find((binding) => binding.id === c.req.param("id"));
    if (!current)
      throw new HTTPException(404, { message: "Lark binding 不存在" });
    store.deleteLarkWorkspaceBinding(current.id);
    return c.json({ ok: true });
  });

  app.get("/api/scm/events", (c) => {
    const workspace = currentWorkspace(c);
    return c.json(store.listScmEvents(workspace.id));
  });

  app.get("/api/scm/objects", (c) => {
    const workspace = currentWorkspace(c);
    const kind = c.req.query("kind");
    if (kind !== undefined && kind !== "issue" && kind !== "change")
      bad("kind 可选 issue/change");
    return c.json(store.listScmExternalObjects(workspace.id, kind));
  });

  const resolveAgentSkills = (
    value: unknown,
    workspaceId: string,
    deviceId: string,
    backend: BackendKind,
  ) => {
    if (
      value !== undefined &&
      (!Array.isArray(value) || value.some((id) => typeof id !== "string"))
    ) {
      bad("skills 需要是 Skill id 数组");
    }
    const builtin = store.getSkillByName(
      HARBOR_BUILTIN_SKILL_NAME,
      workspaceId,
    );
    const ids = [
      ...new Set([
        ...(builtin?.source === "builtin" && !builtin.archivedAt
          ? [builtin.id]
          : []),
        ...((value as string[] | undefined) ?? []),
      ]),
    ];
    return ids.map((id) => {
      const skill = store.getSkill(id);
      if (!skill || skill.archivedAt) bad(`skill "${id}" 不存在或已归档`);
      if (skill.workspaceId !== workspaceId)
        bad(`skill "${skill.name}" 不属于当前 Workspace`);
      if (skill.source === "runtime" && skill.deviceId !== deviceId) {
        bad(`runtime skill "${skill.name}" 只能绑定来源设备上的 Agent`);
      }
      if (!skill.runtimes.includes(backend)) {
        bad(
          `skill "${skill.name}" 不支持 ${backend} Runtime（可用：${skill.runtimes.join(", ")}）`,
        );
      }
      return skill;
    });
  };

  const validateAgentRuntimeForDevice = (
    device: Device,
    backend: BackendKind,
    permission: string,
    model: string | null,
  ): void => {
    const installed = (["claude", "codex"] as BackendKind[]).filter(
      (provider) => !!device.capabilities.clis?.[provider],
    );
    if (!installed.includes(backend)) {
      bad(
        `provider "${backend}" 在设备 "${device.name}" 上不可用。` +
          `可用 provider：${installed.length ? installed.join(", ") : "无（请先安装 claude 或 codex CLI 并重启 harbord）"}`,
      );
    }
    if (backend === "codex" && permission === "default") {
      bad('codex CLI 不支持 Harbor 动态审批；permission 请选 readonly/auto-edit/full（"default" 仅 Claude 可用）');
    }
    if (!model || backend !== "claude") return;

    const bare = model.startsWith("claude-") ? model.slice("claude-".length) : model;
    const isNativeTier = NATIVE_TIER_ALIASES.includes(bare);
    const endpoints = device.capabilities.endpoints ?? [];
    const routes = (device.capabilities.modelRoutes ?? []).filter((candidate) => candidate.runtime === "claude");
    const route = routes.find((candidate) => candidate.id === model || candidate.model === model);
    const invalidStructuredRoute = routes.length > 0 && (!route || !route.ready);
    const invalidLegacyRoute = routes.length === 0 && !endpoints.includes(model);
    if (!isNativeTier && (invalidStructuredRoute || invalidLegacyRoute)) {
      const readyRoutes = routes.filter((candidate) => candidate.ready).map((candidate) => candidate.id);
      bad(
        `model "${model}" 不在设备 "${device.name}" 的能力清单内。` +
          `可用：${NATIVE_TIER_ALIASES.join("/")}（Claude 原生）${readyRoutes.length ? "，sm-toolkit routes：" + readyRoutes.join(", ") : endpoints.length ? "，" + endpoints.join(", ") : "（该设备未上报 sm-toolkit routes，检查 endpoints.yaml 后重启 harbord）"}`,
      );
    }
  };

  // ---- workspaces / repositories ----

  app.get("/api/workspaces", (c) => {
    const actor = requestActor(c);
    return c.json(
      actor.kind === "system"
        ? store.listWorkspaces()
        : store.listMembershipsForAccount(actor.account.id)
            .map((membership) => store.getWorkspace(membership.workspaceId))
            .filter((workspace) => workspace && !workspace.archivedAt),
    );
  });

  app.post("/api/workspaces", async (c) => {
    const actor = requestActor(c);
    const b = (await c.req.json()) as {
      name?: string;
      slug?: string;
      description?: string;
    };
    const name = b.name?.trim() ?? "";
    if (!name) bad("缺少 Workspace name");
    if (name.length > 80) bad("Workspace name 最多 80 字符");
    let slug = (b.slug?.trim() || name.toLowerCase())
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48);
    if (!slug) slug = `workspace-${Date.now().toString(36)}`;
    if (store.resolveWorkspace(name) || store.resolveWorkspace(slug))
      bad(`Workspace name/slug "${name}" / "${slug}" 已存在`);
    const now = Date.now();
    const workspace = store.createWorkspace(
      {
        name,
        slug,
        description: b.description?.trim() || null,
        kind: "team",
        ownerAccountId: actor.kind === "account" ? actor.account.id : "acc_bootstrap",
      },
      now,
    );
    ensureBuiltinHarborSkill(store, workspace.id, now);
    return c.json(workspace, 201);
  });

  app.patch("/api/workspaces/:id", async (c) => {
    const workspace = store.resolveWorkspace(c.req.param("id"));
    if (!workspace)
      throw new HTTPException(404, {
        message: `workspace "${c.req.param("id")}" 不存在`,
      });
    requireRole(c, workspace.id, "admin");
    const b = (await c.req.json()) as {
      name?: string;
      slug?: string;
      description?: string | null;
      archived?: boolean;
    };
    if (workspace.id === DEFAULT_WORKSPACE_ID && b.archived)
      bad("Personal 默认 Workspace 不能归档");
    store.updateWorkspace(
      workspace.id,
      {
        ...(b.name !== undefined ? { name: b.name.trim() } : {}),
        ...(b.slug !== undefined ? { slug: b.slug.trim() } : {}),
        ...(b.description !== undefined
          ? { description: b.description?.trim() || null }
          : {}),
        ...(b.archived !== undefined ? { archived: b.archived } : {}),
      },
      Date.now(),
    );
    return c.json(store.getWorkspace(workspace.id));
  });

  const repositoryView = (id: string) => {
    const repository = store.getRepository(id);
    if (!repository) return null;
    return {
      ...repository,
      mounts: store.listRepositoryMounts(id).map((mount) => ({
        ...mount,
        deviceName:
          store.getDeviceName(mount.deviceId) ?? mount.deviceId,
      })),
    };
  };

  app.get("/api/repositories", (c) => {
    const workspace = currentWorkspace(c);
    return c.json(
      store
        .listRepositories(workspace.id)
        .map((repository) => repositoryView(repository.id)),
    );
  });

  app.post("/api/repositories", async (c) => {
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    const b = (await c.req.json()) as {
      name?: string;
      remoteUrl?: string;
      defaultBranch?: string;
      scmProvider?: "local" | "codebase";
      scmRepository?: string;
      scmAgent?: string;
      scmAutoDispatch?: boolean;
      device?: string;
      path?: string;
    };
    const name = b.name?.trim() ?? "";
    if (!name) bad("缺少 Repository name");
    if (
      b.scmProvider !== undefined &&
      b.scmProvider !== "local" &&
      b.scmProvider !== "codebase"
    ) {
      bad("scmProvider 可选 local/codebase");
    }
    if (b.scmProvider === "codebase" && !b.scmRepository?.trim())
      bad("Codebase Repository 缺少 scmRepository path");
    const scmAgent = b.scmAgent
      ? scopedAgent(c, workspace.id, b.scmAgent)
      : null;
    if (b.scmAgent && !scmAgent) bad(`scmAgent "${b.scmAgent}" 不存在`);
    if (b.scmAutoDispatch && !scmAgent)
      bad("scmAutoDispatch 需要配置 scmAgent");
    if (store.getRepositoryByName(workspace.id, name))
      bad(`repository 名 "${name}" 已存在于当前 Workspace`);
    if ((b.device && !b.path) || (!b.device && b.path))
      bad("首次 mount 需要同时提供 device 与 path");
    let device = null;
    if (b.device) {
      device =
        store.getDeviceByName(b.device, hub.isOnline(b.device)) ??
        store.getDevice(b.device, hub.isOnline(b.device));
      if (!device) bad(`device "${b.device}" 不存在`);
      if (!b.path!.startsWith("/") && !b.path!.startsWith("~"))
        bad("Repository mount path 必须是绝对路径");
    }
    const repository = store.createRepository(
      {
        workspaceId: workspace.id,
        name,
        remoteUrl: b.remoteUrl?.trim() || null,
        defaultBranch: b.defaultBranch?.trim() || "main",
        scmProvider: b.scmProvider ?? "local",
        scmRepository:
          b.scmProvider === "codebase" ? b.scmRepository?.trim() || null : null,
        scmAgentId: scmAgent?.id ?? null,
        scmAutoDispatch: b.scmAutoDispatch ?? false,
      },
      Date.now(),
    );
    if (device && b.path)
      store.setRepositoryMount(
        repository.id,
        device.id,
        b.path.trim(),
        Date.now(),
      );
    return c.json(repositoryView(repository.id), 201);
  });

  app.patch("/api/repositories/:id", async (c) => {
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    const repository = scopedRepository(workspace.id, c.req.param("id"))!;
    const b = (await c.req.json()) as {
      name?: string;
      remoteUrl?: string | null;
      defaultBranch?: string;
      scmProvider?: "local" | "codebase";
      scmRepository?: string | null;
      scmAgent?: string | null;
      scmAutoDispatch?: boolean;
      archived?: boolean;
    };
    if (
      b.scmProvider !== undefined &&
      b.scmProvider !== "local" &&
      b.scmProvider !== "codebase"
    ) {
      bad("scmProvider 可选 local/codebase");
    }
    const targetProvider = b.scmProvider ?? repository.scmProvider;
    const targetScmRepository =
      b.scmRepository === undefined
        ? repository.scmRepository
        : b.scmRepository?.trim() || null;
    if (targetProvider === "codebase" && !targetScmRepository)
      bad("Codebase Repository 缺少 scmRepository path");
    const targetScmAgent =
      b.scmAgent === undefined
        ? repository.scmAgentId
          ? scopedAgent(c, workspace.id, repository.scmAgentId)
          : null
        : b.scmAgent
          ? scopedAgent(c, workspace.id, b.scmAgent)
          : null;
    if (b.scmAgent && !targetScmAgent) bad(`scmAgent "${b.scmAgent}" 不存在`);
    const targetAutoDispatch = b.scmAutoDispatch ?? repository.scmAutoDispatch;
    if (targetAutoDispatch && !targetScmAgent)
      bad("scmAutoDispatch 需要配置 scmAgent");
    store.updateRepository(
      repository.id,
      {
        ...(b.name !== undefined ? { name: b.name.trim() } : {}),
        ...(b.remoteUrl !== undefined
          ? { remoteUrl: b.remoteUrl?.trim() || null }
          : {}),
        ...(b.defaultBranch !== undefined
          ? { defaultBranch: b.defaultBranch.trim() }
          : {}),
        ...(b.scmProvider !== undefined ? { scmProvider: b.scmProvider } : {}),
        ...(b.scmRepository !== undefined || b.scmProvider === "local"
          ? {
              scmRepository:
                targetProvider === "codebase" ? targetScmRepository : null,
            }
          : {}),
        ...(b.scmAgent !== undefined || b.scmProvider === "local"
          ? {
              scmAgentId:
                targetProvider === "codebase"
                  ? (targetScmAgent?.id ?? null)
                  : null,
            }
          : {}),
        ...(b.scmAutoDispatch !== undefined || b.scmProvider === "local"
          ? {
              scmAutoDispatch:
                targetProvider === "codebase" ? targetAutoDispatch : false,
            }
          : {}),
        ...(b.archived !== undefined ? { archived: b.archived } : {}),
      },
      Date.now(),
    );
    return c.json(repositoryView(repository.id));
  });

  app.post("/api/repositories/:id/mounts", async (c) => {
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    const repository = scopedRepository(workspace.id, c.req.param("id"))!;
    const b = (await c.req.json()) as { device?: string; path?: string };
    if (!b.device || !b.path?.trim()) bad("mount 需要 device 与 path");
    if (!b.path.startsWith("/") && !b.path.startsWith("~"))
      bad("Repository mount path 必须是绝对路径");
    const device =
      store.getDeviceByName(b.device, hub.isOnline(b.device)) ??
      store.getDevice(b.device, hub.isOnline(b.device));
    if (!device) bad(`device "${b.device}" 不存在`);
    const existing = store.getRepositoryMountForDevice(
      repository.id,
      device.id,
    );
    if (existing && existing.path !== b.path.trim()) {
      const usage = store.repositoryMountUsage(existing.id);
      if (usage.activeRuns || usage.worktrees) {
        bad(
          `mount 正被 ${usage.activeRuns} 个 active Run / ${usage.worktrees} 个 worktree 使用，不能移动路径`,
        );
      }
    }
    store.setRepositoryMount(
      repository.id,
      device.id,
      b.path.trim(),
      Date.now(),
    );
    return c.json(repositoryView(repository.id));
  });

  app.delete("/api/repositories/:repositoryId/mounts/:mountId", (c) => {
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    const repository = scopedRepository(
      workspace.id,
      c.req.param("repositoryId"),
    )!;
    const mount = store.getRepositoryMount(c.req.param("mountId"));
    if (!mount || mount.repositoryId !== repository.id)
      throw new HTTPException(404, { message: "mount 不存在" });
    const usage = store.repositoryMountUsage(mount.id);
    if (usage.runs || usage.worktrees || usage.agents || usage.conversations) {
      bad(
        `mount 已被 ${usage.runs} 个 Run / ${usage.worktrees} 个 worktree / ${usage.agents} 个 Agent / ${usage.conversations} 个任务引用，不能删除；可归档 Repository`,
      );
    }
    store.deleteRepositoryMount(mount.id);
    return c.json({ ok: true });
  });

  // ---- settings / prompt blocks ----

  app.get("/api/settings/prompt-blocks", (c) => {
    const workspace = currentWorkspace(c);
    return c.json({ blocks: listPromptBlockConfigs(store, workspace.id) });
  });

  app.patch("/api/settings/prompt-blocks", async (c) => {
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    const b = (await c.req.json()) as {
      key?: string;
      enabled?: boolean;
      template?: string;
    };
    if (!PROMPT_BLOCK_KEYS.includes(b.key as PromptBlockKey)) {
      bad(`key 可选 ${PROMPT_BLOCK_KEYS.join("/")}（收到 "${b.key}"）`);
    }
    if (typeof b.enabled !== "boolean") bad("需要 enabled: true/false");
    if (typeof b.template !== "string") bad("需要 template: string");
    const invalid = validatePromptTemplate(b.key as PromptBlockKey, b.template);
    if (invalid) bad(invalid);
    store.setPromptBlock(
      workspace.id,
      b.key as PromptBlockKey,
      b.enabled,
      b.template,
      Date.now(),
    );
    return c.json(
      getPromptBlockConfig(store, workspace.id, b.key as PromptBlockKey),
    );
  });

  app.delete("/api/settings/prompt-blocks/:key", (c) => {
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    const key = c.req.param("key") as PromptBlockKey;
    if (!PROMPT_BLOCK_KEYS.includes(key))
      bad(`key 可选 ${PROMPT_BLOCK_KEYS.join("/")}`);
    store.resetPromptBlock(workspace.id, key);
    return c.json(getPromptBlockConfig(store, workspace.id, key));
  });

  // ---- devices ----

  app.get("/api/devices", (c) =>
    c.json(store.listDeviceSummaries(hub.onlineIds())),
  );

  // ---- skills ----

  const skillView = (id: string) => {
    const skill = store.getSkill(id);
    if (!skill) return null;
    return {
      ...skill,
      agents: store
        .listAgentsForSkill(id)
        .map((agent) => ({ id: agent.id, name: agent.name })),
    };
  };

  app.get("/api/skills", (c) => {
    const workspace = currentWorkspace(c);
    return c.json(
      store.listSkills(false, workspace.id).map((skill) => skillView(skill.id)),
    );
  });

  app.get("/api/skill-groups", (c) => {
    const workspace = currentWorkspace(c);
    return c.json(store.listSkillGroups(workspace.id));
  });

  app.post("/api/skill-groups", async (c) => {
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    const b = (await c.req.json()) as { name?: string; position?: number };
    const name = b.name?.trim() ?? "";
    if (!name || name.length > 80) bad("Skill group name 需要 1–80 字符");
    if (
      store.listSkillGroups(workspace.id).some((group) => group.name === name)
    )
      bad(`Skill group "${name}" 已存在`);
    return c.json(
      store.createSkillGroup(
        workspace.id,
        name,
        b.position ?? store.listSkillGroups(workspace.id).length,
        Date.now(),
      ),
      201,
    );
  });

  app.patch("/api/skill-groups/:id", async (c) => {
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    const group = store.getSkillGroup(c.req.param("id"));
    if (!group || group.workspaceId !== workspace.id)
      throw new HTTPException(404, { message: "Skill group 不存在" });
    const b = (await c.req.json()) as { name?: string; position?: number };
    if (b.name !== undefined && (!b.name.trim() || b.name.trim().length > 80))
      bad("Skill group name 需要 1–80 字符");
    if (
      b.position !== undefined &&
      (!Number.isInteger(b.position) || b.position < 0)
    )
      bad("position 需要非负整数");
    store.updateSkillGroup(group.id, {
      ...(b.name !== undefined ? { name: b.name.trim() } : {}),
      ...(b.position !== undefined ? { position: b.position } : {}),
    });
    return c.json(store.getSkillGroup(group.id));
  });

  app.delete("/api/skill-groups/:id", (c) => {
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    const group = store.getSkillGroup(c.req.param("id"));
    if (!group || group.workspaceId !== workspace.id)
      throw new HTTPException(404, { message: "Skill group 不存在" });
    store.deleteSkillGroup(group.id);
    return c.json({ ok: true });
  });

  app.post("/api/skills", async (c) => {
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    const b = (await c.req.json()) as {
      name?: string;
      description?: string;
      instruction?: string;
      groupId?: string | null;
      files?: unknown;
      dependencies?: unknown;
    };
    const name = b.name?.trim() ?? "";
    const instruction = b.instruction?.trim() ?? "";
    if (!name) bad("缺少 Skill name");
    if (name.length > 80) bad("Skill name 最多 80 字符");
    if (!instruction) bad("缺少 Skill instruction（SKILL.md 正文）");
    if (instruction.length > MAX_SKILL_INSTRUCTION)
      bad("Skill instruction 不能超过 128KB");
    if (store.getSkillByName(name, workspace.id))
      bad(`skill 名 "${name}" 已存在`);
    const group = b.groupId ? store.getSkillGroup(b.groupId) : null;
    if (b.groupId && group?.workspaceId !== workspace.id)
      bad("groupId 不属于当前 Workspace");
    const skill = store.createSkill(
      {
        workspaceId: workspace.id,
        name,
        description: b.description?.trim() ?? "",
        source: "manual",
        instruction,
        runtimes: ["claude", "codex"],
        groupId: group?.id ?? null,
        files: parseSkillFiles(b.files, instruction),
        dependencies: parseSkillDependencies(b.dependencies),
      },
      Date.now(),
    );
    return c.json(skillView(skill.id), 201);
  });

  /** Mew 式 local runtime sync：只接受 daemon hello 中真实探测到的 path，不信任客户端自报正文。 */
  app.post("/api/skills/import", async (c) => {
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    const b = (await c.req.json()) as { device?: string; paths?: string[] };
    if (!b.device) bad("缺少 device");
    if (
      !Array.isArray(b.paths) ||
      b.paths.length === 0 ||
      b.paths.some((path) => typeof path !== "string")
    ) {
      bad("paths 需要是非空的本地 Skill 路径数组");
    }
    const device =
      store.getDeviceByName(b.device, hub.isOnline(b.device)) ??
      store.getDevice(b.device, hub.isOnline(b.device));
    if (!device) bad(`device "${b.device}" 不存在`);
    const installed = device.capabilities.installedSkills ?? [];
    const imported = [];
    for (const path of [...new Set(b.paths)]) {
      const local = installed.find((skill) => skill.path === path);
      if (!local?.instruction)
        bad(
          `device "${device.name}" 未上报可导入的 Skill：${path}（重启 harbord 后重试）`,
        );
      const existing = store.getRuntimeSkill(workspace.id, device.id, path);
      const owner = store.getSkillByName(local.name, workspace.id);
      if (owner && owner.id !== existing?.id) {
        bad(
          `skill 名 "${local.name}" 已被占用；请先重命名现有 Skill 或本地 SKILL.md`,
        );
      }
      if (existing) {
        store.updateSkill(
          existing.id,
          {
            name: local.name,
            description: local.description,
            instruction: local.instruction,
            runtimes: local.runtimes,
            files: local.files,
            dependencies: local.dependencies ?? [],
            autoSync: true,
          },
          Date.now(),
        );
        store.setSkillArchived(existing.id, false, Date.now());
        imported.push(skillView(existing.id));
      } else {
        const skill = store.createSkill(
          {
            workspaceId: workspace.id,
            name: local.name,
            description: local.description,
            source: "runtime",
            instruction: local.instruction,
            deviceId: device.id,
            sourcePath: local.path,
            runtimes: local.runtimes,
            files: local.files,
            dependencies: local.dependencies ?? [],
            autoSync: true,
          },
          Date.now(),
        );
        imported.push(skillView(skill.id));
      }
    }
    return c.json({ imported });
  });

  app.post("/api/skills/import-source", async (c) => {
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    const b = (await c.req.json()) as {
      source?: "codebase" | "github" | "upload";
      repository?: string;
      path?: string;
      ref?: string;
      url?: string;
      zipBase64?: string;
      files?: unknown;
      name?: string;
      groupId?: string | null;
      autoSync?: boolean;
    };
    if (
      b.source !== "codebase" &&
      b.source !== "github" &&
      b.source !== "upload"
    ) {
      bad("source 可选 codebase/github/upload");
    }
    let bundle;
    if (b.source === "codebase") {
      if (!b.repository?.trim()) bad("Codebase import 缺少 repository");
      bundle = await skillImports.fromCodebase(
        b.repository,
        b.path ?? ".",
        b.ref ?? "main",
      );
    } else if (b.source === "github") {
      if (!b.url?.trim()) bad("GitHub import 缺少 url");
      bundle = await skillImports.fromGitHub(
        b.url,
        b.ref,
        workspace.id,
        requestPrincipal(c, workspace.id),
      );
    } else if (b.zipBase64) {
      bundle = await skillImports.fromZip(b.zipBase64);
    } else {
      const files = parseSkillFiles(b.files, "") ?? [];
      bundle = {
        source: "upload" as const,
        originUrl: null,
        sourceRef: null,
        files,
      };
    }
    const fallbackName =
      b.name?.trim() ||
      b.path?.split("/").filter(Boolean).at(-1) ||
      "imported-skill";
    const metadata = importedSkillMetadata(bundle.files, fallbackName);
    const name = b.name?.trim() || metadata.name;
    if (!name || name.length > 80) bad("导入 Skill name 需要 1–80 字符");
    if (store.getSkillByName(name, workspace.id))
      bad(`skill 名 "${name}" 已存在`);
    const group = b.groupId ? store.getSkillGroup(b.groupId) : null;
    if (b.groupId && group?.workspaceId !== workspace.id)
      bad("groupId 不属于当前 Workspace");
    const skill = store.createSkill(
      {
        workspaceId: workspace.id,
        name,
        description: metadata.description,
        source: bundle.source,
        instruction: metadata.instruction,
        sourcePath: b.source === "codebase" ? (b.path ?? ".") : null,
        originUrl: bundle.originUrl,
        sourceRef: bundle.sourceRef,
        autoSync:
          (bundle.source === "codebase" || bundle.source === "github") &&
          b.autoSync === true,
        groupId: group?.id ?? null,
        files: bundle.files,
        dependencies: metadata.dependencies,
        runtimes: ["claude", "codex"],
      },
      Date.now(),
    );
    return c.json(skillView(skill.id), 201);
  });

  app.post("/api/skills/:id/sync", async (c) => {
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    const skill = store.getSkill(c.req.param("id"));
    if (!skill || skill.workspaceId !== workspace.id)
      throw new HTTPException(404, { message: "Skill 不存在" });
    if (
      (skill.source !== "codebase" && skill.source !== "github") ||
      !skill.originUrl
    ) {
      bad("只有 Codebase/GitHub source Skill 支持远端同步");
    }
    const bundle = await skillImports.refresh({
      source: skill.source,
      originUrl: skill.originUrl,
      sourcePath: skill.sourcePath,
      sourceRef: skill.sourceRef,
      workspaceId: workspace.id,
      principal: requestPrincipal(c, workspace.id),
    });
    const metadata = importedSkillMetadata(bundle.files, skill.name);
    store.updateSkill(
      skill.id,
      {
        description: metadata.description,
        instruction: metadata.instruction,
        files: bundle.files,
        dependencies: metadata.dependencies,
        sourceRef: bundle.sourceRef,
      },
      Date.now(),
    );
    return c.json(skillView(skill.id));
  });

  app.patch("/api/skills/:id", async (c) => {
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    const id = c.req.param("id");
    const skill = store.getSkill(id);
    if (!skill || skill.workspaceId !== workspace.id)
      throw new HTTPException(404, { message: `skill "${id}" 不存在` });
    const b = (await c.req.json()) as {
      name?: string;
      description?: string;
      instruction?: string;
      archived?: boolean;
      groupId?: string | null;
      files?: unknown;
      dependencies?: unknown;
      autoSync?: boolean;
    };
    if (skill.source === "builtin") {
      bad("内置 Skill 由 Harbor 版本管理，不能编辑或归档");
    }
    const patch: Parameters<HarborStore["updateSkill"]>[1] = {};
    if (b.name !== undefined) {
      const name = b.name.trim();
      if (!name || name.length > 80) bad("Skill name 需要 1–80 字符");
      const owner = store.getSkillByName(name, workspace.id);
      if (owner && owner.id !== skill.id) bad(`skill 名 "${name}" 已存在`);
      patch.name = name;
    }
    if (b.description !== undefined) patch.description = b.description.trim();
    if (b.instruction !== undefined) {
      if (skill.source === "runtime")
        bad(
          "runtime Skill 的正文由本机同步管理；请使用 Sync local skills 刷新",
        );
      const instruction = b.instruction.trim();
      if (!instruction) bad("Skill instruction 不能为空");
      if (instruction.length > MAX_SKILL_INSTRUCTION)
        bad("Skill instruction 不能超过 128KB");
      patch.instruction = instruction;
    }
    if (b.groupId !== undefined) {
      const group = b.groupId ? store.getSkillGroup(b.groupId) : null;
      if (b.groupId && group?.workspaceId !== workspace.id)
        bad("groupId 不属于当前 Workspace");
      patch.groupId = group?.id ?? null;
    }
    if (b.files !== undefined) {
      if (skill.source === "runtime")
        bad("runtime Skill bundle 由本机同步管理");
      patch.files = parseSkillFiles(
        b.files,
        patch.instruction ?? skill.instruction,
      );
    }
    if (b.dependencies !== undefined)
      patch.dependencies = parseSkillDependencies(b.dependencies);
    if (b.autoSync !== undefined) {
      if (
        skill.source !== "runtime" &&
        skill.source !== "codebase" &&
        skill.source !== "github"
      ) {
        bad("只有 runtime/codebase/github Skill 支持 autoSync");
      }
      patch.autoSync = b.autoSync;
    }
    if (Object.keys(patch).length > 0) store.updateSkill(id, patch, Date.now());
    if (b.archived !== undefined) {
      if (typeof b.archived !== "boolean") bad("archived 需要 true/false");
      store.setSkillArchived(id, b.archived, Date.now());
    }
    if (Object.keys(patch).length === 0 && b.archived === undefined)
      bad("没有可更新的字段");
    return c.json(skillView(id));
  });

  // ---- agents ----

  app.get("/api/agents", (c) => {
    const workspace = currentWorkspace(c);
    return c.json(
      store
        .listAgents(false, workspace.id)
        .filter((agent) => canSeeAgent(c, agent))
        .map(agentView),
    );
  });

  app.post("/api/agents", async (c) => {
    const workspace = currentWorkspace(c);
    const creator = requireRole(c, workspace.id, "admin");
    const b = (await c.req.json()) as {
      name?: string;
      description?: string;
      device?: string;
      backend?: string;
      model?: string;
      permission?: string;
      sandboxNetworkAccess?: boolean;
      repository?: string;
      repositories?: unknown;
      /** legacy CLI compatibility */
      workdir?: string;
      isolation?: string;
      instruction?: string;
      skills?: unknown;
      concurrency?: number;
      visibility?: "workspace" | "private";
      environment?: unknown;
      setupScript?: string;
      reuseDeviceCli?: boolean;
    };
    if (!b.name) bad("缺少 name");
    if (!b.device) bad("缺少 device（设备名或 id）");
    if (b.workdir && !b.workdir.startsWith("/") && !b.workdir.startsWith("~")) {
      bad(`workdir 必须是绝对路径（收到 "${b.workdir}"）`);
    }
    if (
      b.backend !== undefined &&
      b.backend !== "claude" &&
      b.backend !== "codex"
    ) {
      bad(`backend 只支持 claude/codex（收到 "${b.backend}"）`);
    }
    const permission = b.permission ?? "auto-edit";
    if (!PERMISSIONS.includes(permission))
      bad(`permission 可选 ${PERMISSIONS.join("/")}（收到 "${b.permission}"）`);
    if (
      b.sandboxNetworkAccess !== undefined &&
      typeof b.sandboxNetworkAccess !== "boolean"
    ) {
      bad("sandboxNetworkAccess 需要 true/false");
    }
    const isolation = (b.isolation ?? "none") as IsolationKind;
    if (isolation !== "none" && isolation !== "worktree")
      bad(`isolation 可选 none/worktree（收到 "${b.isolation}"）`);
    const concurrency = b.concurrency ?? 1;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64)
      bad("concurrency 需要是 1–64 的整数");
    if (
      b.visibility !== undefined &&
      b.visibility !== "workspace" &&
      b.visibility !== "private"
    ) {
      bad("visibility 可选 workspace/private");
    }
    if (b.setupScript !== undefined && b.setupScript.length > MAX_AGENT_SETUP)
      bad("setupScript 不能超过 64KB");
    if (b.reuseDeviceCli === false) {
      bad(
        "个人部署版没有 Mew managed runtime；reuseDeviceCli 必须开启，Agent 使用所选 Device 的 CLI 登录态",
      );
    }
    const environment = parseAgentEnvironment(b.environment);
    if (
      b.repositories !== undefined &&
      (!Array.isArray(b.repositories) ||
        b.repositories.some((item) => typeof item !== "string"))
    ) {
      bad("repositories 需要是 Repository id/name 数组");
    }

    const device =
      store.getDeviceByName(b.device, hub.isOnline(b.device)) ??
      store.getDevice(b.device, hub.isOnline(b.device));
    if (!device) bad(`device "${b.device}" 未注册（先在该设备上启动 harbord）`);
    if (store.getAgentByNameInWorkspace(workspace.id, b.name))
      bad(`agent 名 "${b.name}" 已存在于当前 Workspace`);

    const installed = (["claude", "codex"] as BackendKind[]).filter(
      (provider) => !!device.capabilities.clis?.[provider],
    );
    const backend = (b.backend ??
      (installed.includes("claude") ? "claude" : installed[0])) as
      BackendKind | undefined;
    if (!backend || !installed.includes(backend)) {
      bad(
        `provider "${b.backend ?? backend ?? "(默认)"}" 在设备 "${device.name}" 上不可用。` +
          `可用 provider：${installed.length ? installed.join(", ") : "无（请先安装 claude 或 codex CLI 并重启 harbord）"}`,
      );
    }
    if (backend === "codex" && permission === "default") {
      bad(
        'codex CLI 不支持 Harbor 动态审批；permission 请选 readonly/auto-edit/full（"default" 仅 Claude 可用）',
      );
    }
    if (backend !== "codex" && b.sandboxNetworkAccess === true) {
      bad("sandboxNetworkAccess 当前只支持 Codex CLI");
    }

    // Claude 接入 endpoints.yaml，需前置校验；CodexBackend 不接 endpoints，model 由 codex CLI 校验。
    if (b.model && backend === "claude") {
      const bare = b.model.startsWith("claude-")
        ? b.model.slice("claude-".length)
        : b.model;
      const isNativeTier = NATIVE_TIER_ALIASES.includes(bare);
      const eps = device.capabilities.endpoints ?? [];
      // 只认 claude routes：codex 清单同存于 modelRoutes，不能为 claude 校验放行/报错
      const routes = (device.capabilities.modelRoutes ?? []).filter(
        (candidate) => candidate.runtime === "claude",
      );
      const route = routes.find(
        (candidate) => candidate.id === b.model || candidate.model === b.model,
      );
      const invalidStructuredRoute =
        routes.length > 0 && (!route || !route.ready);
      const invalidLegacyRoute = routes.length === 0 && !eps.includes(b.model);
      if (!isNativeTier && (invalidStructuredRoute || invalidLegacyRoute)) {
        const readyRoutes = routes
          .filter((candidate) => candidate.ready)
          .map((candidate) => candidate.id);
        bad(
          `model "${b.model}" 不在设备 "${device.name}" 的能力清单内。` +
            `可用：${NATIVE_TIER_ALIASES.join("/")}（Claude 原生）${readyRoutes.length ? "，sm-toolkit routes：" + readyRoutes.join(", ") : eps.length ? "，" + eps.join(", ") : "（该设备未上报 sm-toolkit routes，检查 endpoints.yaml 后重启 harbord）"}`,
        );
      }
    }

    let repository = scopedRepository(workspace.id, b.repository);
    if (!repository && b.workdir) {
      repository = store.ensureRepositoryForPath(
        workspace.id,
        device.id,
        b.workdir,
        Date.now(),
      );
    }
    if (!repository)
      bad("Agent 必须绑定 Repository；请在 Agent 表单选择已有仓库或创建新仓库");
    if (!store.getRepositoryMountForDevice(repository.id, device.id)) {
      bad(`Repository "${repository.name}" 尚未挂载到设备 "${device.name}"`);
    }
    const repositories = [
      ...new Set([
        repository.id,
        ...((b.repositories as string[] | undefined) ?? []).map((key) => {
          const candidate = scopedRepository(workspace.id, key);
          if (!candidate) bad(`repository "${key}" 不存在`);
          if (!store.getRepositoryMountForDevice(candidate.id, device.id)) {
            bad(
              `Repository "${candidate.name}" 尚未挂载到设备 "${device.name}"`,
            );
          }
          return candidate.id;
        }),
      ]),
    ];

    const skills = resolveAgentSkills(
      b.skills,
      workspace.id,
      device.id,
      backend,
    );
    const agent = store.createAgent(
      {
        workspaceId: workspace.id,
        name: b.name,
        description: b.description ?? null,
        deviceId: device.id,
        backend,
        model: b.model ?? null,
        permission: permission as import("@sm/agent").PermissionPolicy,
        sandboxNetworkAccess: b.sandboxNetworkAccess === true,
        repositoryId: repository.id,
        repositoryIds: repositories,
        isolation,
        instruction: b.instruction ?? null,
        concurrency,
        visibility: b.visibility ?? "workspace",
        environment,
        setupScript: b.setupScript?.trim() || null,
        reuseDeviceCli: true,
        createdByMemberId: creator?.id ?? null,
      },
      Date.now(),
    );
    if (skills.length > 0)
      store.setAgentSkills(
        agent.id,
        skills.map((skill) => skill.id),
        Date.now(),
      );
    return c.json(agentView(store.getAgent(agent.id)!), 201);
  });

  app.patch("/api/agents/:id", async (c) => {
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    const key = c.req.param("id");
    const agent = scopedAgent(c, workspace.id, key);
    if (!agent)
      throw new HTTPException(404, { message: `agent "${key}" 不存在` });
    const b = (await c.req.json()) as {
      archived?: boolean;
      skills?: unknown;
      repository?: string;
      repositories?: unknown;
      name?: string;
      description?: string | null;
      model?: string | null;
      permission?: string;
      sandboxNetworkAccess?: boolean;
      isolation?: string;
      instruction?: string | null;
      concurrency?: number;
      visibility?: "workspace" | "private";
      environment?: unknown;
      setupScript?: string | null;
      reuseDeviceCli?: boolean;
      device?: string;
      dropIncompatibleSkills?: boolean;
    };
    if (Object.keys(b).length === 0) bad("没有可更新的 Agent 字段");
    const name = b.name?.trim();
    if (b.name !== undefined && !name) bad("Agent name 不能为空");
    if (name && name !== agent.name) {
      const existing = store.getAgentByNameInWorkspace(workspace.id, name);
      if (existing && existing.id !== agent.id)
        bad(`agent 名 "${name}" 已存在于当前 Workspace`);
    }
    if (
      b.dropIncompatibleSkills !== undefined &&
      typeof b.dropIncompatibleSkills !== "boolean"
    ) {
      bad("dropIncompatibleSkills 需要 true/false");
    }

    const targetDevice =
      b.device === undefined
        ? store.getDevice(agent.deviceId, hub.isOnline(agent.deviceId))
        : (store.getDeviceByName(b.device, hub.isOnline(b.device)) ??
          store.getDevice(b.device, hub.isOnline(b.device)));
    if (!targetDevice) bad(`device "${b.device ?? agent.deviceId}" 未注册`);
    const primary =
      b.repository === undefined
        ? store.getRepository(agent.repositoryId)
        : scopedRepository(workspace.id, b.repository);
    if (!primary) bad("Agent 必须绑定 Repository");
    const requested =
      b.repositories === undefined ? agent.repositoryIds : b.repositories;
    const bindingRequested =
      b.device !== undefined ||
      b.repository !== undefined ||
      b.repositories !== undefined;
    if (
      !Array.isArray(requested) ||
      requested.some((item) => typeof item !== "string")
    ) {
      bad("repositories 需要是 Repository id/name 数组");
    }
    const repositoryIds = [
      ...new Set([
        primary.id,
        ...requested.map((key) => {
          const repository = scopedRepository(workspace.id, key);
          if (!repository) bad(`repository "${key}" 不存在`);
          return repository.id;
        }),
      ]),
    ];
    const deviceChanged = targetDevice.id !== agent.deviceId;
    const repositoryChanged = primary.id !== agent.repositoryId;
    if (deviceChanged || repositoryChanged) {
      const blocker = store.agentExecutionBindingChangeBlocker(agent.id);
      if (blocker) bad(`${blocker}，暂不能更换执行绑定`);
    }
    if (deviceChanged || b.permission !== undefined || b.model !== undefined) {
      validateAgentRuntimeForDevice(
        targetDevice,
        agent.backend,
        b.permission ?? agent.permission,
        b.model === undefined ? agent.model : b.model?.trim() || null,
      );
    }
    if (bindingRequested) {
      for (const repositoryId of repositoryIds) {
        const repository = store.getRepository(repositoryId)!;
        if (
          !store.getRepositoryMountForDevice(repository.id, targetDevice.id)
        ) {
          bad(
            `Repository "${repository.name}" 尚未挂载到设备 "${targetDevice.name}"`,
          );
        }
      }
    }
    const skills =
      b.skills !== undefined
        ? resolveAgentSkills(
            b.skills,
            workspace.id,
            targetDevice.id,
            agent.backend,
          )
        : null;
    const incompatibleRuntimeSkills =
      deviceChanged && !skills
        ? store
            .listSkillsForAgent(agent.id)
            .filter(
              (skill) =>
                skill.source === "runtime" &&
                skill.deviceId !== targetDevice.id,
            )
        : [];
    if (incompatibleRuntimeSkills.length > 0 && !b.dropIncompatibleSkills) {
      bad(
        `迁移到 "${targetDevice.name}" 会解除旧 Device 的 runtime Skills：` +
          `${incompatibleRuntimeSkills.map((skill) => skill.name).join("、")}；确认后请传 dropIncompatibleSkills: true`,
      );
    }
    if (b.archived !== undefined && typeof b.archived !== "boolean")
      bad("archived 需要 true/false");
    if (b.reuseDeviceCli === false) {
      bad("个人部署版没有 Mew managed runtime；reuseDeviceCli 必须开启");
    }
    if (b.permission !== undefined && !PERMISSIONS.includes(b.permission))
      bad(`permission 可选 ${PERMISSIONS.join("/")}`);
    if (
      b.sandboxNetworkAccess !== undefined &&
      typeof b.sandboxNetworkAccess !== "boolean"
    ) {
      bad("sandboxNetworkAccess 需要 true/false");
    }
    if (agent.backend !== "codex" && b.sandboxNetworkAccess === true) {
      bad("sandboxNetworkAccess 当前只支持 Codex CLI");
    }
    if (
      b.isolation !== undefined &&
      b.isolation !== "none" &&
      b.isolation !== "worktree"
    )
      bad("isolation 可选 none/worktree");
    if (
      b.concurrency !== undefined &&
      (!Number.isInteger(b.concurrency) ||
        b.concurrency < 1 ||
        b.concurrency > 64)
    ) {
      bad("concurrency 需要是 1–64 的整数");
    }
    if (
      b.visibility !== undefined &&
      b.visibility !== "workspace" &&
      b.visibility !== "private"
    ) {
      bad("visibility 可选 workspace/private");
    }
    if (
      b.setupScript !== undefined &&
      (b.setupScript?.length ?? 0) > MAX_AGENT_SETUP
    )
      bad("setupScript 不能超过 64KB");
    const configPatch = {
      ...(name !== undefined ? { name } : {}),
      ...(b.description !== undefined
        ? { description: b.description?.trim() || null }
        : {}),
      ...(b.model !== undefined ? { model: b.model?.trim() || null } : {}),
      ...(b.permission !== undefined
        ? { permission: b.permission as import("@sm/agent").PermissionPolicy }
        : {}),
      ...(b.sandboxNetworkAccess !== undefined
        ? { sandboxNetworkAccess: b.sandboxNetworkAccess }
        : {}),
      ...(b.isolation !== undefined
        ? { isolation: b.isolation as IsolationKind }
        : {}),
      ...(b.instruction !== undefined
        ? { instruction: b.instruction?.trim() || null }
        : {}),
      ...(b.concurrency !== undefined ? { concurrency: b.concurrency } : {}),
      ...(b.visibility !== undefined ? { visibility: b.visibility } : {}),
      ...(b.environment !== undefined
        ? { environment: parseAgentEnvironment(b.environment) }
        : {}),
      ...(b.setupScript !== undefined
        ? { setupScript: b.setupScript?.trim() || null }
        : {}),
      ...(b.reuseDeviceCli !== undefined ? { reuseDeviceCli: true } : {}),
    };
    if (b.archived !== undefined)
      store.setAgentArchived(agent.id, b.archived, Date.now());
    store.updateAgentConfig(agent.id, configPatch);
    if (deviceChanged) {
      store.moveAgentToDevice(agent.id, targetDevice.id, primary.id);
    }
    if (
      deviceChanged ||
      b.repository !== undefined ||
      b.repositories !== undefined
    ) {
      store.setAgentRepositories(
        agent.id,
        repositoryIds,
        primary.id,
        Date.now(),
      );
    }
    if (skills)
      store.setAgentSkills(
        agent.id,
        skills.map((skill) => skill.id),
        Date.now(),
      );
    return c.json(agentView(store.getAgent(agent.id)!));
  });

  // ---- issue labels ----

  app.get("/api/labels", (c) => {
    const workspace = currentWorkspace(c);
    return c.json(store.listIssueLabels(workspace.id));
  });

  app.post("/api/labels", async (c) => {
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    const b = (await c.req.json()) as { name?: string; color?: string };
    const name = b.name?.trim() ?? "";
    if (!name || name.length > 40) bad("label name 需要 1–40 字符");
    const color = b.color?.trim() || "#75817b";
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) bad("label color 需要 #RRGGBB");
    if (
      store.listIssueLabels(workspace.id).some((label) => label.name === name)
    )
      bad(`label "${name}" 已存在`);
    return c.json(store.createIssueLabel(workspace.id, name, color), 201);
  });

  // ---- conversations ----

  app.get("/api/conversations", (c) => {
    const workspace = currentWorkspace(c);
    const kind = c.req.query("kind") as ConversationKind | undefined;
    const status = c.req.query("status") as ConversationStatus | undefined;
    // AI draft 是创建器内部态；正式发布前不进入 Chats / Issues / Automation target 列表。
    const convs = store
      .listConversations({ workspaceId: workspace.id, kind, status })
      .filter((conversation) => conversation.kind !== "issue_draft");
    const agentNames = new Map(
      store.listAgents(true, workspace.id).map((a) => [a.id, a.name]),
    );
    return c.json(
      convs.map((cv) => ({
        ...cv,
        agentName: cv.agentId
          ? (agentNames.get(cv.agentId) ?? cv.agentId)
          : null,
        latestRun: store.latestRunForConversation(cv.id),
      })),
    );
  });

  app.post("/api/conversations", async (c) => {
    const workspace = currentWorkspace(c);
    const creator = requireRole(c, workspace.id, "member");
    const b = (await c.req.json()) as {
      kind?: string;
      agent?: string;
      title?: string;
      description?: string;
      priority?: string;
      origin?: Origin;
      originRef?: string;
      ownerMemberId?: string | null;
      labelIds?: unknown;
      repository?: unknown;
    };
    if (b.repository !== undefined)
      bad("Conversation 的 Repository 由 Agent 决定，请修改 Agent 配置");
    if (b.kind !== "chat" && b.kind !== "issue")
      bad(`kind 只支持 chat/issue（收到 "${b.kind}"）`);
    if (b.kind === "chat" && !b.agent) bad("chat 缺少 agent（agent 名或 id）");
    if (
      b.priority !== undefined &&
      !ISSUE_PRIORITIES.includes(b.priority as IssuePriority)
    ) {
      bad(
        `priority 可选 ${ISSUE_PRIORITIES.join("/")}（收到 "${b.priority}"）`,
      );
    }
    const agent = scopedAgent(c, workspace.id, b.agent);
    if (b.agent && !agent)
      bad(`agent "${b.agent}" 不存在（harbor agent ls 查看）`);
    if (agent?.archivedAt) bad(`agent "${agent.name}" 已归档`);
    if (b.ownerMemberId !== undefined && b.ownerMemberId !== null) {
      const owner = store.getWorkspaceMember(b.ownerMemberId);
      if (
        !owner ||
        owner.workspaceId !== workspace.id ||
        owner.status !== "active"
      )
        bad("ownerMemberId 必须是当前 Workspace 的 active member");
    }
    if (
      b.labelIds !== undefined &&
      (!Array.isArray(b.labelIds) ||
        b.labelIds.some((id) => typeof id !== "string"))
    )
      bad("labelIds 需要是 label id 数组");
    const labelIds = b.labelIds as string[] | undefined;
    if (
      labelIds?.some(
        (id) => store.getIssueLabel(id)?.workspaceId !== workspace.id,
      )
    )
      bad("labelIds 包含其他 Workspace 或不存在的 label");
    const repository = agent ? store.getRepository(agent.repositoryId) : null;
    const conv = store.createConversation(
      {
        workspaceId: workspace.id,
        kind: b.kind,
        title: b.title ?? null,
        description: b.description ?? null,
        priority: (b.priority as IssuePriority | undefined) ?? "medium",
        agentId: agent?.id ?? null,
        repositoryId: repository?.id ?? null,
        origin: b.origin ?? "cli",
        originRef: b.originRef ?? null,
        creatorMemberId: creator?.id ?? null,
        ownerMemberId:
          b.ownerMemberId === undefined
            ? (creator?.id ?? null)
            : b.ownerMemberId,
        labelIds: labelIds ?? [],
      },
      Date.now(),
    );
    return c.json(conv, 201);
  });

  /** Mew AI draft：先用只读 Agent 分诊，人工确认标题/正文后才发布到 Issue 看板。 */
  app.post("/api/issue-drafts", async (c) => {
    const workspace = currentWorkspace(c);
    const creator = requireRole(c, workspace.id, "member");
    const b = (await c.req.json()) as {
      request?: string;
      agent?: string;
      priority?: string;
      repository?: unknown;
    };
    if (b.repository !== undefined)
      bad("Issue draft 的 Repository 由 Agent 决定，请修改 Agent 配置");
    if (!b.request?.trim()) bad("请描述要 Agent 分诊的请求");
    if (!b.agent) bad("请选择负责分诊的 Agent");
    if (
      b.priority !== undefined &&
      !ISSUE_PRIORITIES.includes(b.priority as IssuePriority)
    ) {
      bad(
        `priority 可选 ${ISSUE_PRIORITIES.join("/")}（收到 "${b.priority}"）`,
      );
    }
    const agent = scopedAgent(c, workspace.id, b.agent);
    if (!agent) bad(`agent "${b.agent}" 不存在`);
    if (agent.archivedAt) bad(`agent "${agent.name}" 已归档`);
    const repository = store.getRepository(agent.repositoryId);
    const conv = store.createConversation(
      {
        workspaceId: workspace.id,
        kind: "issue_draft",
        agentId: agent.id,
        repositoryId: repository?.id ?? null,
        description: b.request.trim(),
        priority: (b.priority as IssuePriority | undefined) ?? "medium",
        origin: "web",
        originRef: "ai-draft",
        creatorMemberId: creator?.id ?? null,
        ownerMemberId: creator?.id ?? null,
      },
      Date.now(),
    );
    const run = enqueueForRequest(
      c,
      conv,
      agent,
      `${ISSUE_TRIAGE_PROMPT}${b.request.trim()}`,
      "triage",
    );
    return c.json({ conversation: conv, run }, 201);
  });

  app.post("/api/issue-drafts/:id/publish", async (c) => {
    const workspace = currentWorkspace(c);
    const conv = assertConversationWorkspace(workspace.id, c.req.param("id"));
    if (!conv || conv.kind !== "issue_draft") {
      throw new HTTPException(404, {
        message: `issue draft "${c.req.param("id")}" 不存在`,
      });
    }
    if (store.activeRunForConversation(conv.id))
      bad("Agent 仍在分诊，请等待完成后再创建 Issue");
    const latest = store.latestRunForConversation(conv.id);
    if (
      !latest ||
      latest.purpose !== "triage" ||
      latest.status !== "succeeded"
    ) {
      bad("AI 分诊尚未成功完成；可关闭草稿后改用普通模式创建 Issue");
    }
    const b = (await c.req.json()) as {
      title?: string;
      description?: string;
      priority?: string;
      status?: string;
    };
    if (!b.title?.trim()) bad("Issue 标题不能为空");
    if (!b.description?.trim()) bad("Issue 描述不能为空");
    if (!ISSUE_PRIORITIES.includes(b.priority as IssuePriority)) {
      bad(`priority 可选 ${ISSUE_PRIORITIES.join("/")}`);
    }
    if (b.status !== "backlog" && b.status !== "todo")
      bad("初始阶段只支持 backlog/todo");
    return c.json(
      store.publishIssueDraft(
        conv.id,
        {
          title: b.title.trim(),
          description: b.description.trim(),
          priority: b.priority as IssuePriority,
          status: b.status,
        },
        Date.now(),
      ),
    );
  });

  app.get("/api/conversations/:id", (c) => {
    const workspace = currentWorkspace(c);
    const conv = assertConversationWorkspace(workspace.id, c.req.param("id"));
    const rawAgent = conv.agentId ? store.getAgent(conv.agentId) : null;
    const agent =
      rawAgent && canSeeAgent(c, rawAgent) ? agentView(rawAgent) : null;
    const repository = conv.repositoryId
      ? store.getRepository(conv.repositoryId)
      : null;
    const delivery = store.getDeliveryForConversation(conv.id);
    return c.json({
      conversation: conv,
      agent,
      repository,
      // resultText：Chat/Issue 历史渲染用；run_events 7 天 prune 后为 null（UI 显示「记录已过期」）
      runs: store
        .listRunsByConversation(conv.id)
        .map((r) => ({ ...r, resultText: store.getRunResultText(r.id) })),
      statusLog: store.listStatusLog(conv.id),
      delivery,
      deliveryEvents: (() => {
        return delivery ? store.listDeliveryEvents(delivery.id) : [];
      })(),
      messages: store.listConversationMessages(conv.id),
      labels: conv.labelIds
        .map((id) => store.getIssueLabel(id))
        .filter(Boolean),
      creator: conv.creatorMemberId
        ? store.getWorkspaceMember(conv.creatorMemberId)
        : null,
      owner: conv.ownerMemberId
        ? store.getWorkspaceMember(conv.ownerMemberId)
        : null,
    });
  });

  app.patch("/api/conversations/:id", async (c) => {
    const workspace = currentWorkspace(c);
    const conv = assertConversationWorkspace(workspace.id, c.req.param("id"));
    const b = (await c.req.json()) as {
      status?: string;
      title?: string | null;
      description?: string | null;
      priority?: string;
      agent?: string | null;
      repository?: unknown;
      ownerMemberId?: string | null;
      labelIds?: unknown;
    };
    if (b.repository !== undefined)
      bad("Conversation 的 Repository 由 Assignee 决定，请修改 Agent 配置");
    if (
      b.priority !== undefined &&
      !ISSUE_PRIORITIES.includes(b.priority as IssuePriority)
    ) {
      bad(
        `priority 可选 ${ISSUE_PRIORITIES.join("/")}（收到 "${b.priority}"）`,
      );
    }
    if (b.ownerMemberId !== undefined && b.ownerMemberId !== null) {
      const owner = store.getWorkspaceMember(b.ownerMemberId);
      if (
        !owner ||
        owner.workspaceId !== workspace.id ||
        owner.status !== "active"
      )
        bad("ownerMemberId 必须是当前 Workspace 的 active member");
    }
    if (
      b.labelIds !== undefined &&
      (!Array.isArray(b.labelIds) ||
        b.labelIds.some((id) => typeof id !== "string"))
    ) {
      bad("labelIds 需要是 label id 数组");
    }
    const labelIds = b.labelIds as string[] | undefined;
    if (
      labelIds?.some(
        (id) => store.getIssueLabel(id)?.workspaceId !== workspace.id,
      )
    )
      bad("labelIds 包含其他 Workspace 或不存在的 label");
    store.updateConversation(
      conv.id,
      {
        ...(b.title !== undefined ? { title: b.title } : {}),
        ...(b.description !== undefined ? { description: b.description } : {}),
        ...(b.priority !== undefined
          ? { priority: b.priority as IssuePriority }
          : {}),
        ...(b.ownerMemberId !== undefined
          ? { ownerMemberId: b.ownerMemberId }
          : {}),
        ...(labelIds !== undefined ? { labelIds } : {}),
      },
      Date.now(),
    );
    if (b.agent !== undefined) {
      const agent = scopedAgent(c, workspace.id, b.agent);
      if (b.agent && !agent) bad(`agent "${b.agent}" 不存在`);
      if (agent?.archivedAt) bad(`agent "${agent.name}" 已归档`);
      if (store.activeRunForConversation(conv.id))
        bad("Run 进行中，不能更换 Assignee；请先停止 Run");
      if (conv.worktreePath && agent?.repositoryId !== conv.repositoryId) {
        bad("Issue 已有 worktree，不能换到绑定其他 Repository 的 Agent");
      }
      store.setConversationAssignee(conv.id, agent?.id ?? null, Date.now());
    }
    if (b.status !== undefined) {
      if (!ISSUE_STATUSES.includes(b.status as ConversationStatus)) {
        bad(`status 可选 ${ISSUE_STATUSES.join("/")}（收到 "${b.status}"）`);
      }
      if (conv.kind !== "issue") bad("chat 状态恒为 open");
      if (store.activeRunForConversation(conv.id))
        bad("Run 进行中，不能手动调整阶段；请先停止 Run");
      const current = store.getConversation(conv.id)!;
      const to = b.status as ConversationStatus;
      if (to === "doing" || to === "review")
        bad(`${to} 由 Run 生命周期自动推进，不能手动设置`);
      if (to === "done" && current.status !== "review")
        bad("只有 Review 中的 Issue 才能验收完成");
      if (to === "done" && store.getDeliveryForConversation(current.id)) {
        bad(
          "当前 Issue 已建立 Delivery，请完成合并/部署流程，不能绕过交付策略直接 Done",
        );
      }
      if (to === "backlog" || to === "todo") {
        if (current.status === "done" || current.status === "canceled")
          bad(`${current.status} 是终态，不能直接重新打开`);
      }
      transitionConversation(store, current, to, "human", Date.now());
      const fresh = store.getConversation(conv.id)!;
      if (to === "done" || to === "canceled")
        coordinator.requestWorktreeCleanup(fresh);
    }
    return c.json(store.getConversation(conv.id));
  });

  app.post("/api/conversations/:id/runs", async (c) => {
    const workspace = currentWorkspace(c);
    const conv = assertConversationWorkspace(workspace.id, c.req.param("id"));
    const b = (await c.req.json()) as {
      prompt?: string;
      agent?: string;
      purpose?: string;
    };
    if (!b.prompt?.trim()) bad("缺少 prompt");
    const purpose = (b.purpose ?? "implementation") as RunPurpose;
    if (!RUN_PURPOSES.includes(purpose))
      bad(`purpose 可选 ${RUN_PURPOSES.join("/")}`);
    const agentKey = b.agent ?? conv.agentId;
    const agent = scopedAgent(c, workspace.id, agentKey);
    if (!agent) bad("Issue 尚未指派 Agent，请先选择 Assignee");
    if (agent.archivedAt) bad(`agent "${agent.name}" 已归档`);
    appendRequestMessage(c, conv.id, b.prompt.trim());
    const run = enqueueForRequest(c, conv, agent, b.prompt.trim(), purpose);
    return c.json(run, 201);
  });

  /** Mew 式一步派活：选择 Agent 即更新 Assignee + 创建 implementation Run。 */
  app.post("/api/conversations/:id/dispatch", async (c) => {
    const workspace = currentWorkspace(c);
    const conv = assertConversationWorkspace(workspace.id, c.req.param("id"));
    if (conv.kind !== "issue") bad("dispatch 只适用于 Issue");
    const b = (await c.req.json()) as { agent?: string; prompt?: string };
    const agentKey = b.agent ?? conv.agentId;
    const agent = scopedAgent(c, workspace.id, agentKey);
    if (!agent) bad("请选择要执行的 Agent");
    if (agent.archivedAt) bad(`agent "${agent.name}" 已归档`);
    const prompt = b.prompt?.trim() || conv.description?.trim();
    if (!prompt) bad("Issue 缺少任务描述，无法派发");
    appendRequestMessage(c, conv.id, prompt);
    return c.json(enqueueForRequest(c, conv, agent, prompt, "implementation"), 201);
  });

  app.post("/api/conversations/:id/request-changes", async (c) => {
    const workspace = currentWorkspace(c);
    const conv = assertConversationWorkspace(workspace.id, c.req.param("id"));
    if (conv.kind !== "issue" || conv.status !== "review")
      bad("只有 Review 中的 Issue 可以要求修改");
    const b = (await c.req.json()) as { feedback?: string; agent?: string };
    if (!b.feedback?.trim()) bad("请填写修改意见");
    const agentKey = b.agent ?? conv.agentId;
    const agent = scopedAgent(c, workspace.id, agentKey);
    if (!agent) bad("请选择返工 Agent");
    if (agent.archivedAt) bad(`agent "${agent.name}" 已归档`);
    appendRequestMessage(c, conv.id, b.feedback.trim());
    return c.json(
      enqueueForRequest(c, conv, agent, b.feedback.trim(), "implementation"),
      201,
    );
  });

  app.post("/api/conversations/:id/review", async (c) => {
    const workspace = currentWorkspace(c);
    const conv = assertConversationWorkspace(workspace.id, c.req.param("id"));
    if (conv.kind !== "issue" || conv.status !== "review")
      bad("AI Review 只能在 Review 阶段启动");
    const b = (await c.req.json()) as { agent?: string; prompt?: string };
    const agent = scopedAgent(c, workspace.id, b.agent);
    if (!agent) bad("请选择 Reviewer Agent");
    if (agent.archivedAt) bad(`agent "${agent.name}" 已归档`);
    const prompt =
      b.prompt?.trim() ||
      "请独立审查本 Issue 的实现结果、代码改动和测试证据，指出阻塞问题与改进建议；不要直接宣告 Issue 完成。";
    appendRequestMessage(c, conv.id, prompt);
    return c.json(enqueueForRequest(c, conv, agent, prompt, "review"), 201);
  });

  app.post("/api/conversations/:id/messages", async (c) => {
    const workspace = currentWorkspace(c);
    const conv = assertConversationWorkspace(workspace.id, c.req.param("id"));
    const b = (await c.req.json()) as {
      body?: string;
      agent?: string;
      dispatch?: boolean;
    };
    const body = b.body?.trim() ?? "";
    if (!body) bad("message body 不能为空");
    const message = appendRequestMessage(c, conv.id, body);
    if (b.dispatch === false) return c.json({ message }, 201);
    const agent = scopedAgent(c, workspace.id, b.agent ?? conv.agentId);
    if (!agent) bad("请选择响应消息的 Agent");
    const purpose: RunPurpose =
      conv.kind === "issue" && conv.status === "review"
        ? "review"
        : "implementation";
    const promptEvent =
      /@[\w.-]+/.test(body) && conv.kind === "issue"
        ? ("event.issue.mentioned" as const)
        : conv.kind === "chat"
          ? ("event.chat.message_created" as const)
          : ("event.issue.message_created" as const);
    const run = enqueueForRequest(c, conv, agent, body, purpose, promptEvent, message.id);
    return c.json({ message, run }, 201);
  });

  app.post("/api/conversations/:id/delivery", async (c) => {
    const conv = assertConversationWorkspace(
      currentWorkspace(c).id,
      c.req.param("id"),
    );
    const b = (await c.req.json()) as {
      provider?: DeliveryProviderKind;
      changeUrl?: string;
      externalId?: string;
      headBranch?: string;
      baseBranch?: string;
    };
    rejectUnknownFields(b as Record<string, unknown>, ["provider", "changeUrl", "externalId", "headBranch", "baseBranch"]);
    validateDeliveryUrl(b.changeUrl);
    const delivery = await deliveryAction(() => deliveries.create(conv, b));
    return c.json(delivery, 201);
  });

  app.patch("/api/deliveries/:id", async (c) => {
    const { delivery } = assertDeliveryWorkspace(
      currentWorkspace(c).id,
      c.req.param("id"),
    );
    const b = (await c.req.json()) as {
      changeUrl?: string | null;
      externalId?: string | null;
      headBranch?: string | null;
      baseBranch?: string | null;
      checkStatus?: DeliveryCheckStatus;
    };
    if (
      b.checkStatus !== undefined &&
      !DELIVERY_CHECK_STATUSES.includes(b.checkStatus)
    ) {
      bad(`checkStatus 可选 ${DELIVERY_CHECK_STATUSES.join("/")}`);
    }
    if (b.changeUrl !== undefined && b.changeUrl !== null)
      validateDeliveryUrl(b.changeUrl);
    return c.json(await deliveryAction(() => deliveries.update(delivery, b)));
  });

  app.post("/api/deliveries/:id/merge", async (c) => {
    const { delivery, conversation: conv } = assertDeliveryWorkspace(
      currentWorkspace(c).id,
      c.req.param("id"),
    );
    const b = (await c.req.json()) as {
      confirmed?: boolean;
      mergedRevision?: string;
    };
    rejectUnknownFields(b as Record<string, unknown>, [
      "confirmed",
      "mergedRevision",
    ]);
    const fresh = await deliveryAction(() =>
      deliveries.merge(delivery, conv, b, Date.now(), undefined, requestPrincipal(c, conv.workspaceId)),
    );
    finalizeDelivery(fresh);
    return c.json(store.getDelivery(fresh.id));
  });

  app.post("/api/deliveries/:id/refresh", async (c) => {
    const { delivery } = assertDeliveryWorkspace(
      currentWorkspace(c).id,
      c.req.param("id"),
    );
    const conversation = store.getConversation(delivery.conversationId);
    if (!conversation) throw new HTTPException(404, { message: "Delivery Issue 不存在" });
    const fresh = await deliveryAction(() => deliveries.refresh(
      delivery,
      Date.now(),
      requestPrincipal(c, conversation.workspaceId),
    ));
    finalizeDelivery(fresh);
    return c.json(store.getDelivery(fresh.id));
  });

  app.post("/api/deliveries/:id/sync", async (c) => {
    const { delivery, conversation: conv } = assertDeliveryWorkspace(currentWorkspace(c).id, c.req.param("id"));
    const fresh = await deliveryAction(() => deliveries.sync(
      delivery,
      conv,
      Date.now(),
      undefined,
      requestPrincipal(c, conv.workspaceId),
    ));
    finalizeDelivery(fresh);
    return c.json(store.getDelivery(fresh.id));
  });

  app.post("/api/conversations/:id/approve", (c) => {
    const conv = assertConversationWorkspace(
      currentWorkspace(c).id,
      c.req.param("id"),
    );
    if (conv.kind !== "issue" || conv.status !== "review")
      bad("只有 Review 中的 Issue 可以验收完成");
    if (store.activeRunForConversation(conv.id))
      bad("仍有 Run 进行中，不能完成验收");
    const delivery = store.getDeliveryForConversation(conv.id);
    if (delivery) {
      try {
        const fresh = deliveries.approve(delivery, conv);
        finalizeDelivery(fresh);
      } catch (error) {
        bad(error instanceof Error ? error.message : String(error));
      }
      return c.json(store.getConversation(conv.id));
    }
    transitionConversation(store, conv, "done", "human", Date.now());
    const fresh = store.getConversation(conv.id)!;
    coordinator.requestWorktreeCleanup(fresh);
    return c.json(fresh);
  });

  app.post("/api/conversations/:id/cancel", (c) => {
    const conv = assertConversationWorkspace(
      currentWorkspace(c).id,
      c.req.param("id"),
    );
    if (conv.kind !== "issue") bad("chat 不能取消为 Issue 终态");
    const active = store.activeRunForConversation(conv.id);
    if (active) coordinator.cancelRun(active.id);
    transitionConversation(
      store,
      store.getConversation(conv.id)!,
      "canceled",
      "human",
      Date.now(),
    );
    const fresh = store.getConversation(conv.id)!;
    coordinator.requestWorktreeCleanup(fresh);
    return c.json(fresh);
  });

  /**
   * Chat 没有 Issue 终态；管理员可在无 active Run 时显式释放它的 worktree。
   * Conversation/Run 历史保留，只有 daemon 回报实际删除成功后才清空 worktree binding。
   */
  app.post("/api/conversations/:id/worktree/cleanup", (c) => {
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    const conv = assertConversationWorkspace(workspace.id, c.req.param("id"));
    if (conv.kind !== "chat") bad("只有 Chat 支持显式 worktree cleanup");
    if (store.activeRunForConversation(conv.id)) bad("仍有 Run 进行中，不能清理 Chat worktree");
    if (!conv.worktreePath || !conv.worktreeMountId) {
      return c.json({ conversation: conv, cleanupRequested: false });
    }
    if (!coordinator.requestWorktreeCleanup(conv)) {
      bad("Chat worktree cleanup 未送达目标 Device，请在设备恢复在线后重试");
    }
    return c.json({ conversation: conv, cleanupRequested: true }, 202);
  });

  // ---- runs ----

  app.get("/api/runs/:id", (c) => {
    const run = assertRunWorkspace(currentWorkspace(c).id, c.req.param("id"));
    return c.json(run);
  });

  app.post("/api/runs/:id/cancel", (c) => {
    const run = assertRunWorkspace(currentWorkspace(c).id, c.req.param("id"));
    return c.json(coordinator.cancelRun(run.id));
  });

  // ---- approvals（P2 审批链路） ----

  app.get("/api/approvals", (c) => {
    const workspace = currentWorkspace(c);
    const status = c.req.query("status") as
      import("../protocol.js").ApprovalStatus | undefined;
    return c.json(
      store
        .listApprovals(status)
        .filter(
          (approval) =>
            store.getRun(approval.runId)?.workspaceId === workspace.id,
        ),
    );
  });

  app.post("/api/approvals/:id", async (c) => {
    const workspace = currentWorkspace(c);
    const a = store.resolveApprovalPrefix(c.req.param("id"));
    if (!a || store.getRun(a.runId)?.workspaceId !== workspace.id)
      throw new HTTPException(404, {
        message: `approval "${c.req.param("id")}" 不存在`,
      });
    const b = (await c.req.json()) as { behavior?: string };
    if (b.behavior !== "allow" && b.behavior !== "deny")
      bad(`behavior 只支持 allow/deny（收到 "${b.behavior}"）`);
    const decided = approvals.decide(a.id, b.behavior, "cli");
    return c.json(decided);
  });

  // ---- automations ----

  type AutomationTriggerInput =
    | { type: "schedule"; cron: string; timezone: string }
    | { type: "codebase"; repositoryId: string; codebaseEvent: CodebaseAutomationEvent };

  const parseAutomationOutput = (value: unknown, fallback: AutomationOutput): AutomationOutput => {
    const output = value ?? fallback;
    if (output !== "run" && output !== "chat" && output !== "issue") {
      bad(`output 可选 run/chat/issue（收到 "${String(output)}"）`);
    }
    return output;
  };

  const parseAutomationTrigger = (
    workspaceId: string,
    agent: NonNullable<ReturnType<HarborStore["getAgent"]>>,
    value: unknown,
  ): AutomationTriggerInput => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      bad("trigger 需要是 Schedule 或 Codebase 配置");
    }
    const trigger = value as Record<string, unknown>;
    if (trigger.type === "schedule") {
      const cron = typeof trigger.cron === "string" ? trigger.cron.trim() : "";
      const timezone = typeof trigger.timezone === "string" && trigger.timezone.trim()
        ? trigger.timezone.trim()
        : "Asia/Shanghai";
      if (!cron) bad("Schedule trigger 缺少 cron");
      try {
        AutomationService.validateCron(cron, timezone);
      } catch (error) {
        bad(error instanceof Error ? error.message : String(error));
      }
      const repository = store.getRepository(agent.repositoryId);
      if (!repository || repository.archivedAt) {
        bad(`Agent "${agent.name}" 的 Repository 不存在或已归档`);
      }
      if (!store.getRepositoryMountForDevice(repository.id, agent.deviceId)) {
        bad(`Repository "${repository.name}" 尚未挂载到 Agent "${agent.name}" 的设备`);
      }
      return { type: "schedule", cron, timezone };
    }
    if (trigger.type === "codebase") {
      const repositoryKey = typeof trigger.repository === "string"
        ? trigger.repository.trim()
        : typeof trigger.repositoryId === "string"
          ? trigger.repositoryId.trim()
          : "";
      if (!repositoryKey) bad("Codebase trigger 缺少 Repository");
      const repository = scopedRepository(workspaceId, repositoryKey);
      if (!repository || repository.archivedAt) {
        bad(`Repository "${repositoryKey}" 不存在或已归档`);
      }
      if (!agent.repositoryIds.includes(repository.id)) {
        bad(`Agent "${agent.name}" 未绑定 Repository "${repository.name}"`);
      }
      if (!store.getRepositoryMountForDevice(repository.id, agent.deviceId)) {
        bad(`Repository "${repository.name}" 尚未挂载到 Agent "${agent.name}" 的设备`);
      }
      const codebaseEvent = (trigger.event ?? trigger.codebaseEvent) as CodebaseAutomationEvent | undefined;
      if (!codebaseEvent || !CODEBASE_AUTOMATION_EVENTS.includes(codebaseEvent)) {
        bad(`Codebase event 可选 ${CODEBASE_AUTOMATION_EVENTS.join("/")}`);
      }
      return { type: "codebase", repositoryId: repository.id, codebaseEvent };
    }
    bad(`trigger.type 可选 schedule/codebase（收到 "${String(trigger.type)}"）`);
  };

  app.get("/api/automations", (c) => {
    const workspace = currentWorkspace(c);
    const agentNames = new Map(
      store.listAgents(true, workspace.id).map((agent) => [agent.id, agent.name]),
    );
    return c.json(
      store.listAutomations(workspace.id).map((automation) => ({
        ...automation,
        agentName: agentNames.get(automation.agentId) ?? automation.agentId,
      })),
    );
  });

  app.post("/api/automations", async (c) => {
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    const body = (await c.req.json()) as {
      name?: string;
      agent?: string;
      prompt?: string;
      output?: AutomationOutput;
      trigger?: unknown;
      enabled?: boolean;
      purpose?: unknown;
      outputMode?: unknown;
      overlapMode?: unknown;
      target?: unknown;
      notifyChat?: unknown;
    };
    if (
      body.purpose !== undefined ||
      body.outputMode !== undefined ||
      body.overlapMode !== undefined ||
      body.target !== undefined ||
      body.notifyChat !== undefined
    ) {
      bad("Purpose/OutputMode/Overlap/Target/notifyChat 已退出 Automation API；请使用 output=run|chat|issue");
    }
    const name = body.name?.trim() ?? "";
    if (!name) bad("缺少 name");
    if (store.listAutomations(workspace.id).some((candidate) => candidate.name === name)) {
      bad(`automation 名 "${name}" 已存在于当前 Workspace`);
    }
    const prompt = body.prompt?.trim() ?? "";
    if (!prompt) bad("缺少 prompt");
    const agent = scopedAgent(c, workspace.id, body.agent);
    if (!agent || agent.archivedAt) {
      bad(`agent "${body.agent ?? ""}" 不存在或已归档`);
    }
    const output = parseAutomationOutput(body.output, "run");
    const trigger = parseAutomationTrigger(workspace.id, agent, body.trigger);
    const automation = store.createAutomation({
      workspaceId: workspace.id,
      name,
      agentId: agent.id,
      prompt,
      output,
      trigger,
    }, Date.now());
    if (body.enabled === false) {
      store.setAutomationEnabled(automation.id, false);
    } else {
      automations.schedule(automation);
    }
    return c.json(store.getAutomation(automation.id), 201);
  });

  app.patch("/api/automations/:id", async (c) => {
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    const automation = store.resolveAutomationPrefix(c.req.param("id"), workspace.id);
    if (!automation) {
      throw new HTTPException(404, {
        message: `automation "${c.req.param("id")}" 不存在`,
      });
    }
    const body = (await c.req.json()) as {
      name?: string;
      agent?: string;
      prompt?: string;
      output?: AutomationOutput;
      trigger?: unknown;
      enabled?: boolean;
      purpose?: unknown;
      outputMode?: unknown;
      overlapMode?: unknown;
      target?: unknown;
      notifyChat?: unknown;
    };
    if (
      body.purpose !== undefined ||
      body.outputMode !== undefined ||
      body.overlapMode !== undefined ||
      body.target !== undefined ||
      body.notifyChat !== undefined
    ) {
      bad("Purpose/OutputMode/Overlap/Target/notifyChat 已退出 Automation API");
    }
    const name = body.name === undefined ? automation.name : body.name.trim();
    if (!name) bad("name 不能为空");
    if (store.listAutomations(workspace.id).some(
      (candidate) => candidate.id !== automation.id && candidate.name === name,
    )) {
      bad(`automation 名 "${name}" 已存在于当前 Workspace`);
    }
    const prompt = body.prompt === undefined ? automation.prompt : body.prompt.trim();
    if (!prompt) bad("prompt 不能为空");
    const agent = body.agent === undefined
      ? store.getAgent(automation.agentId)
      : scopedAgent(c, workspace.id, body.agent);
    if (!agent || agent.archivedAt) {
      bad(`agent "${body.agent ?? automation.agentId}" 不存在或已归档`);
    }
    const output = parseAutomationOutput(body.output, automation.output);
    const currentTrigger = automation.trigger.type === "schedule"
      ? {
          type: "schedule" as const,
          cron: automation.trigger.cron!,
          timezone: automation.trigger.timezone!,
        }
      : {
          type: "codebase" as const,
          repositoryId: automation.trigger.repositoryId!,
          codebaseEvent: automation.trigger.codebaseEvent!,
        };
    const trigger = body.trigger === undefined
      ? parseAutomationTrigger(
          workspace.id,
          agent,
          currentTrigger.type === "schedule"
            ? currentTrigger
            : {
                type: "codebase",
                repositoryId: currentTrigger.repositoryId,
                event: currentTrigger.codebaseEvent,
              },
        )
      : parseAutomationTrigger(workspace.id, agent, body.trigger);

    automations.unschedule(automation.id);
    const fresh = store.updateAutomationDefinition(
      automation.id,
      {
        name,
        agentId: agent.id,
        prompt,
        output,
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      },
      trigger,
      Date.now(),
    );
    if (fresh.enabled) automations.schedule(fresh);
    return c.json(fresh);
  });

  app.post("/api/automations/:id/run", (c) => {
    const workspace = currentWorkspace(c);
    const automation = store.resolveAutomationPrefix(c.req.param("id"), workspace.id);
    if (!automation) {
      throw new HTTPException(404, {
        message: `automation "${c.req.param("id")}" 不存在`,
      });
    }
    try {
      return c.json(automations.runNow(automation.id), 201);
    } catch (error) {
      bad(error instanceof Error ? error.message : String(error));
    }
  });

  app.delete("/api/automations/:id", (c) => {
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    const automation = store.resolveAutomationPrefix(c.req.param("id"), workspace.id);
    if (!automation) {
      throw new HTTPException(404, {
        message: `automation "${c.req.param("id")}" 不存在`,
      });
    }
    automations.unschedule(automation.id);
    store.deleteAutomation(automation.id);
    return c.json({ ok: true });
  });

  app.get("/api/automations/:id/log", (c) => {
    const workspace = currentWorkspace(c);
    const automation = store.resolveAutomationPrefix(c.req.param("id"), workspace.id);
    if (!automation) {
      throw new HTTPException(404, {
        message: `automation "${c.req.param("id")}" 不存在`,
      });
    }
    return c.json(store.listAutomationLog(automation.id));
  });
  // ---- usage（P3 报表） ----

  app.get("/api/usage", (c) => {
    const workspace = currentWorkspace(c);
    const days = Math.max(1, Number(c.req.query("days") ?? 7));
    const fromTs = Date.now() - days * 24 * 3600 * 1000;
    return c.json(store.usageAggregate(fromTs, workspace.id));
  });

  app.get("/api/usage/runs", (c) => {
    const workspace = currentWorkspace(c);
    const days = Math.max(1, Number(c.req.query("days") ?? 7));
    const fromTs = Date.now() - days * 24 * 3600 * 1000;
    const agentQ = c.req.query("agent");
    let agentId: string | undefined;
    if (agentQ) {
      const agent = scopedAgent(c, workspace.id, agentQ);
      if (!agent) bad(`agent "${agentQ}" 不存在`);
      agentId = agent.id;
    }
    return c.json(
      store.listRunsForUsage({
        workspaceId: workspace.id,
        agentId,
        day: c.req.query("day"),
        fromTs,
      }),
    );
  });

  // SSE：回放 run_events 已有行 → 实时直播 → run 终态发 done 帧收流。
  // 先订阅（缓冲）再回放，seq 去重弥合两段之间的竞态窗口。
  app.get("/api/runs/:id/events", (c) => {
    const run = assertRunWorkspace(currentWorkspace(c).id, c.req.param("id"));

    let unsub: (() => void) | null = null;
    let ping: ReturnType<typeof setInterval> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        let closed = false;
        const finish = () => {
          if (closed) return;
          closed = true;
          unsub?.();
          if (ping) clearInterval(ping);
          try {
            controller.close();
          } catch {}
        };
        const send = (frame: RunStreamFrame) => {
          if (closed) return;
          try {
            controller.enqueue(
              enc.encode(`data: ${JSON.stringify(frame)}\n\n`),
            );
          } catch {
            finish();
          }
        };

        let maxSeq = 0;
        const seenApprovalFrames = new Set<string>(); // 回放/直播竞态去重
        let replaying = true;
        const pending: RunStreamFrame[] = [];
        const deliver = (frame: RunStreamFrame) => {
          if (frame.kind === "event") {
            if (frame.seq <= maxSeq) return;
            maxSeq = frame.seq;
            send(frame);
          } else if (
            frame.kind === "approval" ||
            frame.kind === "approval_decided"
          ) {
            const key =
              frame.kind === "approval"
                ? `a:${frame.approval.id}:${frame.approval.status}`
                : `d:${frame.approvalId}:${frame.status}`;
            if (seenApprovalFrames.has(key)) return;
            seenApprovalFrames.add(key);
            send(frame);
          } else {
            send(frame);
            finish();
          }
        };
        unsub = bus.subscribe(run.id, (frame) => {
          if (replaying) pending.push(frame);
          else deliver(frame);
        });

        for (const row of store.listRunEvents(run.id)) {
          maxSeq = row.seq;
          send({ kind: "event", seq: row.seq, event: row.event });
        }
        replaying = false;

        const fresh = store.getRun(run.id)!;
        if (fresh.status !== "queued" && fresh.status !== "running") {
          send({ kind: "done", run: fresh });
          finish();
          return;
        }
        // 还挂着的审批先补一帧（watch 中途连上也能看到「等审批」）
        for (const a of store.pendingApprovalsForRun(run.id)) {
          deliver({ kind: "approval", approval: a });
        }
        for (const f of pending) deliver(f);
        // 长空窗（模型思考/排队）保活注释帧
        ping = setInterval(() => {
          if (!closed) {
            try {
              controller.enqueue(enc.encode(`: ping\n\n`));
            } catch {
              finish();
            }
          }
        }, 15_000);
      },
      cancel() {
        unsub?.();
        if (ping) clearInterval(ping);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  // ---- Web 静态产物（P4.5）：非 /api|/ws 路径全部映射到 apps/harbor-web/out/ ----
  // 页面壳不鉴权（API 全鉴权），miss fallback index.html（客户端路由用 query param，理论不触发）。
  app.get("*", async (c) => {
    const pathname = decodeURIComponent(new URL(c.req.url).pathname);
    if (pathname.startsWith("/api/") || pathname === "/ws") {
      throw new HTTPException(404, { message: "not found" });
    }
    if (!existsSync(WEB_OUT)) {
      return c.text(
        "harbor-web 未构建：bun run --filter harbor-web build（产物 apps/harbor-web/out/）",
        503,
      );
    }
    const target = resolve(WEB_OUT, "." + pathname);
    if (target !== WEB_OUT && !target.startsWith(WEB_OUT + "/")) {
      throw new HTTPException(403, { message: "forbidden" });
    }
    // 精确文件（/_next/... 静态资源）→ .html 补全（/chats → chats.html）→ 目录 index.html（/）
    for (const p of [target, `${target}.html`, join(target, "index.html")]) {
      const f = Bun.file(p);
      if (await f.exists()) {
        // 带 hash 的产物永久缓存；html 每次校验（部署新版立即生效）
        const cache = pathname.startsWith("/_next/")
          ? "public, max-age=31536000, immutable"
          : "no-cache";
        return new Response(f, { headers: { "Cache-Control": cache } });
      }
    }
    return new Response(Bun.file(join(WEB_OUT, "index.html")), {
      headers: { "Cache-Control": "no-cache" },
    });
  });

  return app;
}

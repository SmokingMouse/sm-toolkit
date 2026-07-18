/**
 * REST 入口层（Hono）：devices/agents/conversations/runs/approvals/automations/usage
 * CRUD + run 事件 SSE + Bearer token auth + 只读看板（GET /）。
 * 语义校验尽量前置到这一层（fail loudly at 配置时而非运行时）：
 *   - agent create 校验 model ∈ device 能力清单（harbor.md §8「endpoints.yaml 各机不一致」对策）
 *   - automation create 校验 cron 表达式 / agent 存在 / append 模式 target 存在
 */

import { existsSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join, resolve } from "node:path";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type {
  BackendKind,
  AutomationOutputMode,
  AutomationOverlapMode,
  AutomationTriggerType,
  AutomationWebhookFilter,
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
  RunPurpose,
  RunStreamFrame,
  WorkspaceMember,
  WorkspaceRole,
} from "../protocol.js";
import {
  AUTOMATION_EVENT_TYPES,
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
import type { RunCoordinator } from "./scheduler.js";
import type { ApprovalService } from "./approvals.js";
import { AutomationService, hashWebhookSecret } from "./automation.js";
import { inactiveMaintenanceGuard, matchesRevisionAwareHealth, type MaintenanceGuard } from "./maintenance.js";
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
): Hono {
  const app = new Hono();
  type ApiActor =
    { kind: "system" } | { kind: "member"; member: WorkspaceMember };
  const actors = new WeakMap<Request, ApiActor>();
  const requestActor = (c: Context): ApiActor =>
    actors.get(c.req.raw) ?? { kind: "system" };

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
    const key =
      c.req.header("X-Harbor-Workspace")?.trim() ||
      (actor.kind === "member"
        ? actor.member.workspaceId
        : DEFAULT_WORKSPACE_ID);
    const workspace = store.resolveWorkspace(key);
    if (!workspace || workspace.archivedAt)
      bad(`workspace "${key}" 不存在或已归档`);
    if (actor.kind === "member" && actor.member.workspaceId !== workspace.id) {
      throw new HTTPException(403, {
        message: "当前 token 不属于该 Workspace",
      });
    }
    return workspace;
  };

  const requireRole = (
    c: Context,
    workspaceId: string,
    minimum: "member" | "admin" | "owner",
  ) => {
    const actor = requestActor(c);
    if (actor.kind === "system") return null;
    if (
      actor.member.workspaceId !== workspaceId ||
      actor.member.status !== "active"
    ) {
      throw new HTTPException(403, { message: "Workspace 访问被拒绝" });
    }
    const rank: Record<WorkspaceRole, number> = {
      member: 1,
      admin: 2,
      owner: 3,
    };
    if (rank[actor.member.role] < rank[minimum]) {
      throw new HTTPException(403, {
        message: `需要 ${minimum} 权限（当前 ${actor.member.role}）`,
      });
    }
    return actor.member;
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
    return (
      actor.kind === "system" ||
      actor.member.role === "owner" ||
      actor.member.role === "admin" ||
      actor.member.id === agent.createdByMemberId
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
    return store.appendConversationMessage(
      conversationId,
      {
        authorType: actor.kind === "member" ? "member" : "system",
        authorId: actor.kind === "member" ? actor.member.id : null,
        authorName: actor.kind === "member" ? actor.member.name : "Local owner",
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

  /** 外部 Trigger 入口：不走 Harbor Bearer auth，只认每个 webhook Trigger 的独立 secret。 */
  app.post("/hooks/automations/:triggerId", async (c) => {
    const contentLength = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > 256 * 1024) {
      return c.json({ error: "webhook payload 超过 256KB" }, 413);
    }
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "webhook body 必须是 JSON object" }, 400);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return c.json({ error: "webhook body 必须是 JSON object" }, 400);
    }
    const payload = raw as Record<string, unknown>;
    if (JSON.stringify(payload).length > 256 * 1024) {
      return c.json({ error: "webhook payload 超过 256KB" }, 413);
    }
    const authorization = c.req.header("authorization") ?? "";
    const secret =
      c.req.header("x-harbor-webhook-secret") ??
      (authorization.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : "");
    const eventType =
      c.req.header("x-harbor-event") ??
      c.req.header("x-codebase-event") ??
      (typeof payload.event === "string" ? payload.event : null) ??
      (typeof payload.type === "string" ? payload.type : "unknown");
    const eventId =
      c.req.header("x-harbor-delivery") ??
      c.req.header("x-codebase-delivery") ??
      c.req.header("x-request-id") ??
      (typeof payload.delivery_id === "string" ? payload.delivery_id : null);
    if (
      secret.length > 512 ||
      eventType.length > 200 ||
      (eventId?.length ?? 0) > 512
    ) {
      return c.json({ error: "webhook header 超过长度限制" }, 400);
    }
    try {
      const result = automations.receiveWebhook(c.req.param("triggerId"), {
        secret,
        eventType,
        eventId,
        payload,
      });
      if (result.status === "started") return c.json(result, 202);
      if (
        result.status === "ignored" &&
        result.reason === "webhook trigger 不存在"
      ) {
        return c.json({ error: result.reason }, 404);
      }
      return c.json(result, 200);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "webhook secret 不正确")
        return c.json({ error: message }, 401);
      throw error;
    }
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

  const runActionContext = (c: Context) => {
    const authorization = c.req.header("authorization") ?? "";
    const raw = authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";
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
    const agent = store.getAgent(run.agentId);
    if (!agent || agent.workspaceId !== run.workspaceId) {
      throw new HTTPException(409, { message: "run agent 不存在" });
    }
    const conversation = run.conversationId
      ? store.getConversation(run.conversationId)
      : null;
    return { run, agent, conversation };
  };

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
      const dispatched = coordinator.enqueueRun(issue, assignee, prompt, "implementation");
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
      deploymentRequired?: boolean;
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
          deploymentRequired: body.deploymentRequired ?? true,
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
        delivery = await deliveries.sync(delivery, conversation, now, run.id);
      } else if (delivery.provider === "codebase") {
        delivery = await deliveries.refresh(delivery, now);
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

  app.use("/api/*", async (c, next) => {
    const auth = c.req.header("Authorization");
    const raw = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
    if (raw === expectedToken) {
      actors.set(c.req.raw, { kind: "system" });
    } else {
      const member = raw
        ? store.memberForApiToken(
            createHash("sha256").update(raw).digest("hex"),
            Date.now(),
          )
        : null;
      if (member) actors.set(c.req.raw, { kind: "member", member });
    }
    if (!actors.has(c.req.raw)) {
      return c.json(
        { error: "unauthorized（Authorization: Bearer <HARBOR_TOKEN>）" },
        401,
      );
    }
    await next();
  });

  app.get("/api/deployment-targets", (c) => c.json(deliveries.listDeploymentTargets()));

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
    return c.json({ kind: "member", member: actor.member });
  });

  app.get("/api/members", (c) => {
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "member");
    return c.json(store.listWorkspaceMembers(workspace.id));
  });

  app.post("/api/members", async (c) => {
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    const b = (await c.req.json()) as {
      name?: string;
      email?: string;
      role?: WorkspaceRole;
      externalProvider?: WorkspaceMember["externalProvider"];
      externalId?: string;
    };
    if (!b.name?.trim()) bad("缺少 member name");
    if (b.role !== undefined && !["owner", "admin", "member"].includes(b.role))
      bad("role 可选 owner/admin/member");
    if (b.role === "owner") requireRole(c, workspace.id, "owner");
    return c.json(
      store.createWorkspaceMember(
        {
          workspaceId: workspace.id,
          name: b.name.trim(),
          email: b.email?.trim() || null,
          role: b.role ?? "member",
          externalProvider: b.externalProvider ?? "local",
          externalId: b.externalId?.trim() || null,
        },
        Date.now(),
      ),
      201,
    );
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
      !["active", "invited", "disabled"].includes(b.status)
    )
      bad("status 可选 active/invited/disabled");
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
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    return c.json(store.listWorkspaceApiTokens(workspace.id));
  });

  app.post("/api/members/:id/tokens", async (c) => {
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    const member = store.getWorkspaceMember(c.req.param("id"));
    if (
      !member ||
      member.workspaceId !== workspace.id ||
      member.status !== "active"
    )
      bad("只能给当前 Workspace 的 active member 创建 token");
    const b = (await c.req.json()) as { label?: string };
    const raw = `harbor_${randomBytes(24).toString("base64url")}`;
    const id = store.createWorkspaceApiToken(
      workspace.id,
      member.id,
      b.label?.trim() || "Personal access token",
      createHash("sha256").update(raw).digest("hex"),
      Date.now(),
    );
    return c.json({ id, token: raw }, 201);
  });

  app.delete("/api/member-tokens/:id", (c) => {
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    const token = store
      .listWorkspaceApiTokens(workspace.id)
      .find((candidate) => candidate.id === c.req.param("id"));
    if (!token) throw new HTTPException(404, { message: "token 不存在" });
    store.revokeWorkspaceApiToken(token.id, Date.now());
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
        : [store.getWorkspace(actor.member.workspaceId)!],
    );
  });

  app.post("/api/workspaces", async (c) => {
    requireSystem(c);
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
      { name, slug, description: b.description?.trim() || null },
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
          store.getDevice(mount.deviceId, hub.isOnline(mount.deviceId))?.name ??
          mount.deviceId,
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
    c.json(
      store.listDevices(hub.onlineIds()).map((device) => ({
        ...device,
        capabilities: {
          ...device.capabilities,
          installedSkills: device.capabilities.installedSkills?.map(
            ({ instruction: _instruction, ...skill }) => skill,
          ),
        },
      })),
    ),
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
      bundle = await skillImports.fromGitHub(b.url, b.ref);
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
      description?: string | null;
      model?: string | null;
      permission?: string;
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
      ...(b.description !== undefined
        ? { description: b.description?.trim() || null }
        : {}),
      ...(b.model !== undefined ? { model: b.model?.trim() || null } : {}),
      ...(b.permission !== undefined
        ? { permission: b.permission as import("@sm/agent").PermissionPolicy }
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
    const run = enqueue(
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
      deploymentJob: delivery?.activeDeploymentJobId
        ? store.getDeploymentJobView(delivery.activeDeploymentJobId)
        : null,
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
    const run = enqueue(conv, agent, b.prompt.trim(), purpose);
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
    return c.json(enqueue(conv, agent, prompt, "implementation"), 201);
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
      enqueue(conv, agent, b.feedback.trim(), "implementation"),
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
    return c.json(enqueue(conv, agent, prompt, "review"), 201);
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
    const run = enqueue(conv, agent, body, purpose, promptEvent, message.id);
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
      deploymentRequired?: boolean;
      deploymentTargetId?: string | null;
    };
    rejectUnknownFields(b as Record<string, unknown>, ["provider", "changeUrl", "externalId", "headBranch", "baseBranch", "deploymentRequired", "deploymentTargetId"]);
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
      deliveries.merge(delivery, conv, b),
    );
    finalizeDelivery(fresh);
    return c.json(store.getDelivery(fresh.id));
  });

  app.post("/api/deliveries/:id/refresh", async (c) => {
    const { delivery } = assertDeliveryWorkspace(
      currentWorkspace(c).id,
      c.req.param("id"),
    );
    const fresh = await deliveryAction(() => deliveries.refresh(delivery));
    finalizeDelivery(fresh);
    return c.json(store.getDelivery(fresh.id));
  });

  app.post("/api/deliveries/:id/sync", async (c) => {
    const { delivery, conversation: conv } = assertDeliveryWorkspace(currentWorkspace(c).id, c.req.param("id"));
    const fresh = await deliveryAction(() => deliveries.sync(delivery, conv));
    finalizeDelivery(fresh);
    return c.json(store.getDelivery(fresh.id));
  });

  app.post("/api/deliveries/:id/deploy", async (c) => {
    const { delivery, conversation: conv } = assertDeliveryWorkspace(
      currentWorkspace(c).id,
      c.req.param("id"),
    );
    const b = (await c.req.json()) as { confirmed?: boolean };
    rejectUnknownFields(b as Record<string, unknown>, ["confirmed"]);
    return c.json(
      await deliveryAction(() => deliveries.startDeployment(delivery, conv, b)),
    );
  });

  app.post("/api/deliveries/:id/deployment-result", async (c) => {
    const { delivery } = assertDeliveryWorkspace(
      currentWorkspace(c).id,
      c.req.param("id"),
    );
    const b = (await c.req.json()) as { status?: "succeeded" | "failed" };
    rejectUnknownFields(b as Record<string, unknown>, ["status"]);
    if (b.status !== "succeeded" && b.status !== "failed")
      bad("status 可选 succeeded/failed");
    const fresh = await deliveryAction(() =>
      deliveries.finishDeployment(delivery, b.status!),
    );
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

  // ---- automations（P3 cron） ----

  app.get("/api/automations", (c) => {
    const workspace = currentWorkspace(c);
    const agentNames = new Map(
      store.listAgents(true, workspace.id).map((a) => [a.id, a.name]),
    );
    return c.json(
      store.listAutomations(workspace.id).map((a) => ({
        ...a,
        agentName: agentNames.get(a.agentId) ?? a.agentId,
      })),
    );
  });

  app.post("/api/automations", async (c) => {
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    const b = (await c.req.json()) as {
      name?: string;
      agent?: string;
      triggerType?: AutomationTriggerType;
      cron?: string;
      provider?: string;
      events?: unknown;
      filters?: unknown;
      prompt?: string;
      purpose?: RunPurpose;
      outputMode?: AutomationOutputMode;
      overlapMode?: AutomationOverlapMode;
      /** 旧客户端兼容。 */
      mode?: string;
      target?: string;
      notifyChat?: string;
      repository?: unknown;
    };
    if (b.repository !== undefined)
      bad("Automation 的 Repository 由 Agent 决定，请修改 Agent 配置");
    const name = b.name?.trim() ?? "";
    if (!name) bad("缺少 name");
    if (
      store
        .listAutomations(workspace.id)
        .some((automation) => automation.name === name)
    ) {
      bad(`automation 名 "${name}" 已存在于当前 Workspace`);
    }
    if (!b.prompt?.trim()) bad("缺少 prompt");
    const agent = scopedAgent(c, workspace.id, b.agent);
    if (!agent) bad(`agent "${b.agent}" 不存在（harbor agent ls 查看）`);
    if (agent.archivedAt) bad(`agent "${agent.name}" 已归档`);

    const triggerType = b.triggerType ?? "schedule";
    if (triggerType !== "schedule" && triggerType !== "webhook" && triggerType !== "event") {
      bad(`triggerType 可选 schedule/webhook/event（收到 "${b.triggerType}"）`);
    }
    let webhookSecret: string | null = null;
    let filters: AutomationWebhookFilter[] = [];
    let events: string[] = [];
    if (triggerType === "schedule") {
      if (!b.cron?.trim())
        bad("schedule trigger 缺少 cron（5 段标准 cron 表达式）");
      try {
        AutomationService.validateCron(b.cron.trim());
      } catch (e) {
        bad(
          `cron 表达式非法："${b.cron}"（${e instanceof Error ? e.message : e}）`,
        );
      }
    } else {
      if (
        b.events !== undefined &&
        (!Array.isArray(b.events) ||
          b.events.some((value) => typeof value !== "string"))
      ) {
        bad("events 必须是 string[]");
      }
      events = [
        ...new Set(
          ((b.events as string[] | undefined) ?? [])
            .map((event) => event.trim())
            .filter(Boolean),
        ),
      ];
      if (b.filters !== undefined && !Array.isArray(b.filters))
        bad("filters 必须是数组");
      filters = (
        (b.filters as AutomationWebhookFilter[] | undefined) ?? []
      ).map((filter) => {
        if (
          !filter ||
          typeof filter !== "object" ||
          typeof filter.path !== "string" ||
          !filter.path.trim()
        ) {
          bad("每个 webhook filter 都需要非空 path");
        }
        if (
          !["string", "number", "boolean"].includes(typeof filter.equals) &&
          filter.equals !== null
        ) {
          bad("webhook filter.equals 只支持 string/number/boolean/null");
        }
        return { path: filter.path.trim(), equals: filter.equals };
      });
      if (triggerType === "event" && events.length === 0) {
        bad("event trigger 至少需要一个 Harbor event type");
      }
      if (
        triggerType === "event" &&
        events.some((event) => !AUTOMATION_EVENT_TYPES.includes(event as (typeof AUTOMATION_EVENT_TYPES)[number]))
      ) {
        bad(`Harbor event 可选 ${AUTOMATION_EVENT_TYPES.join(", ")}`);
      }
      webhookSecret = triggerType === "webhook" ? randomBytes(24).toString("base64url") : null;
    }

    const legacyOutput =
      b.mode === "append" ? "append" : b.mode === "new_issue" ? "issue" : null;
    const outputMode = b.outputMode ?? legacyOutput ?? "run";
    if (!["run", "chat", "issue", "append", "source"].includes(outputMode)) {
      bad(`outputMode 可选 run/chat/issue/append/source（收到 "${outputMode}"）`);
    }
    const purpose = b.purpose ?? "implementation";
    if (!RUN_PURPOSES.includes(purpose)) bad(`purpose 可选 ${RUN_PURPOSES.join("/")}`);
    if (purpose === "triage") bad("Automation 不直接创建 Issue draft，purpose 不能是 triage");
    if ((outputMode === "chat" || outputMode === "issue") && purpose !== "implementation") {
      bad(`${outputMode} output 只支持 implementation purpose`);
    }
    if (purpose === "review" && outputMode !== "source" && outputMode !== "append") {
      bad("review purpose 需要 source 或 append conversation output");
    }
    if (outputMode === "source" && triggerType !== "event") {
      bad("source output 只接受 Harbor event trigger");
    }
    const overlapMode = b.overlapMode ?? "skip";
    if (overlapMode !== "skip" && overlapMode !== "queue") {
      bad(`overlapMode 可选 skip/queue（收到 "${b.overlapMode}"）`);
    }
    if (outputMode === "run" && agent.isolation === "worktree") {
      bad(
        "outputMode=run 当前要求 Agent isolation=none；需要 worktree 时请选择 chat/issue 输出",
      );
    }
    let targetId: string | null = null;
    if (outputMode === "append") {
      if (!b.target) bad("outputMode=append 需要 target conversation");
      const target = store.resolveConversationPrefix(b.target);
      if (!target || target.workspaceId !== workspace.id)
        bad(`target conversation "${b.target}" 不存在于当前 Workspace`);
      if (target.repositoryId && target.repositoryId !== agent.repositoryId) {
        bad("append target 与 Agent 绑定的 Repository 不一致");
      }
      targetId = target.id;
    }
    const repository = store.getRepository(agent.repositoryId);
    if (!repository || repository.archivedAt)
      bad(`Agent "${agent.name}" 的 Repository 不存在或已归档`);
    if (!store.getRepositoryMountForDevice(repository.id, agent.deviceId)) {
      bad(
        `Repository "${repository.name}" 尚未挂载到 Agent "${agent.name}" 的设备`,
      );
    }
    const auto = store.createAutomation(
      {
        workspaceId: workspace.id,
        name,
        agentId: agent.id,
        repositoryId: repository.id,
        prompt: b.prompt.trim(),
        purpose,
        outputMode,
        overlapMode,
        targetConversationId: targetId,
        notifyChatId: b.notifyChat ?? null,
        triggers: [
          {
            type: triggerType,
            cron: triggerType === "schedule" ? b.cron!.trim() : null,
            provider:
              triggerType === "webhook"
                ? b.provider?.trim() || "generic"
                : triggerType === "event"
                  ? "harbor"
                  : null,
            events,
            filters,
            secretHash: webhookSecret ? hashWebhookSecret(webhookSecret) : null,
          },
        ],
      },
      Date.now(),
    );
    automations.schedule(auto);
    return c.json(
      { ...auto, ...(webhookSecret ? { webhookSecret } : {}) },
      201,
    );
  });

  app.patch("/api/automations/:id", async (c) => {
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    const auto = store.resolveAutomationPrefix(c.req.param("id"), workspace.id);
    if (!auto || auto.workspaceId !== workspace.id)
      throw new HTTPException(404, {
        message: `automation "${c.req.param("id")}" 不存在`,
      });
    const b = (await c.req.json()) as { enabled?: boolean };
    if (typeof b.enabled !== "boolean") bad("需要 enabled: true/false");
    store.setAutomationEnabled(auto.id, b.enabled);
    const fresh = store.getAutomation(auto.id)!;
    if (b.enabled) automations.schedule(fresh);
    else automations.unschedule(auto.id);
    return c.json(fresh);
  });

  app.post("/api/automations/:id/run", (c) => {
    const workspace = currentWorkspace(c);
    const auto = store.resolveAutomationPrefix(c.req.param("id"), workspace.id);
    if (!auto)
      throw new HTTPException(404, {
        message: `automation "${c.req.param("id")}" 不存在`,
      });
    try {
      return c.json(automations.runNow(auto.id), 201);
    } catch (error) {
      bad(error instanceof Error ? error.message : String(error));
    }
  });

  app.delete("/api/automations/:id", (c) => {
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    const auto = store.resolveAutomationPrefix(c.req.param("id"), workspace.id);
    if (!auto || auto.workspaceId !== workspace.id)
      throw new HTTPException(404, {
        message: `automation "${c.req.param("id")}" 不存在`,
      });
    automations.unschedule(auto.id);
    store.deleteAutomation(auto.id);
    return c.json({ ok: true });
  });

  app.get("/api/automations/:id/log", (c) => {
    const workspace = currentWorkspace(c);
    const auto = store.resolveAutomationPrefix(c.req.param("id"), workspace.id);
    if (!auto || auto.workspaceId !== workspace.id)
      throw new HTTPException(404, {
        message: `automation "${c.req.param("id")}" 不存在`,
      });
    return c.json(store.listAutomationLog(auto.id));
  });

  app.post("/api/automations/:id/triggers", async (c) => {
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    const auto = store.resolveAutomationPrefix(c.req.param("id"), workspace.id);
    if (!auto)
      throw new HTTPException(404, {
        message: `automation "${c.req.param("id")}" 不存在`,
      });
    const b = (await c.req.json()) as {
      type?: AutomationTriggerType;
      cron?: string;
      provider?: string;
      events?: string[];
      filters?: AutomationWebhookFilter[];
    };
    if (b.type !== "schedule" && b.type !== "webhook" && b.type !== "event")
      bad("type 可选 schedule/webhook/event");
    if (b.type === "schedule") {
      if (!b.cron?.trim()) bad("schedule trigger 缺少 cron");
      try {
        AutomationService.validateCron(b.cron.trim());
      } catch (error) {
        bad(
          `cron 表达式非法：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (b.type === "event" && (!b.events || b.events.length === 0)) {
      bad("event trigger 至少需要一个 Harbor event type");
    }
    if (
      b.type === "event" &&
      b.events?.some((event) => !AUTOMATION_EVENT_TYPES.includes(event as (typeof AUTOMATION_EVENT_TYPES)[number]))
    ) {
      bad(`Harbor event 可选 ${AUTOMATION_EVENT_TYPES.join(", ")}`);
    }
    const secret = b.type === "webhook" ? randomBytes(24).toString("base64url") : null;
    const trigger = store.createAutomationTrigger(
      auto.id,
      {
        type: b.type,
        cron: b.cron?.trim() ?? null,
        provider: b.type === "event" ? "harbor" : b.provider?.trim() || "generic",
        events: b.events ?? [],
        filters: b.filters ?? [],
        secretHash: secret ? hashWebhookSecret(secret) : null,
      },
      Date.now(),
    );
    automations.schedule(store.getAutomation(auto.id)!);
    return c.json(
      { ...trigger, ...(secret ? { webhookSecret: secret } : {}) },
      201,
    );
  });

  app.delete("/api/automations/:id/triggers/:triggerId", (c) => {
    const workspace = currentWorkspace(c);
    requireRole(c, workspace.id, "admin");
    const auto = store.resolveAutomationPrefix(c.req.param("id"), workspace.id);
    const trigger = store.getAutomationTrigger(c.req.param("triggerId"));
    if (!auto || !trigger || trigger.automationId !== auto.id) {
      throw new HTTPException(404, { message: "automation trigger 不存在" });
    }
    store.deleteAutomationTrigger(trigger.id);
    automations.schedule(store.getAutomation(auto.id)!);
    return c.json({ ok: true });
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

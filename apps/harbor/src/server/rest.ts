/**
 * REST 入口层（Hono）：devices/agents/conversations/runs/approvals/automations/usage
 * CRUD + run 事件 SSE + Bearer token auth + 只读看板（GET /）。
 * 语义校验尽量前置到这一层（fail loudly at 配置时而非运行时）：
 *   - agent create 校验 model ∈ device 能力清单（harbor.md §8「endpoints.yaml 各机不一致」对策）
 *   - automation create 校验 cron 表达式 / agent 存在 / append 模式 target 存在
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type {
  BackendKind,
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
} from "../protocol.js";
import {
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
import { AutomationService } from "./automation.js";
import { inactiveMaintenanceGuard, matchesRevisionAwareHealth, type MaintenanceGuard } from "./maintenance.js";
import { transitionConversation } from "./statemachine.js";
import { DeliveryService } from "./delivery.js";
import {
  getPromptBlockConfig,
  listPromptBlockConfigs,
  PROMPT_BLOCK_KEYS,
  validatePromptTemplate,
} from "./prompt-wrapper.js";

const PERMISSIONS = ["readonly", "auto-edit", "full", "default"];
const MAX_SKILL_INSTRUCTION = 128 * 1024;
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
    if (url.protocol !== "http:" && url.protocol !== "https:") bad("MR/PR URL 只支持 http/https");
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    bad("MR/PR URL 格式不正确");
  }
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
  maintenance: MaintenanceGuard = inactiveMaintenanceGuard,
): Hono {
  const app = new Hono();

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
    const key = c.req.header("X-Harbor-Workspace")?.trim() || DEFAULT_WORKSPACE_ID;
    const workspace = store.resolveWorkspace(key);
    if (!workspace || workspace.archivedAt) bad(`workspace "${key}" 不存在或已归档`);
    return workspace;
  };

  const scopedAgent = (workspaceId: string, key: string | null | undefined) => {
    if (!key) return null;
    const agent = store.getAgent(key) ?? store.getAgentByNameInWorkspace(workspaceId, key);
    if (agent && agent.workspaceId !== workspaceId) bad(`agent "${key}" 不属于当前 Workspace`);
    return agent;
  };

  const scopedRepository = (workspaceId: string, key: string | null | undefined) => {
    if (!key) return null;
    const repository = store.resolveRepository(workspaceId, key);
    if (!repository || repository.archivedAt) bad(`repository "${key}" 不存在或已归档`);
    return repository;
  };

  const assertConversationWorkspace = (workspaceId: string, id: string) => {
    const conversation = store.resolveConversationPrefix(id);
    if (!conversation) throw new HTTPException(404, { message: `conversation "${id}" 不存在` });
    if (conversation.workspaceId !== workspaceId) throw new HTTPException(404, { message: `conversation "${id}" 不存在于当前 Workspace` });
    return conversation;
  };

  const assertRunWorkspace = (workspaceId: string, id: string) => {
    const run = store.resolveRunPrefix(id);
    if (!run || run.workspaceId !== workspaceId) throw new HTTPException(404, { message: `run "${id}" 不存在于当前 Workspace` });
    return run;
  };

  const assertDeliveryWorkspace = (workspaceId: string, id: string) => {
    const delivery = store.getDelivery(id);
    const conversation = delivery ? store.getConversation(delivery.conversationId) : null;
    if (!delivery || conversation?.workspaceId !== workspaceId) {
      throw new HTTPException(404, { message: `delivery "${id}" 不存在于当前 Workspace` });
    }
    return { delivery, conversation };
  };

  const deliveryAction = async <T>(action: () => T | Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      bad(error instanceof Error ? error.message : String(error));
    }
  };

  const finalizeDelivery = (delivery: Delivery): void => {
    if (!deliveries.isComplete(delivery)) return;
    const conv = store.getConversation(delivery.conversationId);
    if (!conv || conv.kind !== "issue" || conv.status === "done" || conv.status === "canceled") return;
    transitionConversation(store, conv, "done", "system", Date.now());
    coordinator.requestWorktreeCleanup(store.getConversation(conv.id)!);
  };

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error("[rest]", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
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
    if (auth !== `Bearer ${expectedToken}`) {
      return c.json({ error: "unauthorized（Authorization: Bearer <HARBOR_TOKEN>）" }, 401);
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

  const resolveAgentSkills = (value: unknown, workspaceId: string, deviceId: string, backend: BackendKind) => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) {
      bad("skills 需要是 Skill id 数组");
    }
    const ids = [...new Set(value as string[])];
    return ids.map((id) => {
      const skill = store.getSkill(id);
      if (!skill || skill.archivedAt) bad(`skill "${id}" 不存在或已归档`);
      if (skill.workspaceId !== workspaceId) bad(`skill "${skill.name}" 不属于当前 Workspace`);
      if (skill.source === "runtime" && skill.deviceId !== deviceId) {
        bad(`runtime skill "${skill.name}" 只能绑定来源设备上的 Agent`);
      }
      if (!skill.runtimes.includes(backend)) {
        bad(`skill "${skill.name}" 不支持 ${backend} Runtime（可用：${skill.runtimes.join(", ")}）`);
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

  app.get("/api/workspaces", (c) => c.json(store.listWorkspaces()));

  app.post("/api/workspaces", async (c) => {
    const b = (await c.req.json()) as { name?: string; slug?: string; description?: string };
    const name = b.name?.trim() ?? "";
    if (!name) bad("缺少 Workspace name");
    if (name.length > 80) bad("Workspace name 最多 80 字符");
    let slug = (b.slug?.trim() || name.toLowerCase())
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48);
    if (!slug) slug = `workspace-${Date.now().toString(36)}`;
    if (store.resolveWorkspace(name) || store.resolveWorkspace(slug)) bad(`Workspace name/slug "${name}" / "${slug}" 已存在`);
    return c.json(store.createWorkspace({ name, slug, description: b.description?.trim() || null }, Date.now()), 201);
  });

  app.patch("/api/workspaces/:id", async (c) => {
    const workspace = store.resolveWorkspace(c.req.param("id"));
    if (!workspace) throw new HTTPException(404, { message: `workspace "${c.req.param("id")}" 不存在` });
    const b = (await c.req.json()) as { name?: string; slug?: string; description?: string | null; archived?: boolean };
    if (workspace.id === DEFAULT_WORKSPACE_ID && b.archived) bad("Personal 默认 Workspace 不能归档");
    store.updateWorkspace(workspace.id, {
      ...(b.name !== undefined ? { name: b.name.trim() } : {}),
      ...(b.slug !== undefined ? { slug: b.slug.trim() } : {}),
      ...(b.description !== undefined ? { description: b.description?.trim() || null } : {}),
      ...(b.archived !== undefined ? { archived: b.archived } : {}),
    }, Date.now());
    return c.json(store.getWorkspace(workspace.id));
  });

  const repositoryView = (id: string) => {
    const repository = store.getRepository(id);
    if (!repository) return null;
    return {
      ...repository,
      mounts: store.listRepositoryMounts(id).map((mount) => ({
        ...mount,
        deviceName: store.getDevice(mount.deviceId, hub.isOnline(mount.deviceId))?.name ?? mount.deviceId,
      })),
    };
  };

  app.get("/api/repositories", (c) => {
    const workspace = currentWorkspace(c);
    return c.json(store.listRepositories(workspace.id).map((repository) => repositoryView(repository.id)));
  });

  app.post("/api/repositories", async (c) => {
    const workspace = currentWorkspace(c);
    const b = (await c.req.json()) as {
      name?: string;
      remoteUrl?: string;
      defaultBranch?: string;
      device?: string;
      path?: string;
    };
    const name = b.name?.trim() ?? "";
    if (!name) bad("缺少 Repository name");
    if (store.getRepositoryByName(workspace.id, name)) bad(`repository 名 "${name}" 已存在于当前 Workspace`);
    if ((b.device && !b.path) || (!b.device && b.path)) bad("首次 mount 需要同时提供 device 与 path");
    let device = null;
    if (b.device) {
      device = store.getDeviceByName(b.device, hub.isOnline(b.device)) ?? store.getDevice(b.device, hub.isOnline(b.device));
      if (!device) bad(`device "${b.device}" 不存在`);
      if (!b.path!.startsWith("/") && !b.path!.startsWith("~")) bad("Repository mount path 必须是绝对路径");
    }
    const repository = store.createRepository({
      workspaceId: workspace.id,
      name,
      remoteUrl: b.remoteUrl?.trim() || null,
      defaultBranch: b.defaultBranch?.trim() || "main",
    }, Date.now());
    if (device && b.path) store.setRepositoryMount(repository.id, device.id, b.path.trim(), Date.now());
    return c.json(repositoryView(repository.id), 201);
  });

  app.patch("/api/repositories/:id", async (c) => {
    const workspace = currentWorkspace(c);
    const repository = scopedRepository(workspace.id, c.req.param("id"))!;
    const b = (await c.req.json()) as { name?: string; remoteUrl?: string | null; defaultBranch?: string; archived?: boolean };
    store.updateRepository(repository.id, {
      ...(b.name !== undefined ? { name: b.name.trim() } : {}),
      ...(b.remoteUrl !== undefined ? { remoteUrl: b.remoteUrl?.trim() || null } : {}),
      ...(b.defaultBranch !== undefined ? { defaultBranch: b.defaultBranch.trim() } : {}),
      ...(b.archived !== undefined ? { archived: b.archived } : {}),
    }, Date.now());
    return c.json(repositoryView(repository.id));
  });

  app.post("/api/repositories/:id/mounts", async (c) => {
    const workspace = currentWorkspace(c);
    const repository = scopedRepository(workspace.id, c.req.param("id"))!;
    const b = (await c.req.json()) as { device?: string; path?: string };
    if (!b.device || !b.path?.trim()) bad("mount 需要 device 与 path");
    if (!b.path.startsWith("/") && !b.path.startsWith("~")) bad("Repository mount path 必须是绝对路径");
    const device = store.getDeviceByName(b.device, hub.isOnline(b.device)) ?? store.getDevice(b.device, hub.isOnline(b.device));
    if (!device) bad(`device "${b.device}" 不存在`);
    const existing = store.getRepositoryMountForDevice(repository.id, device.id);
    if (existing && existing.path !== b.path.trim()) {
      const usage = store.repositoryMountUsage(existing.id);
      if (usage.activeRuns || usage.worktrees) {
        bad(`mount 正被 ${usage.activeRuns} 个 active Run / ${usage.worktrees} 个 worktree 使用，不能移动路径`);
      }
    }
    store.setRepositoryMount(repository.id, device.id, b.path.trim(), Date.now());
    return c.json(repositoryView(repository.id));
  });

  app.delete("/api/repositories/:repositoryId/mounts/:mountId", (c) => {
    const workspace = currentWorkspace(c);
    const repository = scopedRepository(workspace.id, c.req.param("repositoryId"))!;
    const mount = store.getRepositoryMount(c.req.param("mountId"));
    if (!mount || mount.repositoryId !== repository.id) throw new HTTPException(404, { message: "mount 不存在" });
    const usage = store.repositoryMountUsage(mount.id);
    if (usage.runs || usage.worktrees || usage.agents || usage.conversations) {
      bad(`mount 已被 ${usage.runs} 个 Run / ${usage.worktrees} 个 worktree / ${usage.agents} 个 Agent / ${usage.conversations} 个任务引用，不能删除；可归档 Repository`);
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
    const b = (await c.req.json()) as { key?: string; enabled?: boolean; template?: string };
    if (!PROMPT_BLOCK_KEYS.includes(b.key as PromptBlockKey)) {
      bad(`key 可选 ${PROMPT_BLOCK_KEYS.join("/")}（收到 "${b.key}"）`);
    }
    if (typeof b.enabled !== "boolean") bad("需要 enabled: true/false");
    if (typeof b.template !== "string") bad("需要 template: string");
    const invalid = validatePromptTemplate(b.key as PromptBlockKey, b.template);
    if (invalid) bad(invalid);
    store.setPromptBlock(workspace.id, b.key as PromptBlockKey, b.enabled, b.template, Date.now());
    return c.json(getPromptBlockConfig(store, workspace.id, b.key as PromptBlockKey));
  });

  app.delete("/api/settings/prompt-blocks/:key", (c) => {
    const workspace = currentWorkspace(c);
    const key = c.req.param("key") as PromptBlockKey;
    if (!PROMPT_BLOCK_KEYS.includes(key)) bad(`key 可选 ${PROMPT_BLOCK_KEYS.join("/")}`);
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
          installedSkills: device.capabilities.installedSkills?.map(({ instruction: _instruction, ...skill }) => skill),
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
      agents: store.listAgentsForSkill(id).map((agent) => ({ id: agent.id, name: agent.name })),
    };
  };

  app.get("/api/skills", (c) => {
    const workspace = currentWorkspace(c);
    return c.json(store.listSkills(false, workspace.id).map((skill) => skillView(skill.id)));
  });

  app.post("/api/skills", async (c) => {
    const workspace = currentWorkspace(c);
    const b = (await c.req.json()) as { name?: string; description?: string; instruction?: string };
    const name = b.name?.trim() ?? "";
    const instruction = b.instruction?.trim() ?? "";
    if (!name) bad("缺少 Skill name");
    if (name.length > 80) bad("Skill name 最多 80 字符");
    if (!instruction) bad("缺少 Skill instruction（SKILL.md 正文）");
    if (instruction.length > MAX_SKILL_INSTRUCTION) bad("Skill instruction 不能超过 128KB");
    if (store.getSkillByName(name, workspace.id)) bad(`skill 名 "${name}" 已存在`);
    const skill = store.createSkill(
      {
        workspaceId: workspace.id,
        name,
        description: b.description?.trim() ?? "",
        source: "manual",
        instruction,
        runtimes: ["claude", "codex"],
      },
      Date.now(),
    );
    return c.json(skillView(skill.id), 201);
  });

  /** Mew 式 local runtime sync：只接受 daemon hello 中真实探测到的 path，不信任客户端自报正文。 */
  app.post("/api/skills/import", async (c) => {
    const workspace = currentWorkspace(c);
    const b = (await c.req.json()) as { device?: string; paths?: string[] };
    if (!b.device) bad("缺少 device");
    if (!Array.isArray(b.paths) || b.paths.length === 0 || b.paths.some((path) => typeof path !== "string")) {
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
      if (!local?.instruction) bad(`device "${device.name}" 未上报可导入的 Skill：${path}（重启 harbord 后重试）`);
      const existing = store.getRuntimeSkill(workspace.id, device.id, path);
      const owner = store.getSkillByName(local.name, workspace.id);
      if (owner && owner.id !== existing?.id) {
        bad(`skill 名 "${local.name}" 已被占用；请先重命名现有 Skill 或本地 SKILL.md`);
      }
      if (existing) {
        store.updateSkill(existing.id, {
          name: local.name,
          description: local.description,
          instruction: local.instruction,
          runtimes: local.runtimes,
        }, Date.now());
        store.setSkillArchived(existing.id, false, Date.now());
        imported.push(skillView(existing.id));
      } else {
        const skill = store.createSkill({
          workspaceId: workspace.id,
          name: local.name,
          description: local.description,
          source: "runtime",
          instruction: local.instruction,
          deviceId: device.id,
          sourcePath: local.path,
          runtimes: local.runtimes,
        }, Date.now());
        imported.push(skillView(skill.id));
      }
    }
    return c.json({ imported });
  });

  app.patch("/api/skills/:id", async (c) => {
    const workspace = currentWorkspace(c);
    const id = c.req.param("id");
    const skill = store.getSkill(id);
    if (!skill || skill.workspaceId !== workspace.id) throw new HTTPException(404, { message: `skill "${id}" 不存在` });
    const b = (await c.req.json()) as {
      name?: string;
      description?: string;
      instruction?: string;
      archived?: boolean;
    };
    const patch: { name?: string; description?: string; instruction?: string } = {};
    if (b.name !== undefined) {
      const name = b.name.trim();
      if (!name || name.length > 80) bad("Skill name 需要 1–80 字符");
      const owner = store.getSkillByName(name, workspace.id);
      if (owner && owner.id !== skill.id) bad(`skill 名 "${name}" 已存在`);
      patch.name = name;
    }
    if (b.description !== undefined) patch.description = b.description.trim();
    if (b.instruction !== undefined) {
      if (skill.source === "runtime") bad("runtime Skill 的正文由本机同步管理；请使用 Sync local skills 刷新");
      const instruction = b.instruction.trim();
      if (!instruction) bad("Skill instruction 不能为空");
      if (instruction.length > MAX_SKILL_INSTRUCTION) bad("Skill instruction 不能超过 128KB");
      patch.instruction = instruction;
    }
    if (Object.keys(patch).length > 0) store.updateSkill(id, patch, Date.now());
    if (b.archived !== undefined) {
      if (typeof b.archived !== "boolean") bad("archived 需要 true/false");
      store.setSkillArchived(id, b.archived, Date.now());
    }
    if (Object.keys(patch).length === 0 && b.archived === undefined) bad("没有可更新的字段");
    return c.json(skillView(id));
  });

  // ---- agents ----

  app.get("/api/agents", (c) => c.json(store.listAgents(false, currentWorkspace(c).id)));

  app.post("/api/agents", async (c) => {
    const workspace = currentWorkspace(c);
    const b = (await c.req.json()) as {
      name?: string;
      description?: string;
      device?: string;
      backend?: string;
      model?: string;
      permission?: string;
      repository?: string;
      /** legacy CLI compatibility */
      workdir?: string;
      isolation?: string;
      instruction?: string;
      skills?: unknown;
    };
    if (!b.name) bad("缺少 name");
    if (!b.device) bad("缺少 device（设备名或 id）");
    if (b.workdir && !b.workdir.startsWith("/") && !b.workdir.startsWith("~")) {
      bad(`workdir 必须是绝对路径（收到 "${b.workdir}"）`);
    }
    if (b.backend !== undefined && b.backend !== "claude" && b.backend !== "codex") {
      bad(`backend 只支持 claude/codex（收到 "${b.backend}"）`);
    }
    const permission = b.permission ?? "auto-edit";
    if (!PERMISSIONS.includes(permission)) bad(`permission 可选 ${PERMISSIONS.join("/")}（收到 "${b.permission}"）`);
    const isolation = (b.isolation ?? "none") as IsolationKind;
    if (isolation !== "none" && isolation !== "worktree") bad(`isolation 可选 none/worktree（收到 "${b.isolation}"）`);

    const device =
      store.getDeviceByName(b.device, hub.isOnline(b.device)) ??
      store.getDevice(b.device, hub.isOnline(b.device));
    if (!device) bad(`device "${b.device}" 未注册（先在该设备上启动 harbord）`);
    if (store.getAgentByNameInWorkspace(workspace.id, b.name)) bad(`agent 名 "${b.name}" 已存在于当前 Workspace`);

    const installed = (["claude", "codex"] as BackendKind[]).filter(
      (provider) => !!device.capabilities.clis?.[provider],
    );
    const backend = (b.backend ?? (installed.includes("claude") ? "claude" : installed[0])) as BackendKind | undefined;
    if (!backend) bad(`设备 "${device.name}" 没有可用 provider（请先安装 claude 或 codex CLI 并重启 harbord）`);
    validateAgentRuntimeForDevice(device, backend, permission, b.model ?? null);

    let repository = scopedRepository(workspace.id, b.repository);
    if (!repository && b.workdir) {
      repository = store.ensureRepositoryForPath(workspace.id, device.id, b.workdir, Date.now());
    }
    if (!repository) bad("Agent 必须绑定 Repository；请在 Agent 表单选择已有仓库或创建新仓库");
    if (!store.getRepositoryMountForDevice(repository.id, device.id)) {
      bad(`Repository "${repository.name}" 尚未挂载到设备 "${device.name}"`);
    }

    const skills = resolveAgentSkills(b.skills, workspace.id, device.id, backend);
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
        isolation,
        instruction: b.instruction ?? null,
      },
      Date.now(),
    );
    if (skills.length > 0) store.setAgentSkills(agent.id, skills.map((skill) => skill.id), Date.now());
    return c.json(store.getAgent(agent.id), 201);
  });

  app.patch("/api/agents/:id", async (c) => {
    const workspace = currentWorkspace(c);
    const key = c.req.param("id");
    const agent = scopedAgent(workspace.id, key);
    if (!agent) throw new HTTPException(404, { message: `agent "${key}" 不存在` });
    const b = (await c.req.json()) as {
      archived?: boolean;
      skills?: unknown;
      repository?: string;
      device?: string;
      dropIncompatibleSkills?: boolean;
    };
    if (b.archived === undefined && b.skills === undefined && b.repository === undefined && b.device === undefined) {
      bad("需要 archived、skills、repository 或 device");
    }
    if (b.dropIncompatibleSkills !== undefined && typeof b.dropIncompatibleSkills !== "boolean") {
      bad("dropIncompatibleSkills 需要 true/false");
    }

    const targetDevice = b.device === undefined
      ? store.getDevice(agent.deviceId, hub.isOnline(agent.deviceId))
      : store.getDeviceByName(b.device, hub.isOnline(b.device)) ?? store.getDevice(b.device, hub.isOnline(b.device));
    if (!targetDevice) bad(`device "${b.device ?? agent.deviceId}" 未注册`);
    const targetRepository = b.repository === undefined
      ? store.getRepository(agent.repositoryId)
      : scopedRepository(workspace.id, b.repository);
    if (!targetRepository) bad("Agent 必须绑定 Repository");

    const deviceChanged = targetDevice.id !== agent.deviceId;
    const repositoryChanged = targetRepository.id !== agent.repositoryId;
    if (deviceChanged) {
      validateAgentRuntimeForDevice(targetDevice, agent.backend, agent.permission, agent.model);
    }
    if (deviceChanged || repositoryChanged) {
      if (!store.getRepositoryMountForDevice(targetRepository.id, targetDevice.id)) {
        bad(`Repository "${targetRepository.name}" 尚未挂载到设备 "${targetDevice.name}"`);
      }
      const blocker = store.agentExecutionBindingChangeBlocker(agent.id);
      if (blocker) bad(`${blocker}，暂不能更换执行绑定`);
    }

    const skills = b.skills !== undefined
      ? resolveAgentSkills(b.skills, workspace.id, targetDevice.id, agent.backend)
      : null;
    const incompatibleRuntimeSkills = deviceChanged && !skills
      ? store.listSkillsForAgent(agent.id).filter(
          (skill) => skill.source === "runtime" && skill.deviceId !== targetDevice.id,
        )
      : [];
    if (incompatibleRuntimeSkills.length > 0 && !b.dropIncompatibleSkills) {
      bad(
        `迁移到 "${targetDevice.name}" 会解除旧 Device 的 runtime Skills：` +
          `${incompatibleRuntimeSkills.map((skill) => skill.name).join("、")}；确认后请传 dropIncompatibleSkills: true`,
      );
    }

    if (b.archived !== undefined) {
      if (typeof b.archived !== "boolean") bad("archived 需要 true/false");
      store.setAgentArchived(agent.id, b.archived, Date.now());
    }
    if (deviceChanged) {
      store.moveAgentToDevice(agent.id, targetDevice.id, targetRepository.id);
    } else if (repositoryChanged) {
      store.setAgentRepository(agent.id, targetRepository.id);
    }
    if (skills) store.setAgentSkills(agent.id, skills.map((skill) => skill.id), Date.now());
    return c.json(store.getAgent(agent.id));
  });

  // ---- conversations ----

  app.get("/api/conversations", (c) => {
    const workspace = currentWorkspace(c);
    const kind = c.req.query("kind") as ConversationKind | undefined;
    const status = c.req.query("status") as ConversationStatus | undefined;
    // AI draft 是创建器内部态；正式发布前不进入 Chats / Issues / Automation target 列表。
    const convs = store.listConversations({ workspaceId: workspace.id, kind, status }).filter((conversation) => conversation.kind !== "issue_draft");
    const agentNames = new Map(store.listAgents(true, workspace.id).map((a) => [a.id, a.name]));
    return c.json(
      convs.map((cv) => ({
        ...cv,
        agentName: cv.agentId ? (agentNames.get(cv.agentId) ?? cv.agentId) : null,
        latestRun: store.latestRunForConversation(cv.id),
      })),
    );
  });

  app.post("/api/conversations", async (c) => {
    const workspace = currentWorkspace(c);
    const b = (await c.req.json()) as {
      kind?: string;
      agent?: string;
      title?: string;
      description?: string;
      priority?: string;
      origin?: Origin;
      originRef?: string;
      repository?: unknown;
    };
    if (b.repository !== undefined) bad("Conversation 的 Repository 由 Agent 决定，请修改 Agent 配置");
    if (b.kind !== "chat" && b.kind !== "issue") bad(`kind 只支持 chat/issue（收到 "${b.kind}"）`);
    if (b.kind === "chat" && !b.agent) bad("chat 缺少 agent（agent 名或 id）");
    if (b.priority !== undefined && !ISSUE_PRIORITIES.includes(b.priority as IssuePriority)) {
      bad(`priority 可选 ${ISSUE_PRIORITIES.join("/")}（收到 "${b.priority}"）`);
    }
    const agent = scopedAgent(workspace.id, b.agent);
    if (b.agent && !agent) bad(`agent "${b.agent}" 不存在（harbor agent ls 查看）`);
    if (agent?.archivedAt) bad(`agent "${agent.name}" 已归档`);
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
      },
      Date.now(),
    );
    return c.json(conv, 201);
  });

  /** Mew AI draft：先用只读 Agent 分诊，人工确认标题/正文后才发布到 Issue 看板。 */
  app.post("/api/issue-drafts", async (c) => {
    const workspace = currentWorkspace(c);
    const b = (await c.req.json()) as { request?: string; agent?: string; priority?: string; repository?: unknown };
    if (b.repository !== undefined) bad("Issue draft 的 Repository 由 Agent 决定，请修改 Agent 配置");
    if (!b.request?.trim()) bad("请描述要 Agent 分诊的请求");
    if (!b.agent) bad("请选择负责分诊的 Agent");
    if (b.priority !== undefined && !ISSUE_PRIORITIES.includes(b.priority as IssuePriority)) {
      bad(`priority 可选 ${ISSUE_PRIORITIES.join("/")}（收到 "${b.priority}"）`);
    }
    const agent = scopedAgent(workspace.id, b.agent);
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
      },
      Date.now(),
    );
    const run = enqueue(conv, agent, `${ISSUE_TRIAGE_PROMPT}${b.request.trim()}`, "triage");
    return c.json({ conversation: conv, run }, 201);
  });

  app.post("/api/issue-drafts/:id/publish", async (c) => {
    const workspace = currentWorkspace(c);
    const conv = assertConversationWorkspace(workspace.id, c.req.param("id"));
    if (!conv || conv.kind !== "issue_draft") {
      throw new HTTPException(404, { message: `issue draft "${c.req.param("id")}" 不存在` });
    }
    if (store.activeRunForConversation(conv.id)) bad("Agent 仍在分诊，请等待完成后再创建 Issue");
    const latest = store.latestRunForConversation(conv.id);
    if (!latest || latest.purpose !== "triage" || latest.status !== "succeeded") {
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
    if (b.status !== "backlog" && b.status !== "todo") bad("初始阶段只支持 backlog/todo");
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
    const agent = conv.agentId ? store.getAgent(conv.agentId) : null;
    const repository = conv.repositoryId ? store.getRepository(conv.repositoryId) : null;
    return c.json({
      conversation: conv,
      agent,
      repository,
      // resultText：Chat/Issue 历史渲染用；run_events 7 天 prune 后为 null（UI 显示「记录已过期」）
      runs: store.listRunsByConversation(conv.id).map((r) => ({ ...r, resultText: store.getRunResultText(r.id) })),
      statusLog: store.listStatusLog(conv.id),
      delivery: store.getDeliveryForConversation(conv.id),
      deliveryEvents: (() => {
        const delivery = store.getDeliveryForConversation(conv.id);
        return delivery ? store.listDeliveryEvents(delivery.id) : [];
      })(),
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
    };
    if (b.repository !== undefined) bad("Conversation 的 Repository 由 Assignee 决定，请修改 Agent 配置");
    if (b.priority !== undefined && !ISSUE_PRIORITIES.includes(b.priority as IssuePriority)) {
      bad(`priority 可选 ${ISSUE_PRIORITIES.join("/")}（收到 "${b.priority}"）`);
    }
    store.updateConversation(
      conv.id,
      {
        ...(b.title !== undefined ? { title: b.title } : {}),
        ...(b.description !== undefined ? { description: b.description } : {}),
        ...(b.priority !== undefined ? { priority: b.priority as IssuePriority } : {}),
      },
      Date.now(),
    );
    if (b.agent !== undefined) {
      const agent = scopedAgent(workspace.id, b.agent);
      if (b.agent && !agent) bad(`agent "${b.agent}" 不存在`);
      if (agent?.archivedAt) bad(`agent "${agent.name}" 已归档`);
      if (store.activeRunForConversation(conv.id)) bad("Run 进行中，不能更换 Assignee；请先停止 Run");
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
      if (store.activeRunForConversation(conv.id)) bad("Run 进行中，不能手动调整阶段；请先停止 Run");
      const current = store.getConversation(conv.id)!;
      const to = b.status as ConversationStatus;
      if (to === "doing" || to === "review") bad(`${to} 由 Run 生命周期自动推进，不能手动设置`);
      if (to === "done" && current.status !== "review") bad("只有 Review 中的 Issue 才能验收完成");
      if (to === "done" && store.getDeliveryForConversation(current.id)) {
        bad("当前 Issue 已建立 Delivery，请完成合并/部署流程，不能绕过交付策略直接 Done");
      }
      if (to === "backlog" || to === "todo") {
        if (current.status === "done" || current.status === "canceled") bad(`${current.status} 是终态，不能直接重新打开`);
      }
      transitionConversation(store, current, to, "human", Date.now());
      const fresh = store.getConversation(conv.id)!;
      if (to === "done" || to === "canceled") coordinator.requestWorktreeCleanup(fresh);
    }
    return c.json(store.getConversation(conv.id));
  });

  app.post("/api/conversations/:id/runs", async (c) => {
    const workspace = currentWorkspace(c);
    const conv = assertConversationWorkspace(workspace.id, c.req.param("id"));
    const b = (await c.req.json()) as { prompt?: string; agent?: string; purpose?: string };
    if (!b.prompt?.trim()) bad("缺少 prompt");
    const purpose = (b.purpose ?? "implementation") as RunPurpose;
    if (!RUN_PURPOSES.includes(purpose)) bad(`purpose 可选 ${RUN_PURPOSES.join("/")}`);
    const agentKey = b.agent ?? conv.agentId;
    const agent = scopedAgent(workspace.id, agentKey);
    if (!agent) bad("Issue 尚未指派 Agent，请先选择 Assignee");
    if (agent.archivedAt) bad(`agent "${agent.name}" 已归档`);
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
    const agent = scopedAgent(workspace.id, agentKey);
    if (!agent) bad("请选择要执行的 Agent");
    if (agent.archivedAt) bad(`agent "${agent.name}" 已归档`);
    const prompt = b.prompt?.trim() || conv.description?.trim();
    if (!prompt) bad("Issue 缺少任务描述，无法派发");
    return c.json(enqueue(conv, agent, prompt, "implementation"), 201);
  });

  app.post("/api/conversations/:id/request-changes", async (c) => {
    const workspace = currentWorkspace(c);
    const conv = assertConversationWorkspace(workspace.id, c.req.param("id"));
    if (conv.kind !== "issue" || conv.status !== "review") bad("只有 Review 中的 Issue 可以要求修改");
    const b = (await c.req.json()) as { feedback?: string; agent?: string };
    if (!b.feedback?.trim()) bad("请填写修改意见");
    const agentKey = b.agent ?? conv.agentId;
    const agent = scopedAgent(workspace.id, agentKey);
    if (!agent) bad("请选择返工 Agent");
    if (agent.archivedAt) bad(`agent "${agent.name}" 已归档`);
    return c.json(enqueue(conv, agent, b.feedback.trim(), "implementation"), 201);
  });

  app.post("/api/conversations/:id/review", async (c) => {
    const workspace = currentWorkspace(c);
    const conv = assertConversationWorkspace(workspace.id, c.req.param("id"));
    if (conv.kind !== "issue" || conv.status !== "review") bad("AI Review 只能在 Review 阶段启动");
    const b = (await c.req.json()) as { agent?: string; prompt?: string };
    const agent = scopedAgent(workspace.id, b.agent);
    if (!agent) bad("请选择 Reviewer Agent");
    if (agent.archivedAt) bad(`agent "${agent.name}" 已归档`);
    const prompt = b.prompt?.trim() || "请独立审查本 Issue 的实现结果、代码改动和测试证据，指出阻塞问题与改进建议；不要直接宣告 Issue 完成。";
    return c.json(enqueue(conv, agent, prompt, "review"), 201);
  });

  app.post("/api/conversations/:id/delivery", async (c) => {
    const conv = assertConversationWorkspace(currentWorkspace(c).id, c.req.param("id"));
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
    const { delivery } = assertDeliveryWorkspace(currentWorkspace(c).id, c.req.param("id"));
    const b = (await c.req.json()) as {
      changeUrl?: string | null;
      externalId?: string | null;
      headBranch?: string | null;
      baseBranch?: string | null;
      checkStatus?: DeliveryCheckStatus;
    };
    if (b.checkStatus !== undefined && !DELIVERY_CHECK_STATUSES.includes(b.checkStatus)) {
      bad(`checkStatus 可选 ${DELIVERY_CHECK_STATUSES.join("/")}`);
    }
    if (b.changeUrl !== undefined && b.changeUrl !== null) validateDeliveryUrl(b.changeUrl);
    return c.json(await deliveryAction(() => deliveries.update(delivery, b)));
  });

  app.post("/api/deliveries/:id/merge", async (c) => {
    const { delivery, conversation: conv } = assertDeliveryWorkspace(currentWorkspace(c).id, c.req.param("id"));
    const b = (await c.req.json()) as { confirmed?: boolean; mergedRevision?: string };
    rejectUnknownFields(b as Record<string, unknown>, ["confirmed", "mergedRevision"]);
    const fresh = await deliveryAction(() => deliveries.merge(delivery, conv, b));
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
    const { delivery, conversation: conv } = assertDeliveryWorkspace(currentWorkspace(c).id, c.req.param("id"));
    const b = (await c.req.json()) as { confirmed?: boolean };
    rejectUnknownFields(b as Record<string, unknown>, ["confirmed"]);
    return c.json(await deliveryAction(() => deliveries.startDeployment(delivery, conv, b)));
  });

  app.post("/api/deliveries/:id/deployment-result", async (c) => {
    const { delivery } = assertDeliveryWorkspace(currentWorkspace(c).id, c.req.param("id"));
    const b = (await c.req.json()) as { status?: "succeeded" | "failed" };
    rejectUnknownFields(b as Record<string, unknown>, ["status"]);
    if (b.status !== "succeeded" && b.status !== "failed") bad("status 可选 succeeded/failed");
    const fresh = await deliveryAction(() => deliveries.finishDeployment(delivery, b.status!));
    finalizeDelivery(fresh);
    return c.json(store.getDelivery(fresh.id));
  });

  app.post("/api/conversations/:id/approve", (c) => {
    const conv = assertConversationWorkspace(currentWorkspace(c).id, c.req.param("id"));
    if (conv.kind !== "issue" || conv.status !== "review") bad("只有 Review 中的 Issue 可以验收完成");
    if (store.activeRunForConversation(conv.id)) bad("仍有 Run 进行中，不能完成验收");
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
    const conv = assertConversationWorkspace(currentWorkspace(c).id, c.req.param("id"));
    if (conv.kind !== "issue") bad("chat 不能取消为 Issue 终态");
    const active = store.activeRunForConversation(conv.id);
    if (active) coordinator.cancelRun(active.id);
    transitionConversation(store, store.getConversation(conv.id)!, "canceled", "human", Date.now());
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
    const status = c.req.query("status") as import("../protocol.js").ApprovalStatus | undefined;
    return c.json(store.listApprovals(status).filter((approval) => store.getRun(approval.runId)?.workspaceId === workspace.id));
  });

  app.post("/api/approvals/:id", async (c) => {
    const workspace = currentWorkspace(c);
    const a = store.resolveApprovalPrefix(c.req.param("id"));
    if (!a || store.getRun(a.runId)?.workspaceId !== workspace.id) throw new HTTPException(404, { message: `approval "${c.req.param("id")}" 不存在` });
    const b = (await c.req.json()) as { behavior?: string };
    if (b.behavior !== "allow" && b.behavior !== "deny") bad(`behavior 只支持 allow/deny（收到 "${b.behavior}"）`);
    const decided = approvals.decide(a.id, b.behavior, "cli");
    return c.json(decided);
  });

  // ---- automations（P3 cron） ----

  app.get("/api/automations", (c) => {
    const workspace = currentWorkspace(c);
    const agentNames = new Map(store.listAgents(true, workspace.id).map((a) => [a.id, a.name]));
    return c.json(
      store.listAutomations(workspace.id).map((a) => ({ ...a, agentName: agentNames.get(a.agentId) ?? a.agentId })),
    );
  });

  app.post("/api/automations", async (c) => {
    const workspace = currentWorkspace(c);
    const b = (await c.req.json()) as {
      name?: string;
      agent?: string;
      cron?: string;
      prompt?: string;
      mode?: string;
      target?: string;
      notifyChat?: string;
      repository?: unknown;
    };
    if (b.repository !== undefined) bad("Automation 的 Repository 由 Agent 决定，请修改 Agent 配置");
    if (!b.name) bad("缺少 name");
    if (store.listAutomations(workspace.id).some((automation) => automation.name === b.name)) {
      bad(`automation 名 "${b.name}" 已存在于当前 Workspace`);
    }
    if (!b.cron) bad("缺少 cron（5 段标准 cron 表达式，server 本机时区）");
    if (!b.prompt?.trim()) bad("缺少 prompt");
    try {
      AutomationService.validateCron(b.cron);
    } catch (e) {
      bad(`cron 表达式非法："${b.cron}"（${e instanceof Error ? e.message : e}）`);
    }
    const agent = scopedAgent(workspace.id, b.agent);
    if (!agent) bad(`agent "${b.agent}" 不存在（harbor agent ls 查看）`);
    if (agent.archivedAt) bad(`agent "${agent.name}" 已归档`);
    const mode = (b.mode ?? "new_issue") as import("../protocol.js").AutomationMode;
    if (mode !== "new_issue" && mode !== "append") bad(`mode 可选 new_issue/append（收到 "${b.mode}"）`);
    let targetId: string | null = null;
    if (mode === "append") {
      if (!b.target) bad("mode=append 需要 --target <conversation-id>");
      const target = store.resolveConversationPrefix(b.target);
      if (!target || target.workspaceId !== workspace.id) bad(`target conversation "${b.target}" 不存在于当前 Workspace`);
      if (target.repositoryId && target.repositoryId !== agent.repositoryId) {
        bad("append target 与 Agent 绑定的 Repository 不一致");
      }
      targetId = target.id;
    }
    const repository = mode === "append"
      ? null
      : store.getRepository(agent.repositoryId);
    if (repository && !store.getRepositoryMountForDevice(repository.id, agent.deviceId)) {
      bad(`Repository "${repository.name}" 尚未挂载到 Agent "${agent.name}" 的设备`);
    }
    const auto = store.createAutomation(
      {
        workspaceId: workspace.id,
        name: b.name,
        agentId: agent.id,
        repositoryId: repository?.id ?? null,
        cron: b.cron,
        prompt: b.prompt,
        mode,
        targetConversationId: targetId,
        notifyChatId: b.notifyChat ?? null,
      },
      Date.now(),
    );
    automations.schedule(auto);
    return c.json(auto, 201);
  });

  app.patch("/api/automations/:id", async (c) => {
    const workspace = currentWorkspace(c);
    const auto = store.resolveAutomationPrefix(c.req.param("id"), workspace.id);
    if (!auto || auto.workspaceId !== workspace.id) throw new HTTPException(404, { message: `automation "${c.req.param("id")}" 不存在` });
    const b = (await c.req.json()) as { enabled?: boolean };
    if (typeof b.enabled !== "boolean") bad("需要 enabled: true/false");
    store.setAutomationEnabled(auto.id, b.enabled);
    const fresh = store.getAutomation(auto.id)!;
    if (b.enabled) automations.schedule(fresh);
    else automations.unschedule(auto.id);
    return c.json(fresh);
  });

  app.post("/api/automations/:id/run", (c) => {
    const auto = store.resolveAutomationPrefix(c.req.param("id"));
    if (!auto) throw new HTTPException(404, { message: `automation "${c.req.param("id")}" 不存在` });
    try {
      return c.json(automations.runNow(auto.id), 201);
    } catch (error) {
      bad(error instanceof Error ? error.message : String(error));
    }
  });

  app.delete("/api/automations/:id", (c) => {
    const workspace = currentWorkspace(c);
    const auto = store.resolveAutomationPrefix(c.req.param("id"), workspace.id);
    if (!auto || auto.workspaceId !== workspace.id) throw new HTTPException(404, { message: `automation "${c.req.param("id")}" 不存在` });
    automations.unschedule(auto.id);
    store.deleteAutomation(auto.id);
    return c.json({ ok: true });
  });

  app.get("/api/automations/:id/log", (c) => {
    const workspace = currentWorkspace(c);
    const auto = store.resolveAutomationPrefix(c.req.param("id"), workspace.id);
    if (!auto || auto.workspaceId !== workspace.id) throw new HTTPException(404, { message: `automation "${c.req.param("id")}" 不存在` });
    return c.json(store.listAutomationLog(auto.id));
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
      const agent = scopedAgent(workspace.id, agentQ);
      if (!agent) bad(`agent "${agentQ}" 不存在`);
      agentId = agent.id;
    }
    return c.json(store.listRunsForUsage({ workspaceId: workspace.id, agentId, day: c.req.query("day"), fromTs }));
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
            controller.enqueue(enc.encode(`data: ${JSON.stringify(frame)}\n\n`));
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
          } else if (frame.kind === "approval" || frame.kind === "approval_decided") {
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
      return c.text("harbor-web 未构建：bun run --filter harbor-web build（产物 apps/harbor-web/out/）", 503);
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
        const cache = pathname.startsWith("/_next/") ? "public, max-age=31536000, immutable" : "no-cache";
        return new Response(f, { headers: { "Cache-Control": cache } });
      }
    }
    return new Response(Bun.file(join(WEB_OUT, "index.html")), { headers: { "Cache-Control": "no-cache" } });
  });

  return app;
}

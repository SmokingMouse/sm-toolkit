/**
 * REST 入口层（Hono）：devices/agents/conversations/runs/approvals/automations/usage
 * CRUD + run 事件 SSE + Bearer token auth + 只读看板（GET /）。
 * 语义校验尽量前置到这一层（fail loudly at 配置时而非运行时）：
 *   - agent create 校验 model ∈ device 能力清单（harbor.md §8「endpoints.yaml 各机不一致」对策）
 *   - automation create 校验 cron 表达式 / agent 存在 / append 模式 target 存在
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type {
  BackendKind,
  ConversationKind,
  ConversationStatus,
  IsolationKind,
  Origin,
  Run,
  RunStreamFrame,
} from "../protocol.js";
import { ISSUE_STATUSES, NATIVE_TIER_ALIASES } from "../protocol.js";
import type { HarborStore } from "./store.js";
import type { RunBus } from "./bus.js";
import type { DeviceHub } from "./ws.js";
import type { RunCoordinator } from "./scheduler.js";
import type { ApprovalService } from "./approvals.js";
import { AutomationService } from "./automation.js";
import { transitionConversation } from "./statemachine.js";
import { DASHBOARD_HTML } from "./dashboard.js";

const PERMISSIONS = ["readonly", "auto-edit", "full", "default"];

function bad(message: string): never {
  throw new HTTPException(400, { message });
}

export function buildRest(
  store: HarborStore,
  bus: RunBus,
  hub: DeviceHub,
  coordinator: RunCoordinator,
  approvals: ApprovalService,
  automations: AutomationService,
  expectedToken: string,
): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error("[rest]", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  });

  app.use("/api/*", async (c, next) => {
    const auth = c.req.header("Authorization");
    if (auth !== `Bearer ${expectedToken}`) {
      return c.json({ error: "unauthorized（Authorization: Bearer <HARBOR_TOKEN>）" }, 401);
    }
    await next();
  });

  app.get("/api/health", (c) => c.json({ ok: true }));

  // 只读看板（P4）：静态壳不带数据，数据面 fetch /api/*（token 在浏览器本地输入）
  app.get("/", (c) => c.html(DASHBOARD_HTML));

  // ---- devices ----

  app.get("/api/devices", (c) => c.json(store.listDevices(hub.onlineIds())));

  // ---- agents ----

  app.get("/api/agents", (c) => c.json(store.listAgents()));

  app.post("/api/agents", async (c) => {
    const b = (await c.req.json()) as {
      name?: string;
      description?: string;
      device?: string;
      backend?: string;
      model?: string;
      permission?: string;
      workdir?: string;
      isolation?: string;
      instruction?: string;
    };
    if (!b.name) bad("缺少 name");
    if (!b.device) bad("缺少 device（设备名或 id）");
    if (!b.workdir) bad("缺少 workdir（device 上的绝对路径）");
    if (!b.workdir.startsWith("/") && !b.workdir.startsWith("~")) {
      bad(`workdir 必须是绝对路径（收到 "${b.workdir}"）`);
    }
    const backend = (b.backend ?? "claude") as BackendKind;
    if (backend !== "claude" && backend !== "codex") bad(`backend 只支持 claude/codex（收到 "${b.backend}"）`);
    const permission = b.permission ?? "auto-edit";
    if (!PERMISSIONS.includes(permission)) bad(`permission 可选 ${PERMISSIONS.join("/")}（收到 "${b.permission}"）`);
    const isolation = (b.isolation ?? "none") as IsolationKind;
    if (isolation !== "none" && isolation !== "worktree") bad(`isolation 可选 none/worktree（收到 "${b.isolation}"）`);

    const device =
      store.getDeviceByName(b.device, hub.isOnline(b.device)) ??
      store.getDevice(b.device, hub.isOnline(b.device));
    if (!device) bad(`device "${b.device}" 未注册（先在该设备上启动 harbord）`);
    if (store.getAgentByName(b.name)) bad(`agent 名 "${b.name}" 已存在`);

    // model 校验：空 = CLI 默认模型放行；裸 tier 别名放行（claude CLI 原生认，不进 endpoints.yaml）；
    // 其余必须在该设备能力上报的 endpoints 清单内。
    if (b.model) {
      const bare = b.model.startsWith("claude-") ? b.model.slice("claude-".length) : b.model;
      const isNativeTier = backend === "claude" && NATIVE_TIER_ALIASES.includes(bare);
      const eps = device.capabilities.endpoints ?? [];
      if (!isNativeTier && !eps.includes(b.model)) {
        bad(
          `model "${b.model}" 不在设备 "${device.name}" 的能力清单内。` +
            `可用：${NATIVE_TIER_ALIASES.join("/")}（claude 原生）${eps.length ? "，" + eps.join(", ") : "（该设备未上报 endpoints，检查其 endpoints.yaml）"}`,
        );
      }
    }

    const agent = store.createAgent(
      {
        name: b.name,
        description: b.description ?? null,
        deviceId: device.id,
        backend,
        model: b.model ?? null,
        permission: permission as import("@sm/agent").PermissionPolicy,
        workdir: b.workdir,
        isolation,
        instruction: b.instruction ?? null,
      },
      Date.now(),
    );
    return c.json(agent, 201);
  });

  // ---- conversations ----

  app.get("/api/conversations", (c) => {
    const kind = c.req.query("kind") as ConversationKind | undefined;
    const status = c.req.query("status") as ConversationStatus | undefined;
    const convs = store.listConversations({ kind, status });
    const agentNames = new Map(store.listAgents(true).map((a) => [a.id, a.name]));
    return c.json(convs.map((cv) => ({ ...cv, agentName: agentNames.get(cv.agentId) ?? cv.agentId })));
  });

  app.post("/api/conversations", async (c) => {
    const b = (await c.req.json()) as {
      kind?: string;
      agent?: string;
      title?: string;
      origin?: Origin;
      originRef?: string;
    };
    if (b.kind !== "chat" && b.kind !== "issue") bad(`kind 只支持 chat/issue（收到 "${b.kind}"）`);
    if (!b.agent) bad("缺少 agent（agent 名或 id）");
    const agent = store.getAgentByName(b.agent) ?? store.getAgent(b.agent);
    if (!agent) bad(`agent "${b.agent}" 不存在（harbor agent ls 查看）`);
    if (agent.archivedAt) bad(`agent "${agent.name}" 已归档`);
    const conv = store.createConversation(
      { kind: b.kind, title: b.title ?? null, agentId: agent.id, origin: b.origin ?? "cli", originRef: b.originRef ?? null },
      Date.now(),
    );
    return c.json(conv, 201);
  });

  app.get("/api/conversations/:id", (c) => {
    const conv = store.resolveConversationPrefix(c.req.param("id"));
    if (!conv) throw new HTTPException(404, { message: `conversation "${c.req.param("id")}" 不存在` });
    const agent = store.getAgent(conv.agentId);
    return c.json({
      conversation: conv,
      agent,
      runs: store.listRunsByConversation(conv.id),
      statusLog: store.listStatusLog(conv.id),
    });
  });

  app.patch("/api/conversations/:id", async (c) => {
    const conv = store.resolveConversationPrefix(c.req.param("id"));
    if (!conv) throw new HTTPException(404, { message: `conversation "${c.req.param("id")}" 不存在` });
    const b = (await c.req.json()) as { status?: string };
    if (!b.status || !ISSUE_STATUSES.includes(b.status as ConversationStatus)) {
      bad(`status 可选 ${ISSUE_STATUSES.join("/")}（收到 "${b.status}"）`);
    }
    const to = b.status as ConversationStatus;
    // 取消 issue 时连带取消进行中的 run（不然 run 跑完又把状态拉走/白烧钱）
    if (to === "canceled") {
      const active = store.activeRunForConversation(conv.id);
      if (active) coordinator.cancelRun(active.id);
    }
    transitionConversation(store, conv, to, "human", Date.now());
    const fresh = store.getConversation(conv.id)!;
    // issue 终结 → worktree 收尾（保留分支删目录）；设备离线由重连对账补发
    if (to === "done" || to === "canceled") coordinator.requestWorktreeCleanup(fresh);
    return c.json(fresh);
  });

  app.post("/api/conversations/:id/runs", async (c) => {
    const conv = store.resolveConversationPrefix(c.req.param("id"));
    if (!conv) throw new HTTPException(404, { message: `conversation "${c.req.param("id")}" 不存在` });
    const b = (await c.req.json()) as { prompt?: string };
    if (!b.prompt?.trim()) bad("缺少 prompt");
    const agent = store.getAgent(conv.agentId);
    if (!agent) bad(`conversation 绑定的 agent 已不存在`);
    const run = coordinator.enqueueRun(conv, agent, b.prompt);
    return c.json(run, 201);
  });

  // ---- runs ----

  app.get("/api/runs/:id", (c) => {
    const run = store.resolveRunPrefix(c.req.param("id"));
    if (!run) throw new HTTPException(404, { message: `run "${c.req.param("id")}" 不存在` });
    return c.json(run);
  });

  app.post("/api/runs/:id/cancel", (c) => {
    const run = store.resolveRunPrefix(c.req.param("id"));
    if (!run) throw new HTTPException(404, { message: `run "${c.req.param("id")}" 不存在` });
    return c.json(coordinator.cancelRun(run.id));
  });

  // ---- approvals（P2 审批链路） ----

  app.get("/api/approvals", (c) => {
    const status = c.req.query("status") as import("../protocol.js").ApprovalStatus | undefined;
    return c.json(store.listApprovals(status));
  });

  app.post("/api/approvals/:id", async (c) => {
    const a = store.resolveApprovalPrefix(c.req.param("id"));
    if (!a) throw new HTTPException(404, { message: `approval "${c.req.param("id")}" 不存在` });
    const b = (await c.req.json()) as { behavior?: string };
    if (b.behavior !== "allow" && b.behavior !== "deny") bad(`behavior 只支持 allow/deny（收到 "${b.behavior}"）`);
    const decided = approvals.decide(a.id, b.behavior, "cli");
    return c.json(decided);
  });

  // ---- automations（P3 cron） ----

  app.get("/api/automations", (c) => {
    const agentNames = new Map(store.listAgents(true).map((a) => [a.id, a.name]));
    return c.json(
      store.listAutomations().map((a) => ({ ...a, agentName: agentNames.get(a.agentId) ?? a.agentId })),
    );
  });

  app.post("/api/automations", async (c) => {
    const b = (await c.req.json()) as {
      name?: string;
      agent?: string;
      cron?: string;
      prompt?: string;
      mode?: string;
      target?: string;
      notifyChat?: string;
    };
    if (!b.name) bad("缺少 name");
    if (!b.cron) bad("缺少 cron（5 段标准 cron 表达式，server 本机时区）");
    if (!b.prompt?.trim()) bad("缺少 prompt");
    try {
      AutomationService.validateCron(b.cron);
    } catch (e) {
      bad(`cron 表达式非法："${b.cron}"（${e instanceof Error ? e.message : e}）`);
    }
    const agent = b.agent ? (store.getAgentByName(b.agent) ?? store.getAgent(b.agent)) : null;
    if (!agent) bad(`agent "${b.agent}" 不存在（harbor agent ls 查看）`);
    if (agent.archivedAt) bad(`agent "${agent.name}" 已归档`);
    const mode = (b.mode ?? "new_issue") as import("../protocol.js").AutomationMode;
    if (mode !== "new_issue" && mode !== "append") bad(`mode 可选 new_issue/append（收到 "${b.mode}"）`);
    let targetId: string | null = null;
    if (mode === "append") {
      if (!b.target) bad("mode=append 需要 --target <conversation-id>");
      const target = store.resolveConversationPrefix(b.target);
      if (!target) bad(`target conversation "${b.target}" 不存在`);
      targetId = target.id;
    }
    const auto = store.createAutomation(
      {
        name: b.name,
        agentId: agent.id,
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
    const auto = store.resolveAutomationPrefix(c.req.param("id"));
    if (!auto) throw new HTTPException(404, { message: `automation "${c.req.param("id")}" 不存在` });
    const b = (await c.req.json()) as { enabled?: boolean };
    if (typeof b.enabled !== "boolean") bad("需要 enabled: true/false");
    store.setAutomationEnabled(auto.id, b.enabled);
    const fresh = store.getAutomation(auto.id)!;
    if (b.enabled) automations.schedule(fresh);
    else automations.unschedule(auto.id);
    return c.json(fresh);
  });

  app.delete("/api/automations/:id", (c) => {
    const auto = store.resolveAutomationPrefix(c.req.param("id"));
    if (!auto) throw new HTTPException(404, { message: `automation "${c.req.param("id")}" 不存在` });
    automations.unschedule(auto.id);
    store.deleteAutomation(auto.id);
    return c.json({ ok: true });
  });

  app.get("/api/automations/:id/log", (c) => {
    const auto = store.resolveAutomationPrefix(c.req.param("id"));
    if (!auto) throw new HTTPException(404, { message: `automation "${c.req.param("id")}" 不存在` });
    return c.json(store.listAutomationLog(auto.id));
  });

  // ---- usage（P3 报表） ----

  app.get("/api/usage", (c) => {
    const days = Math.max(1, Number(c.req.query("days") ?? 7));
    const fromTs = Date.now() - days * 24 * 3600 * 1000;
    return c.json(store.usageAggregate(fromTs));
  });

  app.get("/api/usage/runs", (c) => {
    const days = Math.max(1, Number(c.req.query("days") ?? 7));
    const fromTs = Date.now() - days * 24 * 3600 * 1000;
    const agentQ = c.req.query("agent");
    let agentId: string | undefined;
    if (agentQ) {
      const agent = store.getAgentByName(agentQ) ?? store.getAgent(agentQ);
      if (!agent) bad(`agent "${agentQ}" 不存在`);
      agentId = agent.id;
    }
    return c.json(store.listRunsForUsage({ agentId, day: c.req.query("day"), fromTs }));
  });

  // SSE：回放 run_events 已有行 → 实时直播 → run 终态发 done 帧收流。
  // 先订阅（缓冲）再回放，seq 去重弥合两段之间的竞态窗口。
  app.get("/api/runs/:id/events", (c) => {
    const run = store.resolveRunPrefix(c.req.param("id"));
    if (!run) throw new HTTPException(404, { message: `run "${c.req.param("id")}" 不存在` });

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

  return app;
}

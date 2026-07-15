/**
 * REST 入口层（Hono）：devices/agents/conversations/runs CRUD + run 事件 SSE + Bearer token auth。
 * 语义校验尽量前置到这一层（fail loudly at 配置时而非运行时）：
 *   - agent create 校验 model ∈ device 能力清单（harbor.md §8「endpoints.yaml 各机不一致」对策）
 *   - isolation=worktree P1 直接拒绝（P2 才实现生命周期，拒绝好过静默不隔离）
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
import { transitionConversation } from "./statemachine.js";

const PERMISSIONS = ["readonly", "auto-edit", "full", "default"];

function bad(message: string): never {
  throw new HTTPException(400, { message });
}

export function buildRest(
  store: HarborStore,
  bus: RunBus,
  hub: DeviceHub,
  coordinator: RunCoordinator,
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
    if (isolation === "worktree") bad("isolation=worktree 在 Phase 2 实现（worktree 生命周期未落地，拒绝好过静默不隔离）");

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
    return c.json({ conversation: conv, agent, runs: store.listRunsByConversation(conv.id) });
  });

  app.patch("/api/conversations/:id", async (c) => {
    const conv = store.resolveConversationPrefix(c.req.param("id"));
    if (!conv) throw new HTTPException(404, { message: `conversation "${c.req.param("id")}" 不存在` });
    const b = (await c.req.json()) as { status?: string };
    if (!b.status || !ISSUE_STATUSES.includes(b.status as ConversationStatus)) {
      bad(`status 可选 ${ISSUE_STATUSES.join("/")}（收到 "${b.status}"）`);
    }
    transitionConversation(store, conv, b.status as ConversationStatus, "human", Date.now());
    return c.json(store.getConversation(conv.id));
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
        let replaying = true;
        const pending: RunStreamFrame[] = [];
        const deliver = (frame: RunStreamFrame) => {
          if (frame.kind === "event") {
            if (frame.seq <= maxSeq) return;
            maxSeq = frame.seq;
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

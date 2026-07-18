#!/usr/bin/env bun
/**
 * harbor-server 入口 —— Bun.serve 单端口双面：/ws 升级给 DeviceHub，其余走 Hono REST。
 * 配置（env）：HARBOR_TOKEN（必须）、HARBOR_PORT=7777、HARBOR_DB=~/.harbor/harbor.db、
 * HARBOR_CONCURRENCY=2（per-device 并发闸）；飞书入口走 ~/.harbor.yaml feishu 块（可缺省）。
 */

import { resolve } from "node:path";
import { openDb } from "./db.js";
import { HarborStore } from "./store.js";
import { RunBus } from "./bus.js";
import { DeviceHub, type WsData } from "./ws.js";
import { RunCoordinator } from "./scheduler.js";
import { ApprovalService } from "./approvals.js";
import { AutomationService } from "./automation.js";
import { FeishuEntry } from "./feishu.js";
import { buildRest } from "./rest.js";
import { DeliveryService, ManualDeliveryProvider } from "./delivery.js";
import { GitHubDeliveryProvider, GitHubRestClient } from "./github-delivery.js";
import { CodebaseDeliveryProvider } from "./codebase.js";
import { ScmService } from "./scm.js";
import { transitionConversation } from "./statemachine.js";
import { SkillImportService } from "./skill-import.js";
import { SkillSyncService } from "./skill-sync.js";
import {
  codebaseConfig,
  feishuBotProfiles,
  githubConfig,
  token,
} from "../config.js";
import {
  DEFAULT_DEVICE_CONCURRENCY,
  DEFAULT_PORT,
  RUN_EVENTS_RETENTION_MS,
  type Conversation,
  type Delivery,
} from "../protocol.js";

const authToken = token();
const port = Number(process.env.HARBOR_PORT ?? DEFAULT_PORT);
const dbPath =
  process.env.HARBOR_DB ??
  resolve(process.env.HOME ?? "~", ".harbor/harbor.db");
const concurrency = Number(
  process.env.HARBOR_CONCURRENCY ?? DEFAULT_DEVICE_CONCURRENCY,
);

const db = openDb(dbPath);
const store = new HarborStore(db);
const bus = new RunBus();
const hub = new DeviceHub(store, authToken);
const gc = githubConfig();
const deliveries = new DeliveryService(store, [
  new ManualDeliveryProvider(),
  new CodebaseDeliveryProvider(store),
  ...(gc
    ? [new GitHubDeliveryProvider(new GitHubRestClient(gc.token))]
    : []),
]);
if (!gc) {
  console.log(
    "[harbor-server] GitHub Delivery 未配置（HARBOR_GITHUB_TOKEN 或 ~/.harbor.yaml github.token），manual provider 仍可用",
  );
}
const coordinator = new RunCoordinator(store, bus, hub, concurrency, deliveries);
const approvals = new ApprovalService(store, bus, hub);
const automations = new AutomationService(store, coordinator);
const scm = new ScmService(store, coordinator, deliveries);
const codebase = codebaseConfig();
const skillImports = new SkillImportService();
const skillSync = new SkillSyncService(store, skillImports);
hub.coordinator = coordinator;
hub.approvals = approvals;

const finalizeDelivery = (deliveryId: string): void => {
  const delivery = store.getDelivery(deliveryId);
  if (!delivery || !deliveries.isComplete(delivery)) return;
  const conversation = store.getConversation(delivery.conversationId);
  if (
    !conversation ||
    conversation.kind !== "issue" ||
    conversation.status === "done" ||
    conversation.status === "canceled"
  ) return;
  transitionConversation(store, conversation, "done", "system", Date.now());
  coordinator.requestWorktreeCleanup(store.getConversation(conversation.id)!);
};

const dispatchMergedEvent = (delivery: Delivery, conversation: Conversation): void => {
  const results = automations.receiveEvent({
    workspaceId: conversation.workspaceId,
    eventType: "delivery.merged",
    eventId: `delivery.merged:${delivery.id}:${delivery.mergedAt ?? delivery.revision}`,
    payload: {
      conversationId: conversation.id,
      deliveryId: delivery.id,
      repositoryId: conversation.repositoryId,
      changeUrl: delivery.changeUrl,
      baseBranch: delivery.baseBranch,
      deploymentStatus: delivery.deploymentStatus,
    },
  });
  const deployment = results.find((result) => {
    if (result.status !== "started") return false;
    const automation = store.getAutomation(result.automationId);
    return automation?.purpose === "verification" && automation.outputMode === "run";
  });
  if (delivery.deploymentStatus === "pending" && deployment?.status === "started") {
    deliveries.beginAutomatedDeployment(delivery, deployment.run.id);
  }
};

const dispatchMergeReadyEvent = (delivery: Delivery, conversation: Conversation): void => {
  automations.receiveEvent({
    workspaceId: conversation.workspaceId,
    eventType: "delivery.merge_ready",
    eventId: `delivery.merge_ready:${delivery.id}:${delivery.revision}`,
    payload: {
      conversationId: conversation.id,
      deliveryId: delivery.id,
      repositoryId: conversation.repositoryId,
      changeUrl: delivery.changeUrl,
      checkStatus: delivery.checkStatus,
    },
  });
};

deliveries.onTransition = (before, after) => {
  const conversation = store.getConversation(after.conversationId);
  if (!conversation) return;
  if (before.mergeStatus !== "merged" && after.mergeStatus === "merged") {
    dispatchMergedEvent(after, conversation);
  }
  if (
    before.status !== "merge_ready" &&
    after.status === "merge_ready" &&
    !store.activeRunForConversation(conversation.id)
  ) {
    dispatchMergeReadyEvent(after, conversation);
  }
  finalizeDelivery(after.id);
};

// 飞书入口（可选）：配置齐才挂；审批卡片/结果回报都走它
const feishuEntries: FeishuEntry[] = [];
const profiles = feishuBotProfiles();
if (profiles.length > 0) {
  const { FeishuChannel } = await import("@sm/channel-feishu");
  for (const profile of profiles) {
    const workspace = profile.workspaceKey
      ? store.resolveWorkspace(profile.workspaceKey)
      : null;
    if (profile.mode === "custom" && !workspace) {
      console.error(
        `[harbor-server] custom 飞书 Bot 的 Workspace 不存在：${profile.workspaceKey}`,
      );
      continue;
    }
    const channel = new FeishuChannel({
      appId: profile.config.appId,
      appSecret: profile.config.appSecret,
      botName: profile.config.botName,
      requireMention: false,
    });
    const entry = new FeishuEntry(
      store,
      coordinator,
      approvals,
      profile.config,
      channel,
      {
        botMode: profile.mode,
        ...(workspace ? { workspaceId: workspace.id } : {}),
      },
    );
    feishuEntries.push(entry);
    entry.start().catch((error) => {
      console.error(
        `[harbor-server] ${profile.mode} 飞书入口启动失败（其他入口继续）：`,
        error,
      );
      const index = feishuEntries.indexOf(entry);
      if (index >= 0) feishuEntries.splice(index, 1);
    });
  }
  approvals.sink = {
    onApprovalCreated: (approval, run, conv) =>
      feishuEntries.forEach((entry) =>
        entry.onApprovalCreated(approval, run, conv),
      ),
    onApprovalDecided: (approval) =>
      feishuEntries.forEach((entry) => entry.onApprovalDecided(approval)),
  };
} else {
  console.log(
    "[harbor-server] 飞书未配置（~/.harbor.yaml feishu 块），入口关闭",
  );
}

// run 终态 hook：审批作废 + 飞书回报
coordinator.onRunFinished = (run, conv) => {
  approvals.expireForRun(run.id);
  feishuEntries.forEach((entry) => entry.notifyRunDone(run, conv));
  void scm.notifyRunDone(run, conv).catch((error) => {
    console.error(
      "[codebase] Run 结果回写失败：",
      error instanceof Error ? error.message : error,
    );
  });
  if (
    run.status === "succeeded" &&
    run.purpose === "implementation" &&
    conv?.kind === "issue" &&
    conv.status === "review"
  ) {
    automations.receiveEvent({
      workspaceId: run.workspaceId,
      eventType: "issue.review_ready",
      eventId: `issue.review_ready:${run.id}`,
      payload: {
        conversationId: conv.id,
        runId: run.id,
        repositoryId: conv.repositoryId,
        assigneeAgentId: conv.agentId,
      },
    });
  }
  const triggerPayload = run.triggerContext.payload;
  const deliveryId =
    run.sourceType === "automation" &&
    run.triggerContext.eventType === "delivery.merged" &&
    triggerPayload &&
    typeof triggerPayload === "object" &&
    !Array.isArray(triggerPayload) &&
    typeof (triggerPayload as Record<string, unknown>).deliveryId === "string"
      ? (triggerPayload as Record<string, unknown>).deliveryId as string
      : null;
  if (deliveryId) {
    const delivery = store.getDelivery(deliveryId);
    const deploymentEvent = store
      .listDeliveryEvents(deliveryId)
      .filter((event) => event.kind === "deployment_started")
      .at(-1);
    const deploymentRunId =
      deploymentEvent?.data &&
      typeof deploymentEvent.data === "object" &&
      !Array.isArray(deploymentEvent.data) &&
      typeof (deploymentEvent.data as Record<string, unknown>).runId === "string"
        ? (deploymentEvent.data as Record<string, unknown>).runId
        : null;
    if (delivery?.deploymentStatus === "running" && deploymentRunId === run.id) {
      try {
        deliveries.finishDeployment(
          delivery,
          run.status === "succeeded" ? "succeeded" : "failed",
          Date.now(),
          "agent",
        );
        finalizeDelivery(delivery.id);
      } catch (error) {
        console.error(
          `[automation] deployment Run ${run.id} 收尾失败：`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }
};

const app = buildRest(
  store,
  bus,
  hub,
  coordinator,
  approvals,
  automations,
  authToken,
  deliveries,
  scm,
  codebase?.webhookSecret ?? "",
  skillImports,
  new Set(
    profiles
      .filter((profile) => profile.mode === "custom")
      .map((profile) =>
        profile.workspaceKey
          ? store.resolveWorkspace(profile.workspaceKey)?.id
          : null,
      )
      .filter((id): id is string => !!id),
  ),
);

Bun.serve<WsData>({
  port,
  idleTimeout: 0, // SSE 长挂（模型思考期无数据），禁用 HTTP 空闲超时；WS 保活靠心跳+sweep
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const ok = server.upgrade(req, {
        data: {
          deviceId: null,
          deviceName: null,
          lastHeartbeat: Date.now(),
        } satisfies WsData,
      });
      if (ok) return undefined;
      return new Response("websocket upgrade failed", { status: 400 });
    }
    return app.fetch(req);
  },
  websocket: {
    open: (ws) => hub.handleOpen(ws),
    message: (ws, msg) => hub.handleMessage(ws, msg),
    close: (ws) => hub.handleClose(ws),
  },
});
hub.startSweeper();
approvals.startSweeper();
automations.start();
// crash-safe reconciliation：领域事实先落库，boot 时用稳定 eventId 重放；Trigger delivery 表负责去重。
for (const conversation of store.listConversations({ kind: "issue", status: "review" })) {
  if (store.activeRunForConversation(conversation.id)) continue;
  const delivery = store.getDeliveryForConversation(conversation.id);
  if (delivery?.mergeStatus === "merged" && delivery.deploymentStatus === "pending") {
    dispatchMergedEvent(delivery, conversation);
  } else if (delivery?.status === "merge_ready") {
    dispatchMergeReadyEvent(delivery, conversation);
  }
  if (!delivery || delivery.reviewStatus === "pending") {
    const implementation = store
      .listRunsByConversation(conversation.id)
      .filter((run) => run.purpose === "implementation" && run.status === "succeeded")
      .at(-1);
    if (implementation) {
      automations.receiveEvent({
        workspaceId: conversation.workspaceId,
        eventType: "issue.review_ready",
        eventId: `issue.review_ready:${implementation.id}`,
        payload: {
          conversationId: conversation.id,
          runId: implementation.id,
          repositoryId: conversation.repositoryId,
          assigneeAgentId: conversation.agentId,
        },
      });
    }
  }
}
skillSync.start();

// run_events 7 天滚动 prune（boot 一次 + 每小时）
const prune = () => {
  const n = store.pruneRunEvents(Date.now() - RUN_EVENTS_RETENTION_MS);
  if (n > 0)
    console.log(`[harbor-server] run_events prune：清理 ${n} 行（>7 天）`);
};
prune();
setInterval(prune, 3600_000);

console.log(
  `[harbor-server] listening on :${port}  db=${dbPath}  concurrency/device=${concurrency}`,
);

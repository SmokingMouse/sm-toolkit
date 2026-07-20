#!/usr/bin/env bun
/**
 * harbor-server 入口 —— Bun.serve 单端口双面：/ws 升级给 DeviceHub，其余走 Hono REST。
 * 配置（env）：HARBOR_TOKEN（必须）、HARBOR_PORT=7777、HARBOR_DB=~/.harbor/harbor.db、
 * HARBOR_CONCURRENCY=2（per-device 并发闸）；飞书入口走 ~/.harbor.yaml feishu 块（可缺省）。
 */

import { openDb } from "./db.js";
import { HarborStore } from "./store.js";
import { RunBus } from "./bus.js";
import { DeviceHub, type WsData } from "./ws.js";
import { RunCoordinator } from "./scheduler.js";
import { ApprovalService } from "./approvals.js";
import { AutomationService } from "./automation.js";
import { FeishuEntry } from "./feishu.js";
import { buildRest } from "./rest.js";
import { DeliveryService } from "./delivery.js";
import { GitHubDeliveryProvider, GitHubRestClient } from "./github-delivery.js";
import { CodebaseDeliveryProvider } from "./codebase.js";
import { ScmService } from "./scm.js";
import { transitionConversation } from "./statemachine.js";
import { SkillImportService } from "./skill-import.js";
import { SkillSyncService } from "./skill-sync.js";
import {
  codebaseConfig,
  databasePath,
  feishuBotProfiles,
  githubAppConfig,
  harborSelfDeployTarget,
  publicAuthConfig,
  token,
} from "../config.js";
import {
  DEFAULT_DEVICE_CONCURRENCY,
  DEFAULT_PORT,
  RUN_EVENTS_RETENTION_MS,
  type Conversation,
  type Delivery,
} from "../protocol.js";
import { reconcileCompletedDeliveries } from "./delivery-reconciler.js";
import { HostMaintenanceSentinel } from "../deployment-worker/maintenance.js";
import { DeploymentMaintenanceGuard } from "./maintenance.js";
import { ensureBuiltinSkills } from "./builtin-skills.js";
import { AuthService } from "./auth.js";
import { GitHubAppClient } from "./github-app.js";
import { GitHubIntegrationService } from "./github-integration.js";

const authToken = token();
const port = Number(process.env.HARBOR_PORT ?? DEFAULT_PORT);
const dbPath = databasePath();
const concurrency = Number(
  process.env.HARBOR_CONCURRENCY ?? DEFAULT_DEVICE_CONCURRENCY,
);

const db = openDb(dbPath);
const store = new HarborStore(db);
const selfDeployTarget = harborSelfDeployTarget({ resolveSecrets: false });
const auth = new AuthService(store, publicAuthConfig());
const bus = new RunBus();
const hasDatabaseMaintenance = () =>
  store.listDeploymentMaintenance().length > 0;
const hub = new DeviceHub(store, authToken, hasDatabaseMaintenance);
const gc = githubAppConfig();
const githubAppClient = gc ? new GitHubAppClient(gc) : null;
const githubIntegration = githubAppClient
  ? new GitHubIntegrationService(store, auth, githubAppClient)
  : null;
const maintenance = new DeploymentMaintenanceGuard(store, new HostMaintenanceSentinel());
let maintenanceActive = (await maintenance.current()).active;
const writesBlocked = () => maintenanceActive || hasDatabaseMaintenance();
hub.setMaintenance(maintenanceActive);
const deliveries = new DeliveryService(
  store,
  [
    new CodebaseDeliveryProvider(store),
    ...(githubAppClient
      ? [new GitHubDeliveryProvider((repository) => {
          const connection = store.githubRepositoryConnectionForRepository(repository.id);
          if (!connection) throw new Error(`Repository "${repository.name}" 尚未连接 GitHub App installation`);
          return new GitHubRestClient((forceRefresh) => githubAppClient.installationToken(connection.installationId, forceRefresh));
        })]
      : []),
  ],
);
if (!githubAppClient) {
  console.log(
    "[harbor-server] GitHub App 未配置，GitHub Delivery/OAuth/webhook 关闭；manual provider 仍可用",
  );
}
const coordinator = new RunCoordinator(store, bus, hub, concurrency, deliveries);
const approvals = new ApprovalService(store, bus, hub, writesBlocked);
const automations = new AutomationService(store, coordinator, writesBlocked);
const scm = new ScmService(store, coordinator, deliveries);
scm.setAutomationListener((input) => automations.receiveCodebase(input).length > 0);
const codebase = codebaseConfig();
const skillImports = new SkillImportService(undefined, undefined, githubAppClient
  ? async ({ workspaceId, owner, repository }) => {
      const fullName = `${owner}/${repository}`.toLowerCase();
      const connection = store.listGitHubRepositoryConnections(workspaceId)
        .find((candidate) => candidate.status === "active" && candidate.fullName === fullName);
      return connection ? githubAppClient.installationToken(connection.installationId) : null;
    }
  : null);
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
  store.recordDomainEvent({
    workspaceId: conversation.workspaceId,
    type: "delivery.merged",
    id: `delivery.merged:${delivery.id}:${delivery.mergedAt ?? delivery.revision}`,
    sourceType: "delivery",
    sourceId: delivery.id,
    payload: {
      conversationId: conversation.id,
      deliveryId: delivery.id,
      repositoryId: conversation.repositoryId,
      changeUrl: delivery.changeUrl,
      baseBranch: delivery.baseBranch,
      mergedRevision: delivery.mergedRevision,
    },
  }, delivery.mergedAt ?? Date.now());
};

const dispatchMergeReadyEvent = (delivery: Delivery, conversation: Conversation): void => {
  store.recordDomainEvent({
    workspaceId: conversation.workspaceId,
    type: "delivery.merge_ready",
    id: `delivery.merge_ready:${delivery.id}:${delivery.revision}`,
    sourceType: "delivery",
    sourceId: delivery.id,
    payload: {
      conversationId: conversation.id,
      deliveryId: delivery.id,
      repositoryId: conversation.repositoryId,
      changeUrl: delivery.changeUrl,
      checkStatus: delivery.checkStatus,
    },
  }, delivery.updatedAt);
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
const startedFeishuEntries = new Set<FeishuEntry>();
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
      writesBlocked,
    );
    feishuEntries.push(entry);
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
const startFeishu = () => {
  if (writesBlocked()) return;
  for (const entry of feishuEntries) {
    if (startedFeishuEntries.has(entry)) continue;
    startedFeishuEntries.add(entry);
    entry.start().catch((error) => {
      startedFeishuEntries.delete(entry);
      console.error("[harbor-server] 飞书入口启动失败（其他入口继续）：", error);
    });
  }
};
startFeishu();

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
    store.recordDomainEvent({
      workspaceId: run.workspaceId,
      type: "issue.review_ready",
      id: `issue.review_ready:${run.id}`,
      sourceType: "issue",
      sourceId: conv.id,
      payload: {
        conversationId: conv.id,
        runId: run.id,
        repositoryId: conv.repositoryId,
        assigneeAgentId: conv.agentId,
      },
    }, run.finishedAt ?? Date.now());
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
  maintenance,
  auth,
  selfDeployTarget,
  gc?.webhookSecret ?? "",
  githubIntegration,
);

// Delivery facts already live in SQLite; startup and live updates deterministically finalize Issues.
const finalizeDeliveries = async () => {
  try {
    if ((await maintenance.current()).active) return;
  } catch {
    return;
  }
  reconcileCompletedDeliveries(store, coordinator);
};
void finalizeDeliveries();
setInterval(() => void finalizeDeliveries(), 1_000);

Bun.serve<WsData>({
  port,
  idleTimeout: 0, // SSE 长挂（模型思考期无数据），禁用 HTTP 空闲超时；WS 保活靠心跳+sweep
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      let blocked = true;
      try { blocked = (await maintenance.current()).active; } catch { /* fail-closed */ }
      if (blocked) {
        return new Response("deployment maintenance", { status: 503, headers: { "Retry-After": "1" } });
      }
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

const startControlPlane = () => {
  ensureBuiltinSkills(store);
  approvals.startSweeper();
  automations.start();
  skillSync.start();
  startFeishu();
};

const stopControlPlane = () => {
  approvals.stopSweeper();
  automations.stop();
  skillSync.stop();
};

if (!maintenanceActive) {
  startControlPlane();
}

setInterval(() => {
  void maintenance.current().then((snapshot) => {
    if (snapshot.active === maintenanceActive) return;
    maintenanceActive = snapshot.active;
    hub.setMaintenance(maintenanceActive);
    if (maintenanceActive) {
      stopControlPlane();
    } else {
      startControlPlane();
    }
  }).catch((error) => {
    maintenanceActive = true;
    hub.setMaintenance(true);
    stopControlPlane();
    console.error("[harbor-server] maintenance sentinel 不可判定，已 fail-closed：", error);
  });
}, 250);

// run_events 7 天滚动 prune（boot 一次 + 每小时）
const prune = () => {
  if (writesBlocked()) return;
  const n = store.pruneRunEvents(Date.now() - RUN_EVENTS_RETENTION_MS);
  if (n > 0)
    console.log(`[harbor-server] run_events prune：清理 ${n} 行（>7 天）`);
};
prune();
setInterval(prune, 3600_000);

console.log(
  `[harbor-server] listening on :${port}  db=${dbPath}  concurrency/device=${concurrency}`,
);

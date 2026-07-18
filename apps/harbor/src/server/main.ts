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
import { DeliveryService } from "./delivery.js";
import { GitHubDeliveryProvider, GitHubRestClient } from "./github-delivery.js";
import { feishuConfig, githubConfig, token } from "../config.js";
import { DEFAULT_DEVICE_CONCURRENCY, DEFAULT_PORT, RUN_EVENTS_RETENTION_MS } from "../protocol.js";

const authToken = token();
const port = Number(process.env.HARBOR_PORT ?? DEFAULT_PORT);
const dbPath = process.env.HARBOR_DB ?? resolve(process.env.HOME ?? "~", ".harbor/harbor.db");
const concurrency = Number(process.env.HARBOR_CONCURRENCY ?? DEFAULT_DEVICE_CONCURRENCY);

const db = openDb(dbPath);
const store = new HarborStore(db);
const bus = new RunBus();
const hub = new DeviceHub(store, authToken);
const gc = githubConfig();
const deliveries = new DeliveryService(
  store,
  gc ? [new GitHubDeliveryProvider(new GitHubRestClient(gc.token))] : [],
);
if (!gc) {
  console.log(
    "[harbor-server] GitHub Delivery 未配置（HARBOR_GITHUB_TOKEN 或 ~/.harbor.yaml github.token），manual provider 仍可用",
  );
}
const coordinator = new RunCoordinator(store, bus, hub, concurrency, deliveries);
const approvals = new ApprovalService(store, bus, hub);
const automations = new AutomationService(store, coordinator);
hub.coordinator = coordinator;
hub.approvals = approvals;

// 飞书入口（可选）：配置齐才挂；审批卡片/结果回报都走它
let feishu: FeishuEntry | null = null;
const fc = feishuConfig();
if (fc) {
  const { FeishuChannel } = await import("@sm/channel-feishu");
  const channel = new FeishuChannel({
    appId: fc.appId,
    appSecret: fc.appSecret,
    botName: fc.botName,
    requireMention: true,
  });
  feishu = new FeishuEntry(store, coordinator, approvals, fc, channel);
  approvals.sink = feishu;
  feishu.start().catch((e) => {
    console.error("[harbor-server] 飞书入口启动失败（server 继续跑，仅 CLI/REST 面可用）：", e);
    feishu = null;
    approvals.sink = null;
  });
} else {
  console.log("[harbor-server] 飞书未配置（~/.harbor.yaml feishu 块），入口关闭");
}

// run 终态 hook：审批作废 + 飞书回报
coordinator.onRunFinished = (run, conv) => {
  approvals.expireForRun(run.id);
  feishu?.notifyRunDone(run, conv);
};

const app = buildRest(store, bus, hub, coordinator, approvals, automations, authToken, deliveries);

Bun.serve<WsData>({
  port,
  idleTimeout: 0, // SSE 长挂（模型思考期无数据），禁用 HTTP 空闲超时；WS 保活靠心跳+sweep
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const ok = server.upgrade(req, {
        data: { deviceId: null, deviceName: null, lastHeartbeat: Date.now() } satisfies WsData,
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

// run_events 7 天滚动 prune（boot 一次 + 每小时）
const prune = () => {
  const n = store.pruneRunEvents(Date.now() - RUN_EVENTS_RETENTION_MS);
  if (n > 0) console.log(`[harbor-server] run_events prune：清理 ${n} 行（>7 天）`);
};
prune();
setInterval(prune, 3600_000);

console.log(`[harbor-server] listening on :${port}  db=${dbPath}  concurrency/device=${concurrency}`);

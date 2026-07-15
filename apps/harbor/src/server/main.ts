#!/usr/bin/env bun
/**
 * harbor-server 入口 —— Bun.serve 单端口双面：/ws 升级给 DeviceHub，其余走 Hono REST。
 * 配置（env）：HARBOR_TOKEN（必须）、HARBOR_PORT=7777、HARBOR_DB=~/.harbor/harbor.db、
 * HARBOR_CONCURRENCY=2（per-device 并发闸）。
 */

import { resolve } from "node:path";
import { openDb } from "./db.js";
import { HarborStore } from "./store.js";
import { RunBus } from "./bus.js";
import { DeviceHub, type WsData } from "./ws.js";
import { RunCoordinator } from "./scheduler.js";
import { buildRest } from "./rest.js";
import { token } from "../config.js";
import { DEFAULT_DEVICE_CONCURRENCY, DEFAULT_PORT } from "../protocol.js";

const authToken = token();
const port = Number(process.env.HARBOR_PORT ?? DEFAULT_PORT);
const dbPath = process.env.HARBOR_DB ?? resolve(process.env.HOME ?? "~", ".harbor/harbor.db");
const concurrency = Number(process.env.HARBOR_CONCURRENCY ?? DEFAULT_DEVICE_CONCURRENCY);

const db = openDb(dbPath);
const store = new HarborStore(db);
const bus = new RunBus();
const hub = new DeviceHub(store, authToken);
const coordinator = new RunCoordinator(store, bus, hub, concurrency);
hub.coordinator = coordinator;
const app = buildRest(store, bus, hub, coordinator, authToken);

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

console.log(`[harbor-server] listening on :${port}  db=${dbPath}  concurrency/device=${concurrency}`);

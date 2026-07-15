/**
 * DeviceHub —— daemon WS 连接管理（注册/心跳/离线判定），实现 DeviceTransport。
 * 业务（对账/调度/落库）全在 RunCoordinator，这里只做传输与消息解析。
 *
 * 离线判定双通道：TCP close 即时下线；半开连接靠 sweep（30s 扫一遍，
 * 最后心跳距今 > 90s 主动断开）。daemon 侧 30s 一跳。
 */

import type { ServerWebSocket } from "bun";
import { createHash } from "node:crypto";
import type { DaemonMsg, DeviceCapabilities, ServerMsg } from "../protocol.js";
import { OFFLINE_AFTER_MS } from "../protocol.js";
import type { HarborStore } from "./store.js";
import type { DeviceTransport, RunCoordinator } from "./scheduler.js";
import type { ApprovalService } from "./approvals.js";

export interface WsData {
  deviceId: string | null;
  deviceName: string | null;
  lastHeartbeat: number;
}

export class DeviceHub implements DeviceTransport {
  private conns = new Map<string, ServerWebSocket<WsData>>(); // deviceId → ws
  /** hello 后由 main 注入（hub 先于 coordinator 构造，二者互相引用） */
  coordinator!: RunCoordinator;
  approvals!: ApprovalService;
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(
    private store: HarborStore,
    private expectedToken: string,
  ) {}

  startSweeper(): void {
    this.sweeper = setInterval(() => this.sweep(), 30_000);
  }

  stopSweeper(): void {
    if (this.sweeper) clearInterval(this.sweeper);
  }

  // ---- DeviceTransport ----

  isOnline(deviceId: string): boolean {
    return this.conns.has(deviceId);
  }

  onlineIds(): Set<string> {
    return new Set(this.conns.keys());
  }

  send(deviceId: string, msg: ServerMsg): boolean {
    const ws = this.conns.get(deviceId);
    if (!ws) return false;
    return ws.send(JSON.stringify(msg)) > 0;
  }

  // ---- Bun.serve websocket handlers ----

  handleOpen(_ws: ServerWebSocket<WsData>): void {
    // 注册发生在 hello 消息，open 时什么都不做
  }

  handleMessage(ws: ServerWebSocket<WsData>, raw: string | Buffer): void {
    let msg: DaemonMsg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf-8")) as DaemonMsg;
    } catch {
      return;
    }

    if (msg.type === "hello") {
      this.handleHello(ws, msg.deviceName, msg.token, msg.capabilities, msg.runningRunIds);
      return;
    }

    const deviceId = ws.data.deviceId;
    if (!deviceId) return; // hello 前的消息一律丢弃

    ws.data.lastHeartbeat = Date.now();
    this.store.touchDevice(deviceId, Date.now());

    switch (msg.type) {
      case "heartbeat":
        break; // touch 已完成
      case "run_event":
        this.coordinator.onRunEvents(msg.events);
        break;
      case "run_done":
        this.coordinator.onRunDone(msg);
        break;
      case "approval_req":
        this.approvals.onApprovalReq(msg);
        break;
      case "worktree_ready":
        this.coordinator.onWorktreeReady(msg.conversationId, msg.path);
        break;
      case "worktree_cleanup_result":
        this.coordinator.onWorktreeCleanupResult(msg.conversationId, msg.ok, msg.message);
        break;
    }
  }

  handleClose(ws: ServerWebSocket<WsData>): void {
    const id = ws.data.deviceId;
    if (id && this.conns.get(id) === ws) {
      this.conns.delete(id);
      console.log(`[hub] device 离线：${ws.data.deviceName}（${id}）`);
    }
  }

  // ---- 内部 ----

  private handleHello(
    ws: ServerWebSocket<WsData>,
    deviceName: string,
    tok: string,
    capabilities: DeviceCapabilities,
    runningRunIds: string[],
  ): void {
    if (tok !== this.expectedToken) {
      ws.send(JSON.stringify({ type: "hello_err", message: "token 不匹配" } satisfies ServerMsg));
      ws.close(4001, "auth failed");
      return;
    }
    const now = Date.now();
    const device = this.store.upsertDevice(deviceName, sha256(tok), capabilities, now);

    // 同名 device 重复连接：踢掉旧连接（daemon 重启后旧 TCP 半开的场景）
    const prev = this.conns.get(device.id);
    if (prev && prev !== ws) prev.close(4002, "superseded by new connection");

    ws.data.deviceId = device.id;
    ws.data.deviceName = device.name;
    ws.data.lastHeartbeat = now;
    this.conns.set(device.id, ws);
    ws.send(JSON.stringify({ type: "hello_ok", deviceId: device.id } satisfies ServerMsg));
    console.log(
      `[hub] device 上线：${device.name}（${device.id}）clis=${JSON.stringify(capabilities.clis)} endpoints=${capabilities.endpoints.length} 个，对账 running=${runningRunIds.length}`,
    );

    // 对账（清孤儿 + worktree 收尾补发）+ 决议补投 + 补位调度
    this.coordinator.reconcileDevice(device.id, runningRunIds);
    this.approvals.redeliverForDevice(device.id);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, ws] of this.conns) {
      if (now - ws.data.lastHeartbeat > OFFLINE_AFTER_MS) {
        console.log(`[hub] device 心跳超时（>${OFFLINE_AFTER_MS / 1000}s），断开：${ws.data.deviceName}（${id}）`);
        ws.close(4000, "heartbeat timeout"); // close handler 负责移除
      }
    }
  }
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

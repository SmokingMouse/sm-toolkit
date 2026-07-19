#!/usr/bin/env bun
/**
 * harbord —— 每设备常驻 daemon。主动外连 server（穿 NAT 免端口配置），
 * 断线指数退避重连（1s→2s→…→30s 封顶），重连 hello 带「还认账的 run」做状态对账。
 *
 * outbox 语义：run_event / run_done 是必达消息，断线时缓存、重连后 hello 之后按序补发
 * （server 按 (run_id, seq) 幂等插入，重发不重复）。heartbeat 可丢，不入 outbox。
 *
 * 对账口径（防误判）：hello.runningRunIds = 执行中的 run ∪ outbox 里还有待送达消息的 run。
 * 若只报执行中的，断线期间刚完成的 run 会在 hello 对账时被 server 误判 failed，
 * 随后补发的 run_done(succeeded) 因 run 已终态而被忽略 —— 成功被记成失败。
 */

import type { DaemonMsg, ServerMsg } from "../protocol.js";
import { HEARTBEAT_INTERVAL_MS } from "../protocol.js";
import { deviceName, serverUrl, serverWsUrl, token } from "../config.js";
import { detectCapabilities } from "./capabilities.js";
import { Executor } from "./executor.js";
import { removeReviewCheckout, removeWorktree, reviewWorktreePathFor } from "./worktree.js";
import { HostMaintenanceSentinel } from "../deployment-worker/maintenance.js";
import { DaemonMaintenanceLatch } from "./maintenance.js";

const authToken = token(); // 缺失时这里就抛，fail loudly
const name = deviceName();
const wsUrl = serverWsUrl();
const capabilities = detectCapabilities();
const maintenance = new DaemonMaintenanceLatch(new HostMaintenanceSentinel());

if (!capabilities.clis.claude && !capabilities.clis.codex) {
  console.warn("[harbord] 警告：本机未检测到 claude/codex CLI，收到 run 会直接失败");
}

let ws: WebSocket | null = null;
let attempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const outbox: DaemonMsg[] = [];

/** 必达消息类型（断线入 outbox 重连补发）；heartbeat 可丢 */
const MUST_DELIVER = new Set<DaemonMsg["type"]>([
  "run_event",
  "run_done",
  "approval_req",
  "worktree_ready",
  "run_execution_ready",
  "worktree_cleanup_result",
]);

function sendOrQueue(msg: DaemonMsg): void {
  if (maintenance.isBlocked()) return;
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(msg));
      return;
    } catch {
      // fallthrough → 入队
    }
  }
  if (MUST_DELIVER.has(msg.type)) outbox.push(msg);
}

const executor = new Executor(sendOrQueue, `${serverUrl().replace(/\/$/, "")}/hooks/agent-actions/issues`);

/** daemon 侧还认账的 run：执行中 + outbox 里有待送达消息的（见文件头对账口径） */
function ownedRunIds(): string[] {
  const ids = new Set(executor.runningIds());
  for (const m of outbox) {
    if (
      m.type === "run_done" ||
      m.type === "approval_req" ||
      m.type === "worktree_ready" ||
      m.type === "run_execution_ready"
    ) ids.add(m.runId);
    else if (m.type === "run_event") for (const e of m.events) ids.add(e.runId);
  }
  return [...ids];
}

async function connect(): Promise<void> {
  if (await maintenance.refresh()) {
    scheduleReconnect();
    return;
  }
  console.log(`[harbord] 连接 ${wsUrl} …（device=${name}）`);
  ws = new WebSocket(wsUrl);

  ws.onopen = async () => {
    if (await maintenance.refresh()) {
      ws?.close(1013, "deployment maintenance");
      return;
    }
    attempt = 0;
    ws!.send(
      JSON.stringify({
        type: "hello",
        deviceName: name,
        token: authToken,
        capabilities,
        runningRunIds: ownedRunIds(),
      } satisfies DaemonMsg),
    );
    // hello 之后按序补发积压（同一 ws 内 server 逐消息处理：先对账、后收补发，顺序安全）
    while (outbox.length > 0) {
      const m = outbox[0]!;
      try {
        ws!.send(JSON.stringify(m));
        outbox.shift();
      } catch {
        break; // 连接又断了，留待下次
      }
    }
  };

  ws.onmessage = async (e) => {
    if (await maintenance.refresh()) {
      ws?.close(1013, "deployment maintenance");
      return;
    }
    let msg: ServerMsg;
    try {
      msg = JSON.parse(String(e.data)) as ServerMsg;
    } catch {
      return;
    }
    switch (msg.type) {
      case "hello_ok":
        console.log(
          `[harbord] 已注册（deviceId=${msg.deviceId}），claude=${capabilities.clis.claude ?? "-"} routes=${capabilities.modelRoutes?.filter((route) => route.ready).length ?? 0}/${capabilities.modelRoutes?.length ?? 0}`,
        );
        break;
      case "hello_err":
        console.error(`[harbord] 注册被拒：${msg.message} —— 检查 HARBOR_TOKEN / ~/.harbor.yaml`);
        process.exit(1); // token 错重试无意义
        break;
      case "run_start":
        console.log(`[harbord] run_start ${msg.runId}（backend=${msg.spec.backend} model=${msg.spec.model ?? "默认"} resume=${msg.spec.resume ? "是" : "否"}）`);
        if (!maintenance.isBlocked()) executor.start(msg.runId, msg.spec);
        break;
      case "run_cancel":
        executor.cancel(msg.runId);
        break;
      case "approval_res":
        console.log(`[harbord] approval_res ${msg.behavior}（run=${msg.runId} req=${msg.requestId}）`);
        executor.resolveApproval(msg.runId, msg.requestId, msg.behavior, msg.updatedInput, msg.message);
        break;
      case "worktree_cleanup": {
        const r = removeWorktree(msg.repositoryRoot, msg.worktreePath);
        console.log(`[harbord] worktree_cleanup ${msg.conversationId}：${r.ok ? "✓" : "✗"} ${r.message}`);
        sendOrQueue({ type: "worktree_cleanup_result", conversationId: msg.conversationId, ok: r.ok, message: r.message });
        break;
      }
      case "review_checkout_cleanup": {
        const path = reviewWorktreePathFor(msg.repositoryRoot, msg.runId);
        const result = removeReviewCheckout(msg.repositoryRoot, path);
        console.log(`[harbord] review_checkout_cleanup ${msg.runId}：${result.ok ? "✓" : "✗"} ${result.message}`);
        break;
      }
    }
  };

  ws.onclose = () => {
    ws = null;
    scheduleReconnect();
  };
  ws.onerror = () => {
    // onclose 会跟着触发，重连逻辑集中在那里
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = Math.min(30_000, 1000 * 2 ** attempt);
  attempt++;
  console.log(`[harbord] 连接断开，${Math.round(delay / 1000)}s 后重连（第 ${attempt} 次）`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

setInterval(() => sendOrQueue({ type: "heartbeat", ts: Date.now() }), HEARTBEAT_INTERVAL_MS);
setInterval(() => void maintenance.refresh().then((blocked) => {
  if (blocked && ws) ws.close(1013, "deployment maintenance");
}), 250);
await maintenance.refresh();
void connect();

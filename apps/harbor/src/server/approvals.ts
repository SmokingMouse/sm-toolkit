/**
 * ApprovalService —— permission=default 工具授权的服务端收口（P2）。
 * 流转：daemon approval_req → 落库 pending → 路由（SSE 帧 + 飞书卡片/DM）→
 * 人批（CLI/飞书，先到先得，幂等）→ approval_res 回 daemon resolve → claude 原地续跑。
 * 兜底：30min 过期 sweep 自动 deny；run 终态时挂着的 pending 全部作废；
 * 决议时设备离线 → daemon 重连对账后 redeliver（daemon 侧按 pending map 幂等）。
 */

import type { Approval, Conversation, Run } from "../protocol.js";
import { APPROVAL_TTL_MS } from "../protocol.js";
import type { HarborStore } from "./store.js";
import type { RunBus } from "./bus.js";
import type { DeviceTransport } from "./scheduler.js";

/** 入口面（飞书）挂载点：审批创建/决议时的通知，main 注入 */
export interface ApprovalSink {
  onApprovalCreated(approval: Approval, run: Run, conv: Conversation | null): void;
  onApprovalDecided(approval: Approval): void;
}

export class ApprovalService {
  sink: ApprovalSink | null = null;
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(
    private store: HarborStore,
    private bus: RunBus,
    private transport: DeviceTransport,
  ) {}

  startSweeper(): void {
    this.sweeper = setInterval(() => this.sweep(), 60_000);
  }

  stopSweeper(): void {
    if (this.sweeper) clearInterval(this.sweeper);
  }

  /** daemon approval_req 到达 */
  onApprovalReq(msg: { runId: string; requestId: string; toolName: string; input: unknown }): void {
    const run = this.store.getRun(msg.runId);
    if (!run || (run.status !== "running" && run.status !== "queued")) {
      // run 已终态（取消竞态等）——直接回 deny，别让 daemon 侧挂着
      this.transport.send(run?.deviceId ?? "", {
        type: "approval_res",
        runId: msg.runId,
        requestId: msg.requestId,
        behavior: "deny",
        message: "run 已终态，审批作废",
      });
      return;
    }
    const approval = this.store.createApproval(msg, Date.now());
    console.log(`[approvals] 待批：${approval.id} run=${run.id} tool=${approval.toolName}`);
    this.bus.emitApproval(approval);
    this.sink?.onApprovalCreated(
      approval,
      run,
      run.conversationId ? this.store.getConversation(run.conversationId) : null,
    );
  }

  /**
   * 决议（CLI/飞书共用入口，幂等：仅 pending 可决议）。
   * @returns 决议后的 approval；已决议过则原样返回（调用方据 decidedBy/status 提示）
   */
  decide(approvalId: string, behavior: "allow" | "deny", decidedBy: string): Approval {
    const approval = this.store.getApproval(approvalId);
    if (!approval) throw new Error(`approval "${approvalId}" 不存在`);
    if (approval.status !== "pending") return approval; // 幂等：重复点击/双通道竞态

    const now = Date.now();
    const status = behavior === "allow" ? "allowed" : "denied";
    this.store.markApprovalDecided(approvalId, status, decidedBy, now);
    const decided = this.store.getApproval(approvalId)!;

    this.deliver(decided);
    this.bus.emitApprovalDecided(decided.runId, decided.id, decided.status, decided.decidedBy);
    this.sink?.onApprovalDecided(decided);
    console.log(`[approvals] ${status}：${approvalId}（by ${decidedBy}）`);
    return decided;
  }

  /** run 终态：挂着的 pending 全部作废（daemon 侧 executor 自行清理其 promise） */
  expireForRun(runId: string): void {
    const now = Date.now();
    for (const a of this.store.pendingApprovalsForRun(runId)) {
      this.store.markApprovalDecided(a.id, "expired", "system", now);
      const decided = this.store.getApproval(a.id)!;
      this.bus.emitApprovalDecided(runId, a.id, "expired", "system");
      this.sink?.onApprovalDecided(decided);
    }
  }

  /** 重连对账：run 还在跑但决议消息可能在离线期间丢失 → 重发（daemon 幂等） */
  redeliverForDevice(deviceId: string): void {
    for (const run of this.store.runningRunsForDevice(deviceId)) {
      for (const a of this.store.approvalsForRun(run.id)) {
        if (a.status === "allowed" || a.status === "denied" || a.status === "expired") this.deliver(a);
      }
    }
  }

  private deliver(approval: Approval): void {
    const run = this.store.getRun(approval.runId);
    if (!run) return;
    const sent = this.transport.send(run.deviceId, {
      type: "approval_res",
      runId: approval.runId,
      requestId: approval.requestId,
      behavior: approval.status === "allowed" ? "allow" : "deny",
      ...(approval.status === "expired" ? { message: "审批超时，自动拒绝" } : {}),
    });
    if (!sent) {
      console.warn(`[approvals] 设备离线，决议待重连补发：${approval.id}（run=${approval.runId}）`);
    }
  }

  private sweep(): void {
    const cutoff = Date.now() - APPROVAL_TTL_MS;
    for (const a of this.store.pendingApprovalsOlderThan(cutoff)) {
      this.store.markApprovalDecided(a.id, "expired", "sweep", Date.now());
      const decided = this.store.getApproval(a.id)!;
      this.deliver(decided); // 过期 = deny，回 daemon 让 claude 收到拒绝继续走
      this.bus.emitApprovalDecided(a.runId, a.id, "expired", "sweep");
      this.sink?.onApprovalDecided(decided);
      console.log(`[approvals] 过期自动拒绝：${a.id}（tool=${a.toolName}，pending 超 ${APPROVAL_TTL_MS / 60000}min）`);
    }
  }
}

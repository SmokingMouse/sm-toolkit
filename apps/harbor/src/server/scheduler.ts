/**
 * RunCoordinator —— run 生命周期的两端收口：
 *   入队/下发（per-device 并发闸，默认 2，超出排队；设备离线排队不丢）
 *   完成收尾（落 cost/session → issue 状态自动流转 → 广播 → 补位调度）
 *   重连对账（server 侧 running 但 daemon 不认的 run 判 failed）
 * ws 层只做传输解析，不含业务。
 */

import type { Cost } from "@sm/agent";
import type { Conversation, HarborAgent, Run, RunSpec, ServerMsg } from "../protocol.js";
import type { HarborStore } from "./store.js";
import type { RunBus } from "./bus.js";
import { transitionConversation } from "./statemachine.js";

/** 传输面（由 ws DeviceHub 实现）——注入接口避免 scheduler ↔ ws 循环依赖 */
export interface DeviceTransport {
  isOnline(deviceId: string): boolean;
  send(deviceId: string, msg: ServerMsg): boolean;
}

export class RunCoordinator {
  constructor(
    private store: HarborStore,
    private bus: RunBus,
    private transport: DeviceTransport,
    private concurrency: number,
  ) {}

  /** REST 入口：建 run 入队并尝试即时下发 */
  enqueueRun(conv: Conversation, agent: HarborAgent, prompt: string): Run {
    const run = this.store.createRun(
      { conversationId: conv.id, agentId: agent.id, deviceId: agent.deviceId, prompt },
      Date.now(),
    );
    this.pump(agent.deviceId);
    return this.store.getRun(run.id)!;
  }

  /** 并发闸内逐个下发该设备最老的 queued run */
  pump(deviceId: string): void {
    while (this.transport.isOnline(deviceId)) {
      if (this.store.countRunning(deviceId) >= this.concurrency) return;
      const run = this.store.oldestQueuedForDevice(deviceId);
      if (!run) return;
      const now = Date.now();

      const agent = this.store.getAgent(run.agentId);
      const conv = this.store.getConversation(run.conversationId);
      if (!agent || !conv) {
        this.store.finishRun(
          run.id,
          "failed",
          { claudeSessionId: null, cost: null, error: "agent 或 conversation 已不存在，无法下发" },
          now,
        );
        this.bus.emitDone(this.store.getRun(run.id)!);
        continue;
      }

      const spec: RunSpec = {
        backend: agent.backend,
        model: agent.model,
        prompt: run.prompt,
        workdir: agent.workdir,
        permission: agent.permission,
        systemPrompt: agent.instruction,
        resume: conv.claudeSessionId,
      };
      const sent = this.transport.send(deviceId, { type: "run_start", runId: run.id, spec });
      if (!sent) return; // 连接实际不可用，留在队列等下次上线
      this.store.markRunRunning(run.id, now);
      if (conv.kind === "issue" && conv.status !== "doing") {
        transitionConversation(this.store, conv, "doing", "system", now);
      }
    }
  }

  /** daemon 批量事件：幂等落库 + 实时广播 */
  onRunEvents(events: { runId: string; seq: number; event: import("@sm/agent").AgentEvent }[]): void {
    if (events.length === 0) return;
    this.store.insertRunEvents(events, Date.now());
    for (const e of events) this.bus.emitEvent(e.runId, e.seq, e.event);
  }

  /** daemon 报 run 终态 */
  onRunDone(msg: {
    runId: string;
    status: "succeeded" | "failed" | "canceled";
    claudeSessionId: string | null;
    cost: Cost | null;
    error?: string;
  }): void {
    const now = Date.now();
    const run = this.store.getRun(msg.runId);
    if (!run) return; // 未知 run（库被清过等），忽略
    if (run.status !== "running" && run.status !== "queued") return; // 已终态，重发去重

    this.store.finishRun(
      msg.runId,
      msg.status,
      { claudeSessionId: msg.claudeSessionId, cost: msg.cost, error: msg.error ?? null },
      now,
    );

    const conv = this.store.getConversation(run.conversationId);
    if (conv) {
      if (msg.claudeSessionId) {
        this.store.setConversationClaudeSessionId(conv.id, msg.claudeSessionId, now);
      }
      if (conv.kind === "issue") {
        // succeeded → review（待人验收）；failed/canceled → 回 backlog（等人重试/继续）
        const fresh = this.store.getConversation(conv.id)!;
        transitionConversation(this.store, fresh, msg.status === "succeeded" ? "review" : "backlog", "system", now);
      }
    }

    this.bus.emitDone(this.store.getRun(msg.runId)!);
    this.pump(run.deviceId);
  }

  /**
   * 重连对账：server 侧该设备 status=running 但 daemon 的 runningRunIds 不含的 run
   * → daemon 重启/崩溃丢了进程，判 failed。conversation 留有上一轮 claude_session_id，
   * 之后 continue = 新 run 带 resume，上下文不丢。
   */
  reconcileDevice(deviceId: string, runningRunIds: string[]): void {
    const alive = new Set(runningRunIds);
    const now = Date.now();
    for (const run of this.store.runningRunsForDevice(deviceId)) {
      if (alive.has(run.id)) continue;
      this.store.finishRun(
        run.id,
        "failed",
        {
          claudeSessionId: run.claudeSessionId,
          cost: null,
          error: "daemon 重连时未上报此 run（daemon 重启/崩溃导致执行进程丢失）；issue continue 可基于上一轮 session 恢复",
        },
        now,
      );
      const conv = this.store.getConversation(run.conversationId);
      if (conv && conv.kind === "issue") {
        transitionConversation(this.store, conv, "backlog", "system", now);
      }
      this.bus.emitDone(this.store.getRun(run.id)!);
    }
    this.pump(deviceId);
  }
}

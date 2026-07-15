/**
 * Run 事件内存广播 —— SSE 订阅者（watch）接实时流。
 * 持久化在 store（run_events），bus 只做「已入库事件的实时扇出」，无回放职责。
 */

import type { Approval, ApprovalStatus, Run, RunStreamFrame } from "../protocol.js";
import type { AgentEvent } from "@sm/agent";

type Subscriber = (frame: RunStreamFrame) => void;

export class RunBus {
  private subs = new Map<string, Set<Subscriber>>();

  subscribe(runId: string, fn: Subscriber): () => void {
    let set = this.subs.get(runId);
    if (!set) {
      set = new Set();
      this.subs.set(runId, set);
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.subs.delete(runId);
    };
  }

  private emit(runId: string, frame: RunStreamFrame): void {
    const set = this.subs.get(runId);
    if (!set) return;
    for (const fn of set) fn(frame);
  }

  emitEvent(runId: string, seq: number, event: AgentEvent): void {
    this.emit(runId, { kind: "event", seq, event });
  }

  emitApproval(approval: Approval): void {
    this.emit(approval.runId, { kind: "approval", approval });
  }

  emitApprovalDecided(runId: string, approvalId: string, status: ApprovalStatus, decidedBy: string | null): void {
    this.emit(runId, { kind: "approval_decided", approvalId, status, decidedBy });
  }

  emitDone(run: Run): void {
    this.emit(run.id, { kind: "done", run });
  }
}

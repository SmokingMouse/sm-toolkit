/**
 * Run 事件内存广播 —— SSE 订阅者（watch）接实时流。
 * 持久化在 store（run_events），bus 只做「已入库事件的实时扇出」，无回放职责。
 */

import type { Run, RunStreamFrame } from "../protocol.js";
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

  emitEvent(runId: string, seq: number, event: AgentEvent): void {
    const set = this.subs.get(runId);
    if (!set) return;
    for (const fn of set) fn({ kind: "event", seq, event });
  }

  emitDone(run: Run): void {
    const set = this.subs.get(run.id);
    if (!set) return;
    for (const fn of set) fn({ kind: "done", run });
  }
}

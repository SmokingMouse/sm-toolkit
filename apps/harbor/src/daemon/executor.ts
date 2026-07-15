/**
 * run 执行器：run_start → @sm/agent Backend 流式执行 → run_event 批量回传（200ms/20 条）
 * → run_done（含 cost/claude_session_id）。send 由 main 注入（断线时进 outbox 补发）。
 */

import { ClaudeBackend, CodexBackend, EventType, type Backend, type Cost } from "@sm/agent";
import type { DaemonMsg, RunSpec } from "../protocol.js";

const FLUSH_MS = 200;
const FLUSH_COUNT = 20;

export class Executor {
  private running = new Map<string, AbortController>();
  /** run_done 已生成但可能还压在 outbox 未送达的 run，对账时也要认账 */
  constructor(private send: (msg: DaemonMsg) => void) {}

  runningIds(): string[] {
    return [...this.running.keys()];
  }

  start(runId: string, spec: RunSpec): void {
    if (this.running.has(runId)) return; // 重复下发防御
    const abort = new AbortController();
    this.running.set(runId, abort);
    void this.execute(runId, spec, abort.signal).finally(() => this.running.delete(runId));
  }

  cancel(runId: string): void {
    this.running.get(runId)?.abort();
  }

  private async execute(runId: string, spec: RunSpec, signal: AbortSignal): Promise<void> {
    const backend: Backend = spec.backend === "codex" ? new CodexBackend() : new ClaudeBackend();

    let batch: { runId: string; seq: number; event: import("@sm/agent").AgentEvent }[] = [];
    const flush = () => {
      if (batch.length === 0) return;
      this.send({ type: "run_event", events: batch });
      batch = [];
    };
    const timer = setInterval(flush, FLUSH_MS);

    let seq = 0;
    let sessionId: string | null = spec.resume;
    let cost: Cost | null = null;
    let errMsg: string | null = null;
    try {
      for await (const ev of backend.run(spec.prompt, {
        workspace: spec.workdir,
        cwd: spec.workdir,
        permission: spec.permission,
        systemPrompt: spec.systemPrompt,
        resume: spec.resume,
        model: spec.model ?? undefined,
        env: spec.envOverrides,
        signal,
      })) {
        seq++;
        batch.push({ runId, seq, event: ev });
        if (batch.length >= FLUSH_COUNT) flush();
        if (ev.sessionId) sessionId = ev.sessionId;
        if (ev.type === EventType.Result) cost = (ev.data.cost as Cost) ?? null;
        if (ev.type === EventType.Error) errMsg = String(ev.data.message ?? "unknown backend error");
      }
    } catch (e) {
      // spawn 失败（claude 不在 PATH）、流中断等
      errMsg = e instanceof Error ? e.message : String(e);
    } finally {
      clearInterval(timer);
      flush();
    }

    this.send({
      type: "run_done",
      runId,
      status: signal.aborted ? "canceled" : errMsg ? "failed" : "succeeded",
      claudeSessionId: sessionId,
      cost,
      ...(errMsg ? { error: errMsg } : {}),
    });
  }
}

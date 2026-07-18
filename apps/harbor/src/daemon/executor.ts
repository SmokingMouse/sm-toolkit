/**
 * run 执行器：run_start → @sm/agent Backend 流式执行 → run_event 批量回传（200ms/20 条）
 * → run_done（含 cost/claude_session_id）。send 由 main 注入（断线时进 outbox 补发）。
 *
 * P2 新增：
 *   - permission=default → 挂 onCanUseTool，工具授权走 approval_req/approval_res 链路
 *     （server 30min 过期兜底 deny，claude 进程不会无限挂）。
 *   - isolation=worktree → 首跑创建 per-Issue worktree（worktree_ready 回报路径），
 *     workspace/cwd 都指向 worktree，主仓库不入 --add-dir。
 *   - 长输出截断：单事件 output/stderr/input 超限截到 8KB（run_events 存储与 SSE 都受益，
 *     result/cost 不受影响）。
 */

import { ClaudeBackend, CodexBackend, EventType, type AgentEvent, type Backend, type Cost } from "@sm/agent";
import type { DaemonMsg, RunSpec } from "../protocol.js";
import { ensureWorktree } from "./worktree.js";

const FLUSH_MS = 200;
const FLUSH_COUNT = 20;
const EVENT_FIELD_MAX = 8 * 1024;

type ApprovalResolver = (r: { behavior: "allow" | "deny"; updatedInput?: unknown; message?: string }) => void;

export class Executor {
  private running = new Map<string, AbortController>();
  /** `${runId}:${requestId}` → resolver（approval_res 到达时兑现） */
  private pendingApprovals = new Map<string, ApprovalResolver>();

  constructor(private send: (msg: DaemonMsg) => void) {}

  runningIds(): string[] {
    return [...this.running.keys()];
  }

  start(runId: string, spec: RunSpec): void {
    if (this.running.has(runId)) return; // 重复下发防御
    const abort = new AbortController();
    this.running.set(runId, abort);
    void this.execute(runId, spec, abort.signal).finally(() => {
      this.running.delete(runId);
      this.cleanupApprovals(runId);
    });
  }

  cancel(runId: string): void {
    this.running.get(runId)?.abort();
  }

  /** server approval_res 到达：兑现挂起的 onCanUseTool 回调（幂等：未知/已兑现直接忽略） */
  resolveApproval(
    runId: string,
    requestId: string,
    behavior: "allow" | "deny",
    updatedInput?: unknown,
    message?: string,
  ): void {
    const key = `${runId}:${requestId}`;
    const resolver = this.pendingApprovals.get(key);
    if (!resolver) return;
    this.pendingApprovals.delete(key);
    resolver({ behavior, ...(updatedInput !== undefined ? { updatedInput } : {}), ...(message ? { message } : {}) });
  }

  /** run 结束后还挂着的审批回调：deny 兑现释放 promise（claude 进程已死，纯内存清理） */
  private cleanupApprovals(runId: string): void {
    for (const [key, resolver] of this.pendingApprovals) {
      if (key.startsWith(`${runId}:`)) {
        this.pendingApprovals.delete(key);
        resolver({ behavior: "deny", message: "run 已结束" });
      }
    }
  }

  private async execute(runId: string, spec: RunSpec, signal: AbortSignal): Promise<void> {
    const backend: Backend = spec.backend === "codex" ? new CodexBackend() : new ClaudeBackend();

    let batch: { runId: string; seq: number; event: AgentEvent }[] = [];
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
      // worktree 隔离：首跑创建 + 回报路径；失败直接 run failed（拒绝静默降级回主仓库）
      let effectiveDir = spec.repositoryRoot;
      if (spec.isolation === "worktree") {
        if (!spec.repositoryRoot) throw new Error("worktree isolation 需要 Repository mount");
        if (!spec.conversationId) throw new Error("worktree isolation 需要 Issue/Chat Conversation source");
        effectiveDir = ensureWorktree(spec.repositoryRoot, spec.conversationId, spec.worktreePath);
        if (effectiveDir !== spec.worktreePath) {
          this.send({ type: "worktree_ready", runId, conversationId: spec.conversationId, path: effectiveDir });
        }
      }

      const interactive = spec.permission === "default";
      for await (const ev of backend.run(spec.prompt, {
        ...(effectiveDir ? { workspace: effectiveDir, cwd: effectiveDir } : {}),
        permission: spec.permission,
        systemPrompt: spec.systemPrompt,
        resume: spec.resume,
        model: spec.model ?? undefined,
        env: spec.envOverrides,
        signal,
        ...(interactive
          ? {
              onCanUseTool: (req: { toolName: string; toolUseId: string; requestId: string; input: unknown }) =>
                new Promise<{ behavior: "allow" | "deny"; updatedInput?: unknown; message?: string }>((resolve) => {
                  this.pendingApprovals.set(`${runId}:${req.requestId}`, resolve);
                  this.send({
                    type: "approval_req",
                    runId,
                    requestId: req.requestId,
                    toolName: req.toolName,
                    input: req.input,
                  });
                }),
            }
          : {}),
      })) {
        const event = truncateEvent(ev);
        const last = batch[batch.length - 1];
        const merged = coalesceStreamingEvent(last?.event, event);
        if (last && merged) {
          // Claude/Kimi 可能逐 token 发 thinking/text。按 200ms 发送窗合并，避免一次普通 Run
          // 产生数千 SQLite 行和 SSE 帧，同时保留工具调用之间的真实边界。
          last.event = truncateEvent(merged);
        } else {
          seq++;
          batch.push({ runId, seq, event });
        }
        if (batch.length >= FLUSH_COUNT) flush();
        if (ev.sessionId) sessionId = ev.sessionId;
        if (ev.type === EventType.Result) cost = (ev.data.cost as Cost) ?? null;
        if (ev.type === EventType.Error) errMsg = String(ev.data.message ?? "unknown backend error");
      }
    } catch (e) {
      // spawn 失败（claude 不在 PATH）、worktree 创建失败、流中断等
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

/** 仅合并同一会话中连续的流式文本；工具、结果和不同 event type 必须保留顺序边界。 */
export function coalesceStreamingEvent(previous: AgentEvent | undefined, next: AgentEvent): AgentEvent | null {
  if (
    !previous ||
    (next.type !== EventType.Thinking && next.type !== EventType.TextChunk) ||
    previous.type !== next.type ||
    previous.backend !== next.backend ||
    previous.sessionId !== next.sessionId
  ) {
    return null;
  }
  return {
    ...next,
    data: {
      ...previous.data,
      ...next.data,
      text: `${String(previous.data.text ?? "")}${String(next.data.text ?? "")}`,
    },
  };
}

/** 单事件字段截断（>8KB 的 output/stderr/input），防单条工具输出撑爆存储与流 */
function truncateEvent(ev: AgentEvent): AgentEvent {
  const d = ev.data;
  const needs = (v: unknown) => typeof v === "string" && v.length > EVENT_FIELD_MAX;
  const inputStr = d.input !== undefined ? JSON.stringify(d.input) : undefined;
  if (!needs(d.output) && !needs(d.stderr) && !needs(d.text) && !(inputStr && inputStr.length > EVENT_FIELD_MAX)) {
    return ev;
  }
  const cut = (s: string) => `${s.slice(0, EVENT_FIELD_MAX)}\n…[harbor 截断，原 ${s.length} 字符]`;
  const data: Record<string, unknown> = { ...d };
  if (needs(d.output)) data.output = cut(d.output as string);
  if (needs(d.stderr)) data.stderr = cut(d.stderr as string);
  if (needs(d.text)) data.text = cut(d.text as string);
  if (inputStr && inputStr.length > EVENT_FIELD_MAX) data.input = { __harbor_truncated: cut(inputStr) };
  return { ...ev, data };
}

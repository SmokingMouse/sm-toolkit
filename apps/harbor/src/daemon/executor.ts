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
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { assertAgentEnvironmentSafe } from "../agent-environment.js";
import type { DaemonMsg, RunAttachment, RunSpec } from "../protocol.js";
import { detectEnvironmentSkillNames } from "./capabilities.js";
import {
  ensureReviewCheckout,
  ensureWorktree,
  removeReviewCheckout,
  resolveWorktreeGitCommonDir,
} from "./worktree.js";

const FLUSH_MS = 200;
const FLUSH_COUNT = 20;
const EVENT_FIELD_MAX = 8 * 1024;

type ApprovalResolver = (r: { behavior: "allow" | "deny"; updatedInput?: unknown; message?: string }) => void;

export class Executor {
  private running = new Map<string, AbortController>();
  /** `${runId}:${requestId}` → resolver（approval_res 到达时兑现） */
  private pendingApprovals = new Map<string, ApprovalResolver>();

  constructor(
    private send: (msg: DaemonMsg) => void,
    private agentActionUrl = process.env.HARBOR_AGENT_ACTION_URL ?? "",
  ) {}

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
    let attachmentDir: string | null = null;
    let reviewCheckoutPath: string | null = null;
    try {
      const agentEnvironment = spec.envOverrides ?? {};
      // 老 DB / 旧 server 也不能绕过新 API 校验：daemon 在真正 spawn 前再次 fail-closed。
      assertAgentEnvironmentSafe(agentEnvironment);
      const { executionRoot: effectiveDir, shouldReportWorktreeReady } = prepareRunExecution(spec, runId);
      reviewCheckoutPath = spec.reviewCheckout ? effectiveDir : null;
      if (shouldReportWorktreeReady && effectiveDir && spec.conversationId) {
        this.send({ type: "worktree_ready", runId, conversationId: spec.conversationId, path: effectiveDir });
      }
      if (reviewCheckoutPath) {
        this.send({ type: "run_execution_ready", runId, path: reviewCheckoutPath });
      }
      const additionalWritableDirs = resolveRunAdditionalWritableDirs(spec, effectiveDir);

      if (spec.setupScript?.trim()) {
        if (!effectiveDir) throw new Error("Agent setup 需要 Repository mount");
        await runAgentSetup(effectiveDir, spec.setupScript, spec.setupKey, agentEnvironment, signal);
      }

      const materialized = materializeRunAttachments(runId, spec.attachments ?? []);
      attachmentDir = materialized.directory;
      const prompt = materialized.paths.length
        ? `${spec.prompt}\n\n## Input attachments\nThe following files were attached to this request and are available locally:\n${materialized.paths.map((item) => `- ${item.name}: ${item.path} (${item.mime})`).join("\n")}`
        : spec.prompt;
      const actionEnvironment: Record<string, string> = {};
      if (spec.agentActionToken && this.agentActionUrl) {
        actionEnvironment.HARBOR_AGENT_ACTION_URL = this.agentActionUrl;
        const actionBaseUrl = this.agentActionUrl.replace(/\/issues$/, "");
        actionEnvironment.HARBOR_AGENT_ISSUE_URL = `${actionBaseUrl}/issues`;
        actionEnvironment.HARBOR_AGENT_DELIVERY_URL = `${actionBaseUrl}/deliveries`;
        actionEnvironment.HARBOR_AGENT_REVIEW_URL = `${actionBaseUrl}/reviews`;
        actionEnvironment.HARBOR_AGENT_CONTEXT_URL = `${actionBaseUrl}/context`;
        actionEnvironment.HARBOR_AGENT_DISPATCH_URL = `${actionBaseUrl}/dispatch`;
        actionEnvironment.HARBOR_AGENT_SELF_DEPLOY_URL = `${actionBaseUrl}/self-deployments`;
        actionEnvironment.HARBOR_AGENT_ACTION_TOKEN = spec.agentActionToken;
      }
      const interactive = spec.permission === "default";
      const environmentSkillNames =
        spec.backend === "codex" ? detectEnvironmentSkillNames(effectiveDir) : [];
      for await (const ev of backend.run(prompt, {
        ...(effectiveDir ? { workspace: effectiveDir, cwd: effectiveDir } : {}),
        ...(additionalWritableDirs.length > 0 ? { additionalWritableDirs } : {}),
        additionalWorkspaces: spec.additionalRepositoryRoots,
        permission: spec.permission,
        systemPrompt: spec.systemPrompt,
        // Agent 的能力边界只来自 Harbor 配置：scheduler 注入 instruction + 已绑定
        // Skill；Device 用户目录、checkout 或 Runtime bundled Skill 一律不继承。
        environmentSkills: false,
        ...(environmentSkillNames.length > 0 ? { environmentSkillNames } : {}),
        resume: spec.resume,
        model: spec.model ?? undefined,
        env: { ...agentEnvironment, ...actionEnvironment },
        attachments: materialized.paths
          .filter((attachment) => attachment.mime.startsWith("image/"))
          .map((attachment) => ({ path: attachment.path, mime: attachment.mime })),
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
      if (attachmentDir) rmSync(attachmentDir, { recursive: true, force: true });
      if (reviewCheckoutPath && spec.repositoryRoot) {
        const cleanup = removeReviewCheckout(spec.repositoryRoot, reviewCheckoutPath);
        if (!cleanup.ok) errMsg = [errMsg, cleanup.message].filter(Boolean).join("; ");
      }
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

/**
 * 解析 daemon 实际 cwd。Repository mount 只作为仓库身份锚点；executionRoot/worktreePath
 * 是独立的执行位置。worktree 模式始终从 mount 校验/创建，已有路径只做幂等复用。
 */
export function prepareRunExecution(spec: RunSpec, runId?: string): {
  executionRoot: string | null;
  shouldReportWorktreeReady: boolean;
} {
  if (spec.reviewCheckout) {
    if (!spec.repositoryRoot) throw new Error("exact-revision Review 需要 Repository mount");
    if (spec.purpose !== "review" && spec.purpose !== "verification") {
      throw new Error("reviewCheckout 只允许 review/verification purpose");
    }
    if (!runId) throw new Error("exact-revision Review 缺少 Run ID");
    return {
      executionRoot: ensureReviewCheckout(spec.repositoryRoot, runId, spec.reviewCheckout),
      shouldReportWorktreeReady: false,
    };
  }
  if (spec.isolation !== "worktree") {
    return { executionRoot: spec.executionRoot ?? spec.repositoryRoot, shouldReportWorktreeReady: false };
  }
  if (!spec.repositoryRoot) throw new Error("worktree isolation 需要 Repository mount");
  if (!spec.conversationId) throw new Error("worktree isolation 需要 Issue/Chat Conversation source");
  const executionRoot = ensureWorktree(spec.repositoryRoot, spec.conversationId, spec.worktreePath);
  return { executionRoot, shouldReportWorktreeReady: spec.worktreePath === null };
}

/**
 * Codex 自举授权闸：只有 linked worktree 中的可写 implementation Run 能写 Git metadata。
 * review/verification/triage/readonly/非 worktree 均不得获得 common gitdir。
 */
export function resolveRunAdditionalWritableDirs(spec: RunSpec, effectiveDir: string | null): string[] {
  if (
    spec.backend !== "codex" ||
    spec.purpose !== "implementation" ||
    spec.isolation !== "worktree" ||
    (spec.permission !== "auto-edit" && spec.permission !== "full")
  ) {
    return [];
  }
  if (!spec.repositoryRoot || !effectiveDir || !spec.conversationId) {
    throw new Error("Codex worktree implementation 缺少 Repository/worktree 路径，拒绝扩大可写范围");
  }
  return [resolveWorktreeGitCommonDir(spec.repositoryRoot, effectiveDir, spec.conversationId)];
}

export function materializeRunAttachments(
  runId: string,
  attachments: RunAttachment[],
): {
  directory: string | null;
  paths: Array<{ name: string; mime: string; path: string }>;
} {
  if (attachments.length === 0) return { directory: null, paths: [] };
  const directory = mkdtempSync(join(tmpdir(), `harbor-${runId.replace(/[^A-Za-z0-9_-]/g, "_")}-`));
  const used = new Set<string>();
  const paths = attachments.map((attachment, index) => {
    const rawName = basename(attachment.name).replace(/[^\p{L}\p{N}._ -]/gu, "_") || `attachment-${index + 1}`;
    let name = rawName;
    let suffix = 2;
    while (used.has(name)) name = `${index + 1}-${suffix++}-${rawName}`;
    used.add(name);
    const path = join(directory, name);
    writeFileSync(path, Buffer.from(attachment.dataBase64, "base64"), { mode: 0o600 });
    return { name, mime: attachment.mime, path };
  });
  return { directory, paths };
}

/**
 * Setup command 是用户在 Agent 配置中显式授权的本机脚本。成功标记放在 ~/.harbor，
 * 不污染仓库；key + checkout 路径任一变化都会重新执行。失败则拒绝启动 Agent runtime。
 */
export async function runAgentSetup(
  cwd: string,
  script: string,
  setupKey: string | null | undefined,
  environment: Record<string, string>,
  signal: AbortSignal,
  timeoutMs = 5 * 60_000,
): Promise<void> {
  const marker = setupKey
    ? join(homedir(), ".harbor", "setup-cache", `${createHash("sha256").update(`${cwd}\0${setupKey}`).digest("hex")}.done`)
    : null;
  if (marker && existsSync(marker)) return;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/bin/sh", ["-lc", script], {
      cwd,
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const append = (current: string, chunk: unknown) => `${current}${String(chunk)}`.slice(-16 * 1024);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const stop = () => child.kill("SIGTERM");
    signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      reject(new Error(`Agent setup 启动失败：${error.message}`));
    });
    child.on("close", (code, terminatedBy) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      if (signal.aborted) return reject(new Error("Agent setup 已取消"));
      if (terminatedBy || code !== 0) {
        return reject(new Error(
          `Agent setup 失败（exit=${code ?? terminatedBy ?? "unknown"}）：${(stderr || stdout || "无输出").trim()}`,
        ));
      }
      if (marker) {
        mkdirSync(join(homedir(), ".harbor", "setup-cache"), { recursive: true });
        writeFileSync(marker, `${Date.now()}\n`, { mode: 0o600 });
      }
      resolve();
    });
  });
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

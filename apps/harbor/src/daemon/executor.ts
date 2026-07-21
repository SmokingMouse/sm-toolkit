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
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { pushGitHead, type GitPushCredential } from "./git-push.js";

const FLUSH_MS = 200;
const FLUSH_COUNT = 20;
const EVENT_FIELD_MAX = 8 * 1024;
const ACTION_REQUEST_MAX = 4 * 1024;

export interface SelfDeployActionRequest {
  revision: string;
  idempotencyKey: string;
}

export interface DeliveryActionRequest {
  provider: "github";
  headBranch: string;
  baseBranch: string;
  title: string;
  body: string;
}

type ApprovalResolver = (r: { behavior: "allow" | "deny"; updatedInput?: unknown; message?: string }) => void;

export class Executor {
  private running = new Map<string, AbortController>();
  /** `${runId}:${requestId}` → resolver（approval_res 到达时兑现） */
  private pendingApprovals = new Map<string, ApprovalResolver>();

  constructor(
    private send: (msg: DaemonMsg) => void,
    private agentActionUrl = process.env.HARBOR_AGENT_ACTION_URL ?? "",
    private daemonToken = "",
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
    let actionOutboxDir: string | null = null;
    let reviewCheckoutPath: string | null = null;
    let effectiveDir: string | null = null;
    try {
      const agentEnvironment = spec.envOverrides ?? {};
      // 老 DB / 旧 server 也不能绕过新 API 校验：daemon 在真正 spawn 前再次 fail-closed。
      assertAgentEnvironmentSafe(agentEnvironment);
      const preparedExecution = prepareRunExecution(spec, runId);
      effectiveDir = preparedExecution.executionRoot;
      const { shouldReportWorktreeReady } = preparedExecution;
      reviewCheckoutPath = spec.reviewCheckout ? effectiveDir : null;
      if (shouldReportWorktreeReady && effectiveDir && spec.conversationId) {
        this.send({ type: "worktree_ready", runId, conversationId: spec.conversationId, path: effectiveDir });
      }
      if (reviewCheckoutPath) {
        this.send({ type: "run_execution_ready", runId, path: reviewCheckoutPath });
      }
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
        actionOutboxDir = mkdtempSync(join(tmpdir(), `harbor-actions-${runId.replace(/[^A-Za-z0-9_-]/g, "_")}-`));
        const emptyGhConfig = join(actionOutboxDir, "gh-config");
        mkdirSync(emptyGhConfig, { mode: 0o700 });
        // Agent 不能继承 host 登录态绕过 principal broker；本地 commit 的非凭证 git config 仍保留。
        actionEnvironment.GH_CONFIG_DIR = emptyGhConfig;
        actionEnvironment.GH_TOKEN = "";
        actionEnvironment.GITHUB_TOKEN = "";
        actionEnvironment.GIT_TERMINAL_PROMPT = "0";
        actionEnvironment.GIT_CONFIG_COUNT = "1";
        actionEnvironment.GIT_CONFIG_KEY_0 = "credential.helper";
        actionEnvironment.GIT_CONFIG_VALUE_0 = "";
        actionEnvironment.SSH_AUTH_SOCK = "";
        actionEnvironment.HARBOR_AGENT_SELF_DEPLOY_REQUEST_PATH = join(actionOutboxDir, "self-deploy.json");
        actionEnvironment.HARBOR_AGENT_GIT_PUSH_REQUEST_PATH = join(actionOutboxDir, "git-push.json");
        actionEnvironment.HARBOR_AGENT_DELIVERY_REQUEST_PATH = join(actionOutboxDir, "delivery.json");
        Object.assign(actionEnvironment, agentActionTriggerEnvironment(spec.agentActionTrigger));
      }
      const additionalWritableDirs = [
        ...resolveRunAdditionalWritableDirs(spec, effectiveDir),
        ...(actionOutboxDir && spec.backend === "codex" && spec.purpose === "implementation"
          ? [actionOutboxDir]
          : []),
      ];
      const interactive = spec.permission === "default";
      const actionSandbox = resolveSelfDeployActionSandbox(spec, actionOutboxDir);
      const environmentSkillNames =
        spec.backend === "codex" ? detectEnvironmentSkillNames(effectiveDir) : [];
      for await (const ev of backend.run(prompt, {
        ...(actionSandbox
          ? { workspace: actionSandbox.directory, cwd: actionSandbox.directory }
          : effectiveDir
            ? { workspace: effectiveDir, cwd: effectiveDir }
            : {}),
        ...(!actionSandbox && additionalWritableDirs.length > 0 ? { additionalWritableDirs } : {}),
        additionalWorkspaces: actionSandbox ? [] : spec.additionalRepositoryRoots,
        // Self-deploy intent 仍走 daemon-mediated outbox；不能因为 Release Agent
        // 平时获准联网，就让这次 coordination 绕过 action control plane。
        sandboxNetworkAccess: resolveRunSandboxNetworkAccess(spec, actionSandbox),
        // Codex read-only sandbox 不允许写任何 tmp path。Self-deploy coordination
        // 只把 cwd 切到一次性空 outbox 并启 workspace-write；Repository 不再是
        // cwd/add-dir/writable root，仍不可修改，Run 的领域 permission 也不变。
        permission: actionSandbox ? "auto-edit" : spec.permission,
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
      if (!errMsg && actionOutboxDir && spec.agentActionToken && effectiveDir) {
        const gitPushRequested = readGitPushActionRequest(join(actionOutboxDir, "git-push.json"));
        const delivery = readDeliveryActionRequest(join(actionOutboxDir, "delivery.json"));
        if (delivery && !gitPushRequested) {
          throw new Error("GitHub Delivery action 必须同时请求受控 git push");
        }
        if (gitPushRequested) {
          if (!this.daemonToken) throw new Error("daemon credential 未配置，不能安全获取 git push credential");
          const credentialUrl = this.agentActionUrl.replace(
            /\/hooks\/agent-actions\/issues$/,
            "/hooks/daemon-actions/git/push-credential",
          );
          let credential = await requestGitPushCredential(
            credentialUrl,
            this.daemonToken,
            spec.agentActionToken,
            false,
          );
          let pushed = await pushGitHead(effectiveDir, credential);
          if (!pushed.ok && pushed.authenticationFailed) {
            credential = await requestGitPushCredential(
              credentialUrl,
              this.daemonToken,
              spec.agentActionToken,
              true,
            );
            pushed = await pushGitHead(effectiveDir, credential);
          }
          if (!pushed.ok) throw new Error(pushed.message);
        }
        if (delivery) {
          const actionBaseUrl = this.agentActionUrl.replace(/\/issues$/, "");
          await submitDeliveryAction(`${actionBaseUrl}/deliveries`, spec.agentActionToken, delivery);
        }
      }
      if (!errMsg && actionOutboxDir && spec.agentActionToken) {
        const request = readSelfDeployActionRequest(join(actionOutboxDir, "self-deploy.json"));
        if (request) {
          const actionBaseUrl = this.agentActionUrl.replace(/\/issues$/, "");
          await submitSelfDeployAction(
            `${actionBaseUrl}/self-deployments`,
            spec.agentActionToken,
            request,
          );
        }
      }
    } catch (e) {
      // spawn 失败（claude 不在 PATH）、worktree 创建失败、流中断等
      errMsg = e instanceof Error ? e.message : String(e);
    } finally {
      clearInterval(timer);
      flush();
      if (attachmentDir) rmSync(attachmentDir, { recursive: true, force: true });
      if (actionOutboxDir) rmSync(actionOutboxDir, { recursive: true, force: true });
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

export function resolveSelfDeployActionSandbox(
  spec: RunSpec,
  actionOutboxDir: string | null,
): { directory: string } | null {
  if (
    !actionOutboxDir ||
    spec.backend !== "codex" ||
    spec.purpose !== "coordination" ||
    !spec.agentActionToken ||
    spec.agentActionTrigger?.eventType !== "merge_request_merged"
  ) {
    return null;
  }
  return { directory: actionOutboxDir };
}

export function resolveRunSandboxNetworkAccess(
  spec: RunSpec,
  actionSandbox: { directory: string } | null,
): boolean {
  return actionSandbox === null && spec.sandboxNetworkAccess === true;
}

/**
 * Codex 的 read-only/workspace-write sandbox 默认不能访问 loopback。Release Agent
 * 因此把非敏感 intent 写进 Run 专属临时 outbox，由 daemon 在 sandbox 外携带短期
 * token 提交；server 仍重新验证 source Run、Repository、event 与 exact revision。
 */
export function readSelfDeployActionRequest(path: string): SelfDeployActionRequest | null {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("self-deploy action outbox 必须是普通文件");
  if (stat.size > ACTION_REQUEST_MAX) throw new Error("self-deploy action outbox 超过 4KB");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("self-deploy action outbox 不是合法 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("self-deploy action outbox 必须是 JSON object");
  }
  const body = parsed as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  if (keys.join(",") !== "idempotencyKey,revision") {
    throw new Error("self-deploy action outbox 只允许 revision 与 idempotencyKey");
  }
  const revision = typeof body.revision === "string" ? body.revision.trim().toLowerCase() : "";
  const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  if (!/^[a-f0-9]{40,64}$/.test(revision)) throw new Error("self-deploy action revision 无效");
  if (!idempotencyKey || idempotencyKey.length > 128) {
    throw new Error("self-deploy action idempotencyKey 需要 1–128 字符");
  }
  return { revision, idempotencyKey };
}

export function readGitPushActionRequest(path: string): boolean {
  const body = readActionRequestObject(path, "git push");
  if (body === null) return false;
  if (Object.keys(body).join(",") !== "push" || body.push !== true) {
    throw new Error("git push action outbox 只允许 {\"push\":true}");
  }
  return true;
}

export function readDeliveryActionRequest(path: string): DeliveryActionRequest | null {
  const body = readActionRequestObject(path, "delivery");
  if (body === null) return null;
  const allowed = ["baseBranch", "body", "headBranch", "provider", "title"];
  if (Object.keys(body).sort().join(",") !== allowed.join(",")) {
    throw new Error(`delivery action outbox 只允许 ${allowed.join(", ")}`);
  }
  const provider = body.provider;
  const headBranch = typeof body.headBranch === "string" ? body.headBranch.trim() : "";
  const baseBranch = typeof body.baseBranch === "string" ? body.baseBranch.trim() : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const deliveryBody = typeof body.body === "string" ? body.body : "";
  if (provider !== "github") throw new Error("delivery action outbox 当前只支持 github provider");
  if (!/^harbor\/[A-Za-z0-9._-]+$/.test(headBranch)) throw new Error("delivery action headBranch 无效");
  if (!/^[A-Za-z0-9._/-]+$/.test(baseBranch) || baseBranch.includes("..")) throw new Error("delivery action baseBranch 无效");
  if (!title || title.length > 256) throw new Error("delivery action title 需要 1–256 字符");
  if (deliveryBody.length > 64 * 1024) throw new Error("delivery action body 不能超过 64KB");
  return { provider, headBranch, baseBranch, title, body: deliveryBody };
}

function readActionRequestObject(path: string, label: string): Record<string, unknown> | null {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} action outbox 必须是普通文件`);
  if (stat.size > 128 * 1024) throw new Error(`${label} action outbox 过大`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${label} action outbox 不是合法 JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} action outbox 必须是 JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export async function requestGitPushCredential(
  url: string,
  daemonToken: string,
  runActionToken: string,
  forceRefresh: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<GitPushCredential> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${daemonToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runActionToken, forceRefresh }),
    signal: AbortSignal.timeout(10_000),
  });
  const parsed = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`Harbor git push credential request rejected (HTTP ${response.status})`);
  }
  if (typeof parsed.token !== "string" || typeof parsed.remoteUrl !== "string" || typeof parsed.refspec !== "string") {
    throw new Error("Harbor git push credential response 无效");
  }
  return { token: parsed.token, remoteUrl: parsed.remoteUrl, refspec: parsed.refspec };
}

export async function submitDeliveryAction(
  url: string,
  token: string,
  request: DeliveryActionRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Harbor delivery action rejected (HTTP ${response.status})`);
}

export function agentActionTriggerEnvironment(
  trigger: RunSpec["agentActionTrigger"],
): Record<string, string> {
  const result: Record<string, string> = {};
  const assign = (key: string, value: string | undefined, max: number) => {
    if (value === undefined) return;
    if (value.length > max || value.includes("\0")) throw new Error(`Agent action trigger ${key} 无效`);
    result[key] = value;
  };
  assign("HARBOR_AGENT_TRIGGER_EVENT_TYPE", trigger?.eventType, 128);
  assign("HARBOR_AGENT_TRIGGER_EVENT_ID", trigger?.eventId, 256);
  assign("HARBOR_AGENT_TRIGGER_REPOSITORY_ID", trigger?.repositoryId, 128);
  assign("HARBOR_AGENT_TRIGGER_REVISION", trigger?.revision, 128);
  return result;
}

export async function submitSelfDeployAction(
  url: string,
  token: string,
  request: SelfDeployActionRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<{ jobId: string; reused: boolean }> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Harbor self-deploy action rejected (HTTP ${response.status})`);
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new Error("Harbor self-deploy action returned invalid JSON");
  }
  const body = parsed as { job?: { id?: unknown }; reused?: unknown };
  if (!body?.job || typeof body.job.id !== "string" || !body.job.id) {
    throw new Error("Harbor self-deploy action response 缺少 job id");
  }
  return { jobId: body.job.id, reused: body.reused === true };
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

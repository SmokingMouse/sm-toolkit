/**
 * RunCoordinator —— run 生命周期的两端收口：
 *   入队/下发（per-device 并发闸，默认 2，超出排队；设备离线排队不丢）
 *   完成收尾（落 cost/session → issue 状态自动流转 → 广播 → 补位调度）
 *   重连对账（server 侧 running 但 daemon 不认的 run 判 failed）
 *   worktree 收尾（issue 终结 → 通知 daemon 删目录留分支；离线时重连补发）
 * ws 层只做传输解析，不含业务。
 */

import type { Cost } from "@sm/agent";
import { createHash, randomBytes } from "node:crypto";
import type {
  Automation,
  Conversation,
  HarborAgent,
  HarborSkill,
  PromptEventBlockKey,
  Run,
  RunAttachment,
  RunPurpose,
  RunSpec,
  ReviewCheckout,
  ServerMsg,
} from "../protocol.js";
import type { HarborStore } from "./store.js";
import type { RunBus } from "./bus.js";
import { transitionConversation } from "./statemachine.js";
import { inferPromptEvent, renderRunPrompt } from "./prompt-wrapper.js";
import { DeliveryService } from "./delivery.js";

/** 传输面（由 ws DeviceHub 实现）——注入接口避免 scheduler ↔ ws 循环依赖 */
export interface DeviceTransport {
  isOnline(deviceId: string): boolean;
  send(deviceId: string, msg: ServerMsg): boolean;
}

export class RunCoordinator {
  static readonly MAX_DISPATCH_DEPTH = 8;
  /** run 终态 hook（main 注入）：审批过期清理 / 飞书结果回报都挂这里 */
  onRunFinished?: (run: Run, conv: Conversation | null) => void;

  private readonly deliveries: DeliveryService;
  /** Chat 显式 cleanup 已送达、尚未收到 daemon proof；期间禁止新 Run 复用正在删除的目录。 */
  private readonly pendingWorktreeCleanups = new Set<string>();

  constructor(
    private store: HarborStore,
    private bus: RunBus,
    private transport: DeviceTransport,
    private concurrency: number,
    deliveries?: DeliveryService,
  ) {
    this.deliveries = deliveries ?? new DeliveryService(store);
  }

  /** 入队并尝试即时下发（REST/飞书/automation 共用）。同 conversation 串行——防 resume 分叉 */
  enqueueRun(
    conv: Conversation,
    agent: HarborAgent,
    prompt: string,
    purpose: RunPurpose = "implementation",
    promptEvent?: PromptEventBlockKey,
    triggerRef?: string | null,
    options: {
      triggerContext?: Record<string, unknown>;
      concurrencyKey?: string | null;
      allowQueuedBehindConversation?: boolean;
      attachments?: RunAttachment[];
      parentRunId?: string | null;
      rootRunId?: string;
      dispatchDepth?: number;
      dispatchKey?: string | null;
    } = {},
  ): Run {
    if (conv.workspaceId !== agent.workspaceId) {
      throw new Error(`Agent "${agent.name}" 不属于当前 Workspace，不能跨作用域执行`);
    }
    if (this.pendingWorktreeCleanups.has(conv.id)) {
      throw new Error("conversation worktree cleanup 进行中，请等待 Device 回报后再执行");
    }
    const active = this.store.activeRunForConversation(conv.id);
    if (active && !options.allowQueuedBehindConversation) {
      throw new Error(
        `conversation 已有进行中的 run（${active.id}，${active.status}）——同一会话串行执行，等它结束或先取消`,
      );
    }
    if (purpose === "triage" && conv.kind !== "issue_draft") {
      throw new Error("triage run 只能用于 AI Issue 草稿");
    }
    if (conv.kind === "issue_draft" && purpose !== "triage") {
      throw new Error("AI Issue 草稿只允许 triage run");
    }
    const reviewing = purpose === "review" || purpose === "verification";
    const repositoryId = conv.repositoryId && agent.repositoryIds.includes(conv.repositoryId)
      ? conv.repositoryId
      : agent.repositoryId;
    if (!repositoryId) throw new Error("当前任务尚未确定 Repository");
    if (reviewing && !agent.repositoryIds.includes(repositoryId)) {
      throw new Error(`Reviewer Agent 必须能看到实现仓库；当前 Agent 未绑定该 Repository`);
    }
    const repository = this.store.getRepository(repositoryId);
    if (repository?.archivedAt) {
      throw new Error(`Repository "${repository.name}" 已归档，不能启动新的 Run`);
    }
    const mount = this.store.getRepositoryMountForDevice(repositoryId, agent.deviceId);
    if (!mount) {
      throw new Error(
        `Repository "${repository?.name ?? repositoryId}" 没有挂载到 Agent 设备；请在 Agent 配置中补全该 Device 的本地路径`,
      );
    }
    const neutral = purpose === "coordination";
    const effectiveIsolation = purpose === "triage" || neutral || reviewing ? "none" : agent.isolation;
    if (effectiveIsolation === "worktree" && !mount) {
      throw new Error(`Agent "${agent.name}" 使用 Git worktree 隔离，但当前任务没有 Repository mount`);
    }
    let reviewCheckout: ReviewCheckout | null = null;
    if (reviewing) {
      const delivery = this.store.getDeliveryForConversation(conv.id);
      if (
        delivery &&
        (delivery.provider === "github" || delivery.provider === "codebase") &&
        delivery.latestHeadSha &&
        /^[a-f0-9]{40,64}$/i.test(delivery.latestHeadSha) &&
        delivery.headBranch?.trim() &&
        repository?.remoteUrl?.trim()
      ) {
        const githubPullNumber = delivery.provider === "github"
          ? /^#(\d+)$/.exec(delivery.externalId ?? "")?.[1]
          : null;
        reviewCheckout = {
          deliveryId: delivery.id,
          remoteUrl: repository.remoteUrl.trim(),
          ref: githubPullNumber
            ? `refs/pull/${githubPullNumber}/head`
            : `refs/heads/${delivery.headBranch.trim()}`,
          revision: delivery.latestHeadSha.toLowerCase(),
        };
      }
      if (!reviewCheckout && !conv.worktreePath) {
        throw new Error("Review 缺少 Provider 证明的 exact head revision，也没有原始 Issue worktree；拒绝审查未知代码");
      }
    }
    const needsIssueWorktree = !neutral && (!reviewing || !reviewCheckout);
    if (needsIssueWorktree && conv.worktreePath && conv.worktreeMountId !== mount.id) {
      throw new Error(
        reviewing
          ? "当前 Delivery 没有可信 exact revision，只能在原 Repository mount 审查 Issue worktree"
          : "当前 Issue 已有 worktree，只能继续使用创建该 worktree 的 Repository mount",
      );
    }
    if (conv.repositoryId !== repositoryId) {
      if (conv.worktreePath) throw new Error("当前 Issue 已有 worktree，不能切换 Repository");
      this.store.setConversationRepository(conv.id, repositoryId, Date.now());
      conv = this.store.getConversation(conv.id)!;
    }
    if (conv.kind === "issue") {
      if (conv.status === "done" || conv.status === "canceled") {
        throw new Error(`issue 已是 ${conv.status}，不能继续执行`);
      }
      if (reviewing) {
        if (conv.status !== "review") throw new Error(`${purpose} run 只能在 review 阶段启动`);
      } else if (purpose === "implementation") {
        const now = Date.now();
        // 新实现会改变 commit 集合，旧人工验收与 CI 证据必须失效；已合并交付在这里硬拒绝。
        this.deliveries.prepareImplementation(conv, now);
        if (conv.agentId !== agent.id) this.store.setConversationAssignee(conv.id, agent.id, now);
        const fresh = this.store.getConversation(conv.id)!;
        if (fresh.status !== "todo" && fresh.status !== "doing") {
          transitionConversation(this.store, fresh, "todo", "system", now);
        }
      }
    }
    const event = promptEvent ?? inferPromptEvent(conv, this.store.listRunsByConversation(conv.id).length > 0);
    const run = this.store.createRun(
      {
        workspaceId: conv.workspaceId,
        conversationId: conv.id,
        agentId: agent.id,
        deviceId: agent.deviceId,
        repositoryId,
        repositoryMountId: mount.id,
        executionRoot: reviewCheckout ? mount.path : neutral ? mount.path : conv.worktreePath ?? mount.path,
        prompt,
        purpose,
        promptEvent: event,
        triggerRef: triggerRef ?? conv.originRef,
        triggerContext: options.triggerContext,
        concurrencyKey: options.concurrencyKey,
        parentRunId: options.parentRunId,
        rootRunId: options.rootRunId,
        dispatchDepth: options.dispatchDepth,
        dispatchKey: options.dispatchKey,
        reviewCheckout,
        attachments: options.attachments,
      },
      Date.now(),
    );
    this.pump(agent.deviceId);
    return this.store.getRun(run.id)!;
  }

  /** 当前 Run 的最小权限派生入口；Harbor 校验目标，不替用户选择 Agent。 */
  enqueueChildRun(
    parent: Run,
    agent: HarborAgent,
    prompt: string,
    purpose: RunPurpose,
    dispatchKey: string,
  ): Run {
    const key = dispatchKey.trim();
    if (!key || key.length > 128) throw new Error("idempotencyKey 需要 1–128 字符");
    const existing = this.store.getRunByDispatchKey(parent.rootRunId, key);
    if (existing) {
      if (existing.agentId !== agent.id || existing.purpose !== purpose || existing.prompt !== prompt) {
        throw new Error(`idempotencyKey "${key}" 已用于不同的 Agent/purpose/prompt`);
      }
      return existing;
    }
    const depth = parent.dispatchDepth + 1;
    if (depth > RunCoordinator.MAX_DISPATCH_DEPTH) {
      throw new Error(`Run dispatch 深度超过上限 ${RunCoordinator.MAX_DISPATCH_DEPTH}`);
    }
    if (agent.workspaceId !== parent.workspaceId || agent.archivedAt) {
      throw new Error("目标 Agent 不属于当前 Workspace 或已归档");
    }
    if (parent.conversationId) {
      const conversation = this.store.getConversation(parent.conversationId);
      if (!conversation) throw new Error("当前 Run 的 Conversation 已不存在");
      return this.enqueueRun(
        conversation,
        agent,
        prompt,
        purpose,
        "event.automation.event",
        parent.id,
        {
          triggerContext: { parentRunId: parent.id, dispatchKey: key },
          concurrencyKey: `conversation:${conversation.id}`,
          allowQueuedBehindConversation: true,
          parentRunId: parent.id,
          rootRunId: parent.rootRunId,
          dispatchDepth: depth,
          dispatchKey: key,
        },
      );
    }
    if (parent.sourceType !== "automation") throw new Error("当前 Run source 不支持派生");
    if (purpose !== "coordination" && purpose !== "implementation") {
      throw new Error("无 Conversation 的 Automation source 只支持 coordination/implementation Run");
    }
    if (agent.isolation === "worktree" && purpose !== "coordination") {
      throw new Error("无 Conversation 的派生 Run 要求目标 Agent isolation=none");
    }
    const repositoryId = parent.repositoryId;
    if (!repositoryId || !agent.repositoryIds.includes(repositoryId)) {
      throw new Error("目标 Agent 看不到当前 Run 的 Repository");
    }
    const repository = this.store.getRepository(repositoryId);
    const mount = this.store.getRepositoryMountForDevice(repositoryId, agent.deviceId);
    if (!repository || repository.archivedAt || !mount) {
      throw new Error("目标 Agent 的 Repository mount 不可用");
    }
    const run = this.store.createRun({
      workspaceId: parent.workspaceId,
      sourceType: parent.sourceType,
      sourceId: parent.sourceId,
      conversationId: null,
      agentId: agent.id,
      deviceId: agent.deviceId,
      repositoryId,
      repositoryMountId: mount.id,
      executionRoot: mount.path,
      prompt,
      purpose,
      promptEvent: "event.automation.event",
      triggerRef: parent.triggerRef,
      triggerContext: { parentRunId: parent.id, dispatchKey: key },
      concurrencyKey: `source:${parent.sourceType}:${parent.sourceId}`,
      parentRunId: parent.id,
      rootRunId: parent.rootRunId,
      dispatchDepth: depth,
      dispatchKey: key,
    }, Date.now());
    this.pump(agent.deviceId);
    return run;
  }

  /** Mew 式 Automation 直跑：source=automation，不创建伪 Issue/Chat。 */
  enqueueAutomationRun(
    automation: Automation,
    agent: HarborAgent,
    repositoryId: string,
    prompt: string,
    purpose: RunPurpose,
    promptEvent: PromptEventBlockKey,
    triggerContext: Record<string, unknown>,
  ): Run {
    if (agent.workspaceId !== automation.workspaceId) {
      throw new Error("agent 与 automation 不在同一 Workspace，不能执行");
    }
    if (agent.archivedAt) throw new Error("agent 已归档，不能执行");
    if (!agent.repositoryIds.includes(repositoryId)) {
      throw new Error("Automation Repository 不在 Agent 可见范围");
    }
    const repository = this.store.getRepository(repositoryId);
    if (!repository || repository.archivedAt) throw new Error("Automation Agent 的 Repository 不存在或已归档");
    const mount = this.store.getRepositoryMountForDevice(repository.id, agent.deviceId);
    if (!mount) {
      throw new Error(`Repository "${repository.name}" 没有挂载到 Agent 设备`);
    }
    const run = this.store.createRun({
      workspaceId: automation.workspaceId,
      sourceType: "automation",
      sourceId: automation.id,
      conversationId: null,
      agentId: agent.id,
      deviceId: agent.deviceId,
      repositoryId,
      repositoryMountId: mount.id,
      executionRoot: mount.path,
      prompt,
      purpose,
      promptEvent,
      triggerRef: automation.id,
      triggerContext,
      concurrencyKey: `automation:${automation.id}`,
    }, Date.now());
    this.pump(agent.deviceId);
    return this.store.getRun(run.id)!;
  }

  /** 取消：queued 直接终态；running 发 run_cancel 等 daemon 回 run_done(canceled) */
  cancelRun(runId: string): Run {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`run "${runId}" 不存在`);
    if (run.status === "queued") {
      this.store.finishRun(runId, "canceled", { claudeSessionId: null, cost: null, error: null }, Date.now());
      const finished = this.store.getRun(runId)!;
      const conv = run.conversationId ? this.store.getConversation(run.conversationId) : null;
      if (
        conv?.kind === "issue" &&
        run.purpose === "implementation" &&
        conv.status !== "done" &&
        conv.status !== "canceled" &&
        conv.status !== "todo"
      ) {
        transitionConversation(this.store, conv, "todo", "system", Date.now());
      }
      this.bus.emitDone(finished);
      this.onRunFinished?.(finished, run.conversationId ? this.store.getConversation(run.conversationId) : null);
      return finished;
    }
    if (run.status === "running") {
      this.transport.send(run.deviceId, { type: "run_cancel", runId });
      // 设备离线时消息丢失也无妨：重连对账会把孤儿 run 判 failed
    }
    return this.store.getRun(runId)!;
  }

  /** 并发闸内逐个下发该设备最老的 queued run */
  pump(deviceId: string): void {
    while (this.transport.isOnline(deviceId)) {
      if (this.store.countRunning(deviceId) >= this.concurrency) return;
      const run = this.store.oldestQueuedForDevice(deviceId);
      if (!run) return;
      const now = Date.now();

      const agent = this.store.getAgent(run.agentId);
      const conv = run.conversationId ? this.store.getConversation(run.conversationId) : null;
      const mount = run.repositoryMountId
        ? this.store.getRepositoryMount(run.repositoryMountId)
        : null;
      if (
        !agent ||
        (!conv && run.sourceType !== "automation") ||
        !mount ||
        mount.repositoryId !== run.repositoryId ||
        mount.deviceId !== run.deviceId
      ) {
        this.store.finishRun(
          run.id,
          "failed",
          {
            claudeSessionId: null,
            cost: null,
            error:
              !agent || (!conv && run.sourceType !== "automation")
                ? "agent 或 Run source 已不存在，无法下发"
                : "Run 绑定的 Repository mount 已不存在或身份不匹配，拒绝下发",
          },
          now,
        );
        this.bus.emitDone(this.store.getRun(run.id)!);
        continue;
      }

      const actionToken = `harbor_run_${randomBytes(24).toString("base64url")}`;
      this.store.revokeRunActionTokens(run.id, now);
      this.store.createRunActionToken(
        run.id,
        createHash("sha256").update(actionToken).digest("hex"),
        now + 2 * 60 * 60 * 1000,
        now,
      );
      const spec: RunSpec = {
        backend: agent.backend,
        model: agent.model,
        // runs.prompt 保留原文；只在 dispatch 瞬间按来源包裹结构化上下文。
        prompt: renderRunPrompt(this.store, { run, conversation: conv, agent }),
        purpose: run.purpose,
        repositoryRoot: mount.path,
        executionRoot: run.executionRoot,
        additionalRepositoryRoots: agent.repositoryIds
          .filter((repositoryId) => repositoryId !== run.repositoryId)
          .map((repositoryId) => this.store.getRepositoryMountForDevice(repositoryId, agent.deviceId)?.path)
          .filter((path): path is string => !!path),
        // AI draft 只允许读取仓库做分诊，不能在 Issue 尚未确认时改文件或创建 worktree。
        permission: ["triage", "review", "verification", "coordination"].includes(run.purpose)
          ? "readonly"
          : agent.permission,
        systemPrompt: withAgentActionGuidance(
          composeAgentSystemPrompt(agent.instruction, this.store.listSkillsForAgent(agent.id)),
        ),
        resume:
          conv && (run.purpose === "implementation" || run.purpose === "triage") && conv.agentId === agent.id
            ? conv.claudeSessionId
            : null,
        conversationId: conv?.id ?? null,
        isolation: ["triage", "review", "verification", "coordination"].includes(run.purpose)
          ? "none"
          : agent.isolation,
        worktreePath: ["triage", "coordination"].includes(run.purpose) || run.reviewCheckout
          ? null
          : conv?.worktreePath ?? null,
        reviewCheckout: run.reviewCheckout,
        envOverrides: agent.environment,
        setupScript: ["triage", "review", "verification", "coordination"].includes(run.purpose)
          ? null
          : agent.setupScript,
        setupKey: agent.setupScript
          ? createHash("sha256").update(`${agent.id}\0${agent.setupScript}`).digest("hex")
          : null,
        attachments: this.store.listRunAttachments(run.id),
        agentActionToken: actionToken,
      };
      const sent = this.transport.send(deviceId, { type: "run_start", runId: run.id, spec });
      if (!sent) {
        this.store.revokeRunActionTokens(run.id, Date.now());
        return; // 连接实际不可用，留在队列等下次上线
      }
      this.store.markRunRunning(run.id, now);
      if (conv?.kind === "issue" && run.purpose === "implementation" && conv.status !== "doing") {
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
    this.store.revokeRunActionTokens(msg.runId, now);

    const conv = run.conversationId ? this.store.getConversation(run.conversationId) : null;
    if (conv) {
      if (
        msg.claudeSessionId &&
        (run.purpose === "implementation" || run.purpose === "triage") &&
        conv.agentId === run.agentId
      ) {
        this.store.setConversationClaudeSessionId(conv.id, msg.claudeSessionId, now);
      }
      if (conv.kind === "issue" && run.purpose === "implementation") {
        // implementation succeeded → review；failed/canceled → todo（已完成分诊，等待修复/重试）。
        // 人在 run 期间已把 issue 关了（done/canceled）→ 尊重人工终态，不自动拉回。
        const fresh = this.store.getConversation(conv.id)!;
        if (fresh.status !== "done" && fresh.status !== "canceled") {
          transitionConversation(this.store, fresh, msg.status === "succeeded" ? "review" : "todo", "system", now);
        }
      }
    }

    const finished = this.store.getRun(msg.runId)!;
    this.bus.emitDone(finished);
    this.onRunFinished?.(finished, run.conversationId ? this.store.getConversation(run.conversationId) : null);
    this.pump(run.deviceId);
  }

  /** worktree 回填（daemon 首跑创建后回报） */
  onWorktreeReady(runId: string, conversationId: string, path: string): void {
    const run = this.store.getRun(runId);
    const conv = this.store.getConversation(conversationId);
    if (!conv || !run) return;
    if (conv.worktreePath !== path) {
      this.store.setConversationWorktreePath(conversationId, path, run.repositoryMountId, Date.now());
      this.store.setRunExecutionRoot(runId, path);
      console.log(`[coordinator] worktree 就绪：${conversationId} → ${path}`);
    }
  }

  onRunExecutionReady(runId: string, path: string): void {
    const run = this.store.getRun(runId);
    if (!run || !run.reviewCheckout || run.status !== "running") return;
    this.store.setRunExecutionRoot(runId, path);
    console.log(`[coordinator] exact revision checkout 就绪：${runId} → ${path}`);
  }

  /** worktree 收尾（保留分支删目录）。返回 false 表示当前未送达；终态 Issue 会在重连对账时补发。 */
  requestWorktreeCleanup(conv: Conversation): boolean {
    if (!conv.worktreePath || !conv.worktreeMountId) return true;
    const mount = this.store.getRepositoryMount(conv.worktreeMountId);
    if (!mount) return false;
    const sent = this.transport.send(mount.deviceId, {
      type: "worktree_cleanup",
      conversationId: conv.id,
      repositoryRoot: mount.path,
      worktreePath: conv.worktreePath,
    });
    if (!sent) {
      console.log(`[coordinator] 设备离线，worktree 收尾等重连补发：${conv.id}（${conv.worktreePath}）`);
    } else if (conv.kind === "chat") {
      this.pendingWorktreeCleanups.add(conv.id);
    }
    return sent;
  }

  onWorktreeCleanupResult(conversationId: string, ok: boolean, message: string): void {
    this.pendingWorktreeCleanups.delete(conversationId);
    const conv = this.store.getConversation(conversationId);
    if (!conv) return;
    if (ok) {
      this.store.setConversationWorktreePath(conversationId, null, null, Date.now());
      console.log(`[coordinator] worktree 已清理：${conversationId}`);
    } else {
      // 保留 worktree_path（目录还在是事实），fail loudly；daemon 重连时会再试一次
      console.warn(`[coordinator] worktree 清理失败（保留目录，下次设备重连重试）：${conversationId} —— ${message}`);
    }
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
      if (run.reviewCheckout && run.repositoryMountId) {
        const reviewMount = this.store.getRepositoryMount(run.repositoryMountId);
        if (reviewMount?.deviceId === deviceId) {
          this.transport.send(deviceId, {
            type: "review_checkout_cleanup",
            runId: run.id,
            repositoryRoot: reviewMount.path,
          });
        }
      }
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
      this.store.revokeRunActionTokens(run.id, now);
      const conv = run.conversationId ? this.store.getConversation(run.conversationId) : null;
      if (conv?.kind === "issue" && run.purpose === "implementation") {
        transitionConversation(this.store, conv, "todo", "system", now);
      }
      const finished = this.store.getRun(run.id)!;
      this.bus.emitDone(finished);
      this.onRunFinished?.(finished, run.conversationId ? this.store.getConversation(run.conversationId) : null);
    }
    // 设备离线期间人工终结的 issue：worktree 收尾消息已丢，这里补发
    for (const { conversation } of this.store.listWorktreeCleanupsForDevice(deviceId)) {
      this.requestWorktreeCleanup(conversation);
    }
    for (const conversationId of this.pendingWorktreeCleanups) {
      const conversation = this.store.getConversation(conversationId);
      const mount = conversation?.worktreeMountId
        ? this.store.getRepositoryMount(conversation.worktreeMountId)
        : null;
      if (conversation && mount?.deviceId === deviceId) this.requestWorktreeCleanup(conversation);
    }
    this.pump(deviceId);
  }
}

const AGENT_ACTION_GUIDANCE = `# Harbor control-plane safety

Harbor owns lifecycle state. Do not mutate the current Issue status from the shell.
All action endpoints require Authorization: Bearer $HARBOR_AGENT_ACTION_TOKEN. Never print, log, persist, or include that token in output.
The built-in harbor Skill defines the supported action shapes and role playbooks. Only call the endpoint appropriate to the current Run purpose. A rejected action is a control-plane decision; do not bypass it with the owner token or direct database writes.`;

function withAgentActionGuidance(systemPrompt: string | null): string {
  return [systemPrompt?.trim(), AGENT_ACTION_GUIDANCE].filter(Boolean).join("\n\n---\n\n");
}

/**
 * Skill 是 Agent instruction 的可复用补充。统一在 server dispatch 时合成，
 * Claude 走 --system-prompt，Codex 由 Backend inline 到用户请求之前，两种 Runtime 都真实生效。
 */
export function composeAgentSystemPrompt(
  instruction: string | null,
  skills: HarborSkill[],
): string | null {
  const sections: string[] = [];
  if (instruction?.trim()) sections.push(instruction.trim());
  if (skills.length > 0) {
    sections.push([
      "# Harbor configured skills",
      "Apply the following workspace Skills whenever the task matches. Treat each Skill as system-level operating guidance.",
      ...skills.map((skill) => [
        `## Skill: ${skill.name}`,
        skill.description ? `Description: ${skill.description}` : "",
        skill.instruction.trim(),
      ].filter(Boolean).join("\n\n")),
    ].join("\n\n"));
  }
  return sections.length > 0 ? sections.join("\n\n---\n\n") : null;
}

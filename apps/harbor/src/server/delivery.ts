/**
 * Delivery control plane：policy 决定 MR/PR 能不能 review/check/merge。
 * Release 与部署由 Agent/项目自己的 capability 编排，不属于 Delivery 生命周期。
 */

import type {
  Conversation,
  Delivery,
  DeliveryCheckStatus,
  DeliveryEvent,
  DeliveryMergeStatus,
  DeliveryProviderKind,
  HarborRepository,
  Run,
} from "../protocol.js";
import type { HarborStore } from "./store.js";

export interface DeliveryProviderAction {
  confirmed?: boolean;
  mergedRevision?: string;
}

export interface DeliveryProviderResult {
  message: string;
  data?: unknown;
  /** SCM merge 后可部署的 exact committed revision；自动 target 不接受 branch/Agent 自报。 */
  mergedRevision?: string | null;
}

export interface DeliveryProviderContext {
  conversation: Conversation;
  repository: HarborRepository | null;
}

export interface DeliveryChangeInput {
  changeUrl?: string | null;
  externalId?: string | null;
  headBranch?: string | null;
  baseBranch?: string | null;
  /** Provider 证明的当前 head commit；Agent 自报不会被当作可信事实。 */
  latestHeadSha?: string | null;
  checkStatus?: DeliveryCheckStatus;
  title?: string | null;
  body?: string | null;
}

export interface DeliveryProviderSnapshot {
  changeUrl?: string | null;
  externalId?: string | null;
  headBranch?: string | null;
  baseBranch?: string | null;
  latestHeadSha?: string | null;
  reviewStatus?: Delivery["reviewStatus"];
  checkStatus?: Delivery["checkStatus"];
  mergeStatus?: Delivery["mergeStatus"];
  mergedRevision?: string | null;
  providerData?: unknown;
}

export interface DeliveryProviderSyncResult extends DeliveryProviderResult {
  metadata: {
    changeUrl: string;
    externalId: string;
    headBranch: string;
    baseBranch: string;
    latestHeadSha: string;
  };
  checkStatus: DeliveryCheckStatus;
  mergeStatus: DeliveryMergeStatus;
  mergedAt: number | null;
  mergedRevision: string | null;
}

export interface DeliveryProvider {
  readonly kind: DeliveryProviderKind;
  readonly mode: "confirmation" | "automatic";
  prepareChange?(context: DeliveryProviderContext, input: DeliveryChangeInput): DeliveryChangeInput;
  /** Agent 已 push head branch 后，由 server-side SCM credential 创建 PR/MR。 */
  createChange?(context: DeliveryProviderContext, input: DeliveryChangeInput): Promise<DeliveryChangeInput>;
  sync?(delivery: Delivery, context: DeliveryProviderContext): Promise<DeliveryProviderSyncResult>;
  merge(
    delivery: Delivery,
    input: DeliveryProviderAction,
    context: DeliveryProviderContext,
  ): Promise<DeliveryProviderResult>;
  refresh?(delivery: Delivery, context: DeliveryProviderContext): Promise<DeliveryProviderSnapshot>;
}

/**
 * 人工 Provider 的按钮语义是“我已在外部系统完成/开始”，不是 Harbor 代替用户执行。
 * 这条边界必须体现在文案和 API confirmed=true 上。
 */
export class ManualDeliveryProvider implements DeliveryProvider {
  readonly kind = "manual" as const;
  readonly mode = "confirmation" as const;

  async merge(
    _delivery: Delivery,
    input: DeliveryProviderAction,
    _context: DeliveryProviderContext,
  ): Promise<DeliveryProviderResult> {
    if (input.confirmed !== true) throw new Error("manual provider 需要 confirmed=true 才能记录已合并事实");
    if (input.mergedRevision && !/^[a-f0-9]{40,64}$/i.test(input.mergedRevision)) {
      throw new Error("merged revision 必须是完整十六进制 commit id");
    }
    return { message: "人工确认变更已在外部 SCM 合并", mergedRevision: input.mergedRevision?.toLowerCase() ?? null };
  }

}

export class DeliveryService {
  /** 仅发布已经持久化的正交事实变化；监听方失败不能反向污染外部 merge 结果。 */
  onTransition?: (before: Delivery, after: Delivery) => void;
  private readonly providers: Map<DeliveryProviderKind, DeliveryProvider>;
  private readonly externalActionTails = new Map<string, Promise<void>>();

  constructor(
    private readonly store: HarborStore,
    providers: DeliveryProvider[] = [],
  ) {
    this.providers = new Map(
      [new ManualDeliveryProvider(), ...providers].map((provider) => [provider.kind, provider]),
    );
  }

  create(
    conv: Conversation,
    input: DeliveryChangeInput & { provider?: DeliveryProviderKind },
    now = Date.now(),
  ): Delivery {
    if (conv.kind !== "issue" || conv.status !== "review") {
      throw new Error("Delivery 只能在 Issue 的 Review 阶段创建");
    }
    if (this.store.activeRunForConversation(conv.id)) throw new Error("仍有 Run 进行中，不能创建 Delivery");
    return this.createPrepared(conv, input, "human", now);
  }

  /**
   * implementation Run 的最小权限交付入口：只允许给当前 Issue 的固定 branch 注册/创建 PR。
   * 它不批准、不合并，也不修改 Issue 状态。
   */
  async createFromImplementationRun(
    run: Run,
    conv: Conversation,
    input: DeliveryChangeInput & { provider?: DeliveryProviderKind },
    now = Date.now(),
  ): Promise<Delivery> {
    if (
      run.status !== "running" ||
      run.purpose !== "implementation" ||
      run.conversationId !== conv.id ||
      run.workspaceId !== conv.workspaceId ||
      conv.kind !== "issue"
    ) {
      throw new Error("只有当前 Issue 的 running implementation Run 可以注册 Delivery");
    }
    if (conv.status !== "doing") throw new Error("当前 Issue 不在 Doing 阶段");
    if (this.store.getDeliveryForConversation(conv.id)) throw new Error("当前 Issue 已有 Delivery");
    const repository = conv.repositoryId ? this.store.getRepository(conv.repositoryId) : null;
    if (!repository) throw new Error("当前 Issue 没有关联 Repository");
    const expectedHead = `harbor/${conv.id}`;
    if (input.headBranch?.trim() !== expectedHead) {
      throw new Error(`headBranch 必须是当前 Issue 的隔离分支 ${expectedHead}`);
    }
    if (input.baseBranch?.trim() && input.baseBranch.trim() !== repository.defaultBranch) {
      throw new Error(`baseBranch 必须是 Repository default branch ${repository.defaultBranch}`);
    }
    const providerKind = input.provider ?? (repository.scmProvider === "codebase" ? "codebase" : "github");
    const provider = this.configuredProvider(providerKind);
    let preparedInput: DeliveryChangeInput = {
      ...input,
      headBranch: expectedHead,
      baseBranch: repository.defaultBranch,
    };
    if (!preparedInput.changeUrl?.trim() && provider.createChange) {
      preparedInput = await provider.createChange(this.context(conv), preparedInput);
    }
    return this.createPrepared(conv, { ...preparedInput, provider: providerKind }, "agent", now);
  }

  private createPrepared(
    conv: Conversation,
    input: DeliveryChangeInput & { provider?: DeliveryProviderKind },
    actor: DeliveryEvent["actor"],
    now: number,
  ): Delivery {
    if (this.store.getDeliveryForConversation(conv.id)) throw new Error("当前 Issue 已有 Delivery");
    const repository = conv.repositoryId ? this.store.getRepository(conv.repositoryId) : null;
    const providerKind = input.provider ?? (repository?.scmProvider === "codebase" ? "codebase" : "manual");
    const provider = this.configuredProvider(providerKind);
    if (providerKind === "manual" && !input.changeUrl?.trim()) {
      throw new Error("manual provider 需要填写 MR/PR URL");
    }
    let changeInput: DeliveryChangeInput = input;
    if (providerKind === "codebase") {
      if (repository?.scmProvider !== "codebase" || !repository.scmRepository) {
        throw new Error("Codebase Delivery 需要 Repository 配置 Codebase repository path");
      }
      const externalId = input.externalId?.trim() || /\/merge_requests\/(\d+)/.exec(input.changeUrl ?? "")?.[1];
      if (!externalId || !/^\d+$/.test(externalId)) {
        throw new Error("Codebase Delivery 需要 MR number（externalId）");
      }
      changeInput = { ...input, externalId };
    }
    const prepared: DeliveryChangeInput = provider.prepareChange?.(this.context(conv), changeInput) ?? changeInput;
    const delivery = this.store.createDelivery(
      {
        conversationId: conv.id,
        provider: providerKind,
        changeUrl: clean(prepared.changeUrl),
        externalId: clean(prepared.externalId),
        headBranch: clean(prepared.headBranch),
        baseBranch: clean(prepared.baseBranch),
        latestHeadSha: clean(prepared.latestHeadSha),
        checkStatus: prepared.checkStatus,
      },
      now,
    );
    this.store.appendDeliveryEvent(
      delivery.id,
      "created",
      {
        provider: providerKind,
        changeUrl: delivery.changeUrl,
      },
      actor,
      now,
    );
    return this.store.getDelivery(delivery.id)!;
  }

  update(
    delivery: Delivery,
    input: {
      changeUrl?: string | null;
      externalId?: string | null;
      headBranch?: string | null;
      baseBranch?: string | null;
      checkStatus?: DeliveryCheckStatus;
    },
    now = Date.now(),
  ): Delivery {
    if (delivery.mergeStatus === "merged") throw new Error("已合并的 Delivery 不能再修改变更或 CI 事实");
    if (delivery.provider !== "manual") {
      throw new Error(
        delivery.provider === "github"
          ? "GitHub Delivery 的 PR、branch 与 CI 事实只能通过 Sync from GitHub 更新"
          : `${delivery.provider} Delivery 的变更与 CI 事实只能通过对应 Provider 同步`,
      );
    }
    if (delivery.provider === "manual" && input.changeUrl !== undefined && !clean(input.changeUrl)) {
      throw new Error("manual provider 需要保留 MR/PR URL");
    }
    const metadata: { changeUrl?: string | null; externalId?: string | null; headBranch?: string | null; baseBranch?: string | null } = {};
    const candidates = {
      ...(input.changeUrl !== undefined ? { changeUrl: clean(input.changeUrl) } : {}),
      ...(input.externalId !== undefined ? { externalId: clean(input.externalId) } : {}),
      ...(input.headBranch !== undefined ? { headBranch: clean(input.headBranch) } : {}),
      ...(input.baseBranch !== undefined ? { baseBranch: clean(input.baseBranch) } : {}),
    };
    for (const key of Object.keys(candidates) as (keyof typeof candidates)[]) {
      if (candidates[key] !== delivery[key]) metadata[key] = candidates[key];
    }
    this.store.updateDeliveryMetadata(delivery.id, metadata, now);
    const metadataChanged = Object.keys(metadata).length > 0;
    if (metadataChanged) {
      // MR/branch 指向变了，旧人工验收必然失效；CI 若未随请求给新结果则回到 pending。
      this.store.updateDeliveryState(
        delivery.id,
        {
          reviewStatus: "pending",
          reviewApprovedAt: null,
          approvedHeadSha: null,
          checkStatus: input.checkStatus ?? "pending",
        },
        now,
      );
      this.store.appendDeliveryEvent(delivery.id, "change_updated", metadata, "human", now);
      this.store.appendDeliveryEvent(delivery.id, "evidence_invalidated", { reason: "change_reference_updated" }, "system", now);
    } else if (input.checkStatus !== undefined && input.checkStatus !== delivery.checkStatus) {
      this.store.updateDeliveryState(delivery.id, { checkStatus: input.checkStatus }, now);
      this.store.appendDeliveryEvent(
        delivery.id,
        "checks_updated",
        { from: delivery.checkStatus, to: input.checkStatus },
        "human",
        now,
      );
    }
    return this.store.getDelivery(delivery.id)!;
  }

  approve(
    delivery: Delivery,
    conv: Conversation,
    now = Date.now(),
    allowedRunId?: string,
    actor: DeliveryEvent["actor"] = "human",
  ): Delivery {
    this.assertReviewIdle(conv, allowedRunId);
    const current = this.store.getDelivery(delivery.id);
    if (!current) throw new Error(`Delivery "${delivery.id}" 不存在`);
    if (!current.changeUrl) throw new Error("Delivery 尚未关联 MR/PR，不能验收");
    if (current.provider === "manual" && current.mergeStatus === "merged") {
      throw new Error("Delivery 已合并，无需重复验收");
    }
    if (current.provider === "github" && !current.latestHeadSha) {
      throw new Error("GitHub Delivery 尚未同步 head SHA；请先 Sync from GitHub 再验收");
    }
    const approvedHeadSha = current.provider === "github" ? current.latestHeadSha : null;
    if (current.reviewStatus === "approved" && current.approvedHeadSha === approvedHeadSha) return current;
    this.store.updateDeliveryState(
      current.id,
      { reviewStatus: "approved", reviewApprovedAt: now, approvedHeadSha },
      now,
    );
    this.store.appendDeliveryEvent(
      current.id,
      "review_approved",
      current.provider === "github" ? { headSha: approvedHeadSha } : {},
      actor,
      now,
    );
    const after = this.requireDelivery(current.id);
    this.emitTransition(current, after);
    return after;
  }

  async sync(
    delivery: Delivery,
    _conv: Conversation,
    now = Date.now(),
    allowedRunId?: string,
  ): Promise<Delivery> {
    return this.runExternalAction(delivery.id, async () => {
      const current = this.requireDelivery(delivery.id);
      const conv = this.requireConversation(current);
      this.assertReviewIdle(conv, allowedRunId);
      const provider = this.provider(current);
      if (!provider.sync) throw new Error(`delivery provider "${current.provider}" 不支持外部同步`);
      const result = await provider.sync(current, this.context(conv));

      const metadata = changedMetadata(current, result.metadata);
      const headChanged = current.latestHeadSha !== null && result.metadata.latestHeadSha !== current.latestHeadSha;
      const nextMergeStatus = current.mergeStatus === "merged" ? "merged" : result.mergeStatus;
      const nextMergedAt = nextMergeStatus === "merged"
        ? result.mergedAt ?? current.mergedAt ?? now
        : null;
      const patch: Parameters<HarborStore["compareAndSetDelivery"]>[2] = { ...metadata };
      if (result.checkStatus !== current.checkStatus) patch.checkStatus = result.checkStatus;
      if (nextMergeStatus !== current.mergeStatus) patch.mergeStatus = nextMergeStatus;
      if (nextMergedAt !== current.mergedAt) patch.mergedAt = nextMergedAt;
      if (result.mergedRevision !== current.mergedRevision) patch.mergedRevision = result.mergedRevision;
      if (headChanged) {
        // 旧 checks 先随旧 head 失效；本次 result.checkStatus 是同一 sync 对新 head 重建的新证据。
        patch.reviewStatus = "pending";
        patch.reviewApprovedAt = null;
        patch.approvedHeadSha = null;
      }
      if (Object.keys(patch).length === 0) {
        if (this.requireDelivery(current.id).revision !== current.revision) {
          throw new Error("Delivery 证据在 GitHub sync 期间已变化；旧响应已丢弃，请重新 Sync from GitHub");
        }
        return current;
      }

      const events = [
        ...(headChanged ? [{
          kind: "evidence_invalidated",
          data: {
            reason: "github_head_changed",
            fromHeadSha: current.latestHeadSha,
            toHeadSha: result.metadata.latestHeadSha,
            invalidated: ["human_review", "checks"],
            checksReplacedBySync: true,
          },
          actor: "provider" as const,
        }] : []),
        {
          kind: "synced",
          data: {
            message: result.message,
            from: {
              headSha: current.latestHeadSha,
              checkStatus: current.checkStatus,
              mergeStatus: current.mergeStatus,
            },
            to: {
              headSha: result.metadata.latestHeadSha,
              checkStatus: result.checkStatus,
              mergeStatus: nextMergeStatus,
            },
            data: result.data,
          },
          actor: "provider" as const,
        },
      ];
      if (!this.store.compareAndSetDelivery(current.id, current.revision, patch, events, now)) {
        throw new Error("Delivery 证据在 GitHub sync 期间已变化；旧响应已丢弃，请重新 Sync from GitHub");
      }
      const after = this.requireDelivery(current.id);
      this.emitTransition(current, after);
      return after;
    });
  }

  /** 新一轮实现会让旧审批和 CI 证据失效；merged 后禁止在原 Issue 上继续返工。 */
  prepareImplementation(conv: Conversation, now = Date.now()): Delivery | null {
    const delivery = this.store.getDeliveryForConversation(conv.id);
    if (!delivery) return null;
    if (delivery.mergeStatus === "merged") {
      throw new Error("Delivery 已合并，不能在原 Issue 上继续修改；请创建修复 Issue 或走回滚流程");
    }
    this.store.updateDeliveryState(
      delivery.id,
      { reviewStatus: "pending", reviewApprovedAt: null, approvedHeadSha: null, checkStatus: "pending" },
      now,
    );
    this.store.appendDeliveryEvent(
      delivery.id,
      "evidence_invalidated",
      { reason: "new_implementation_run" },
      "system",
      now,
    );
    return this.store.getDelivery(delivery.id)!;
  }

  async merge(
    delivery: Delivery,
    _conv: Conversation,
    input: DeliveryProviderAction,
    now = Date.now(),
    allowedRunId?: string,
  ): Promise<Delivery> {
    return this.runExternalAction(delivery.id, async () => {
      const current = this.requireDelivery(delivery.id);
      const conv = this.requireConversation(current);
      this.assertReviewIdle(conv, allowedRunId);
      if (current.mergeStatus === "merged") return current;
      if (current.mergeStatus !== "open") throw new Error("PR 已关闭且未合并；重新打开并 Sync 后才能合并");
      if (!current.changeUrl) throw new Error("Delivery 尚未关联 MR/PR");
      if (current.reviewStatus !== "approved") throw new Error("人工验收尚未通过，不能合并");
      if (current.checkStatus !== "passed") throw new Error("CI checks 尚未通过，不能合并");
      if (current.provider === "github") {
        if (!current.latestHeadSha) throw new Error("GitHub head SHA 尚未同步，不能合并");
        if (current.approvedHeadSha !== current.latestHeadSha) {
          throw new Error("人工验收对应的 GitHub head SHA 已过期；请 Sync 后重新验收");
        }
      }
      const result = await this.provider(current).merge(current, input, this.context(conv));
      const committed = this.store.compareAndSetDelivery(
        current.id,
        current.revision,
        { mergeStatus: "merged", mergedAt: now, mergedRevision: result.mergedRevision ?? null },
        [{ kind: "merged", data: { message: result.message, data: result.data }, actor: "provider" }],
        now,
      );
      if (!committed) {
        const latest = this.requireDelivery(current.id);
        if (latest.mergeStatus === "merged") return latest;
        throw new Error(
          "GitHub merge 返回期间 Delivery 证据已变化；未写入 merged，请 Sync from GitHub 核对外部结果后重新验收",
        );
      }
      const after = this.requireDelivery(current.id);
      this.emitTransition(current, after);
      return after;
    });
  }

  async refresh(delivery: Delivery, now = Date.now()): Promise<Delivery> {
    const provider = this.provider(delivery);
    if (!provider.refresh) throw new Error(`delivery provider "${delivery.provider}" 不支持主动刷新`);
    const conv = this.requireConversation(delivery);
    const snapshot = await provider.refresh(delivery, this.context(conv));
    return this.applyProviderSnapshot(delivery, snapshot, now);
  }

  applyProviderSnapshot(delivery: Delivery, snapshot: DeliveryProviderSnapshot, now = Date.now()): Delivery {
    const metadata = {
      ...(snapshot.changeUrl !== undefined ? { changeUrl: clean(snapshot.changeUrl) } : {}),
      ...(snapshot.externalId !== undefined ? { externalId: clean(snapshot.externalId) } : {}),
      ...(snapshot.headBranch !== undefined ? { headBranch: clean(snapshot.headBranch) } : {}),
      ...(snapshot.baseBranch !== undefined ? { baseBranch: clean(snapshot.baseBranch) } : {}),
      ...(snapshot.latestHeadSha !== undefined ? { latestHeadSha: clean(snapshot.latestHeadSha)?.toLowerCase() ?? null } : {}),
    };
    this.store.updateDeliveryMetadata(delivery.id, metadata, now);
    this.store.updateDeliveryState(delivery.id, {
      ...(snapshot.reviewStatus !== undefined ? {
        reviewStatus: snapshot.reviewStatus,
        reviewApprovedAt: snapshot.reviewStatus === "approved" ? (delivery.reviewApprovedAt ?? now) : null,
      } : {}),
      ...(snapshot.checkStatus !== undefined ? { checkStatus: snapshot.checkStatus } : {}),
      ...(snapshot.mergeStatus !== undefined ? {
        mergeStatus: snapshot.mergeStatus,
        mergedAt: snapshot.mergeStatus === "merged" ? (delivery.mergedAt ?? now) : null,
      } : {}),
      ...(snapshot.mergedRevision !== undefined ? { mergedRevision: clean(snapshot.mergedRevision)?.toLowerCase() ?? null } : {}),
    }, now);
    this.store.appendDeliveryEvent(
      delivery.id,
      "provider_refreshed",
      { snapshot, providerData: snapshot.providerData },
      "provider",
      now,
    );
    const after = this.requireDelivery(delivery.id);
    this.emitTransition(delivery, after);
    return after;
  }

  isComplete(delivery: Delivery): boolean {
    return delivery.status === "succeeded";
  }

  private provider(delivery: Delivery): DeliveryProvider {
    return this.configuredProvider(delivery.provider);
  }


  private configuredProvider(kind: DeliveryProviderKind): DeliveryProvider {
    const provider = this.providers.get(kind);
    if (provider) return provider;
    if (kind === "github") {
      throw new Error(
        "GitHub Delivery provider 未配置：请在 harbor-server 设置 HARBOR_GITHUB_TOKEN（或 ~/.harbor.yaml github.token）；manual provider 仍可用",
      );
    }
    throw new Error(`delivery provider "${kind}" 尚未配置`);
  }

  private context(conv: Conversation): DeliveryProviderContext {
    return {
      conversation: conv,
      repository: conv.repositoryId ? this.store.getRepository(conv.repositoryId) : null,
    };
  }

  private requireDelivery(id: string): Delivery {
    const delivery = this.store.getDelivery(id);
    if (!delivery) throw new Error(`Delivery "${id}" 不存在`);
    return delivery;
  }

  private requireConversation(delivery: Delivery): Conversation {
    const conv = this.store.getConversation(delivery.conversationId);
    if (!conv) throw new Error(`Delivery "${delivery.id}" 的 Issue 不存在`);
    return conv;
  }

  /** 同一 Delivery 的 sync/merge 按调用顺序执行，避免旧 HTTP 响应乱序落库。 */
  private runExternalAction<T>(deliveryId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.externalActionTails.get(deliveryId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(action);
    const tail = run.then(() => undefined, () => undefined);
    this.externalActionTails.set(deliveryId, tail);
    return run.finally(() => {
      if (this.externalActionTails.get(deliveryId) === tail) this.externalActionTails.delete(deliveryId);
    });
  }

  private emitTransition(before: Delivery, after: Delivery): void {
    if (!this.onTransition || before.revision === after.revision) return;
    try {
      this.onTransition(before, after);
    } catch (error) {
      console.error(
        "[delivery] transition listener 失败：",
        error instanceof Error ? error.message : error,
      );
    }
  }

  private assertReviewIdle(conv: Conversation, allowedRunId?: string): void {
    if (conv.kind !== "issue" || conv.status !== "review") throw new Error("当前 Issue 不在 Review 阶段");
    const active = this.store.activeRunForConversation(conv.id);
    if (active && active.id !== allowedRunId) throw new Error("仍有 Run 进行中，不能推进 Delivery");
  }
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function changedMetadata(
  delivery: Delivery,
  metadata: DeliveryProviderSyncResult["metadata"],
): Partial<DeliveryProviderSyncResult["metadata"]> {
  const changed: Partial<DeliveryProviderSyncResult["metadata"]> = {};
  for (const key of ["changeUrl", "externalId", "headBranch", "baseBranch", "latestHeadSha"] as const) {
    if (metadata[key] !== delivery[key]) changed[key] = metadata[key];
  }
  return changed;
}

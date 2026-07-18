/**
 * Delivery control plane：policy 决定“能不能做”；SCM Provider 与 Deployment target/provider 正交。
 * manual SCM 不伪装调用外部平台；自动部署结果只来自独立 host worker。
 */

import type {
  Conversation,
  Delivery,
  DeliveryCheckStatus,
  DeliveryMergeStatus,
  DeliveryProviderKind,
  DeploymentTargetDescriptor,
  HarborRepository,
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
  deploymentRequired?: boolean;
  checkStatus?: DeliveryCheckStatus;
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
  sync?(delivery: Delivery, context: DeliveryProviderContext): Promise<DeliveryProviderSyncResult>;
  merge(
    delivery: Delivery,
    input: DeliveryProviderAction,
    context: DeliveryProviderContext,
  ): Promise<DeliveryProviderResult>;
}

/** server 只持有 target 的安全 routing metadata；执行路径/argv/secret 只给独立 worker。 */
export interface DeploymentTargetRegistration extends DeploymentTargetDescriptor {
  repositoryId: string;
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
    if (_delivery.deploymentTargetId && !/^[a-f0-9]{40,64}$/i.test(input.mergedRevision ?? "")) {
      throw new Error("manual SCM + 自动 deployment target 需要填写完整十六进制 merged commit id");
    }
    return { message: "人工确认变更已在外部 SCM 合并", mergedRevision: input.mergedRevision?.toLowerCase() ?? null };
  }

}

export class DeliveryService {
  private readonly providers: Map<DeliveryProviderKind, DeliveryProvider>;
  private readonly deploymentTargets: Map<string, DeploymentTargetRegistration>;
  private readonly externalActionTails = new Map<string, Promise<void>>();

  constructor(
    private readonly store: HarborStore,
    providers: DeliveryProvider[] = [],
    deploymentTargets: DeploymentTargetRegistration[] = [],
  ) {
    this.providers = new Map(
      [new ManualDeliveryProvider(), ...providers].map((provider) => [provider.kind, provider]),
    );
    this.deploymentTargets = new Map(deploymentTargets.map((target) => [target.id, target]));
  }

  listDeploymentTargets(): DeploymentTargetDescriptor[] {
    return [...this.deploymentTargets.values()].map(({ id, name, provider }) => ({ id, name, provider }));
  }

  create(
    conv: Conversation,
    input: {
      provider?: DeliveryProviderKind;
      changeUrl?: string | null;
      externalId?: string | null;
      headBranch?: string | null;
      baseBranch?: string | null;
      deploymentRequired?: boolean;
      deploymentTargetId?: string | null;
    },
    now = Date.now(),
  ): Delivery {
    if (conv.kind !== "issue" || conv.status !== "review") {
      throw new Error("Delivery 只能在 Issue 的 Review 阶段创建");
    }
    if (this.store.activeRunForConversation(conv.id)) throw new Error("仍有 Run 进行中，不能创建 Delivery");
    if (this.store.getDeliveryForConversation(conv.id)) throw new Error("当前 Issue 已有 Delivery");
    const providerKind = input.provider ?? "manual";
    const provider = this.configuredProvider(providerKind);
    const deploymentTargetId = clean(input.deploymentTargetId);
    if (deploymentTargetId && input.deploymentRequired === false) {
      throw new Error("选择 deployment target 后 deploymentRequired 必须为 true");
    }
    if (deploymentTargetId) {
      const target = this.configuredTarget(deploymentTargetId);
      if (!conv.repositoryId || target.repositoryId !== conv.repositoryId) {
        throw new Error(`deployment target "${deploymentTargetId}" 不属于当前 Issue Repository`);
      }
    }
    if (providerKind === "manual" && !input.changeUrl?.trim()) {
      throw new Error("manual provider 需要填写 MR/PR URL");
    }
    const changeInput: DeliveryChangeInput = input;
    const prepared: DeliveryChangeInput = provider.prepareChange?.(this.context(conv), changeInput) ?? changeInput;
    const delivery = this.store.createDelivery(
      {
        conversationId: conv.id,
        provider: providerKind,
        changeUrl: clean(prepared.changeUrl),
        externalId: clean(prepared.externalId),
        headBranch: clean(prepared.headBranch),
        baseBranch: clean(prepared.baseBranch),
        checkStatus: prepared.checkStatus,
        deploymentRequired: deploymentTargetId ? true : prepared.deploymentRequired ?? false,
        deploymentTargetId,
      },
      now,
    );
    this.store.appendDeliveryEvent(
      delivery.id,
      "created",
      {
        provider: providerKind,
        deploymentRequired: deploymentTargetId ? true : prepared.deploymentRequired ?? false,
        deploymentTargetId,
        changeUrl: delivery.changeUrl,
      },
      "human",
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
      throw new Error("GitHub Delivery 的 PR、branch 与 CI 事实只能通过 Sync from GitHub 更新");
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

  approve(delivery: Delivery, conv: Conversation, now = Date.now()): Delivery {
    this.assertReviewIdle(conv);
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
      "human",
      now,
    );
    return this.reconcileAutomaticDeployment(current.id, now);
  }

  async sync(
    delivery: Delivery,
    _conv: Conversation,
    now = Date.now(),
  ): Promise<Delivery> {
    return this.runExternalAction(delivery.id, async () => {
      const current = this.requireDelivery(delivery.id);
      const conv = this.requireConversation(current);
      this.assertReviewIdle(conv);
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
        return this.reconcileAutomaticDeployment(current.id, now);
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
      return this.reconcileAutomaticDeployment(current.id, now);
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
  ): Promise<Delivery> {
    return this.runExternalAction(delivery.id, async () => {
      const current = this.requireDelivery(delivery.id);
      const conv = this.requireConversation(current);
      this.assertReviewIdle(conv);
      if (current.mergeStatus === "merged") return this.reconcileAutomaticDeployment(current.id, now);
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
      return this.reconcileAutomaticDeployment(current.id, now);
    });
  }

  async startDeployment(
    delivery: Delivery,
    conv: Conversation,
    input: DeliveryProviderAction,
    now = Date.now(),
  ): Promise<Delivery> {
    this.assertReviewIdle(conv);
    if (delivery.mergeStatus !== "merged") throw new Error("代码尚未合并，不能开始部署");
    if (delivery.deploymentStatus === "not_required") throw new Error("当前 Delivery 配置为无需部署");
    if (delivery.deploymentStatus !== "pending" && delivery.deploymentStatus !== "failed") {
      throw new Error(`当前部署状态为 ${delivery.deploymentStatus}，不能重新开始`);
    }
    if (delivery.deploymentTargetId) {
      return this.reconcileAutomaticDeployment(delivery.id, now);
    }
    if (input.confirmed !== true) throw new Error("manual deployment 需要 confirmed=true 才能记录已开始");
    this.store.updateDeliveryState(delivery.id, { deploymentStatus: "running", deployedAt: null, deploymentError: null }, now);
    this.store.appendDeliveryEvent(
      delivery.id,
      "deployment_started",
      { message: "人工确认外部部署已开始" },
      "human",
      now,
    );
    return this.store.getDelivery(delivery.id)!;
  }

  finishDeployment(delivery: Delivery, status: "succeeded" | "failed", now = Date.now()): Delivery {
    if (delivery.deploymentTargetId) {
      throw new Error("自动 deployment target 的结果只能由独立 host worker 写入，不能由 UI/Issue 自报");
    }
    if (delivery.mergeStatus !== "merged") throw new Error("代码尚未合并，不能记录部署结果");
    if (delivery.deploymentStatus !== "running") throw new Error("只有 running 的部署可以记录结果");
    this.store.updateDeliveryState(
      delivery.id,
      { deploymentStatus: status, deployedAt: status === "succeeded" ? now : null, deploymentError: status === "failed" ? "人工确认外部部署失败" : null },
      now,
    );
    this.store.appendDeliveryEvent(delivery.id, `deployment_${status}`, {}, "human", now);
    return this.store.getDelivery(delivery.id)!;
  }

  isComplete(delivery: Delivery): boolean {
    return delivery.status === "succeeded";
  }

  private provider(delivery: Delivery): DeliveryProvider {
    return this.configuredProvider(delivery.provider);
  }

  /** gates 已满足时幂等 enqueue；Retry 会由 failed 推进新 generation。 */
  reconcileAutomaticDeployment(id: string, now = Date.now()): Delivery {
    const delivery = this.requireDelivery(id);
    if (!delivery.deploymentTargetId) return delivery;
    if (delivery.mergeStatus !== "merged" || delivery.reviewStatus !== "approved" || delivery.checkStatus !== "passed") {
      return delivery;
    }
    this.configuredTarget(delivery.deploymentTargetId);
    if (delivery.deploymentStatus === "queued" || delivery.deploymentStatus === "running" || delivery.deploymentStatus === "succeeded") {
      return delivery;
    }
    if (!delivery.mergedRevision || !/^[a-f0-9]{40,64}$/i.test(delivery.mergedRevision)) {
      const message = "SCM Provider 未提供可信 exact merged revision，自动部署未入队";
      if (delivery.deploymentStatus !== "failed" || delivery.deploymentError !== message) {
        this.store.updateDeliveryState(delivery.id, { deploymentStatus: "failed", deploymentError: message }, now);
        this.store.appendDeliveryEvent(delivery.id, "deployment_enqueue_failed", { reason: "missing_exact_merged_revision" }, "system", now);
      }
      return this.requireDelivery(delivery.id);
    }
    this.store.enqueueDeploymentJob(delivery.id, delivery.deploymentTargetId, delivery.mergedRevision, now);
    return this.requireDelivery(delivery.id);
  }

  private configuredTarget(id: string): DeploymentTargetRegistration {
    const target = this.deploymentTargets.get(id);
    if (!target) {
      throw new Error(`deployment target "${id}" 未配置或已移除；请检查 server/worker 的 env 或 ~/.harbor.yaml`);
    }
    return target;
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

  private assertReviewIdle(conv: Conversation): void {
    if (conv.kind !== "issue" || conv.status !== "review") throw new Error("当前 Issue 不在 Review 阶段");
    if (this.store.activeRunForConversation(conv.id)) throw new Error("仍有 Run 进行中，不能推进 Delivery");
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

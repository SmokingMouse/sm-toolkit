/**
 * Delivery control plane：policy 决定“能不能做”，Provider 只决定“怎么对外执行/确认”。
 * 首期 manual provider 不伪装调用外部平台，所有高风险动作都要求显式 confirmed。
 */

import type {
  Conversation,
  Delivery,
  DeliveryCheckStatus,
  DeliveryProviderKind,
} from "../protocol.js";
import type { HarborStore } from "./store.js";

export interface DeliveryProviderAction {
  confirmed?: boolean;
}

export interface DeliveryProviderResult {
  message: string;
  data?: unknown;
}

export interface DeliveryProviderSnapshot {
  changeUrl?: string | null;
  externalId?: string | null;
  headBranch?: string | null;
  baseBranch?: string | null;
  reviewStatus?: Delivery["reviewStatus"];
  checkStatus?: Delivery["checkStatus"];
  mergeStatus?: Delivery["mergeStatus"];
  providerData?: unknown;
}

export interface DeliveryProvider {
  readonly kind: DeliveryProviderKind;
  readonly mode: "confirmation" | "automatic";
  merge(delivery: Delivery, input: DeliveryProviderAction): Promise<DeliveryProviderResult>;
  startDeployment(delivery: Delivery, input: DeliveryProviderAction): Promise<DeliveryProviderResult>;
  refresh?(delivery: Delivery): Promise<DeliveryProviderSnapshot>;
}

/**
 * 人工 Provider 的按钮语义是“我已在外部系统完成/开始”，不是 Harbor 代替用户执行。
 * 这条边界必须体现在文案和 API confirmed=true 上。
 */
export class ManualDeliveryProvider implements DeliveryProvider {
  readonly kind = "manual" as const;
  readonly mode = "confirmation" as const;

  async merge(_delivery: Delivery, input: DeliveryProviderAction): Promise<DeliveryProviderResult> {
    if (input.confirmed !== true) throw new Error("manual provider 需要 confirmed=true 才能记录已合并事实");
    return { message: "人工确认变更已在外部 SCM 合并" };
  }

  async startDeployment(_delivery: Delivery, input: DeliveryProviderAction): Promise<DeliveryProviderResult> {
    if (input.confirmed !== true) throw new Error("manual provider 需要 confirmed=true 才能记录部署已开始");
    return { message: "人工确认外部部署已开始" };
  }
}

export class DeliveryService {
  private readonly providers: Map<DeliveryProviderKind, DeliveryProvider>;

  constructor(
    private readonly store: HarborStore,
    providers: DeliveryProvider[] = [new ManualDeliveryProvider()],
  ) {
    this.providers = new Map(providers.map((provider) => [provider.kind, provider]));
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
    },
    now = Date.now(),
  ): Delivery {
    if (conv.kind !== "issue" || conv.status !== "review") {
      throw new Error("Delivery 只能在 Issue 的 Review 阶段创建");
    }
    if (this.store.activeRunForConversation(conv.id)) throw new Error("仍有 Run 进行中，不能创建 Delivery");
    if (this.store.getDeliveryForConversation(conv.id)) throw new Error("当前 Issue 已有 Delivery");
    const repository = conv.repositoryId ? this.store.getRepository(conv.repositoryId) : null;
    const provider = input.provider ?? (repository?.scmProvider === "codebase" ? "codebase" : "manual");
    if (!this.providers.has(provider)) throw new Error(`delivery provider "${provider}" 尚未配置`);
    if (provider === "manual" && !input.changeUrl?.trim()) {
      throw new Error("manual provider 需要填写 MR/PR URL");
    }
    if (provider === "codebase") {
      if (repository?.scmProvider !== "codebase" || !repository.scmRepository) {
        throw new Error("Codebase Delivery 需要 Repository 配置 Codebase repository path");
      }
      const externalId = input.externalId?.trim() || /\/merge_requests\/(\d+)/.exec(input.changeUrl ?? "")?.[1];
      if (!externalId || !/^\d+$/.test(externalId)) throw new Error("Codebase Delivery 需要 MR number（externalId）");
      input = { ...input, externalId };
    }
    const delivery = this.store.createDelivery(
      {
        conversationId: conv.id,
        provider,
        changeUrl: clean(input.changeUrl),
        externalId: clean(input.externalId),
        headBranch: clean(input.headBranch),
        baseBranch: clean(input.baseBranch),
        deploymentRequired: input.deploymentRequired ?? false,
      },
      now,
    );
    this.store.appendDeliveryEvent(
      delivery.id,
      "created",
      { provider, deploymentRequired: input.deploymentRequired ?? false, changeUrl: delivery.changeUrl },
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
        { reviewStatus: "pending", reviewApprovedAt: null, checkStatus: input.checkStatus ?? "pending" },
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
    if (!delivery.changeUrl) throw new Error("Delivery 尚未关联 MR/PR，不能验收");
    if (delivery.mergeStatus === "merged") throw new Error("Delivery 已合并，无需重复验收");
    if (delivery.reviewStatus === "approved") return delivery;
    this.store.updateDeliveryState(delivery.id, { reviewStatus: "approved", reviewApprovedAt: now }, now);
    this.store.appendDeliveryEvent(delivery.id, "review_approved", {}, "human", now);
    return this.store.getDelivery(delivery.id)!;
  }

  /** 新一轮实现会让旧审批和 CI 证据失效；merged 后禁止在原 Issue 上继续返工。 */
  prepareImplementation(conv: Conversation, now = Date.now()): Delivery | null {
    const delivery = this.store.getDeliveryForConversation(conv.id);
    if (!delivery) return null;
    if (delivery.mergeStatus === "merged") {
      throw new Error("Delivery 已合并，不能在原 Issue 上继续修改；请创建修复 Issue 或走回滚流程");
    }
    if (delivery.reviewStatus === "pending" && delivery.checkStatus === "pending") return delivery;
    this.store.updateDeliveryState(
      delivery.id,
      { reviewStatus: "pending", reviewApprovedAt: null, checkStatus: "pending" },
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
    conv: Conversation,
    input: DeliveryProviderAction,
    now = Date.now(),
  ): Promise<Delivery> {
    this.assertReviewIdle(conv);
    if (delivery.mergeStatus === "merged") return delivery;
    if (!delivery.changeUrl) throw new Error("Delivery 尚未关联 MR/PR");
    if (delivery.reviewStatus !== "approved") throw new Error("人工验收尚未通过，不能合并");
    if (delivery.checkStatus !== "passed") throw new Error("CI checks 尚未通过，不能合并");
    const result = await this.provider(delivery).merge(delivery, input);
    this.store.updateDeliveryState(delivery.id, { mergeStatus: "merged", mergedAt: now }, now);
    this.store.appendDeliveryEvent(delivery.id, "merged", { message: result.message, data: result.data }, "provider", now);
    return this.store.getDelivery(delivery.id)!;
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
    const result = await this.provider(delivery).startDeployment(delivery, input);
    this.store.updateDeliveryState(delivery.id, { deploymentStatus: "running", deployedAt: null }, now);
    this.store.appendDeliveryEvent(
      delivery.id,
      "deployment_started",
      { message: result.message, data: result.data },
      "provider",
      now,
    );
    return this.store.getDelivery(delivery.id)!;
  }

  async refresh(delivery: Delivery, now = Date.now()): Promise<Delivery> {
    const provider = this.provider(delivery);
    if (!provider.refresh) throw new Error(`delivery provider "${delivery.provider}" 不支持主动刷新`);
    const snapshot = await provider.refresh(delivery);
    return this.applyProviderSnapshot(delivery, snapshot, now);
  }

  applyProviderSnapshot(delivery: Delivery, snapshot: DeliveryProviderSnapshot, now = Date.now()): Delivery {
    const metadata = {
      ...(snapshot.changeUrl !== undefined ? { changeUrl: clean(snapshot.changeUrl) } : {}),
      ...(snapshot.externalId !== undefined ? { externalId: clean(snapshot.externalId) } : {}),
      ...(snapshot.headBranch !== undefined ? { headBranch: clean(snapshot.headBranch) } : {}),
      ...(snapshot.baseBranch !== undefined ? { baseBranch: clean(snapshot.baseBranch) } : {}),
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
    }, now);
    this.store.appendDeliveryEvent(
      delivery.id,
      "provider_refreshed",
      { snapshot, providerData: snapshot.providerData },
      "provider",
      now,
    );
    return this.store.getDelivery(delivery.id)!;
  }

  finishDeployment(delivery: Delivery, status: "succeeded" | "failed", now = Date.now()): Delivery {
    if (delivery.mergeStatus !== "merged") throw new Error("代码尚未合并，不能记录部署结果");
    if (delivery.deploymentStatus !== "running") throw new Error("只有 running 的部署可以记录结果");
    this.store.updateDeliveryState(
      delivery.id,
      { deploymentStatus: status, deployedAt: status === "succeeded" ? now : null },
      now,
    );
    this.store.appendDeliveryEvent(delivery.id, `deployment_${status}`, {}, "human", now);
    return this.store.getDelivery(delivery.id)!;
  }

  isComplete(delivery: Delivery): boolean {
    return delivery.status === "succeeded";
  }

  private provider(delivery: Delivery): DeliveryProvider {
    const provider = this.providers.get(delivery.provider);
    if (!provider) throw new Error(`delivery provider "${delivery.provider}" 尚未配置`);
    return provider;
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

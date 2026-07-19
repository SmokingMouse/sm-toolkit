/**
 * Mew 式 Automation 编排：Automation 是 Run Source，Trigger 是触发配置。
 *
 * - schedule/webhook/event Trigger 可并存，manual 是每条 Automation 都有的即时入口；
 * - output=run 不创建伪 Conversation，source 把可信领域事件派回原 Conversation；
 * - chat/issue/append 保留协作与旧数据兼容；
 * - overlap=skip 拒绝重叠触发，queue 通过 Run concurrencyKey 串行下发；
 * - webhook payload 只是低信任触发上下文，prompt wrapper 会明确标注边界。
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { Cron } from "croner";
import type {
  Automation,
  AutomationTrigger,
  AutomationWebhookFilter,
  Conversation,
  DomainEvent,
  PromptEventBlockKey,
  Run,
} from "../protocol.js";
import type { HarborStore } from "./store.js";
import type { RunCoordinator } from "./scheduler.js";

export interface AutomationWebhookInput {
  secret: string;
  eventType: string;
  eventId: string | null;
  payload: Record<string, unknown>;
}

export interface AutomationEventInput {
  workspaceId: string;
  eventType: string;
  /** 领域事件的稳定幂等键；同一 Trigger 只消费一次。 */
  eventId: string;
  payload: Record<string, unknown>;
  /** 持久领域事实的发生时间；新建 Trigger 不追溯消费更早的历史事件。 */
  createdAt?: number;
}

export type AutomationWebhookResult =
  | { status: "started"; run: Run }
  | { status: "skipped"; reason: string }
  | { status: "ignored"; reason: string }
  | { status: "duplicate"; reason: string };

export type AutomationEventResult =
  | { status: "started"; automationId: string; triggerId: string; run: Run }
  | { status: "skipped" | "duplicate" | "rejected"; automationId: string; triggerId: string; reason: string };

interface ScheduledJob {
  automationId: string;
  cron: Cron;
}

export class AutomationService {
  private jobs = new Map<string, ScheduledJob>();

  constructor(
    private store: HarborStore,
    private coordinator: RunCoordinator,
    private readonly maintenanceActive: () => boolean = () => false,
  ) {}

  /** boot：missed 检查 + 全部 enabled schedule Trigger 排班。 */
  start(): void {
    if (this.maintenanceActive()) return;
    const now = Date.now();
    for (const automation of this.store.listAutomations()) {
      if (!automation.enabled) continue;
      for (const trigger of automation.triggers.filter((candidate) => candidate.enabled && candidate.type === "schedule")) {
        this.recordMissedSchedule(automation, trigger, now);
      }
      this.schedule(automation);
    }
    console.log(`[automation] 已排班 ${this.jobs.size} 个 schedule trigger`);
  }

  stop(): void {
    for (const job of this.jobs.values()) job.cron.stop();
    this.jobs.clear();
  }

  static validateCron(expr: string): void {
    const probe = new Cron(expr);
    probe.stop();
  }

  schedule(automation: Automation): void {
    if (this.maintenanceActive())
      throw new Error("deployment maintenance 期间禁止排班/触发 automation");
    this.unschedule(automation.id);
    if (!automation.enabled) return;
    for (const trigger of automation.triggers) {
      if (!trigger.enabled || trigger.type !== "schedule" || !trigger.cron) continue;
      const cron = new Cron(trigger.cron, { name: trigger.id }, () => this.fire(trigger.id));
      this.jobs.set(trigger.id, { automationId: automation.id, cron });
    }
  }

  unschedule(automationId: string): void {
    for (const [triggerId, job] of this.jobs) {
      if (job.automationId !== automationId) continue;
      job.cron.stop();
      this.jobs.delete(triggerId);
    }
  }

  /** 即使已停用也允许人工单次执行；停用只控制自动 Trigger。 */
  runNow(id: string): Run {
    if (this.maintenanceActive())
      throw new Error("deployment maintenance 期间禁止触发 automation");
    const automation = this.store.getAutomation(id);
    if (!automation) throw new Error(`automation "${id}" 不存在`);
    const run = this.dispatch(automation, null, "event.automation.manual", {
      eventType: "manual",
      triggeredAt: new Date().toISOString(),
    });
    if (!run) throw new Error("automation 已有 queued/running Run，overlap=skip 本次未触发");
    return run;
  }

  receiveWebhook(triggerId: string, input: AutomationWebhookInput): AutomationWebhookResult {
    if (this.maintenanceActive())
      throw new Error("deployment maintenance 期间禁止触发 automation");
    const trigger = this.store.getAutomationTrigger(triggerId);
    if (!trigger || trigger.type !== "webhook") return { status: "ignored", reason: "webhook trigger 不存在" };
    const automation = this.store.getAutomation(trigger.automationId);
    if (!automation || !automation.enabled || !trigger.enabled) {
      return { status: "ignored", reason: "automation 或 trigger 已停用" };
    }
    const expectedHash = this.store.getAutomationTriggerSecretHash(trigger.id);
    if (!expectedHash || !verifyWebhookSecret(input.secret, expectedHash)) {
      throw new Error("webhook secret 不正确");
    }

    const eventType = input.eventType.trim() || "unknown";
    if (trigger.events.length > 0 && !trigger.events.includes(eventType)) {
      this.store.appendAutomationLog({
        automationId: automation.id,
        kind: "rejected",
        triggerId: trigger.id,
        eventId: input.eventId,
        note: `event ${eventType} 不在允许清单`,
      }, Date.now());
      return { status: "ignored", reason: `event ${eventType} 不匹配` };
    }
    if (trigger.filters.length > 0 && !trigger.filters.some((filter) => matchesFilter(input.payload, filter))) {
      this.store.appendAutomationLog({
        automationId: automation.id,
        kind: "rejected",
        triggerId: trigger.id,
        eventId: input.eventId,
        note: `event ${eventType} 未命中 filter`,
      }, Date.now());
      return { status: "ignored", reason: "event filter 不匹配" };
    }
    if (input.eventId && this.store.hasAutomationTriggerDelivery(trigger.id, input.eventId)) {
      return { status: "duplicate", reason: `delivery ${input.eventId} 已处理` };
    }

    const run = this.dispatch(automation, trigger, "event.automation.webhook", {
      eventType,
      eventId: input.eventId,
      provider: trigger.provider ?? "generic",
      triggerId: trigger.id,
      receivedAt: new Date().toISOString(),
      payload: input.payload,
    }, input.eventId);
    if (input.eventId) this.store.recordAutomationTriggerDelivery(trigger.id, input.eventId, Date.now());
    if (!run) return { status: "skipped", reason: "已有 queued/running Run，overlap=skip" };
    return { status: "started", run };
  }

  /**
   * Harbor 内部领域事件入口。事件由 control plane 直接调用，不走公开 webhook，也不接受 secret。
   * 一个事件可命中多条 Automation；每个 Trigger 用 eventId 独立去重。
   */
  receiveEvent(input: AutomationEventInput): AutomationEventResult[] {
    if (this.maintenanceActive()) return [];
    const eventType = input.eventType.trim();
    if (!eventType) throw new Error("Automation eventType 不能为空");
    if (!input.eventId.trim()) throw new Error("Automation eventId 不能为空");
    const results: AutomationEventResult[] = [];
    const createdAt = input.createdAt ?? Date.now();
    for (const automation of this.store.listAutomations(input.workspaceId)) {
      if (!automation.enabled) continue;
      for (const trigger of automation.triggers) {
        if (!trigger.enabled || trigger.type !== "event") continue;
        if (createdAt < trigger.createdAt) continue;
        if (trigger.events.length > 0 && !trigger.events.includes(eventType)) continue;
        if (
          trigger.filters.length > 0 &&
          !trigger.filters.some((filter) => matchesFilter(input.payload, filter))
        ) {
          this.store.appendAutomationLog({
            automationId: automation.id,
            kind: "rejected",
            triggerId: trigger.id,
            eventId: input.eventId,
            note: `internal event ${eventType} 未命中 filter`,
          }, Date.now());
          this.store.recordAutomationTriggerDelivery(trigger.id, input.eventId, Date.now());
          results.push({
            status: "rejected",
            automationId: automation.id,
            triggerId: trigger.id,
            reason: "event filter 不匹配",
          });
          continue;
        }
        if (this.store.hasAutomationTriggerDelivery(trigger.id, input.eventId)) {
          results.push({
            status: "duplicate",
            automationId: automation.id,
            triggerId: trigger.id,
            reason: `event ${input.eventId} 已处理`,
          });
          continue;
        }
        try {
          const run = this.dispatch(automation, trigger, "event.automation.event", {
            eventType,
            eventId: input.eventId,
            provider: "harbor",
            triggerId: trigger.id,
            emittedAt: new Date(createdAt).toISOString(),
            payload: input.payload,
          }, input.eventId);
          if (run) {
            this.store.recordAutomationTriggerDelivery(trigger.id, input.eventId, Date.now());
            results.push({ status: "started", automationId: automation.id, triggerId: trigger.id, run });
          } else {
            // internal event 是持久化事实的投影；skip 不消费幂等键，后续重放仍可补派。
            results.push({
              status: "skipped",
              automationId: automation.id,
              triggerId: trigger.id,
              reason: "已有 queued/running Run，overlap=skip",
            });
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          this.store.appendAutomationLog({
            automationId: automation.id,
            kind: "rejected",
            triggerId: trigger.id,
            eventId: input.eventId,
            note: reason,
          }, Date.now());
          results.push({ status: "rejected", automationId: automation.id, triggerId: trigger.id, reason });
        }
      }
    }
    return results;
  }

  /** 重放仍未被各 Trigger 消费的持久事件；新 Trigger 不追溯早于自身创建时间的事实。 */
  replayEvents(): AutomationEventResult[] {
    if (this.maintenanceActive()) return [];
    const pending = new Map<string, DomainEvent>();
    for (const automation of this.store.listAutomations()) {
      if (!automation.enabled) continue;
      for (const trigger of automation.triggers) {
        if (!trigger.enabled || trigger.type !== "event") continue;
        for (const event of this.store.listUndeliveredDomainEvents(
          trigger.id,
          automation.workspaceId,
          trigger.createdAt,
        )) {
          if (trigger.events.length === 0 || trigger.events.includes(event.type)) pending.set(event.id, event);
        }
      }
    }
    const results: AutomationEventResult[] = [];
    for (const event of [...pending.values()].sort((left, right) =>
      left.createdAt - right.createdAt || left.id.localeCompare(right.id))) {
      results.push(...this.receiveEvent({
        workspaceId: event.workspaceId,
        eventType: event.type,
        eventId: event.id,
        payload: event.payload,
        createdAt: event.createdAt,
      }));
    }
    return results;
  }

  private fire(triggerId: string): void {
    if (this.maintenanceActive()) return;
    const trigger = this.store.getAutomationTrigger(triggerId);
    if (!trigger || trigger.type !== "schedule" || !trigger.enabled) return;
    const automation = this.store.getAutomation(trigger.automationId);
    if (!automation || !automation.enabled) return;
    try {
      this.dispatch(automation, trigger, "event.automation.schedule", {
        eventType: "schedule",
        triggerId: trigger.id,
        scheduledAt: new Date().toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.appendAutomationLog({
        automationId: automation.id,
        kind: "missed",
        triggerId: trigger.id,
        note: message,
      }, Date.now());
      console.warn(`[automation] ${automation.name} 触发失败：${message}`);
    }
  }

  private dispatch(
    automation: Automation,
    trigger: AutomationTrigger | null,
    promptEvent: PromptEventBlockKey,
    triggerContext: Record<string, unknown>,
    eventId: string | null = null,
  ): Run | null {
    if (this.maintenanceActive())
      throw new Error("deployment maintenance 期间禁止 automation 写入");
    const agent = this.store.getAgent(automation.agentId);
    if (!agent || agent.archivedAt) throw new Error("agent 不存在或已归档，未触发");
    if (agent.workspaceId !== automation.workspaceId) {
      throw new Error("agent 与 automation 不在同一 Workspace，未触发");
    }

    const active = this.store.activeRunForTriggerRef(automation.id);
    if (active && automation.overlapMode === "skip") {
      this.store.appendAutomationLog({
        automationId: automation.id,
        kind: "skipped",
        triggerId: trigger?.id ?? null,
        eventId,
        note: `active run ${active.id} (${active.status})`,
      }, Date.now());
      return null;
    }

    let conversation: Conversation | null = null;
    if (automation.outputMode === "append") {
      conversation = automation.targetConversationId
        ? this.store.getConversation(automation.targetConversationId)
        : null;
      if (!conversation) throw new Error(`target conversation ${automation.targetConversationId} 不存在，未触发`);
      if (conversation.repositoryId && conversation.repositoryId !== agent.repositoryId) {
        throw new Error("target conversation 与 Agent 绑定的 Repository 不一致，未触发");
      }
    } else if (automation.outputMode === "source") {
      const payload = triggerContext.payload;
      const conversationId = payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).conversationId
        : null;
      conversation = typeof conversationId === "string" ? this.store.getConversation(conversationId) : null;
      if (!conversation || conversation.workspaceId !== automation.workspaceId) {
        throw new Error("source output 需要同 Workspace 领域事件提供有效 conversationId");
      }
      if (conversation.repositoryId && !agent.repositoryIds.includes(conversation.repositoryId)) {
        throw new Error("source conversation 的 Repository 不在 Agent 可见范围，未触发");
      }
    } else if (automation.outputMode === "chat" || automation.outputMode === "issue") {
      const kind = automation.outputMode;
      conversation = this.store.createConversation({
        workspaceId: automation.workspaceId,
        kind,
        title: `[auto] ${automation.name} ${new Date().toLocaleString("sv-SE")}`,
        description: kind === "issue" ? automation.prompt : null,
        agentId: agent.id,
        repositoryId: agent.repositoryId,
        origin: "automation",
        originRef: automation.id,
      }, Date.now());
    }

    const concurrencyKey = `automation:${automation.id}`;
    const run = conversation
      ? this.coordinator.enqueueRun(
          conversation,
          agent,
          automation.prompt,
          automation.purpose,
          promptEvent,
          automation.id,
          {
            triggerContext,
            concurrencyKey,
            allowQueuedBehindConversation: automation.overlapMode === "queue",
          },
        )
      : this.coordinator.enqueueAutomationRun(
          automation,
          agent,
          automation.prompt,
          automation.purpose,
          promptEvent,
          triggerContext,
        );

    this.store.markAutomationFired(automation.id, Date.now());
    if (trigger) this.store.markAutomationTriggerFired(trigger.id, Date.now());
    const triggerName = promptEvent.replace("event.automation.", "");
    this.store.appendAutomationLog({
      automationId: automation.id,
      kind: "fired",
      runId: run.id,
      triggerId: trigger?.id ?? null,
      eventId,
      note: `${triggerName}:${automation.outputMode}`,
    }, Date.now());
    console.log(`[automation] ${triggerName}：${automation.name} → run ${run.id}（source ${run.sourceType}:${run.sourceId}）`);
    return run;
  }

  private recordMissedSchedule(automation: Automation, trigger: AutomationTrigger, now: number): void {
    if (!trigger.lastFiredAt || !trigger.cron) return;
    try {
      const probe = new Cron(trigger.cron);
      const previous = probe.previousRuns(1)[0];
      probe.stop();
      if (previous && previous.getTime() > trigger.lastFiredAt) {
        this.store.appendAutomationLog({
          automationId: automation.id,
          kind: "missed",
          triggerId: trigger.id,
          note: `server 停机错过 ${previous.toISOString()}（跳过不补跑）`,
        }, now);
      }
    } catch (error) {
      console.warn(`[automation] missed 探测失败（${automation.name}）：`, error instanceof Error ? error.message : error);
    }
  }
}

export function hashWebhookSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function verifyWebhookSecret(secret: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashWebhookSecret(secret), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function matchesFilter(payload: Record<string, unknown>, filter: AutomationWebhookFilter): boolean {
  const segments = filter.path.split(".").filter(Boolean);
  let value: unknown = payload;
  for (const segment of segments) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    value = (value as Record<string, unknown>)[segment];
  }
  return value === filter.equals;
}

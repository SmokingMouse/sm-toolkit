/**
 * Mew Automation runtime.
 *
 * Product model:
 * - one Output: Run / Chat / Issue;
 * - one Trigger: Schedule / Codebase;
 * - Run purpose and overlap behavior are control-plane details, not user configuration.
 */

import { Cron } from "croner";
import type {
  Automation,
  AutomationTrigger,
  CodebaseAutomationEvent,
  Conversation,
  PromptEventBlockKey,
  Run,
} from "../protocol.js";
import type { HarborStore } from "./store.js";
import type { RunCoordinator } from "./scheduler.js";

export interface AutomationCodebaseInput {
  workspaceId: string;
  repositoryId: string;
  eventType: CodebaseAutomationEvent;
  eventId: string;
  payload: Record<string, unknown>;
  revision?: string | null;
  occurredAt?: number;
}

export type AutomationCodebaseResult =
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

  start(): void {
    if (this.maintenanceActive()) return;
    const now = Date.now();
    for (const automation of this.store.listAutomations()) {
      if (!automation.enabled) continue;
      if (automation.trigger.type === "schedule") {
        this.recordMissedSchedule(automation, automation.trigger, now);
      }
      this.schedule(automation);
    }
    console.log(`[automation] 已排班 ${this.jobs.size} 个 schedule trigger`);
  }

  stop(): void {
    for (const job of this.jobs.values()) job.cron.stop();
    this.jobs.clear();
  }

  static validateCron(expr: string, timezone?: string): void {
    if (timezone) this.validateTimezone(timezone);
    const probe = new Cron(expr, timezone ? { timezone } : undefined);
    probe.stop();
  }

  static validateTimezone(timezone: string): void {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    } catch {
      throw new Error(`timezone "${timezone}" 不是有效 IANA timezone`);
    }
  }

  schedule(automation: Automation): void {
    if (this.maintenanceActive()) {
      throw new Error("deployment maintenance 期间禁止排班/触发 automation");
    }
    this.unschedule(automation.id);
    const trigger = automation.trigger;
    if (!automation.enabled || trigger.type !== "schedule" || !trigger.cron || !trigger.timezone) return;
    const cron = new Cron(
      trigger.cron,
      { name: trigger.id, timezone: trigger.timezone },
      () => this.fire(trigger.id),
    );
    this.jobs.set(trigger.id, { automationId: automation.id, cron });
  }

  unschedule(automationId: string): void {
    for (const [triggerId, job] of this.jobs) {
      if (job.automationId !== automationId) continue;
      job.cron.stop();
      this.jobs.delete(triggerId);
    }
  }

  /** Disabled only suppresses automatic triggers; users may still run once manually. */
  runNow(id: string): Run {
    if (this.maintenanceActive()) {
      throw new Error("deployment maintenance 期间禁止触发 automation");
    }
    const automation = this.store.getAutomation(id);
    if (!automation) throw new Error(`automation "${id}" 不存在`);
    const run = this.dispatch(automation, "event.automation.manual", {
      eventType: "manual",
      triggerId: automation.trigger.id,
      triggeredAt: new Date().toISOString(),
    });
    if (!run) throw new Error("automation 已有 queued/running Run，本次未触发");
    return run;
  }

  receiveCodebase(input: AutomationCodebaseInput): AutomationCodebaseResult[] {
    if (this.maintenanceActive()) return [];
    const results: AutomationCodebaseResult[] = [];
    for (const automation of this.store.listAutomations(input.workspaceId)) {
      const trigger = automation.trigger;
      if (
        !automation.enabled ||
        trigger.type !== "codebase" ||
        trigger.repositoryId !== input.repositoryId ||
        trigger.codebaseEvent !== input.eventType
      ) continue;
      if (this.store.hasAutomationTriggerDelivery(trigger.id, input.eventId)) {
        results.push({
          status: "duplicate",
          automationId: automation.id,
          triggerId: trigger.id,
          reason: `Codebase event ${input.eventId} 已处理`,
        });
        continue;
      }
      try {
        const run = this.dispatch(automation, "event.automation.webhook", {
          eventType: input.eventType,
          eventId: input.eventId,
          triggerId: trigger.id,
          repositoryId: input.repositoryId,
          revision: input.revision,
          occurredAt: new Date(input.occurredAt ?? Date.now()).toISOString(),
          payload: input.payload,
        }, input.eventId);
        this.store.recordAutomationTriggerDelivery(trigger.id, input.eventId, Date.now());
        results.push(run
          ? { status: "started", automationId: automation.id, triggerId: trigger.id, run }
          : {
              status: "skipped",
              automationId: automation.id,
              triggerId: trigger.id,
              reason: "已有 queued/running Run",
            });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.store.recordAutomationTriggerDelivery(trigger.id, input.eventId, Date.now());
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
    return results;
  }

  private fire(triggerId: string): void {
    if (this.maintenanceActive()) return;
    const trigger = this.store.getAutomationTrigger(triggerId);
    if (!trigger || trigger.type !== "schedule") return;
    const automation = this.store.getAutomation(trigger.automationId);
    if (!automation || !automation.enabled) return;
    try {
      this.dispatch(automation, "event.automation.schedule", {
        eventType: "schedule",
        triggerId: trigger.id,
        timezone: trigger.timezone,
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
    promptEvent: PromptEventBlockKey,
    triggerContext: Record<string, unknown>,
    eventId: string | null = null,
  ): Run | null {
    if (this.maintenanceActive()) {
      throw new Error("deployment maintenance 期间禁止 automation 写入");
    }
    const agent = this.store.getAgent(automation.agentId);
    if (!agent || agent.archivedAt) throw new Error("agent 不存在或已归档，未触发");
    if (agent.workspaceId !== automation.workspaceId) {
      throw new Error("agent 与 automation 不在同一 Workspace，未触发");
    }

    const repositoryId = automation.trigger.type === "codebase"
      ? automation.trigger.repositoryId
      : agent.repositoryId;
    if (!repositoryId || !agent.repositoryIds.includes(repositoryId)) {
      throw new Error("Automation Trigger 的 Repository 不在 Agent 可见范围");
    }
    const repository = this.store.getRepository(repositoryId);
    if (!repository || repository.archivedAt) throw new Error("Automation Repository 不存在或已归档");
    if (!this.store.getRepositoryMountForDevice(repositoryId, agent.deviceId)) {
      throw new Error(`Repository "${repository.name}" 没有挂载到 Agent 设备`);
    }

    const active = this.store.activeRunForTriggerRef(automation.id);
    if (active) {
      this.store.appendAutomationLog({
        automationId: automation.id,
        kind: "skipped",
        triggerId: automation.trigger.id,
        eventId,
        note: `active run ${active.id} (${active.status})`,
      }, Date.now());
      return null;
    }

    let conversation: Conversation | null = null;
    if (automation.output === "chat" || automation.output === "issue") {
      conversation = this.store.createConversation({
        workspaceId: automation.workspaceId,
        kind: automation.output,
        title: `[auto] ${automation.name} ${new Date().toLocaleString("sv-SE")}`,
        description: automation.output === "issue" ? automation.prompt : null,
        agentId: agent.id,
        repositoryId,
        origin: "automation",
        originRef: automation.id,
      }, Date.now());
    }

    const purpose = automation.output === "issue" ? "implementation" : "coordination";
    const run = conversation
      ? this.coordinator.enqueueRun(
          conversation,
          agent,
          automation.prompt,
          purpose,
          promptEvent,
          automation.id,
          {
            triggerContext,
            concurrencyKey: `automation:${automation.id}`,
          },
        )
      : this.coordinator.enqueueAutomationRun(
          automation,
          agent,
          repositoryId,
          automation.prompt,
          purpose,
          promptEvent,
          triggerContext,
        );

    const now = Date.now();
    this.store.markAutomationFired(automation.id, now);
    this.store.markAutomationTriggerFired(automation.trigger.id, now);
    const triggerName = promptEvent === "event.automation.webhook"
      ? "codebase"
      : promptEvent.replace("event.automation.", "");
    this.store.appendAutomationLog({
      automationId: automation.id,
      kind: "fired",
      runId: run.id,
      triggerId: automation.trigger.id,
      eventId,
      note: `${triggerName}:${automation.output}`,
    }, now);
    console.log(`[automation] ${triggerName}：${automation.name} → run ${run.id}`);
    return run;
  }

  private recordMissedSchedule(automation: Automation, trigger: AutomationTrigger, now: number): void {
    if (!trigger.lastFiredAt || !trigger.cron || !trigger.timezone) return;
    try {
      const probe = new Cron(trigger.cron, { timezone: trigger.timezone });
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

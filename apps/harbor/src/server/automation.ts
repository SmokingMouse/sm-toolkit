/**
 * AutomationService —— cron 定时派活（P3，croner）。
 * 语义：server 停机期间错过的触发跳过不补跑，boot 时对比 previousRun 与 last_fired_at
 * 记 missed 日志；触发时按 mode 开新 issue（origin=automation）或追加到固定 conversation。
 * 时区：跟 server 本机时区（croner 默认）。
 */

import { Cron } from "croner";
import type { Automation, Conversation, PromptEventBlockKey, Run } from "../protocol.js";
import type { HarborStore } from "./store.js";
import type { RunCoordinator } from "./scheduler.js";

export class AutomationService {
  private jobs = new Map<string, Cron>();

  constructor(
    private store: HarborStore,
    private coordinator: RunCoordinator,
    private readonly maintenanceActive: () => boolean = () => false,
  ) {}

  /** boot：missed 检查 + 全部 enabled 排班 */
  start(): void {
    if (this.maintenanceActive()) return;
    const now = Date.now();
    for (const auto of this.store.listAutomations()) {
      if (!auto.enabled) continue;
      // missed 检查：上一个应触发时刻晚于 last_fired_at → server 停机漏掉了。
      // 注意 croner 的 previousRun() 是「本实例的运行历史」（新实例恒 null），
      // 模式回溯要用 previousRuns(1)，且它是 croner v10 才有的 API——2026-07-15 实测踩过。
      if (auto.lastFiredAt) {
        try {
          const probe = new Cron(auto.cron);
          const prev = probe.previousRuns(1)[0];
          probe.stop();
          if (prev && prev.getTime() > auto.lastFiredAt) {
            this.store.appendAutomationLog(
              { automationId: auto.id, kind: "missed", note: `server 停机错过 ${prev.toISOString()}（跳过不补跑）` },
              now,
            );
            console.log(`[automation] missed：${auto.name} @ ${prev.toISOString()}`);
          }
        } catch (e) {
          // cron 表达式坏了会在 schedule 时报；这里只可能是 previousRuns 探测本身出错
          console.warn(`[automation] missed 探测失败（${auto.name}）：`, e instanceof Error ? e.message : e);
        }
      }
      this.schedule(auto);
    }
    console.log(`[automation] 已排班 ${this.jobs.size} 条`);
  }

  stop(): void {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
  }

  /** cron 表达式校验（REST create 前置闸）——非法直接 throw */
  static validateCron(expr: string): void {
    const probe = new Cron(expr);
    probe.stop();
  }

  schedule(auto: Automation): void {
    if (this.maintenanceActive()) throw new Error("deployment maintenance 期间禁止排班/触发 automation");
    this.unschedule(auto.id);
    const job = new Cron(auto.cron, { name: auto.id }, () => this.fire(auto.id));
    this.jobs.set(auto.id, job);
  }

  unschedule(id: string): void {
    this.jobs.get(id)?.stop();
    this.jobs.delete(id);
  }

  /** 即使规则已停用也允许人工单次执行；停用只控制 cron 排班。 */
  runNow(id: string): Run {
    if (this.maintenanceActive()) throw new Error("deployment maintenance 期间禁止触发 automation");
    const auto = this.store.getAutomation(id);
    if (!auto) throw new Error(`automation "${id}" 不存在`);
    return this.dispatch(auto, "event.automation.manual");
  }

  private fire(id: string): void {
    const now = Date.now();
    if (this.maintenanceActive()) return;
    const auto = this.store.getAutomation(id);
    if (!auto || !auto.enabled) return; // 已删/已停用（stop 竞态兜底）

    try {
      this.dispatch(auto, "event.automation.schedule", now);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.appendAutomationLog({ automationId: id, kind: "missed", note: message }, now);
      console.warn(`[automation] ${auto.name} 触发失败：${message}`);
    }
  }

  private dispatch(auto: Automation, promptEvent: PromptEventBlockKey, now = Date.now()): Run {
    if (this.maintenanceActive()) throw new Error("deployment maintenance 期间禁止 automation 写入");
    const agent = this.store.getAgent(auto.agentId);
    if (!agent || agent.archivedAt) {
      throw new Error("agent 不存在或已归档，未触发");
    }
    if (agent.workspaceId !== auto.workspaceId) {
      throw new Error("agent 与 automation 不在同一 Workspace，未触发");
    }

    let conv: Conversation;
    if (auto.mode === "append") {
      const target = auto.targetConversationId ? this.store.getConversation(auto.targetConversationId) : null;
      if (!target) {
        throw new Error(`target conversation ${auto.targetConversationId} 不存在，未触发`);
      }
      if (target.repositoryId && target.repositoryId !== agent.repositoryId) {
        throw new Error("target conversation 与 Agent 绑定的 Repository 不一致，未触发");
      }
      conv = target;
    } else {
      conv = this.store.createConversation(
        {
          workspaceId: auto.workspaceId,
          kind: "issue",
          title: `[auto] ${auto.name} ${new Date(now).toLocaleString("sv-SE")}`,
          description: auto.prompt,
          agentId: agent.id,
          repositoryId: agent.repositoryId,
          origin: "automation",
          originRef: auto.id,
        },
        now,
      );
    }

    const run = this.coordinator.enqueueRun(conv, agent, auto.prompt, "implementation", promptEvent, auto.id);
    this.store.markAutomationFired(auto.id, now);
    const trigger = promptEvent === "event.automation.manual" ? "manual" : "schedule";
    this.store.appendAutomationLog({ automationId: auto.id, kind: "fired", runId: run.id, note: trigger }, now);
    console.log(`[automation] ${trigger}：${auto.name} → run ${run.id}（conv ${conv.id}）`);
    return run;
  }
}

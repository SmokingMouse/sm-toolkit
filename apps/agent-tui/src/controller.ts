import type { AgentClient } from "@smokingmouse/agent-server/client";
import type { RequestCard, TuiModel } from "./model.js";
import { controlError, controlSuccess, effortBudgets, efforts, estimatedContextWindow, nativePermission, nextEffort, nextPermission, permissionModes, type Effort, type Permission } from "./modes.js";

export interface Key { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string }
export class Controller {
  private interruptedAt = -Infinity;
  private submitting = false;
  private controlling = false;
  private submission?: { text: string; threadId: string; turnId?: string; id: string };
  constructor(readonly client: AgentClient, readonly model: TuiModel, readonly exit: () => void, readonly now: () => number = Date.now) {}
  async key(text: string | undefined, key: Key = {}): Promise<void> {
    try {
      if (key.ctrl && key.name === "c") {
        if (this.now() - this.interruptedAt < 1500) { this.exit(); return; }
        this.interruptedAt = this.now(); this.model.message = "已请求中断；1.5 秒内再按 Ctrl-C 退出";
        this.model.changed();
        if (this.model.thread && this.client.state === "connected") await this.client.request("turn/interrupt", { threadId: this.model.thread.id });
        return;
      }
      this.interruptedAt = -Infinity;
      if (key.name === "pageup" || key.name === "pagedown") { this.model.scroll = Math.max(0, this.model.scroll + (key.name === "pageup" ? (this.model.activeCard ? -10 : 10) : (this.model.activeCard ? 10 : -10))); return; }
      if (this.model.activeCard) { await this.cardKey(this.model.activeCard, text, key); return; }
      if (this.model.permissionPicker !== undefined) { await this.permissionKey(text, key); return; }
      if (key.ctrl && key.name === "r") { this.model.expandedReasoning = !this.model.expandedReasoning; return; }
      if (key.ctrl && key.name === "p") { this.model.expandedPlan = !this.model.expandedPlan; return; }
      if (key.name === "tab") {
        await this.control(async () => key.shift || key.sequence === "\x1b[Z"
          ? this.setPermission(nextPermission(this.model.thread?.permission, this.model.bypassAvailable))
          : this.setEffort(nextEffort(this.model.effort)));
        return;
      }
      if (key.name === "return" || key.name === "enter") { await this.submit(); return; }
      if (key.name === "backspace") this.model.input = Array.from(this.model.input).slice(0, -1).join("");
      else if (key.ctrl && key.name === "u") this.model.input = "";
      else if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) this.model.input += text;
    } catch (error) { this.model.message = controlError(error); }
    finally { this.model.changed(); }
  }
  async submit(): Promise<void> {
    const text = this.model.input.trim(), thread = this.model.thread;
    if (!text || !thread || this.submitting) return;
    if (this.client.state !== "connected") throw new Error("连接尚未恢复，输入已保留");
    if (thread.backend === "external") throw new Error("External thread 为只读");
    this.submitting = true;
    try {
      if (await this.command(text)) {
        if (this.model.input.trim() === text) this.model.input = "";
        return;
      }
      const steer = text.startsWith("/steer ");
      const input = [{ type: "text" as const, text: steer ? text.slice(7).trim() : text }];
      if (!input[0].text) return;
      const turnId = steer ? this.model.activeTurnId : undefined;
      if (!this.submission || this.submission.text !== text || this.submission.threadId !== thread.id || this.submission.turnId !== turnId) {
        this.submission = { text, threadId: thread.id, turnId, id: crypto.randomUUID() };
      }
      const clientTurnId = this.submission.id;
      if (steer) {
        if (!this.model.activeTurnId) throw new Error("当前 turn id 未知；请用普通输入排队");
        await this.client.request("turn/steer", { threadId: thread.id, expectedTurnId: this.model.activeTurnId, input, clientTurnId });
        this.model.message = "已插话";
      } else {
        const { turn } = await this.client.request("turn/start", { threadId: thread.id, input, clientTurnId });
        const queued = this.model.queue.find(q => q.turnId === turn.id);
        this.model.message = queued ? `已排队 #${queued.position + 1}` : turn.status === "queued" ? "已入队，等待队列位置" : "已发送";
      }
      // Do not erase text typed while the request was in flight.
      if (this.model.input.trim() === text) this.model.input = "";
      this.submission = undefined;
      this.model.scroll = 0;
    } finally { this.submitting = false; this.model.changed(); }
  }
  private async control(action: () => Promise<void>): Promise<void> {
    if (this.controlling) throw new Error("控制请求处理中，请稍后重试");
    if (this.client.state !== "connected") throw new Error("连接尚未恢复，输入已保留");
    if (!this.model.thread) throw new Error("尚未连接 thread");
    this.controlling = true;
    try { await action(); } catch (error) { throw new Error(controlError(error, true)); } finally { this.controlling = false; }
  }
  private async acquire(ttlMs: number): Promise<void> {
    const { lease } = await this.client.request("thread/lease/acquire", { threadId: this.model.thread!.id, ttlMs });
    this.model.leaseExpiresAt = lease.expiresAtMs;
  }
  private async withEscalationLease(action: () => Promise<void>): Promise<void> {
    if (this.model.leaseExpiresAt > this.now()) { await action(); return; }
    await this.acquire(5000);
    try { await action(); }
    finally {
      try { await this.client.request("thread/lease/release", { threadId: this.model.thread!.id }); }
      finally { this.model.leaseExpiresAt = 0; }
    }
  }
  private async setPermission(permission: Permission): Promise<void> {
    if (this.model.thread?.permission === "readonly") {
      this.model.message = "readonly 为启动限制，当前线程保持 readonly；更改需新建线程";
      return;
    }
    const change = async () => {
      const { thread } = await this.client.request("thread/permission/set", { threadId: this.model.thread!.id, permission });
      this.model.thread = thread;
      this.model.message = `权限模式：${nativePermission(thread.permission)}`;
    };
    if (["full", "bypassPermissions", "dontAsk"].includes(permission)) await this.withEscalationLease(change);
    else await change();
  }
  private async setEffort(effort: Effort): Promise<void> {
    controlSuccess(await this.client.request("thread/effort/set", { threadId: this.model.thread!.id, maxThinkingTokens: effortBudgets[effort] }));
    this.model.effort = effort;
    this.model.message = `effort ${effort} · thinking budget ${effortBudgets[effort]}`;
  }
  private get permissionChoices(): Permission[] { return this.model.permissionChoices; }
  private async permissionKey(text: string | undefined, key: Key): Promise<void> {
    const choices = this.permissionChoices;
    if (key.name === "escape") { this.model.permissionPicker = undefined; return; }
    if (key.name === "up" || key.name === "down") { this.model.permissionPicker = (this.model.permissionPicker! + (key.name === "up" ? choices.length - 1 : 1)) % choices.length; return; }
    if (text && /^[1-5]$/.test(text) && Number(text) <= choices.length) this.model.permissionPicker = Number(text) - 1;
    if (key.name === "return" || key.name === "enter") {
      await this.control(() => this.setPermission(choices[this.model.permissionPicker!]));
      this.model.permissionPicker = undefined;
    }
  }
  private async command(text: string): Promise<boolean> {
    const [command, ...args] = text.split(/\s+/), value = args.join(" ");
    if (command === "/permissions") {
      if (value) throw new Error("用法：/permissions");
      this.model.permissionPicker = Math.max(0, this.permissionChoices.indexOf(nativePermission(this.model.thread?.permission)));
      return true;
    }
    if (command === "/context") {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) throw new Error("用法：/context <窗口 token 数>，当前默认窗口为估算值");
      this.model.contextWindow = Number(value); this.model.contextWindowEstimated = false; return true;
    }
    if (!["/effort", "/model", "/compact", "/takeover", "/release"].includes(command)) return false;
    if (command === "/effort" && !efforts.includes(value as Effort)) throw new Error("用法：/effort <low|medium|high|max>");
    if (command === "/model" && (!value || args.length !== 1)) throw new Error("用法：/model <name>");
    if ((command === "/takeover" || command === "/release") && value) throw new Error(`用法：${command}`);
    await this.control(async () => {
      const threadId = this.model.thread!.id;
      if (command === "/effort") { await this.setEffort(value as Effort); return; }
      if (command === "/release") { await this.client.request("thread/lease/release", { threadId }); this.model.leaseExpiresAt = 0; this.model.message = "已释放控制权"; return; }
      if (command === "/takeover") { await this.acquire(30_000); this.model.message = "已接管控制权（独占输入 30 秒）；请重试原操作 · /release 释放"; return; }
      if (command === "/model") {
        controlSuccess(await this.client.request("thread/engineControl", { threadId, subtype: "set_model", params: { model: value } }));
        this.model.liveModel = value; this.model.message = `模型：${value}`;
        if (this.model.contextWindowEstimated) this.model.contextWindow = estimatedContextWindow(value);
      } else {
        if (!this.submission || this.submission.text !== text || this.submission.threadId !== threadId) this.submission = { text, threadId, id: crypto.randomUUID() };
        await this.client.request("thread/compact", { threadId, clientTurnId: this.submission.id, ...(value ? { instructions: value } : {}) });
        this.submission = undefined; this.model.message = "已请求压缩，等待 compact_boundary";
      }
    });
    return true;
  }
  private async cardKey(card: RequestCard, text: string | undefined, key: Key): Promise<void> {
    if (card.state !== "pending") return;
    const handle = this.client.pendingRequests.get(card.request.params.requestId);
    if (!handle || this.client.state !== "connected") throw new Error("请求连接已失效，等待重连快照");
    if (handle.method === "item/tool/requestUserInput") {
      const question = handle.params.questions[card.question];
      if (key.name === "escape") { handle.respond({ answers: {} }); card.state = "sending"; return; }
      const choose = (number: number) => {
        const option = question?.options?.[number - 1]; if (!option || !question) return;
        const selected = card.answers[question.id]?.answers ?? [];
        card.answers[question.id] = { answers: question.multiSelect ? (selected.includes(option.label) ? selected.filter(s => s !== option.label) : [...selected, option.label]) : [option.label] };
      };
      if ((question?.options?.length ?? 0) <= 9 && text && /^[1-9]$/.test(text) && !card.draft) { choose(Number(text)); return; }
      if (text === " " && /^\d+$/.test(card.draft) && question?.options?.length) { choose(Number(card.draft)); card.draft = ""; return; }
      if (key.name === "return" || key.name === "enter") {
        if (question) {
          if (card.draft.trim()) card.answers[question.id] = { answers: [card.draft.trim()] };
          if (!card.answers[question.id]?.answers.length) throw new Error("请选择选项或输入回答");
        }
        card.draft = "";
        if (card.question + 1 < handle.params.questions.length) { card.question++; this.model.scroll = 0; return; }
        handle.respond({ answers: card.answers }); card.state = "sending"; return;
      }
      if (key.name === "backspace") card.draft = Array.from(card.draft).slice(0, -1).join("");
      else if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) card.draft += text;
      return;
    }
    const choices = { y: "accept", s: "acceptForSession", n: "reject", a: "abort" } as const;
    const decision = key.name === "escape" ? "reject" : choices[text?.toLowerCase() as keyof typeof choices];
    if (!decision) return;
    if (handle.method === "item/permissions/requestApproval") {
      if (handle.params.permissions.toolName === "ExitPlanMode" && (decision === "accept" || decision === "acceptForSession")) {
        await this.control(async () => {
          if (card.state !== "pending" || !this.client.pendingRequests.has(handle.params.requestId)) throw new Error("审批已失效或由另一客户端处理");
          // Only the winning, server-confirmed approval may change the mode.
          await new Promise<void>((resolve, reject) => {
            const disposers: Array<() => void> = [];
            const finish = (error?: Error) => { clearTimeout(timer); disposers.forEach(fn => fn()); error ? reject(error) : resolve(); };
            const timer = setTimeout(() => finish(new Error("退出计划审批未确认；请等待状态通知或重连")), 10_000);
            disposers.push(this.client.onNotification("serverRequest/resolved", p => {
              if (p.requestId === handle.params.requestId) finish(p.decidedBy.clientId === this.client.clientId ? undefined : new Error("审批已由另一客户端处理"));
            }), this.client.onNotification("serverRequest/expired", p => {
              if (p.requestId === handle.params.requestId) finish(new Error(`审批已过期：${p.reason}`));
            }), this.client.onStateChange(state => { if (state !== "connected") finish(new Error("审批连接中断；等待重连快照")); }), this.client.onError((error, id) => { if (id === handle.id) finish(error); }));
            card.state = "sending";
            try { handle.respond({ permissions: handle.params.permissions, scope: "turn" }); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
          });
          await this.setPermission("default");
        });
        return;
      }
      handle.respond({ permissions: decision === "accept" || decision === "acceptForSession" ? handle.params.permissions : {}, scope: decision === "acceptForSession" ? "session" : "turn" });
      // Permissions replies have no abort variant in AS v1; deny, then interrupt the turn.
      if (decision === "abort") await this.client.request("turn/interrupt", { threadId: handle.params.threadId, turnId: handle.params.turnId });
    } else handle.respond({ decision });
    if (card.state === "pending") card.state = "sending";
  }
}

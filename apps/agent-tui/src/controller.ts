import type { AgentClient } from "@smokingmouse/agent-server/client";
import type { RequestCard, TuiModel } from "./model.js";
import { InputLease } from "./lease.js";

export interface Key { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string }
export class Controller {
  private interruptedAt = -Infinity;
  private submitting = false;
  readonly lease: InputLease;
  private submission?: { text: string; threadId: string; turnId?: string; id: string };
  constructor(readonly client: AgentClient, readonly model: TuiModel, readonly exit: () => void, readonly now: () => number = Date.now) { this.lease = new InputLease(client, model); }
  dispose(): void { this.lease.dispose(); }
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
      if (key.ctrl && key.name === "l") { this.toggleLog(); return; }
      if (key.name === "f6") {
        const focus = ["history", ...(this.model.logExpanded ? ["log"] : []), ...(this.model.tasksVisible ? ["tasks"] : [])] as const;
        this.model.panelFocus = focus[(focus.indexOf(this.model.panelFocus) + 1) % focus.length] as typeof this.model.panelFocus; return;
      }
      if (!this.model.activeCard && (key.name === "pageup" || key.name === "pagedown") && this.model.panelFocus !== "history") {
        const field = this.model.panelFocus === "log" ? "logScroll" : "taskScroll";
        this.model[field] = Math.max(0, this.model[field] + (key.name === "pageup" ? 5 : -5)); return;
      }
      if (key.name === "pageup" || key.name === "pagedown") { this.model.scroll = Math.max(0, this.model.scroll + (key.name === "pageup" ? (this.model.activeCard ? -10 : 10) : (this.model.activeCard ? 10 : -10))); return; }
      if (key.name === "tab") { this.model.expandedReasoning = !this.model.expandedReasoning; return; }
      if (this.model.activeCard) { await this.cardKey(this.model.activeCard, text, key); return; }
      if (key.name === "return" || key.name === "enter") { await this.submit(); return; }
      if (key.name === "backspace") this.model.input = Array.from(this.model.input).slice(0, -1).join("");
      else if (key.ctrl && key.name === "u") this.model.input = "";
      else if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) this.model.input += text;
    } catch (error) { this.model.recordError(error); }
    finally { this.model.changed(); }
  }
  async submit(): Promise<void> {
    const text = this.model.input.trim(), thread = this.model.thread;
    if (text === "/log") { this.toggleLog(); this.model.input = ""; this.model.changed(); return; }
    if (text === "/tasks") { this.model.tasksVisible = !this.model.tasksVisible; this.model.panelFocus = this.model.tasksVisible ? "tasks" : "history"; this.model.input = ""; this.model.changed(); return; }
    if (text === "/agents" || text.startsWith("/agents ")) {
      const id = text.slice(7).trim(), agents = [...this.model.items.values()].filter(i => i.type === "subAgent" && (!id || i.id === id || i.payload.parentItemId === id));
      const collapse = agents.some(i => !this.model.collapsedAgents.has(i.id));
      for (const i of agents) { if (collapse) this.model.collapsedAgents.add(i.id); else this.model.collapsedAgents.delete(i.id); }
      this.model.input = ""; this.model.changed(); return;
    }
    if (!text || !thread || this.submitting) return;
    if (this.client.state !== "connected") throw new Error("连接尚未恢复，输入已保留");
    if (thread.backend === "external") throw new Error("External thread 为只读");
    this.submitting = true;
    try {
      if (text === "/takeover") {
        await this.lease.takeover(thread.id);
        this.model.message = "已取得控制权；/release 释放"; this.model.input = ""; return;
      }
      if (text === "/release") { await this.lease.relinquish(thread.id); this.model.message = "已请求释放控制权"; this.model.input = ""; return; }
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
        await this.withLease(thread.id, () => this.client.request("turn/steer", { threadId: thread.id, expectedTurnId: turnId!, input, clientTurnId }));
        this.model.message = "已插话";
      } else {
        const { turn } = await this.withLease(thread.id, () => this.client.request("turn/start", { threadId: thread.id, input, clientTurnId }));
        const queued = this.model.queue.find(q => q.turnId === turn.id);
        this.model.message = queued ? `已排队 #${queued.position + 1}` : turn.status === "queued" ? "已入队，等待队列位置" : "已发送";
      }
      // Do not erase text typed while the request was in flight.
      if (this.model.input.trim() === text) this.model.input = "";
      this.submission = undefined;
      this.model.scroll = 0;
    } finally { this.submitting = false; this.model.changed(); }
  }
  private toggleLog(): void { this.model.logExpanded = !this.model.logExpanded; this.model.panelFocus = this.model.logExpanded ? "log" : "history"; }
  private async withLease<T>(threadId: string, action: () => Promise<T> | T): Promise<T> {
    return this.lease.run(threadId, action);
  }
  private reply(card: RequestCard, send: () => void): Promise<void> {
    return this.withLease(card.request.params.threadId, () => new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timer); unsubscribe(); error ? reject(error) : resolve(); };
      const check = () => {
        if (card.state === "resolved" || card.state === "expired") finish();
        else if (card.state === "pending" || card.state === "offline") finish(new Error(this.model.message || "审批回复尚未确认"));
      };
      const unsubscribe = this.model.onChange(check);
      const timer = setTimeout(() => { card.state = "pending"; finish(new Error("审批回复超时，等待服务器确认或重试")); }, 30_000);
      timer.unref(); card.state = "sending";
      try { send(); this.model.changed(); } catch (error) { card.state = "pending"; finish(error instanceof Error ? error : new Error(String(error))); }
    }));
  }
  private async cardKey(card: RequestCard, text: string | undefined, key: Key): Promise<void> {
    if (card.state !== "pending") return;
    const handle = this.client.pendingRequests.get(card.request.params.requestId);
    if (!handle || this.client.state !== "connected") throw new Error("请求连接已失效，等待重连快照");
    if (handle.method === "item/tool/requestUserInput") {
      const question = handle.params.questions[card.question];
      if (key.name === "escape") { await this.reply(card, () => handle.respond({ answers: {} })); return; }
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
        await this.reply(card, () => handle.respond({ answers: card.answers })); return;
      }
      if (key.name === "backspace") card.draft = Array.from(card.draft).slice(0, -1).join("");
      else if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) card.draft += text;
      return;
    }
    const choices = { y: "accept", s: "acceptForSession", n: "reject", a: "abort" } as const;
    const decision = key.name === "escape" ? "reject" : choices[text?.toLowerCase() as keyof typeof choices];
    if (!decision) return;
    let replied = false;
    try {
      await this.reply(card, () => {
        if (handle.method === "item/permissions/requestApproval") handle.respond({ permissions: decision === "accept" || decision === "acceptForSession" ? handle.params.permissions : {}, scope: decision === "acceptForSession" ? "session" : "turn" });
        else handle.respond({ decision });
      });
      replied = true;
    } finally {
      // Even a denied approval lease must never disable the emergency stop.
      if (decision === "abort" && (!replied || handle.method === "item/permissions/requestApproval")) await this.client.request("turn/interrupt", { threadId: handle.params.threadId, turnId: handle.params.turnId });
    }
  }
}

import type { AgentClient } from "@smokingmouse/agent-server/client";
import type { RequestCard, TuiModel } from "./model.js";
import { imageInput, messageInput, pasteImage, unquote } from "./attachments.js";

export interface Key { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string }
export class Controller {
  private interruptedAt = -Infinity;
  private submitting = false;
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
      if (key.name === "tab") { this.model.expandedReasoning = !this.model.expandedReasoning; return; }
      if (this.model.activeCard) { await this.cardKey(this.model.activeCard, text, key); return; }
      if (key.name === "return" || key.name === "enter") { await this.submit(); return; }
      if (key.name === "backspace") this.model.input = Array.from(this.model.input).slice(0, -1).join("");
      else if (key.ctrl && key.name === "u") this.model.input = "";
      else if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) this.model.input += text;
    } catch (error) { this.model.message = error instanceof Error ? error.message : String(error); }
    finally { this.model.changed(); }
  }
  async submit(): Promise<void> {
    const text = this.model.input, thread = this.model.thread;
    const attachments = [...this.model.attachments];
    if ((!text.trim() && !attachments.length) || !thread || this.submitting) return;
    if (this.client.state !== "connected") throw new Error("连接尚未恢复，输入已保留");
    if (thread.backend === "external") throw new Error("External thread 为只读");
    this.submitting = true;
    try {
      if (text.trim() === "/paste-image") {
        this.model.attachments.push(await pasteImage());
        if (this.model.input === text) this.model.input = "";
        this.model.message = "已附加剪贴板图片；Enter 发送，可继续输入文字";
        return;
      }
      const steer = text.startsWith("/steer ");
      const input = /^\/image(?:\s|$)/.test(text)
        ? [...attachments, await imageInput(unquote(text.slice(6).trim()), thread.cwd)]
        : await messageInput(steer ? text.slice(7) : text, thread.cwd, attachments);
      if (!input.length) return;
      const fingerprint = JSON.stringify(input);
      const turnId = steer ? this.model.activeTurnId : undefined;
      if (!this.submission || this.submission.text !== fingerprint || this.submission.threadId !== thread.id || this.submission.turnId !== turnId) {
        this.submission = { text: fingerprint, threadId: thread.id, turnId, id: crypto.randomUUID() };
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
      if (this.model.input === text) this.model.input = "";
      this.model.attachments = this.model.attachments.filter(i => !attachments.includes(i));
      this.submission = undefined;
      this.model.scroll = 0;
    } finally { this.submitting = false; this.model.changed(); }
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
      handle.respond({ permissions: decision === "accept" || decision === "acceptForSession" ? handle.params.permissions : {}, scope: decision === "acceptForSession" ? "session" : "turn" });
      // Permissions replies have no abort variant in AS v1; deny, then interrupt the turn.
      if (decision === "abort") await this.client.request("turn/interrupt", { threadId: handle.params.threadId, turnId: handle.params.turnId });
    } else handle.respond({ decision });
    if (card.state === "pending") card.state = "sending";
  }
}

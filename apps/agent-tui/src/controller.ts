import type { AgentClient } from "@smokingmouse/agent-server/client";
import type { RequestCard, TuiModel } from "./model.js";
import { Sessions } from "./sessions.js";
import { pickerOffset } from "./render.js";
import { imageInput, messageInput, pasteImage, unquote } from "./attachments.js";
import { CompletionSource } from "./completion.js";
import { controlError, controlSuccess, effortBudgets, efforts, estimatedContextWindow, nativePermission, nextEffort, nextPermission, permissionModes, type Effort, type Permission } from "./modes.js";
import { InputLease } from "./lease.js";

export interface Key { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; paste?: boolean; sequence?: string }
export class Controller {
  private completions = new CompletionSource();
  get inFlight(): boolean { return this.submitting || this.controlling || !!this.model.activeCard?.replying; }
  private interruptedAt = -Infinity;
  private submitting = false;
  private controlling = false;
  private droppedControls = 0;
  readonly lease: InputLease;
  private submission?: { text: string; threadId: string; turnId?: string; id: string };
  readonly sessions: Sessions;
  private columns = 100;
  private rows = 30;
  resize(columns = this.columns, rows = this.rows): void {
    this.columns = columns; this.rows = rows;
    if (this.model.picker) this.model.picker.offset = pickerOffset(this.model, columns, rows);
    if (this.model.forkPicker) this.model.forkPicker.offset = pickerOffset(this.model, columns, rows);
  }
  constructor(readonly client: AgentClient, readonly model: TuiModel, readonly exit: () => void, readonly now: () => number = Date.now) { this.sessions = new Sessions(client, model); this.lease = new InputLease(client, model); }
  dispose(): void { this.lease.dispose(); }
  async key(text: string | undefined, key: Key = {}): Promise<void> {
    try {
      this.lease.touch(this.model.thread?.id);
      // Approval shortcuts apply only to physical keys, including during a session scan.
      if (key.paste && this.model.activeCard && this.model.activeCard.request.method !== "item/tool/requestUserInput") {
        this.model.input += text ?? "";
        this.model.completion = undefined;
        return;
      }
      if (key.ctrl && key.name === "c") {
        if (this.now() - this.interruptedAt < 1500) { this.exit(); return; }
        this.interruptedAt = this.now(); this.model.message = "已请求中断；1.5 秒内再按 Ctrl-C 退出";
        this.model.changed();
        if (this.model.thread && this.client.state === "connected") await this.client.request("turn/interrupt", { threadId: this.model.thread.id });
        return;
      }
      this.interruptedAt = -Infinity;
      if (this.sessions.busy) {
        const card = this.model.activeCard;
        if (this.sessions.scanning && card) {
          if (key.name === "pageup" || key.name === "pagedown") {
            this.model.scroll = Math.max(0, this.model.scroll + (key.name === "pageup" ? -10 : 10)); return;
          }
          if (card.request.method === "item/tool/requestUserInput" || key.name === "escape" || (!key.ctrl && !key.meta && ["y", "s", "n", "a"].includes(text?.toLowerCase() ?? ""))) {
            await this.cardKey(card, text, key); return;
          }
        }
        this.sessions.rejectInput(); return;
      }
      // Match render's card overlay, including lease acquisition and reply confirmation.
      // In-flight card keys must be swallowed, never fall through to a hidden surface.
      if (this.model.activeCard && !this.model.picker) {
        if (key.name === "pageup" || key.name === "pagedown") {
          this.model.scroll = Math.max(0, this.model.scroll + (key.name === "pageup" ? -10 : 10)); return;
        }
        await this.cardKey(this.model.activeCard, text, key); return;
      }
      if (this.model.resumeConfirmation) {
        const threadId = this.model.resumeConfirmation;
        if (!key.ctrl && !key.meta && text?.toLowerCase() === "y") {
          this.model.resumeConfirmation = undefined;
          await this.sessions.run("/resume", threadId, true);
        } else if (text?.toLowerCase() === "n" || ["return", "enter", "escape"].includes(key.name ?? "")) {
          this.model.resumeConfirmation = undefined; this.model.message = "已取消恢复关闭的会话";
        }
        return;
      }
      if (key.ctrl && (key.name === "n" || key.name === "t")) {
        if (this.submitting || this.controlling) this.model.message = "提交进行中，本次快捷键已丢弃，请稍后重试";
        else await this.sessions.run(key.name === "n" ? "/new" : "/threads");
        return;
      }
      if (this.model.forkPicker) {
        const picker = this.model.forkPicker;
        if (key.name === "escape") this.model.forkPicker = undefined;
        else if (key.name === "up") picker.index = Math.max(0, picker.index - 1);
        else if (key.name === "down") picker.index = Math.min(picker.entries.length - 1, picker.index + 1);
        else if (key.name === "return" || key.name === "enter") {
          if (picker.threadId !== this.model.thread?.id) { this.model.forkPicker = undefined; throw new Error("分叉来源已切换，请重新 /fork"); }
          const entry = picker.entries[picker.index];
          if (entry) await this.sessions.run("/fork", entry.itemId, false, !entry.itemId);
        }
        return;
      }
      if (this.model.picker) {
        const picker = this.model.picker;
        if (key.name === "escape") this.model.picker = undefined;
        else if (key.name === "up") picker.index = Math.max(0, picker.index - 1);
        else if (key.name === "down") picker.index = Math.min(Math.max(0, picker.entries.length - 1), picker.index + 1);
        else if (key.name === "return" || key.name === "enter") {
          const entry = picker.entries[picker.index];
          if (entry) await this.sessions.run("/resume", entry.thread.id);
          else this.model.message = "没有可选择的会话；按 Esc 退出";
        }
        return;
      }
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
      if (this.model.permissionPicker !== undefined) { await this.permissionKey(text, key); return; }
      if (key.paste || (key.ctrl && key.name === "j") || (key.shift && ["return", "enter"].includes(key.name ?? ""))) {
        this.model.input += key.paste ? (text ?? "") : "\n";
        this.model.completion = undefined; return;
      }
      const completion = this.model.completion;
      if (completion) {
        if (key.name === "escape") { this.model.completion = undefined; return; }
        if (key.name === "up" || key.name === "down") {
          completion.selected = (completion.selected + (key.name === "up" ? -1 : 1) + completion.candidates.length) % completion.candidates.length; return;
        }
        if (!key.shift && ["tab", "return", "enter"].includes(key.name ?? "")) {
          const name = completion.candidates[completion.selected].name;
          this.model.input = this.model.input.slice(0, completion.start) + completion.prefix + (/\s|["']/.test(name) ? JSON.stringify(name) : name) + " ";
          this.model.completion = undefined; return;
        }
      }
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
      else if (key.ctrl && key.name === "u") { this.model.input = ""; this.model.attachments = []; }
      else if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) this.model.input += text;
      const draft = this.model.input;
      this.model.completion = undefined;
      const next = await this.completions.complete(draft, this.model.thread?.cwd ?? process.cwd());
      if (draft === this.model.input) this.model.completion = next;
    } catch (error) { this.model.recordError(error); }
    finally { this.resize(); this.model.changed(); }
  }
  async submit(): Promise<void> {
    const text = this.model.input, thread = this.model.thread;
    const attachments = [...this.model.attachments];
    if (this.sessions.busy) { this.sessions.rejectInput(); return; }
    if (this.submitting || this.controlling) { this.model.message = "提交进行中，本次提交已丢弃，请稍后重试"; this.model.changed(); return; }
    if (text.trim() === "/log") { this.toggleLog(); this.model.input = ""; this.model.changed(); return; }
    if (text.trim() === "/tasks") { this.model.tasksVisible = !this.model.tasksVisible; this.model.panelFocus = this.model.tasksVisible ? "tasks" : "history"; this.model.input = ""; this.model.changed(); return; }
    if (text.trim() === "/agents" || text.trim().startsWith("/agents ")) {
      const id = text.trim().slice(7).trim(), agents = [...this.model.items.values()].filter(i => i.type === "subAgent" && (!id || i.id === id || i.payload.parentItemId === id));
      if (!agents.length) this.model.message = "没有匹配的子 agent";
      const collapse = agents.some(i => !this.model.collapsedAgents.has(i.id));
      for (const i of agents) { if (collapse) this.model.collapsedAgents.add(i.id); else this.model.collapsedAgents.delete(i.id); }
      this.model.input = ""; this.model.changed(); return;
    }
    if ((!text.trim() && !attachments.length) || !thread) return;
    if (this.client.state !== "connected") throw new Error("连接尚未恢复，输入已保留");
    const [command, ...args] = text.trim().split(/\s+/);
    if (["/new", "/clear", "/threads", "/fork", "/resume"].includes(command)) {
      if ((!["/resume", "/fork"].includes(command) && args.length) || args.length > 1) throw new Error(`用法：${command}${command === "/resume" ? " [id]" : command === "/fork" ? " [itemId]" : ""}`);
      this.submitting = true;
      this.model.input = "";
      try { await this.sessions.run(command, args[0]); }
      catch (error) { this.model.input = text; throw error; }
      finally { this.submitting = false; this.model.changed(); }
      return;
    }
    if (thread.backend === "external") throw new Error("External thread 为只读");
    this.submitting = true;
    try {
      if (text.trim() === "/paste-image") {
        this.model.attachments.push(await pasteImage());
        if (this.model.input === text) this.model.input = "";
        this.model.message = "已附加剪贴板图片；Enter 发送，可继续输入文字";
        return;
      }
      if (await this.command(text.trim())) {
        if (this.model.input === text) this.model.input = "";
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
        await this.withLease(thread.id, () => this.client.request("turn/steer", { threadId: thread.id, expectedTurnId: turnId!, input, clientTurnId }));
        this.model.message = "已插话";
      } else {
        const { turn } = await this.withLease(thread.id, () => this.client.request("turn/start", { threadId: thread.id, input, clientTurnId }));
        const queued = this.model.queue.find(q => q.turnId === turn.id);
        this.model.message = queued ? `已排队 #${queued.position + 1}` : turn.status === "queued" ? "已入队，等待队列位置" : "已发送";
      }
      // Do not erase text typed while the request was in flight.
      if (this.model.input === text) this.model.input = "";
      this.model.completion = undefined;
      this.model.attachments = this.model.attachments.filter(i => !attachments.includes(i));
      this.submission = undefined;
      this.model.scroll = 0;
    } finally { this.submitting = false; this.model.changed(); }
  }
  private async control(action: () => Promise<void>): Promise<void> {
    if (this.controlling) {
      this.model.discardNote = `控制请求处理中，已丢弃 ${++this.droppedControls} 次切换；请稍后重试`;
      return;
    }
    if (this.client.state !== "connected") throw new Error("连接尚未恢复，输入已保留");
    if (!this.model.thread) throw new Error("尚未连接 thread");
    this.controlling = true;
    this.droppedControls = 0;
    this.model.discardNote = "";
    try { await action(); } catch (error) { throw new Error(controlError(error, true)); } finally { this.controlling = false; }
  }
  private async withEscalationLease(action: () => Promise<void>): Promise<void> {
    await this.lease.run(this.model.thread!.id, action);
  }
  private async setPermission(permission: Permission): Promise<void> {
    if (this.model.readonlyRestricted) {
      this.model.message = "readonly 为启动限制，当前线程保持 readonly；更改需新建线程";
      return;
    }
    if (!this.permissionChoices.includes(permission)) throw new Error("启动权限不允许此模式，或启动上限未知");
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
      if (this.model.permissionPicker! < 0) throw new Error("当前模式不在允许集合，请显式选择模式或 Esc 取消");
      await this.control(() => this.setPermission(choices[this.model.permissionPicker!]));
      this.model.permissionPicker = undefined;
    }
  }
  private async command(text: string): Promise<boolean> {
    const [command, ...args] = text.split(/\s+/), value = args.join(" ");
    if (command === "/permissions") {
      if (value) throw new Error("用法：/permissions");
      this.model.permissionPicker = this.permissionChoices.indexOf(nativePermission(this.model.thread?.permission));
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
      if (command === "/release") { await this.lease.relinquish(threadId); this.model.message = "已释放控制权"; return; }
      if (command === "/takeover") { await this.lease.takeover(threadId); this.model.message = "已接管控制权（活跃时续期，空闲后到期）；请重试原操作 · /release 释放"; return; }
      if (command === "/model") {
        // Subscribe before the RPC: modelChanged may precede or follow its response.
        let confirm!: (received: boolean) => void;
        const confirmed = new Promise<boolean>(resolve => { confirm = resolve; });
        const unsubscribe = this.client.onNotification("thread/metadata/updated", p => {
          if (p.threadId === threadId && p.model === value) confirm(true);
        });
        const offState = this.client.onStateChange(state => { if (state !== "connected") confirm(false); });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          controlSuccess(await this.client.request("thread/engineControl", { threadId, subtype: "set_model", params: { model: value } }));
          this.model.message = `模型切换请求已接收，等待 ${value} 的模型通知确认`;
          this.model.changed();
          timer = setTimeout(() => confirm(false), 2000);
          if (!await confirmed) throw new Error("模型切换尚未收到权威通知确认，请检查当前模型后重试");
          if (this.model.thread?.id !== threadId) throw new Error("当前会话已改变，请检查目标会话模型");
          this.model.message = `模型：${this.model.thread.model ?? "默认"}`;
        } finally { clearTimeout(timer); unsubscribe(); offState(); }
      } else {
        if (!this.submission || this.submission.text !== text || this.submission.threadId !== threadId) this.submission = { text, threadId, id: crypto.randomUUID() };
        await this.client.request("thread/compact", { threadId, clientTurnId: this.submission.id, ...(value ? { instructions: value } : {}) });
        this.submission = undefined; this.model.message = "已请求压缩，等待 compact_boundary";
      }
    });
    return true;
  }
  private toggleLog(): void { this.model.logExpanded = !this.model.logExpanded; this.model.panelFocus = this.model.logExpanded ? "log" : "history"; }
  private async withLease<T>(threadId: string, action: () => Promise<T> | T): Promise<T> {
    return this.lease.run(threadId, action);
  }
  private async reply(card: RequestCard, send: () => void): Promise<void> {
    if (card.replying) return;
    card.replying = true; this.model.changed();
    const handle = this.client.pendingRequests.get(card.request.params.requestId);
    try {
      await this.withLease(card.request.params.threadId, () => {
        // The acquire round trip may resolve/expire/replace this card. Never revive it.
        if (card.state !== "pending" || this.model.cards.get(card.request.params.requestId) !== card) return;
        if (!handle || this.client.pendingRequests.get(card.request.params.requestId) !== handle) {
          card.state = "expired"; card.note = "请求已失效，等待新快照"; this.model.changed(); return;
        }
        card.responseId = handle.id;
        return new Promise<void>((resolve, reject) => {
          let finished = false;
          const finish = (error?: Error) => { if (finished) return; finished = true; clearTimeout(timer); unsubscribe(); error ? reject(error) : resolve(); };
          const check = () => {
            if (this.model.cards.get(card.request.params.requestId) !== card || card.state === "resolved" || card.state === "expired") finish();
            else if (card.state === "pending" || card.state === "offline") finish(new Error(this.model.message || "审批回复尚未确认"));
          };
          const unsubscribe = this.model.onChange(check);
          const timer = setTimeout(() => {
            if (card.state === "sending") { card.state = "pending"; card.note = "审批回复超时，可重试；不会自动重发"; }
            finish(new Error("审批回复超时，可重试；不会自动重发")); this.model.changed();
          }, Math.min(this.client.options.requestTimeoutMs ?? 5000, 5000));
          timer.unref(); card.state = "sending";
          try { send(); check(); this.model.changed(); } catch (error) { if (card.state === "sending") card.state = "pending"; finish(error instanceof Error ? error : new Error(String(error))); }
        });
      });
    } finally { card.replying = false; this.model.changed(); }
  }
  private async cardKey(card: RequestCard, text: string | undefined, key: Key): Promise<void> {
    if (card.state !== "pending" || card.replying) return;
    const handle = this.client.pendingRequests.get(card.request.params.requestId);
    if (!handle || this.client.state !== "connected") throw new Error("请求连接已失效，等待重连快照");
    if (handle.method === "item/tool/requestUserInput") {
      // TerminalInput already normalizes pasted CR/CRLF for every input surface.
      // Treat the entire paste as draft text, including digits that select options when typed.
      if (key.paste) { card.draft += text ?? ""; return; }
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
    const exitPlan = handle.method === "item/permissions/requestApproval" && handle.params.permissions.toolName === "ExitPlanMode" && (decision === "accept" || decision === "acceptForSession");
    let won = false;
    const unsubscribe = this.client.onNotification("serverRequest/resolved", p => {
      if (p.requestId === handle.params.requestId) won = p.decidedBy.clientId === this.client.clientId;
    });
    const unsubscribePending = this.client.onNotification("thread/pendingRequests", p => {
      if (p.requestId === handle.params.requestId && p.status === "resolved") won = p.decidedBy?.clientId === this.client.clientId;
    });
    let replied = false;
    try {
      await this.reply(card, () => {
        if (handle.method === "item/permissions/requestApproval") handle.respond({ permissions: decision === "accept" || decision === "acceptForSession" ? handle.params.permissions : {}, scope: decision === "acceptForSession" ? "session" : "turn" });
        else handle.respond({ decision });
      });
      replied = true;
      if (exitPlan && won && this.model.thread?.id === handle.params.threadId) await this.control(() => this.setPermission("default"));
    } finally {
      unsubscribe();
      unsubscribePending();
      // Even a denied approval lease must never disable the emergency stop.
      if (decision === "abort" && (!replied || handle.method === "item/permissions/requestApproval")) await this.client.request("turn/interrupt", { threadId: handle.params.threadId, turnId: handle.params.turnId });
    }
  }
}

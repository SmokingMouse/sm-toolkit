import { AgentClient, type ClientState } from "@smokingmouse/agent-server/client";
import { NotificationMethodSchema, type AttachResult, type Item, type PendingRequestState, type PendingServerRequest, type QueuedTurn, type RpcId, type ServerNotification, type Thread, type Usage } from "@smokingmouse/agent-server/protocol";
import { classifyEvent, LogBuffer, object, rebuildTasks } from "./observations.js";
import { errorCode, errorMessage, leaseHolder } from "./errors.js";
import type { ThreadEntry } from "./sessions.js";
import type { ForkEntry } from "./fork.js";
import type { ImageInput } from "./attachments.js";
import type { Completion } from "./completion.js";
import { controlError, estimatedContextWindow, nativePermission, permissionModes, type Effort, type Permission } from "./modes.js";

export interface RequestCard { request: PendingServerRequest; responseId?: RpcId; replying?: boolean; state: "pending" | "sending" | "resolved" | "expired" | "offline"; note?: string; question: number; answers: Record<string, { answers: string[] }>; draft: string }
export function expiredNote(reason: string): string {
  return `${reason === "timeout" ? "请求超时" : "请求已撤回/过期"}：${reason}`;
}
export function canResume(thread: Thread | undefined): boolean {
  return !!thread && thread.backend !== "external" && ["systemError", "closed"].includes(thread.status.type);
}
export class TuiModel {
  thread?: Thread;
  items = new Map<string, Item>();
  cards = new Map<string, RequestCard>();
  pendingStates = new Map<string, PendingRequestState>();
  get pendingCount(): number {
    // This client can only act on requests delivered as cards (including offline recovery).
    return [...this.cards.values()].filter(card => ["pending", "sending", "offline"].includes(card.state)).length;
  }
  queue: QueuedTurn[] = [];
  usage?: Usage;
  connection: ClientState = "disconnected";
  message = "";
  discardNote = "";
  leaseWarning = "";
  input = "";
  attachments: ImageInput[] = [];
  completion?: Completion;
  expandedReasoning = false;
  expandedPlan = true;
  permissionPicker?: number;
  launchPermission?: Permission;
  get bypassAvailable(): boolean { return nativePermission(this.launchPermission) === "bypassPermissions"; }
  get readonlyRestricted(): boolean { return this.launchPermission === "readonly" || this.thread?.permission === "readonly"; }
  get permissionChoices(): Permission[] {
    return this.readonlyRestricted ? ["readonly"] : [...permissionModes(this.bypassAvailable), ...(this.bypassAvailable || this.launchPermission === "dontAsk" ? ["dontAsk" as const] : [])];
  }
  effort?: Effort;
  leaseExpiresAt = 0;
  contextWindow = 200_000;
  contextWindowEstimated = true;
  scroll = 0;
  logs = new LogBuffer();
  logExpanded = false;
  private logAnchorEnd?: number;
  private logAnchorStart?: number;
  get logScroll(): number { return this.logAnchorEnd === undefined ? 0 : Math.max(0, this.logs.dropped + this.logs.length - this.logAnchorEnd); }
  set logScroll(offset: number) {
    this.logAnchorEnd = offset <= 0 ? undefined : this.logs.dropped + this.logs.length - offset;
    this.logAnchorStart = undefined;
  }
  get logViewportLost(): boolean { return this.logAnchorStart !== undefined && this.logAnchorStart < this.logs.dropped; }
  logWindowEnd(count: number): number {
    if (this.logAnchorEnd === undefined) return this.logs.length;
    if (this.logAnchorStart === undefined) this.logAnchorEnd = Math.max(this.logs.dropped + Math.min(count, this.logs.length), Math.min(this.logs.dropped + this.logs.length, this.logAnchorEnd));
    return this.logAnchorEnd - this.logs.dropped;
  }
  rememberLogWindowStart(index: number): void {
    if (this.logAnchorEnd !== undefined && this.logAnchorStart === undefined) this.logAnchorStart = this.logs.dropped + index;
  }
  logsMayBeMissing = false;
  logsStartAtAttach = false;
  tasksVisible = false;
  taskScroll = 0;
  panelFocus: "history" | "log" | "tasks" = "history";
  collapsedAgents = new Set<string>();
  lease: { state: "none" } | { state: "self"; expiresAtMs: number; threadId: string } | { state: "other"; holder: string } = { state: "none" };
  get leaseLabel(): string {
    return this.lease.state === "self" && this.lease.expiresAtMs > Date.now() ? this.leaseWarning ? "释放未确认（未续期）" : "持有/续期中"
      : this.lease.state === "other" ? `他端持有:${this.lease.holder}（最近拒绝）` : "未持有";
  }
  recordError(error: unknown): void {
    if (errorCode(error) === -32012) this.lease = { state: "other", holder: leaseHolder(error) ?? "未知客户端" };
    else if (errorCode(error) === -32005) this.lease = { state: "none" };
    this.message = errorMessage(error); this.changed();
  }
  recordLeaseReleaseError(error: unknown): void {
    if (errorCode(error) === -32012) this.lease = { state: "other", holder: leaseHolder(error) ?? "未知客户端" };
    this.leaseWarning = `租约释放未确认：${errorMessage(error)}`;
    this.changed();
  }
  get tasks() { return rebuildTasks(this.items.values()); }
  setConnection(state: ClientState): void {
    // engineEvent is live-only in AS/1: no item sequence exists to replay this interval.
    if (this.connection === "connected" && state !== "connected" && this.thread) this.logsMayBeMissing = true;
    this.connection = state;
  }
  activeTurnId?: string;
  sessionOperation?: string;
  resumeConfirmation?: string;
  picker?: { entries: ThreadEntry[]; index: number; offset?: number };
  forkPicker?: { threadId: string; entries: ForkEntry[]; index: number; offset?: number };
  private sessionModes = new Map<string, { launchPermission?: Permission }>();
  forgetLeases(): void {
    this.leaseExpiresAt = 0;
  }
  select(snapshot: AttachResult): void {
    if (this.thread?.id !== snapshot.thread.id) {
      if (this.thread) this.sessionModes.set(this.thread.id, { launchPermission: this.launchPermission });
      const modes = this.sessionModes.get(snapshot.thread.id);
      this.launchPermission = modes?.launchPermission;
      this.leaseExpiresAt = 0;
      this.lease = { state: "none" }; this.leaseWarning = "";
      this.logs = new LogBuffer(); this.logScroll = 0; this.logsMayBeMissing = false;
      this.collapsedAgents.clear(); this.taskScroll = 0;
    }
    this.permissionPicker = undefined; this.completion = undefined;
    this.thread = snapshot.thread;
    this.items.clear(); this.cards.clear(); this.queue = []; this.usage = undefined;
    this.activeTurnId = undefined; this.scroll = 0; this.picker = undefined; this.forkPicker = undefined;
    this.snapshot(snapshot);
  }
  private listeners = new Set<() => void>();
  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  changed(): void { for (const fn of this.listeners) fn(); }
  get activeCard(): RequestCard | undefined { return [...this.cards.values()].find(c => c.state === "pending" || c.state === "sending"); }
  get agentState(): "working" | "idle" | "blocked" {
    if (this.activeCard || this.connection !== "connected" || this.thread?.status.type === "systemError") return "blocked";
    return this.thread?.status.type === "running" || this.thread?.status.type === "spawning" ? "working" : "idle";
  }
  snapshot(s: AttachResult): void {
    if (this.thread && this.thread.id !== s.thread.id) return;
    this.logsStartAtAttach = true;
    this.thread = s.thread; this.queue = s.queue;
    this.effort = undefined;
    if (this.contextWindowEstimated) this.contextWindow = estimatedContextWindow(s.thread.model);
    for (const item of s.items) this.items.set(item.id, structuredClone(item));
    const ids = new Set(s.pendingRequests.map(r => r.params.requestId));
    this.pendingStates.clear();
    for (const [id, card] of this.cards) if (!ids.has(id) && ["pending", "sending", "offline"].includes(card.state)) {
      card.state = "expired"; card.note = "重连确认已处理（处理者未知）";
    }
    for (const request of s.pendingRequests) this.request(request);
    this.changed();
  }
  request(request: PendingServerRequest, responseId?: RpcId): void {
    if (this.thread && this.thread.id !== request.params.threadId) return;
    const old = this.cards.get(request.params.requestId);
    if (!old || old.state === "offline") this.scroll = 0;
    this.cards.set(request.params.requestId, { request, responseId: responseId ?? old?.responseId, state: "pending", question: old?.question ?? 0, answers: old?.answers ?? {}, draft: old?.draft ?? "" });
    if (request.state) this.pendingState(request.state);
    this.changed();
  }
  private pendingState(state: PendingRequestState): void {
    if (state.status === "pending") this.pendingStates.set(state.requestId, structuredClone(state));
    else this.pendingStates.delete(state.requestId);
    const card = this.cards.get(state.requestId);
    if (state.status !== "pending") {
      const note = state.status === "resolved" ? `已由 ${state.decidedBy?.label || state.decidedBy?.clientId || "未知客户端"} 处理` : expiredNote(state.reason ?? "unknown");
      if (card) { card.state = state.status; card.replying = false; card.note = note; this.message = note; }
    }
  }
  notification(n: ServerNotification): void {
    if ("threadId" in n.params && this.thread && n.params.threadId && n.params.threadId !== this.thread.id) return;
    switch (n.method) {
      case "thread/pendingRequests": this.pendingState(n.params); break;
      case "thread/metadata/updated":
        if (this.thread) {
          const { threadId: _, ...metadata } = n.params;
          Object.assign(this.thread, metadata);
          if (this.contextWindowEstimated) this.contextWindow = estimatedContextWindow(this.thread.model);
        }
        break;
      case "thread/permission/changed": if (this.thread) this.thread.permission = n.params.permission; break;
      case "thread/engineEvent": this.logs.push(classifyEvent(n.params.subtype, n.params.payload)); break;
      case "thread/status/changed": if (this.thread) this.thread.status = n.params.status; break;
      case "thread/queue/changed": this.queue = n.params.queue; break;
      case "thread/tokenUsage/updated": this.usage = n.params.usage; break;
      case "thread/closed": if (this.thread) this.thread.status = { type: "closed" }; break;
      case "turn/started": this.activeTurnId = n.params.turn.id; break;
      case "turn/completed": this.activeTurnId = undefined; if (n.params.turn.usage) this.usage = n.params.turn.usage; if (n.params.turn.error) this.message = n.params.turn.error.message; break;
      case "item/started": case "item/completed": this.items.set(n.params.item.id, structuredClone(n.params.item)); break;
      case "item/agentMessage/delta": { const i = this.items.get(n.params.itemId); if (i?.type === "agentMessage") i.payload.text += n.params.delta; break; }
      case "item/reasoning/textDelta": case "item/reasoning/summaryTextDelta": {
        const i = this.items.get(n.params.itemId); if (i?.type === "reasoning") { const key = n.method === "item/reasoning/textDelta" ? "text" : "summary"; i.payload[key] = (i.payload[key] ?? "") + n.params.delta; } break;
      }
      case "item/commandExecution/outputDelta": { const i = this.items.get(n.params.itemId); if (i?.type === "commandExecution") i.payload.aggregatedOutput = (i.payload.aggregatedOutput ?? "") + n.params.chunk; break; }
      case "item/fileChange/patchUpdated": { const i = this.items.get(n.params.itemId); if (i?.type === "fileChange") i.payload.changes = n.params.changes; break; }
      case "item/subAgent/progress": {
        const i = this.items.get(n.params.itemId);
        if (i?.type === "subAgent") {
          Object.assign(i.payload, { phase: n.params.phase, progress: n.params.progress });
          const progress = object(n.params.progress);
          for (const key of ["text", "thinking"] as const) if (typeof progress[key] === "string") i.payload[key] = progress[key];
        }
        break;
      }
      case "serverRequest/resolved": { this.pendingStates.delete(n.params.requestId); const c = this.cards.get(n.params.requestId); if (c) { c.state = "resolved"; c.replying = false; c.note = `已由 ${n.params.decidedBy.label || n.params.decidedBy.clientId} 处理`; } break; }
      case "serverRequest/expired": { this.pendingStates.delete(n.params.requestId); const c = this.cards.get(n.params.requestId); if (c) { c.state = "expired"; c.replying = false; c.note = expiredNote(n.params.reason); } break; }
      case "error": this.message = n.params.error.message; break;
      case "server/shuttingDown": this.message = `daemon stopping: ${n.params.reason}`; break;
    }
    this.changed();
  }
}

export function bindClient(client: AgentClient, model: TuiModel): () => void {
  let recovering = false;
  const disposers = [client.onSnapshot(s => model.snapshot(s)), client.onStateChange(state => {
    model.setConnection(state);
    if (state === "disconnected" && model.thread) recovering = true;
    if (recovering) model.message = state === "connected" ? canResume(model.thread)
      ? "已重连并补齐历史；引擎已停止，请用 /resume 选择会话恢复"
      : `已重连并恢复会话 ${model.thread?.id}（sinceSeq 补齐）` : "连接中断，正在自动重连…";
    if (state === "connected") recovering = false;
    if (state !== "connected") { model.effort = undefined; model.forgetLeases(); model.activeTurnId = undefined; for (const c of model.cards.values()) if (c.state === "pending" || c.state === "sending") c.state = "offline"; }
    model.changed();
  }), client.onError((error, id) => {
    model.recordError(error);
    // Keep correlation on the card: AgentClient removes pending handles before late errors arrive.
    for (const card of model.cards.values()) {
      if (id != null && card.responseId === id && (card.state === "sending" || card.state === "pending")) {
        if (errorCode(error) === -32014) { card.state = "resolved"; card.note = errorMessage(error); }
        else if (card.state === "sending") card.state = "pending";
      }
    }
    model.changed();
  })];
  for (const method of NotificationMethodSchema.options) disposers.push(client.onNotification(method, params => model.notification({ jsonrpc: "2.0", method, params } as ServerNotification)));
  for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput"] as const) disposers.push(client.onServerRequest(method, r => model.request(r, r.id)));
  return () => disposers.forEach(fn => fn());
}

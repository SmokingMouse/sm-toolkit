import { AgentClient, type ClientState } from "@smokingmouse/agent-server/client";
import { NotificationMethodSchema, type AttachResult, type Item, type PendingServerRequest, type QueuedTurn, type ServerNotification, type Thread, type Usage } from "@smokingmouse/agent-server/protocol";
import { controlError, estimatedContextWindow, nativePermission, permissionModes, type Effort, type Permission } from "./modes.js";

export interface RequestCard { request: PendingServerRequest; state: "pending" | "sending" | "resolved" | "expired" | "offline"; note?: string; question: number; answers: Record<string, { answers: string[] }>; draft: string }
export class TuiModel {
  thread?: Thread;
  items = new Map<string, Item>();
  cards = new Map<string, RequestCard>();
  queue: QueuedTurn[] = [];
  usage?: Usage;
  connection: ClientState = "disconnected";
  message = "";
  input = "";
  expandedReasoning = false;
  expandedPlan = true;
  permissionPicker?: number;
  launchPermission?: Permission;
  get bypassAvailable(): boolean { return nativePermission(this.launchPermission) === "bypassPermissions"; }
  get readonlyRestricted(): boolean { return this.launchPermission === "readonly" || this.thread?.permission === "readonly"; }
  get permissionChoices(): Permission[] {
    return this.readonlyRestricted ? ["readonly"] : [...permissionModes(this.bypassAvailable), ...(this.bypassAvailable ? ["dontAsk" as const] : [])];
  }
  effort?: Effort;
  leaseExpiresAt = 0;
  contextWindow = 200_000;
  contextWindowEstimated = true;
  scroll = 0;
  activeTurnId?: string;
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
    this.thread = s.thread; this.queue = s.queue;
    this.effort = undefined;
    if (this.contextWindowEstimated) this.contextWindow = estimatedContextWindow(s.thread.model);
    for (const item of s.items) this.items.set(item.id, structuredClone(item));
    const ids = new Set(s.pendingRequests.map(r => r.params.requestId));
    for (const [id, card] of this.cards) if (!ids.has(id) && ["pending", "sending", "offline"].includes(card.state)) {
      card.state = "expired"; card.note = "重连确认已处理（处理者未知）";
    }
    for (const request of s.pendingRequests) this.request(request);
    this.changed();
  }
  request(request: PendingServerRequest): void {
    if (this.thread && this.thread.id !== request.params.threadId) return;
    const old = this.cards.get(request.params.requestId);
    if (!old || old.state === "offline") this.scroll = 0;
    this.cards.set(request.params.requestId, { request, state: "pending", question: old?.question ?? 0, answers: old?.answers ?? {}, draft: old?.draft ?? "" });
    this.changed();
  }
  notification(n: ServerNotification): void {
    if ("threadId" in n.params && this.thread && n.params.threadId && n.params.threadId !== this.thread.id) return;
    switch (n.method) {
      case "thread/metadata/updated":
        if (this.thread) {
          const { threadId: _, ...metadata } = n.params;
          Object.assign(this.thread, metadata);
          if (this.contextWindowEstimated) this.contextWindow = estimatedContextWindow(this.thread.model);
        }
        break;
      case "thread/permission/changed": if (this.thread) this.thread.permission = n.params.permission; break;
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
      case "item/subAgent/progress": { const i = this.items.get(n.params.itemId); if (i?.type === "subAgent") Object.assign(i.payload, { phase: n.params.phase, progress: n.params.progress }); break; }
      case "serverRequest/resolved": { const c = this.cards.get(n.params.requestId); if (c) { c.state = "resolved"; c.note = `已由 ${n.params.decidedBy.label || n.params.decidedBy.clientId} 处理`; } break; }
      case "serverRequest/expired": { const c = this.cards.get(n.params.requestId); if (c) { c.state = "expired"; c.note = `已过期：${n.params.reason}`; } break; }
      case "error": this.message = n.params.error.message; break;
      case "server/shuttingDown": this.message = `daemon stopping: ${n.params.reason}`; break;
    }
    this.changed();
  }
}

export function bindClient(client: AgentClient, model: TuiModel): () => void {
  const disposers = [client.onSnapshot(s => model.snapshot(s)), client.onStateChange(state => {
    model.connection = state;
    if (state !== "connected") { model.effort = undefined; model.leaseExpiresAt = 0; model.activeTurnId = undefined; for (const c of model.cards.values()) if (c.state === "pending" || c.state === "sending") c.state = "offline"; }
    model.changed();
  }), client.onError((error, id) => {
    model.message = controlError(error);
    for (const handle of client.pendingRequests.values()) {
      const card = model.cards.get(handle.params.requestId);
      if (handle.id === id && card?.state === "sending") card.state = "pending";
    }
    model.changed();
  })];
  for (const method of NotificationMethodSchema.options) disposers.push(client.onNotification(method, params => model.notification({ jsonrpc: "2.0", method, params } as ServerNotification)));
  for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput"] as const) disposers.push(client.onServerRequest(method, r => model.request(r)));
  return () => disposers.forEach(fn => fn());
}

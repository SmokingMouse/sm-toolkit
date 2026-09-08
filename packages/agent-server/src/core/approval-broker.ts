import { ErrorCode, PendingServerRequestSchema, ProtocolError, ServerRequestSchemas, type ClientIdentity, type PendingServerRequest, type ServerRequestMethod, type ServerRequestResult } from "../protocol/index.js";
import { ItemLog } from "./item-log.js";
import { LeaseManager } from "./lease-manager.js";
import { pendingRequestState } from "../protocol/index.js";

export interface ApprovalClient extends ClientIdentity { serverRequests: ReadonlySet<ServerRequestMethod>; attached: ReadonlySet<string>; sendRequest: (request: PendingServerRequest) => void }
export interface ApprovalBrokerOptions { orphanTimeoutMs?: number; timeoutMs?: number; now?: () => number; onDeliveryError?: (threadId: string, error: unknown) => void }
interface Waiting { request: PendingServerRequest; respond: (result: ServerRequestResult) => void | Promise<void>; since: number; orphan: boolean; timer?: ReturnType<typeof setTimeout> }
function defaultDecision(request: PendingServerRequest): ServerRequestResult {
  return request.method === "item/tool/requestUserInput" ? { answers: {} } : request.method === "item/permissions/requestApproval" ? { permissions: {}, scope: "turn" } : { decision: "reject" };
}
export class ApprovalBroker {
  private waiting = new Map<string, Waiting>();
  readonly orphanTimeoutMs: number;
  private now: () => number;
  constructor(private readonly log: ItemLog, private readonly clients: () => Iterable<ApprovalClient>, private readonly leases = new LeaseManager(), private readonly options: ApprovalBrokerOptions = {}) {
    this.orphanTimeoutMs = options.orphanTimeoutMs ?? 30 * 60_000; this.now = options.now ?? Date.now;
    // Pending callbacks belonged to the previous process and cannot be resurrected.
    log.db.query("UPDATE approvals SET status='expired',decided_at=?,decision_json=? WHERE status='pending'").run(this.now(), JSON.stringify({ reason: "engine_gone" }));
  }
  private audience(request: PendingServerRequest): ApprovalClient[] { return [...this.clients()].filter(c => c.attached.has(request.params.threadId) && c.serverRequests.has(request.method)); }
  create(raw: PendingServerRequest, respond: Waiting["respond"]): void {
    const request = PendingServerRequestSchema.parse(raw), p = request.params;
    if (this.log.approval(p.requestId)) {
      this.log.publish({ jsonrpc: "2.0", method: "error", params: { threadId: p.threadId, turnId: p.turnId, error: new ProtocolError(ErrorCode.engine_protocol_error, "engine reused requestId", { threadId: p.threadId }).toJSON(), willRetry: false } });
      // Preserve the original card and settle only the duplicate engine callback.
      this.deliver({ request, respond, since: this.now(), orphan: false }, defaultDecision(request));
      return;
    }
    this.log.turn(p.turnId, p.threadId); this.log.item(p.threadId, p.itemId);
    request.state = pendingRequestState(request, this.now());
    this.log.db.query("INSERT INTO approvals(id,thread_id,turn_id,item_id,kind,params_json,status,created_at) VALUES(?,?,?,?,?,?,'pending',?)").run(p.requestId, p.threadId, p.turnId, p.itemId, request.method, JSON.stringify(request), this.now());
    const audience = this.audience(request);
    const pending: Waiting = { request, respond, since: this.now(), orphan: !audience.length };
    this.waiting.set(p.requestId, pending); this.schedule(pending);
    this.log.publish({ jsonrpc: "2.0", method: "thread/pendingRequests", params: request.state });
    for (const client of audience) client.sendRequest(structuredClone(request));
  }
  clientAttached(client: ApprovalClient, threadId: string): void {
    for (const pending of this.waiting.values()) if (pending.request.params.threadId === threadId && client.serverRequests.has(pending.request.method)) client.sendRequest(structuredClone(pending.request));
    this.audienceChanged();
  }
  audienceChanged(): void {
    for (const pending of this.waiting.values()) {
      const orphan = !this.audience(pending.request).length;
      if (orphan !== pending.orphan) { pending.orphan = orphan; pending.since = this.now(); this.schedule(pending); }
    }
  }
  private timeout(pending: Waiting): number { return pending.orphan ? this.orphanTimeoutMs : pending.request.method === "item/tool/requestUserInput" && pending.request.params.isBlocking ? Infinity : this.options.timeoutMs ?? 120_000; }
  private schedule(pending: Waiting): void {
    if (pending.timer) clearTimeout(pending.timer);
    const timeout = this.timeout(pending);
    if (Number.isFinite(timeout)) { pending.timer = setTimeout(() => this.sweep(), Math.max(1, Math.min(2 ** 31 - 1, pending.since + timeout - this.now()))); pending.timer.unref(); }
  }
  sweep(): void {
    for (const pending of [...this.waiting.values()]) {
      if (this.now() - pending.since >= this.timeout(pending)) this.expire(pending.request.params.requestId, pending.orphan ? "orphan_timeout" : "timeout");
      else this.schedule(pending);
    }
  }
  answer(requestId: string, clientId: string, raw: unknown): void {
    const row = this.log.approval(requestId);
    if (!row) throw new ProtocolError(ErrorCode.invalid_params, "unknown server request");
    if (row.status !== "pending") throw new ProtocolError(ErrorCode.already_resolved, "server request already resolved", { threadId: row.thread_id });
    const pending = this.waiting.get(requestId)!;
    const client = this.audience(pending.request).find(c => c.clientId === clientId);
    if (!client) throw new ProtocolError(ErrorCode.unauthorized, "client must be attached and capable", { threadId: row.thread_id });
    this.leases.assertInput(row.thread_id, clientId);
    const result = ServerRequestSchemas[pending.request.method].result.parse(raw);
    if (pending.request.method === "item/tool/requestUserInput" && "answers" in result) {
      const questions = new Set(pending.request.params.questions.map(q => q.id));
      if (Object.keys(result.answers).some(id => !questions.has(id))) throw new ProtocolError(ErrorCode.invalid_params, "unknown questionId");
    }
    const decidedBy = { clientId, label: client.label };
    const changed = this.log.db.query("UPDATE approvals SET status='decided',decided_by=?,decision_json=?,decided_at=? WHERE id=? AND status='pending'").run(JSON.stringify(decidedBy), JSON.stringify(result), this.now(), requestId);
    if (!changed.changes) throw new ProtocolError(ErrorCode.already_resolved, "server request already resolved");
    this.remove(pending);
    this.log.publish({ jsonrpc: "2.0", method: "thread/pendingRequests", params: { ...pending.request.state!, status: "resolved", decidedBy, updatedAtMs: this.now() } });
    this.log.publish({ jsonrpc: "2.0", method: "serverRequest/resolved", params: { threadId: row.thread_id, requestId, decidedBy, outcome: "decision" in result ? result.decision : result } });
    this.deliver(pending, result);
  }
  private remove(pending: Waiting): void { if (pending.timer) clearTimeout(pending.timer); this.waiting.delete(pending.request.params.requestId); }
  private deliver(pending: Waiting, result: ServerRequestResult): void {
    try { void Promise.resolve(pending.respond(result)).catch(error => this.options.onDeliveryError?.(pending.request.params.threadId, error)); }
    catch (error) { this.options.onDeliveryError?.(pending.request.params.threadId, error); }
  }
  expire(requestId: string, reason: string): void {
    const pending = this.waiting.get(requestId); if (!pending) return;
    const result = defaultDecision(pending.request);
    this.log.db.query("UPDATE approvals SET status='expired',decision_json=?,decided_at=? WHERE id=? AND status='pending'").run(JSON.stringify({ reason, result }), this.now(), requestId);
    this.remove(pending);
    this.log.publish({ jsonrpc: "2.0", method: "thread/pendingRequests", params: { ...pending.request.state!, status: "expired", reason, updatedAtMs: this.now() } });
    this.log.publish({ jsonrpc: "2.0", method: "serverRequest/expired", params: { threadId: pending.request.params.threadId, requestId, reason } });
    this.deliver(pending, result);
  }
  expireThread(threadId: string, reason: string, turnId?: string): void { for (const pending of [...this.waiting.values()]) if (pending.request.params.threadId === threadId && (!turnId || pending.request.params.turnId === turnId)) this.expire(pending.request.params.requestId, reason); }
  close(): void { for (const id of [...this.waiting.keys()]) this.expire(id, "server_closed"); }
}

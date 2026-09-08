import { ErrorCode, ProtocolError, rpcError, type MethodParams, type MethodResult, type RpcError, type ThreadStatus, type Turn, type Usage } from "../protocol/index.js";
import type { EngineSession } from "../engines/session.js";
import { ItemLog } from "./item-log.js";

export class TurnQueue {
  private active: string | null = null;
  private frozen = false;
  private dispatch = new Map<string, Promise<void>>();
  private interruptTimer?: ReturnType<typeof setTimeout>;
  constructor(readonly threadId: string, private readonly log: ItemLog, private readonly engine: () => EngineSession, private readonly status: (status: ThreadStatus) => void, readonly maxQueuedTurns = 8, private readonly onEngineFailure?: (error: RpcError) => void, private readonly interruptTimeoutMs = 5000) {}
  get runningTurnId(): string | null { return this.active; }
  get isFrozen(): boolean { return this.frozen; }
  read() { return this.log.queue(this.threadId); }
  private changed(): void { this.log.publish({ jsonrpc: "2.0", method: "thread/queue/changed", params: { threadId: this.threadId, queue: this.read() } }); }
  enqueue(params: MethodParams<"turn/start">): MethodResult<"turn/start"> {
    const existing = this.log.deduplicate<Turn>("turns", params.clientTurnId, params);
    if (existing) return { turn: existing, deduplicated: true };
    const thread = this.log.thread(this.threadId), state = thread.status.type;
    if (thread.backend === "external") throw new ProtocolError(ErrorCode.unsupported_capability, "external threads are read-only", { threadId: this.threadId });
    if (state === "closed") throw new ProtocolError(ErrorCode.thread_closed, "thread closed", { threadId: this.threadId });
    if (state === "systemError" || state === "spawning") throw new ProtocolError(ErrorCode.engine_unavailable, "resume thread before starting a turn", { threadId: this.threadId, retryable: true });
    this.engine().validateTurn?.(params);
    if ((this.active || this.frozen) && this.read().length >= this.maxQueuedTurns) throw new ProtocolError(ErrorCode.thread_busy, "turn queue is full", { threadId: this.threadId, retryable: true });
    const turn: Turn = { id: `tn_${crypto.randomUUID()}`, threadId: this.threadId, ordinal: (this.log.turns(this.threadId).at(-1)?.ordinal ?? 0) + 1, status: "queued", enqueuedAtMs: Date.now(), ...(params.clientTurnId ? { clientTurnId: params.clientTurnId } : {}) };
    this.log.transaction(() => this.log.insertTurn(turn, params, params.input.map(p => p.type === "text" ? p.text : p.type === "bash" ? `!${p.command}` : p.path).join(" ").slice(0, 200)));
    this.changed(); this.pump();
    return { turn: this.log.turn(turn.id) };
  }
  private pump(): void {
    if (this.frozen || this.active) return;
    const head = this.read()[0]; if (!head) return;
    const turn = this.log.turn(head.turnId), input = this.log.turnInput(turn.id);
    turn.status = "inProgress"; turn.startedAtMs = Date.now(); this.active = turn.id;
    this.log.transaction(() => { this.log.dequeue(turn.id); this.log.saveTurn(turn); });
    this.status({ type: "running" }); this.changed();
    this.log.publish({ jsonrpc: "2.0", method: "turn/started", params: { threadId: this.threadId, turnId: turn.id, turn } });
    if (!this.engine().emitsUserMessages) {
      const userItem = this.log.startItem(this.threadId, turn.id, { id: `it_${crypto.randomUUID()}`, type: "userMessage", payload: { content: input.input, ...(input.clientTurnId ? { clientTurnId: input.clientTurnId } : {}) } });
      this.log.updateItem(this.threadId, { ...userItem, status: "completed" }, true);
    }
    // Set up the promise before invoking the engine, including synchronous fakes.
    const sent = Promise.resolve().then(() => this.engine().sendTurn(turn.id, input.input, input));
    this.dispatch.set(turn.id, sent);
    void sent.catch(error => { if (this.active === turn.id) { if (this.onEngineFailure) this.onEngineFailure(rpcError(error)); else this.freeze(rpcError(error)); } }).finally(() => { this.dispatch.delete(turn.id); });
  }
  private assertActive(expected?: string): string {
    if (!this.active || (expected && expected !== this.active) || this.frozen) throw new ProtocolError(ErrorCode.turn_not_active, "turn is not active", { threadId: this.threadId, turnId: expected });
    return this.active;
  }
  async steer(params: MethodParams<"turn/steer">): Promise<void> {
    const turnId = this.assertActive(params.expectedTurnId);
    await this.dispatch.get(turnId); this.assertActive(turnId);
    await this.engine().steer(turnId, params.input, params);
    if (!this.engine().emitsUserMessages) {
      const item = this.log.startItem(this.threadId, turnId, { id: `it_${crypto.randomUUID()}`, type: "userMessage", payload: { content: params.input, ...(params.clientTurnId ? { clientTurnId: params.clientTurnId } : {}) } });
      this.log.updateItem(this.threadId, { ...item, status: "completed" }, true);
    }
  }
  async interrupt(expected?: string): Promise<string | null> {
    if (!this.active && !expected) return null;
    if (expected) this.log.turn(expected, this.threadId);
    const turnId = this.assertActive(expected);
    await this.dispatch.get(turnId); this.assertActive(turnId);
    await this.engine().interrupt(turnId);
    if (this.active === turnId && !this.interruptTimer) {
      // An ack does not prove completion. Retire an engine that never closes
      // the interrupted generation; do not let it leak output into a new turn.
      this.interruptTimer = setTimeout(() => {
        this.interruptTimer = undefined;
        if (this.active !== turnId) return;
        const error = new ProtocolError(ErrorCode.engine_unavailable, "interrupt acknowledged without turn completion; resume required", { threadId: this.threadId, turnId, retryable: true }).toJSON();
        if (this.onEngineFailure) this.onEngineFailure(error); else this.freeze(error);
      }, this.interruptTimeoutMs);
      this.interruptTimer.unref();
    }
    return turnId;
  }
  cancel(turnId: string): void {
    const turn = this.log.turn(turnId, this.threadId);
    if (turn.status !== "queued") throw new ProtocolError(ErrorCode.turn_not_active, "only queued turns can be cancelled", { threadId: this.threadId, turnId });
    turn.status = "cancelled"; turn.completedAtMs = Date.now();
    this.log.transaction(() => { this.log.dequeue(turnId); this.log.saveTurn(turn); }); this.changed();
  }
  complete(turnId: string, status: "completed" | "interrupted" | "failed", usage?: Usage, error?: RpcError): void {
    if (this.active !== turnId) return; // late terminal frames must not finish the next turn
    clearTimeout(this.interruptTimer); this.interruptTimer = undefined;
    const turn = this.log.turn(turnId); turn.status = status; turn.completedAtMs = Date.now();
    turn.durationMs = turn.completedAtMs - (turn.startedAtMs ?? turn.enqueuedAtMs);
    if (usage) turn.usage = usage; if (error) turn.error = error;
    this.log.finishOpenItems(this.threadId, turnId, status !== "completed");
    this.log.saveTurn(turn); this.active = null;
    this.log.publish({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: this.threadId, turnId, turn } });
    if (usage && !this.engine().emitsTokenUsage) this.log.publish({ jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: { threadId: this.threadId, usage } });
    if (!this.frozen) { if (status === "interrupted") this.status({ type: "interrupted" }); this.status({ type: "idle" }); }
    this.changed(); this.pump();
  }
  freeze(error: RpcError): void {
    this.frozen = true;
    this.status({ type: "systemError", error });
    if (this.active) this.complete(this.active, "failed", undefined, error);
    else this.changed();
  }
  pause(): void { this.frozen = true; if (this.active) this.complete(this.active, "interrupted"); else this.changed(); }
  resume(): void { this.frozen = false; this.changed(); this.pump(); }
}

import type { Backend, PendingServerRequest, ServerRequestResult, StartTurnParams, UserInput } from "../protocol/index.js";
import { AsyncQueue, type EngineEvent, type EngineSession, type SessionOptions } from "./session.js";

export type MockStep = EngineEvent | { waitMs: number } | { approval: PendingServerRequest; onDecision?: (decision: ServerRequestResult) => void };
export type MockScript = (turnId: string, input: UserInput[], engine: MockEngine) => Iterable<MockStep> | AsyncIterable<MockStep>;
export class MockEngine implements EngineSession {
  readonly events = new AsyncQueue<EngineEvent>();
  engineThreadId: string | null = null;
  spawnCount = 0;
  attachCount = 0;
  options?: SessionOptions;
  sent: Array<{ turnId: string; input: UserInput[]; options: StartTurnParams }> = [];
  steered: Array<{ turnId: string; input: UserInput[] }> = [];
  interrupted: string[] = [];
  closed = false;
  private active: string | null = null;
  private generation = 0;
  constructor(readonly script?: MockScript, readonly backend: Backend = "claude") {}
  async spawn(options: SessionOptions): Promise<void> {
    this.options = options; this.spawnCount++;
    this.engineThreadId = options.forkSession ? `mock_${crypto.randomUUID()}` : options.engineThreadId ?? `mock_${options.threadId}`;
    this.events.push({ type: "metadata", engineThreadId: this.engineThreadId });
  }
  async attach(): Promise<void> { this.attachCount++; }
  async sendTurn(turnId: string, input: UserInput[], options: StartTurnParams): Promise<void> {
    this.sent.push({ turnId, input, options }); this.active = turnId;
    if (this.script) void this.play(this.script(turnId, input, this), ++this.generation);
  }
  private async play(steps: Iterable<MockStep> | AsyncIterable<MockStep>, generation: number): Promise<void> {
    try {
      for await (const step of steps) {
        if (this.closed || generation !== this.generation) break;
        if ("waitMs" in step) await new Promise(resolve => setTimeout(resolve, step.waitMs));
        else if ("approval" in step) {
          await new Promise<void>(resolve => this.events.push({ type: "approval", request: step.approval, respond: decision => { step.onDecision?.(decision); resolve(); } }));
        } else this.emit(step);
      }
    } catch (error) { this.events.push({ type: "exit", error: { code: -32015, message: String(error), data: { retryable: false } } }); }
  }
  emit(event: EngineEvent): void { if (event.type === "turnCompleted" && event.turnId === this.active) this.active = null; this.events.push(event); }
  async steer(turnId: string, input: UserInput[]): Promise<void> { this.steered.push({ turnId, input }); }
  async interrupt(turnId: string): Promise<void> {
    this.interrupted.push(turnId); this.generation++;
    this.emit({ type: "turnCompleted", turnId, status: "interrupted" });
  }
  async close(_reason: string): Promise<void> { this.closed = true; this.generation++; this.events.end(); }
}

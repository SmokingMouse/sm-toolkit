import {
  ErrorCode, FrameSchema, MethodSchemas, NotificationMethodSchema, NotificationSchemas,
  PendingServerRequestSchema, ProtocolError, ServerRequestSchemas,
  type AttachResult, type Frame, type Item, type Method, type MethodParams, type MethodResult,
  type NotificationMethod, type NotificationParams, type PendingServerRequest, type RpcId,
  type ServerNotification, type ServerRequestMethod, type ServerRequestParams, type ServerRequestResult,
} from "../protocol/index.js";
import { openWire, type ClientEndpoint, type ClientWire } from "./wire.js";

export type ClientState = "disconnected" | "connecting" | "reconnecting" | "connected" | "closed";
export interface ClientOptions {
  token?: string;
  protocolVersion?: string;
  client?: MethodParams<"initialize">["client"];
  capabilities?: MethodParams<"initialize">["capabilities"];
  reconnect?: false | { minDelayMs?: number; maxDelayMs?: number };
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
}
export type ServerRequestHandle<M extends ServerRequestMethod = ServerRequestMethod> = {
  [K in M]: { id: RpcId; method: K; params: ServerRequestParams<K>;
    /** Sends a JSON-RPC response. Rejections arrive through onError; success through resolved. */
    respond(result: ServerRequestResult<K>): void;
  }
}[M];
interface Cursor { highest: number }
interface Call { method: Method; params: MethodParams<Method>; resolve(result: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }
type Listener<T> = (value: T) => void;

/** AS v1 client. Snapshots are upserts by item.id; delta notifications are live only. */
export class AgentClient {
  private wire?: ClientWire;
  private connecting?: Promise<void>;
  private generation = 0;
  private sequence = 0;
  private stopped = false;
  private everConnected = false;
  private retries = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private calls = new Map<RpcId, Call>();
  private cursors = new Map<string, Cursor>();
  private pending = new Map<string, ServerRequestHandle>();
  private frameListeners = new Set<Listener<Frame>>();
  private notifications = new Set<Listener<ServerNotification>>();
  private requests = new Set<Listener<ServerRequestHandle>>();
  private snapshots = new Set<Listener<AttachResult>>();
  private states = new Set<Listener<ClientState>>();
  private errors = new Set<(error: Error, id?: RpcId | null) => void>();
  private currentState: ClientState = "disconnected";
  private initialized?: MethodResult<"initialize">;
  constructor(readonly endpoint: ClientEndpoint, readonly options: ClientOptions = {}) {}
  get state(): ClientState { return this.currentState; }
  get clientId(): string | undefined { return this.initialized?.clientId; }
  get initializeResult(): MethodResult<"initialize"> | undefined { return this.initialized && structuredClone(this.initialized); }
  get pendingRequests(): ReadonlyMap<string, ServerRequestHandle> { return new Map(this.pending); }

  static async connectUnix(options: ClientOptions & { path: string }): Promise<AgentClient> {
    const client = new AgentClient({ transport: "unix", path: options.path }, options);
    try { await client.connect(); return client; } catch (error) { client.close(); throw error; }
  }
  static async connectWebSocket(options: ClientOptions & { url: string }): Promise<AgentClient> {
    const client = new AgentClient({ transport: "ws", url: options.url }, options);
    try { await client.connect(); return client; } catch (error) { client.close(); throw error; }
  }
  onFrame(listener: Listener<Frame>): () => void { return this.listen(this.frameListeners, listener); }
  onStateChange(listener: Listener<ClientState>): () => void { return this.listen(this.states, listener); }
  onSnapshot(listener: Listener<AttachResult>): () => void { return this.listen(this.snapshots, listener); }
  onError(listener: (error: Error, id?: RpcId | null) => void): () => void { this.errors.add(listener); return () => this.errors.delete(listener); }
  onNotification<M extends NotificationMethod>(method: M, listener: Listener<NotificationParams<M>>): () => void {
    return this.listen(this.notifications, frame => { if (frame.method === method) listener(frame.params as NotificationParams<M>); });
  }
  onServerRequest<M extends ServerRequestMethod>(method: M, listener: Listener<ServerRequestHandle<M>>): () => void {
    return this.listen(this.requests, request => { if (request.method === method) listener(request as ServerRequestHandle<M>); });
  }
  private listen<T>(listeners: Set<Listener<T>>, listener: Listener<T>): () => void { listeners.add(listener); return () => listeners.delete(listener); }
  private emit<T>(listeners: Set<Listener<T>>, value: T): void {
    for (const listener of [...listeners]) { try { listener(value); } catch (error) { this.error(error as Error); } }
  }
  private error(error: Error, id?: RpcId | null): void { for (const listener of [...this.errors]) { try { listener(error, id); } catch { /* Consumer isolation. */ } } }
  private setState(state: ClientState): void { if (this.currentState !== state) { this.currentState = state; this.emit(this.states, state); } }

  connect(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("client closed"));
    if (this.currentState === "connected") return Promise.resolve();
    if (this.connecting) return this.connecting;
    clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined;
    this.connecting = this.open().finally(() => { this.connecting = undefined; if (!this.wire) this.scheduleReconnect(); });
    return this.connecting;
  }
  private async open(): Promise<void> {
    const generation = ++this.generation;
    this.setState(this.everConnected ? "reconnecting" : "connecting");
    try {
      const wire = await openWire(this.endpoint, text => { if (generation === this.generation) this.receive(text); }, error => this.lost(generation, error), this.options.connectTimeoutMs ?? 5000);
      if (this.stopped || generation !== this.generation) { wire.close(); throw new Error("connection cancelled"); }
      this.wire = wire;
      this.initialized = await this.call("initialize", {
        protocolVersion: this.options.protocolVersion ?? "as/1", token: this.options.token,
        client: this.options.client ?? { name: "agent-client", version: "0.1.0", kind: "library", label: "agent-client" },
        capabilities: { engineEvents: true, ...this.options.capabilities },
      });
      this.send({ jsonrpc: "2.0", method: "initialized", params: {} });
      for (const threadId of [...this.cursors.keys()]) {
        try { await this.call("thread/attach", { threadId, sinceSeq: this.sinceSeq(threadId) }); }
        catch (error) {
          if (error instanceof ProtocolError && error.code === ErrorCode.thread_not_found) { this.cursors.delete(threadId); this.error(error); }
          else throw error;
        }
      }
      if (generation !== this.generation || this.stopped) throw new Error("connection cancelled");
      this.everConnected = true; this.retries = 0; this.setState("connected");
    } catch (error) {
      if (error instanceof ProtocolError && (error.code === ErrorCode.unauthorized || error.code === ErrorCode.unsupported_protocol_version)) this.close();
      this.lost(generation, error as Error);
      throw error;
    }
  }
  private lost(generation: number, error: Error): void {
    if (generation !== this.generation) return;
    ++this.generation;
    const wire = this.wire; this.wire = undefined; wire?.close(); this.pending.clear();
    for (const call of this.calls.values()) { clearTimeout(call.timer); call.reject(error); }
    this.calls.clear(); this.setState(this.stopped ? "closed" : "disconnected"); this.scheduleReconnect();
  }
  private scheduleReconnect(): void {
    if (this.stopped || !this.everConnected || this.options.reconnect === false || this.connecting || this.reconnectTimer) return;
    const options = this.options.reconnect || {};
    const delay = Math.min(options.maxDelayMs ?? 5000, (options.minDelayMs ?? 100) * 2 ** Math.min(this.retries++, 16));
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; void this.connect().catch(error => this.error(error)); }, delay);
  }
  close(): void { this.stopped = true; clearTimeout(this.reconnectTimer); this.lost(this.generation, new Error("client closed")); }

  async request<M extends Method>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    await this.connect(); return this.call(method, params);
  }
  engineControl(params: MethodParams<"thread/engineControl">): Promise<MethodResult<"thread/engineControl">> { return this.request("thread/engineControl", params); }
  private call<M extends Method>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    const id = `cli_${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.calls.delete(id); reject(new Error(`${method} timed out; delivery is unknown`)); }, this.options.requestTimeoutMs ?? 30_000);
      this.calls.set(id, { method, params: structuredClone(params), resolve: result => resolve(result as MethodResult<M>), reject, timer });
      try { this.send({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { clearTimeout(timer); this.calls.delete(id); reject(error); }
    });
  }
  private send(frame: unknown): void {
    if (!this.wire) throw new Error("client disconnected");
    try { this.wire.send(JSON.stringify(frame)); }
    catch (error) { this.lost(this.generation, error as Error); throw error; }
  }
  private receive(text: string): void {
    try {
      const frame = FrameSchema.parse(JSON.parse(text));
      this.emit(this.frameListeners, structuredClone(frame));
      if (!("method" in frame)) {
        const call = frame.id === null ? undefined : this.calls.get(frame.id);
        if (call) {
          this.calls.delete(frame.id!); clearTimeout(call.timer);
          if ("error" in frame) call.reject(new ProtocolError(frame.error.code, frame.error.message, frame.error.data));
          else {
            try {
              const result = MethodSchemas[call.method].result.parse(frame.result);
              this.trackResult(call.method, call.params, result); call.resolve(result);
            } catch (error) { call.reject(error); }
          }
        } else if ("error" in frame) this.error(new ProtocolError(frame.error.code, frame.error.message, frame.error.data), frame.id);
        return;
      }
      if ("id" in frame) {
        const request = PendingServerRequestSchema.parse(frame);
        if (!this.options.capabilities?.serverRequests?.includes(request.method)) throw new Error(`undeclared server request: ${request.method}`);
        this.rememberRequest(request, frame.id); return;
      }
      const known = NotificationMethodSchema.safeParse(frame.method);
      // AS v1 can add notifications without a version bump; onFrame still exposes them.
      if (!known.success) return;
      const method = known.data;
      const parsed = NotificationSchemas[method].safeParse(frame.params);
      // A malformed notification is local to this frame, not a broken connection.
      if (!parsed.success) { this.error(parsed.error); return; }
      const params = parsed.data;
      const notification = { jsonrpc: "2.0", method, params } as ServerNotification;
      if (notification.method === "thread/started") this.cursor(notification.params.threadId);
      if (notification.method === "item/started" || notification.method === "item/completed") this.trackItem(notification.params.threadId, notification.params.item);
      if (notification.method === "serverRequest/resolved" || notification.method === "serverRequest/expired") this.pending.delete(notification.params.requestId);
      this.emit(this.notifications, notification);
    } catch (error) { this.error(error as Error); this.lost(this.generation, error as Error); }
  }
  private rememberRequest(request: PendingServerRequest, id: RpcId): void {
    const generation = this.generation;
    const handle = { ...request, id, respond: (result: ServerRequestResult) => {
      if (generation !== this.generation) throw new Error("server request belongs to a disconnected connection");
      const validated = ServerRequestSchemas[request.method].result.parse(result);
      this.send({ jsonrpc: "2.0", id, result: validated });
    } } as ServerRequestHandle;
    const previous = this.pending.get(request.params.requestId);
    this.pending.set(request.params.requestId, handle);
    if (previous?.id !== id) this.emit(this.requests, handle);
  }
  private cursor(threadId: string): Cursor {
    let cursor = this.cursors.get(threadId);
    if (!cursor) { cursor = { highest: 0 }; this.cursors.set(threadId, cursor); }
    return cursor;
  }
  private trackItem(threadId: string, item: Item): void {
    const cursor = this.cursor(threadId); cursor.highest = Math.max(cursor.highest, item.seq, item.completedSeq ?? 0);
  }
  /** Server completion cursors reconcile items finished while disconnected. */
  sinceSeq(threadId: string): number {
    return this.cursors.get(threadId)?.highest ?? 0;
  }
  private trackResult(method: Method, params: MethodParams<Method>, result: unknown): void {
    if (method === "thread/detach") {
      const { threadId } = params as MethodParams<"thread/detach">;
      this.cursors.delete(threadId);
      for (const [id, request] of this.pending) if (request.params.threadId === threadId) this.pending.delete(id);
    } else if (method === "thread/attach") {
      const snapshot = result as AttachResult, threadId = snapshot.thread.id;
      const cursor = this.cursor(threadId);
      cursor.highest = Math.max(cursor.highest, snapshot.nextSeq - 1);
      for (const item of snapshot.items) this.trackItem(threadId, item);
      const pendingIds = new Set(snapshot.pendingRequests.map(request => request.params.requestId));
      for (const [id, request] of this.pending) if (request.params.threadId === threadId && !pendingIds.has(id)) this.pending.delete(id);
      // The attach response has logical IDs; the preceding reverse frames supply connection-local IDs.
      for (const request of snapshot.pendingRequests) {
        const handle = this.pending.get(request.params.requestId);
        if (handle) this.rememberRequest(request, handle.id);
      }
      this.emit(this.snapshots, structuredClone(snapshot));
    } else if (method === "thread/start" || method === "thread/resume" || method === "thread/fork") this.cursor((result as MethodResult<"thread/start">).thread.id);
  }
}

export const connectUnix = AgentClient.connectUnix;
export const connectWebSocket = AgentClient.connectWebSocket;

import { CODEX_SCHEMA_VERSION } from "../../engines/codex-version.js";
import { ErrorCode, ProtocolError, rpcError, ServerRequestMethodSchema, ServerRequestSchemas, type Frame, type RpcId, type ServerRequestMethod } from "../../protocol/index.js";
import type { AgentServer, InProcessClient } from "../../server/server.js";
import type { ControlClient, NativeObject } from "./control-process.js";
import { CodexRouter, NativeRpcError } from "./router.js";

export function nativeDecision(method: ServerRequestMethod, result: NativeObject): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: decision object required");
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
    const decisions: Record<string, string> = { accept: "accept", acceptForSession: "acceptForSession", decline: "reject", cancel: "abort" };
    if (typeof result.decision !== "string" || !Object.hasOwn(decisions, result.decision)) throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: unsupported approval decision");
    return ServerRequestSchemas[method].result.parse({ decision: decisions[result.decision] });
  }
  if (method === "item/permissions/requestApproval") {
    if (result.scope !== "turn" && result.scope !== "session") throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: unsupported permission scope");
    return ServerRequestSchemas[method].result.parse({ permissions: result.permissions, scope: result.scope === "session" ? "thread" : "turn" });
  }
  return ServerRequestSchemas[method].result.parse(result);
}

/** Each WebSocket owns exactly one authenticated AS connection. */
export class CodexSession {
  readonly client: InProcessClient;
  readonly router: CodexRouter;
  private state: "new" | "initializing" | "initialized" | "ready" | "closed" = "new";
  private abort = new AbortController();
  private reverse = new Map<RpcId, { requestId: string; method: ServerRequestMethod }>();
  private logical = new Map<string, RpcId>();
  private optOut = new Set<string>();
  private unsubscribe: () => void;
  private unclose: () => void;
  constructor(server: AgentServer, private readonly control: ControlClient, private readonly options: { token: string; send: (frame: NativeObject) => void; end?: () => void; audit?: (message: string) => void }) {
    this.client = server.connectInProcess();
    this.router = new CodexRouter(server, this.client, control, this.abort.signal);
    this.unsubscribe = this.client.onFrame(frame => this.fromAS(frame));
    this.unclose = this.client.onClose(() => { this.close(); options.end?.(); });
  }
  private send(frame: NativeObject): void {
    if (this.state === "closed") return;
    if (frame.method && frame.id == null && this.optOut.has(frame.method) && frame.method !== "serverRequest/resolved") return;
    try { this.options.send(frame); } catch { this.close(); this.options.end?.(); }
  }
  async receive(raw: unknown): Promise<void> {
    if (this.state === "closed") return;
    const f = raw as NativeObject;
    const id = f && (typeof f.id === "string" || (typeof f.id === "number" && Number.isSafeInteger(f.id))) ? f.id : null;
    try {
      if (!f || typeof f !== "object" || Array.isArray(f) || ("id" in f && id === null) || (f.jsonrpc != null && f.jsonrpc !== "2.0")) throw new ProtocolError(ErrorCode.invalid_request, "as-ingress: invalid native frame");
      if (!f.method) {
        if (this.state !== "ready") throw new ProtocolError(ErrorCode.not_initialized, "as-ingress: initialize and initialized required");
        const pending = id === null ? undefined : this.reverse.get(id);
        if (!pending || !("result" in f) || "error" in f) throw new ProtocolError(ErrorCode.invalid_request, "as-ingress: unknown approval or missing decision");
        await this.client.respond(id!, nativeDecision(pending.method, f.result)); return;
      }
      if (typeof f.method !== "string" || "result" in f || "error" in f) throw new ProtocolError(ErrorCode.invalid_request, "as-ingress: invalid request");
      const p = f.params ?? {};
      if (typeof p !== "object" || Array.isArray(p)) throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: params must be an object");
      if (f.method === "initialized" && id === null) {
        if (this.state !== "initialized") throw new ProtocolError(ErrorCode.not_initialized, "as-ingress: invalid initialized notification");
        // AS send serializes its own frames. Mark ready before awaiting so a
        // native startup burst can queue immediately behind initialized.
        this.state = "ready"; await this.client.notifyInitialized(); return;
      }
      if (id === null) throw new ProtocolError(ErrorCode.invalid_request, "as-ingress: request ID required");
      if (f.method === "initialize") {
        if (this.state !== "new") throw new ProtocolError(ErrorCode.invalid_request, "as-ingress: already initialized");
        if (typeof p.clientInfo?.name !== "string" || typeof p.clientInfo?.version !== "string") throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: clientInfo required");
        if (p.capabilities?.requestAttestation === true) throw new ProtocolError(ErrorCode.unsupported_capability, "as-ingress: attestation unavailable");
        const optOut = p.capabilities?.optOutNotificationMethods;
        if (optOut != null && (!Array.isArray(optOut) || optOut.some((v: unknown) => typeof v !== "string"))) throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: invalid notification opt-outs");
        this.optOut = new Set(optOut ?? []); this.state = "initializing";
        const result = await this.control.initialize();
        await this.client.request("initialize", { protocolVersion: "as/1", token: this.options.token,
          client: { name: "codex-tui", version: p.clientInfo.version, kind: "tui", label: `codex-tui:${this.client.clientId}` },
          capabilities: { pendingRequests: true, engineEvents: true, bashInput: false, serverRequests: ServerRequestMethodSchema.options },
        });
        const version = String(result.userAgent ?? "").match(/^[^\s/]+\/(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)(?=\s|$)/)?.[1];
        if (version !== CODEX_SCHEMA_VERSION) {
          const message = `Codex version ${version ?? "unknown"} differs from pinned schema ${CODEX_SCHEMA_VERSION}`;
          this.options.audit?.(message); this.send({ method: "warning", params: { message } });
        }
        if (this.client.closed) return;
        this.state = "initialized"; this.send({ id, result }); return;
      }
      if (this.state !== "ready") throw new ProtocolError(ErrorCode.not_initialized, "as-ingress: initialize and initialized required");
      this.send({ id, result: await this.router.request(f.method, p) });
    } catch (error) {
      if (error instanceof NativeRpcError) { this.send({ id, error: { code: error.code, message: error.message } }); return; }
      const rpc = rpcError(error);
      this.send({ id, error: { ...rpc, message: `${rpc.message.startsWith("as-ingress: ") ? "" : "as-ingress: "}${rpc.message}${rpc.data?.holder ? ` (holder: ${rpc.data.holder.label})` : ""}` } });
      if (this.state === "initializing") { this.close(); this.options.end?.(); }
    }
  }
  private fromAS(frame: Frame): void {
    if (!("method" in frame)) {
      if (frame.id !== null && this.reverse.has(frame.id) && "error" in frame) this.send({ id: frame.id, error: frame.error });
      return;
    }
    const p = frame.params as NativeObject;
    if ("id" in frame) {
      const method = ServerRequestMethodSchema.safeParse(frame.method); if (!method.success) return;
      const raw = p.data?.raw;
      if (!raw || typeof raw !== "object") return;
      this.reverse.set(frame.id, { method: method.data, requestId: p.requestId }); this.logical.set(p.requestId, frame.id);
      const params = structuredClone(raw);
      if (method.data === "item/commandExecution/requestApproval" || method.data === "item/fileChange/requestApproval") {
        const supported = ["accept", "acceptForSession", "decline", "cancel"];
        params.availableDecisions = Array.isArray(raw.availableDecisions) ? raw.availableDecisions.filter((d: unknown) => typeof d === "string" && supported.includes(d)) : supported;
      }
      this.send({ id: frame.id, method: method.data, params }); return;
    }
    if (frame.method === "thread/engineEvent" && p.backend === "codex" && typeof p.payload?.method === "string") {
      // Broker owns card closure; engine request IDs are process-local and collide.
      if (p.payload.method !== "serverRequest/resolved") this.send(p.payload);
    } else if (frame.method === "serverRequest/resolved" || frame.method === "serverRequest/expired") {
      const id = this.logical.get(p.requestId); if (id === undefined) return;
      const thread = this.router.server.threads.get(p.threadId);
      this.send({ method: "serverRequest/resolved", params: { threadId: thread.engineThreadId, requestId: id, ...(p.decidedBy ? { decidedBy: p.decidedBy } : {}), ...(p.reason ? { reason: p.reason } : {}) } });
      this.logical.delete(p.requestId); this.reverse.delete(id);
    } else if (frame.method === "thread/metadata/updated" && typeof p.title === "string") {
      const thread = this.router.server.threads.get(p.threadId);
      this.send({ method: "thread/name/updated", params: { threadId: thread.engineThreadId, threadName: p.title } });
    } else if (frame.method === "error") {
      // CodexEventMapper also projects each native error into AS. Its raw error
      // object identifies that projection; the original frame was sent above.
      if (p.error.code === ErrorCode.engine_unavailable && p.error.data?.raw?.message === p.error.message) return;
      const thread = this.router.server.threads.get(p.threadId);
      this.send({ method: "error", params: { threadId: thread.engineThreadId, error: { message: p.error.message, codexErrorInfo: null, additionalDetails: null }, willRetry: p.willRetry } });
    }
  }
  parseError(): void { this.send({ id: null, error: { code: ErrorCode.parse, message: "as-ingress: invalid JSON" } }); }
  close(): void {
    if (this.state === "closed") return;
    this.state = "closed"; this.abort.abort(); this.unsubscribe?.(); this.unclose?.(); this.client.close(); this.reverse.clear(); this.logical.clear();
  }
}

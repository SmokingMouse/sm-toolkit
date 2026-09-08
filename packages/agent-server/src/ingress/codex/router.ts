import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { CodexEngine } from "../../engines/codex.js";
import { ErrorCode, ProtocolError, type StartThreadParams, type Thread, UserInputSchema } from "../../protocol/index.js";
import type { AgentServer, InProcessClient } from "../../server/server.js";
import { CONTROL_METHODS, type ControlClient, type NativeObject } from "./control-process.js";

/** Preserve native app-server errors without AS codes or message prefixes. */
export class NativeRpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

export function nativeThreadId(thread: Thread): string {
  if (thread.backend !== "codex" || !thread.engineThreadId) throw new ProtocolError(ErrorCode.backend_unsupported, "as-ingress: slice 1 requires a Codex thread");
  return thread.engineThreadId;
}
export function resolveThread(server: AgentServer, id: unknown): Thread {
  if (typeof id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: native thread UUID required");
  const thread = server.log.findEngine(id, "codex");
  if (!thread) throw new ProtocolError(ErrorCode.thread_not_found, "as-ingress: unknown Codex thread");
  return thread;
}
function effectiveSandbox(options: Pick<StartThreadParams, "sandbox" | "permission">): string | undefined {
  return options.sandbox ?? (options.permission === "readonly" ? "read-only" : options.permission === "full" ? "danger-full-access" : options.permission ? "workspace-write" : undefined);
}
export function nativeOptions(p: NativeObject, current: Partial<StartThreadParams> = {}): Partial<StartThreadParams> {
  if (p.serviceTier != null && p.serviceTier !== "default") throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: serviceTier must be default");
  if (p.serviceTierForTurn != null && p.serviceTierForTurn !== "default") throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: serviceTierForTurn must be default");
  if (p.approvalsReviewer != null && p.approvalsReviewer !== "user") throw new ProtocolError(ErrorCode.unauthorized, "as-ingress: approvalsReviewer must be user");
  const sandbox = p.sandbox ?? (p.sandboxPolicy ? ({ readOnly: "read-only", workspaceWrite: "workspace-write", dangerFullAccess: "danger-full-access" } as Record<string, string>)[p.sandboxPolicy.type] : undefined);
  if (p.sandboxPolicy != null && (!sandbox || Object.keys(p.sandboxPolicy).some(k => !["type", "networkAccess", "writableRoots", "excludeTmpdirEnvVar", "excludeSlashTmp"].includes(k)))) throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: unsupported sandboxPolicy");
  if (sandbox != null && !["read-only", "workspace-write", "danger-full-access"].includes(sandbox)) throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: unsupported sandbox");
  if (p.approvalPolicy != null && !["never", "untrusted", "on-request"].includes(p.approvalPolicy)) throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: unsupported approvalPolicy");
  let permission: StartThreadParams["permission"];
  if (p.approvalPolicy === "never") {
    const mode = sandbox ?? effectiveSandbox(current);
    if (mode === "read-only") permission = "readonly";
    else if (mode === "danger-full-access") permission = "full";
    else throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: never requires read-only or danger-full-access sandbox");
  } else if (p.approvalPolicy === "untrusted") permission = "default";
  else if (p.approvalPolicy === "on-request") permission = "auto-edit";
  // A sandbox override cannot silently bypass the lease required for full access.
  if (sandbox === "danger-full-access" && permission !== "full") throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: full access requires explicit never approval policy");
  return {
    ...(p.model != null ? { model: p.model } : {}), ...(p.cwd != null ? { cwd: p.cwd } : {}),
    ...(p.effort != null ? { effort: p.effort } : {}), ...(sandbox ? { sandbox } : {}), ...(permission ? { permission } : {}),
  };
}

/** The durable engine UUID index plus ThreadManager.live are the routing table. */
export class CodexRouter {
  constructor(readonly server: AgentServer, readonly client: InProcessClient, readonly control: ControlClient, private readonly signal?: AbortSignal) {}
  private engine(thread: Thread): CodexEngine {
    const engine = this.server.threads.session(thread.id);
    if (!(engine instanceof CodexEngine)) throw new ProtocolError(ErrorCode.backend_unsupported, "as-ingress: native Codex engine required");
    return engine;
  }
  async allowedPath(path: string): Promise<void> {
    const config = await this.client.request("server/config/read", {});
    let actual: string;
    try { actual = realpathSync(path); } catch { throw new ProtocolError(ErrorCode.unauthorized, "as-ingress: inaccessible path"); }
    if (actual === "/" || !config.allowed_roots.some(root => { const child = relative(root, actual); return child === "" || (child !== ".." && !child.startsWith("../") && !isAbsolute(child)); })) throw new ProtocolError(ErrorCode.unauthorized, "as-ingress: path outside allowed_roots");
  }
  private async paths(p: NativeObject): Promise<void> {
    for (const key of ["cwd", "path", "marketplacePath"]) if (p[key] != null) { if (typeof p[key] !== "string") throw new ProtocolError(ErrorCode.invalid_params, `as-ingress: invalid ${key}`); await this.allowedPath(p[key]); }
    for (const key of ["cwds", "runtimeWorkspaceRoots"]) if (p[key] != null) {
      if (!Array.isArray(p[key]) || p[key].some((v: unknown) => typeof v !== "string")) throw new ProtocolError(ErrorCode.invalid_params, `as-ingress: invalid ${key}`);
      for (const path of p[key]) await this.allowedPath(path);
    }
    for (const path of p.sandboxPolicy?.writableRoots ?? []) await this.allowedPath(path);
  }
  private rejectExtras(p: NativeObject): void {
    for (const key of ["permissions", "permissionProfile", "modelProvider", "developerInstructions", "environments", "selectedCapabilityRoots", "outputSchema", "fjContext", "toolOutput", "additionalContext"]) if (p[key] != null) throw new ProtocolError(ErrorCode.unsupported_capability, `as-ingress: ${key} is unavailable in slice 1`);
    if (p.collaborationMode != null) {
      if (p.collaborationMode.mode !== "default") throw new ProtocolError(ErrorCode.unsupported_capability, "as-ingress: only default collaboration mode is supported");
      const settings = p.collaborationMode.settings;
      if (settings?.model != null && p.model != null && settings.model !== p.model) throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: conflicting collaboration model");
      if (settings?.reasoning_effort != null && p.effort != null && settings.reasoning_effort !== p.effort) throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: conflicting collaboration effort");
      p.model ??= settings?.model; p.effort ??= settings?.reasoning_effort;
    }
    if (p.config != null && (typeof p.config !== "object" || Array.isArray(p.config) || Object.keys(p.config).some(k => !["web_search", "personality"].includes(k)))) throw new ProtocolError(ErrorCode.unauthorized, "as-ingress: native config overrides are not supported");
    if (p.ephemeral === true) throw new ProtocolError(ErrorCode.unsupported_capability, "as-ingress: ephemeral threads are unsupported");
  }
  private async guardThread(thread: Thread, options: Partial<StartThreadParams>): Promise<void> {
    const saved = this.server.log.options<StartThreadParams>(thread.id);
    await this.allowedPath(options.cwd ?? thread.cwd);
    if (thread.permission === "readonly" && ((options.permission && options.permission !== "readonly") || (options.sandbox && options.sandbox !== "read-only"))) throw new ProtocolError(ErrorCode.unauthorized, "as-ingress: readonly thread cannot be elevated");
    if (saved.fjContext && options.model != null && options.model !== "gpt-6-astra") throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: fj Codex requires gpt-6-astra");
    if (options.permission === "full") await this.client.request("thread/lease/acquire", { threadId: thread.id });
  }
  private threadView(thread: Thread): NativeObject {
    const engine = this.server.threads.live.get(thread.id);
    const native = engine instanceof CodexEngine ? engine.nativeThreadStart().thread : thread.meta?.nativeThreadData;
    return { forkedFromId: null, parentThreadId: null,
      preview: thread.title ?? "", ephemeral: false, modelProvider: "unknown", createdAt: Math.floor(thread.createdAtMs / 1000),
      updatedAt: Math.floor(thread.createdAtMs / 1000), cwd: thread.cwd, cliVersion: "", source: "appServer", gitInfo: null,
      name: thread.title ?? null, turns: [], historyMode: "paginated", ...(native as NativeObject ?? {}),
      id: nativeThreadId(thread), sessionId: nativeThreadId(thread),
      ...(thread.title !== undefined ? { name: thread.title } : {}),
      status: { type: thread.status.type === "running" ? "active" : thread.status.type === "systemError" ? "systemError" : "idle", ...(thread.status.type === "running" ? { activeFlags: [] } : {}) },
    };
  }
  async request(method: string, p: NativeObject = {}): Promise<NativeObject> {
    if (CONTROL_METHODS.has(method)) {
      await this.paths(p);
      if (method === "account/read" && p.refreshToken === true) throw new ProtocolError(ErrorCode.unauthorized, "as-ingress: token refresh is unsupported");
      const result = await this.control.request(method, p);
      if (method === "model/list") return { ...result, data: result.data.filter((model: NativeObject) => {
        try { this.server.threads.model(model.model, "codex", `ingress_${this.client.clientId}`); return true; } catch { return false; }
      }).map((model: NativeObject) => ({ ...model, serviceTiers: [], additionalSpeedTiers: [], defaultServiceTier: null })) };
      return result;
    }
    switch (method) {
      case "thread/start": {
        this.rejectExtras(p); const options = nativeOptions(p); await this.paths(p);
        if (!options.cwd && p.runtimeWorkspaceRoots?.length) options.cwd = p.runtimeWorkspaceRoots[0];
        const { thread } = await this.client.request("thread/start", { ...options, backend: "codex", serviceTier: "default", permission: options.permission ?? "default", ...(p.baseInstructions != null ? { systemPrompt: p.baseInstructions } : {}) });
        const result = this.engine(thread).nativeThreadStart();
        // The ID mapping stays in the existing durable engine index. This shadow
        // contains presentation fields for listing after the owning process exits.
        thread.meta = { ...thread.meta, nativeThreadData: result.thread }; this.server.log.saveThread(thread);
        return result;
      }
      case "thread/resume": {
        this.rejectExtras(p); const thread = resolveThread(this.server, p.threadId);
        const saved = this.server.log.options<StartThreadParams>(thread.id);
        const options = nativeOptions(p, { ...saved, permission: thread.permission }); await this.paths(p);
        await this.guardThread(thread, options);
        // AS attach to a live thread intentionally keeps its saved settings.
        if (this.server.threads.live.has(thread.id)) {
          const effective = { ...saved, model: thread.model, cwd: thread.cwd, permission: thread.permission, sandbox: effectiveSandbox({ ...saved, permission: thread.permission }) };
          for (const key of ["model", "cwd", "sandbox", "permission", "effort"] as const) if (options[key] != null && options[key] !== effective[key]) throw new ProtocolError(ErrorCode.invalid_params, `as-ingress: live resume cannot override ${key}`);
        }
        await this.client.request("thread/resume", { ...options, threadId: thread.id, backend: "codex" });
        const engine = this.engine(thread), response = engine.nativeThreadStart();
        const result = { ...response, ...await engine.nativeThreadRead(true) };
        const title = this.server.threads.get(thread.id).title;
        if (title !== undefined) result.thread.name = title;
        return result;
      }
      case "turn/start": {
        this.rejectExtras(p); const thread = resolveThread(this.server, p.threadId);
        const saved = this.server.log.options<StartThreadParams>(thread.id);
        const options = nativeOptions(p, { ...saved, permission: thread.permission }); await this.paths(p);
        await this.guardThread(thread, { ...options, permission: options.permission ?? thread.permission });
        if (!Array.isArray(p.input)) throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: input array required");
        const input = p.input.map((part: NativeObject) => UserInputSchema.parse(part.type === "localImage" ? { type: "image", path: part.path, mime: "application/octet-stream" } : part));
        for (const part of input) if (part.type === "image" || part.type === "file") await this.allowedPath(part.path);
        const engine = this.engine(thread);
        const { turn } = await this.client.request("turn/start", { ...options, threadId: thread.id, input, permission: options.permission ?? thread.permission, sandbox: options.sandbox ?? saved.sandbox, ...(p.clientUserMessageId ? { clientTurnId: p.clientUserMessageId } : {}) });
        try { return await engine.waitNativeTurn(turn.id, this.signal); }
        catch (error) {
          // A queued AS turn has no native ID yet. Do not report a timeout and
          // leave that undisclosed turn to execute later behind a long approval.
          if (!this.signal?.aborted && this.server.log.turn(turn.id).status === "queued") await this.client.request("turn/cancel", { threadId: thread.id, turnId: turn.id });
          throw error;
        }
      }
      case "turn/interrupt": {
        const thread = resolveThread(this.server, p.threadId), turnId = this.server.threads.queue(thread.id).runningTurnId;
        if (p.turnId === undefined) throw new NativeRpcError(-32600, "Invalid request: missing field `turnId`");
        if (typeof p.turnId !== "string") throw new ProtocolError(ErrorCode.invalid_params, "turnId must be a string");
        // Upstream turn_interrupt_inner: empty ID is startup cancellation; a
        // named terminal/absent turn is InvalidRequest, not AS turn_not_active.
        if (!turnId) {
          if (p.turnId === "") return {};
          throw new NativeRpcError(-32600, "no active turn to interrupt");
        }
        const nativeId = this.engine(thread).nativeTurnId(turnId);
        if (p.turnId !== "" && nativeId && nativeId !== p.turnId) throw new NativeRpcError(-32600, `expected active turn id ${p.turnId} but found ${nativeId}`);
        try { await this.client.request("turn/interrupt", { threadId: thread.id, turnId }); }
        catch (error) {
          if (error instanceof ProtocolError && error.code === ErrorCode.turn_not_active) {
            if (p.turnId === "") return {};
            throw new NativeRpcError(-32600, "no active turn to interrupt");
          }
          if (error instanceof ProtocolError && typeof error.data.raw === "string") {
            let native: NativeObject | undefined;
            try { native = JSON.parse(error.data.raw); } catch { /* Non-native AS failure. */ }
            if (native && typeof native.code === "number" && typeof native.message === "string") throw new NativeRpcError(native.code, native.message);
          }
          throw error;
        }
        return {};
      }
      case "thread/name/set": {
        const thread = resolveThread(this.server, p.threadId);
        if (typeof p.name !== "string" || !p.name.trim()) throw new NativeRpcError(-32600, "thread name must not be empty");
        return this.client.request("thread/name/set", { threadId: thread.id, name: p.name });
      }
      case "thread/read": {
        const thread = resolveThread(this.server, p.threadId); await this.allowedPath(thread.cwd);
        await this.client.request("thread/read", { threadId: thread.id });
        const result = await this.engine(thread).nativeThreadRead(p.includeTurns === true);
        const title = this.server.threads.get(thread.id).title;
        if (title !== undefined) result.thread.name = title;
        return result;
      }
      case "thread/items/list":
      case "thread/turns/list": {
        const thread = resolveThread(this.server, p.threadId); await this.allowedPath(thread.cwd);
        await this.client.request("thread/read", { threadId: thread.id });
        try { return await this.engine(thread).nativeThreadHistory(method, p); }
        catch (error) {
          // Native 0.153.4 has no rollout before the first message. This is a
          // verified empty history, not a fallback for arbitrary read failures.
          if (method === "thread/turns/list" && error instanceof ProtocolError && error.message.includes("not materialized yet; thread/turns/list is unavailable before first user message")) return { data: [], nextCursor: null };
          throw error;
        }
      }
      case "thread/list": {
        await this.paths(p);
        const result = await this.client.request("thread/list", { backend: "codex", limit: 10000, ...(p.cwd ? { cwd: p.cwd } : {}) });
        let data = result.threads.filter(t => t.engineThreadId && (p.archived == null || (t.status.type === "closed") === p.archived)).map(t => this.threadView(t));
        if (p.modelProviders?.length) data = data.filter(t => p.modelProviders.includes(t.modelProvider));
        if (p.sourceKinds?.length) data = data.filter(t => p.sourceKinds.includes(typeof t.source === "string" ? t.source : "subAgent"));
        if (p.searchTerm) data = data.filter(t => `${t.name ?? ""} ${t.preview}`.toLowerCase().includes(String(p.searchTerm).toLowerCase()));
        if (p.parentThreadId) data = data.filter(t => t.parentThreadId === p.parentThreadId);
        if (p.ancestorThreadId) throw new ProtocolError(ErrorCode.unsupported_capability, "as-ingress: ancestor search unavailable");
        const key = p.sortKey === "created_at" ? "createdAt" : p.sortKey === "updated_at" ? "updatedAt" : "recencyAt";
        data.sort((a, b) => ((b[key] ?? b.updatedAt) - (a[key] ?? a.updatedAt) || a.id.localeCompare(b.id)) * (p.sortDirection === "asc" ? -1 : 1));
        if (p.cursor != null) { const index = data.findIndex(t => t.id === p.cursor); if (index < 0) throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: invalid list cursor"); data = data.slice(index + 1); }
        const limit = p.limit ?? 100;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: invalid list limit");
        const page = data.slice(0, limit); return { data: page, nextCursor: data.length > limit ? page.at(-1)!.id : null };
      }
      case "thread/loaded/list": {
        const health = await this.client.request("server/health", {});
        return { data: health.engines.filter(e => e.backend === "codex" && e.engineThreadId).map(e => e.engineThreadId) };
      }
      case "thread/unsubscribe": {
        const thread = resolveThread(this.server, p.threadId);
        await this.client.request("thread/detach", { threadId: thread.id }); return { status: "unsubscribed" };
      }
      default: throw new ProtocolError(ErrorCode.method_not_found, `as-ingress: unsupported method ${method}`);
    }
  }
}

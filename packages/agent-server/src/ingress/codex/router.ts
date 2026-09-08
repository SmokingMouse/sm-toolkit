import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { CodexEngine } from "../../engines/codex.js";
import { ErrorCode, ProtocolError, type Item, type StartThreadParams, type Thread, UserInputSchema } from "../../protocol/index.js";
import type { AgentServer, InProcessClient } from "../../server/server.js";
import { CONTROL_METHODS, type ControlClient, type NativeObject } from "./control-process.js";
import { claudeItems, claudeSettings, claudeThread, claudeTurn } from "./claude-projection.js";

export const isClaudeModel = (model: string): boolean => /^(claude-|sonnet(?:$|-)|opus(?:$|-)|haiku(?:$|-)|fable(?:$|-))/i.test(model);
const claudeModels = ["sonnet", "opus"].map(model => ({ id: model, model, displayName: `Claude · ${model}`, description: `Claude ${model} via Agent Server; readonly auto-allow requires a trusted PATH executable (rg without ripgrep always requires approval)`, hidden: false,
  isDefault: false, supportedReasoningEfforts: [], defaultReasoningEffort: "medium", inputModalities: ["text", "image"] }));

/** Preserve native app-server errors without AS codes or message prefixes. */
export class NativeRpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

export function nativeThreadId(thread: Thread): string {
  if (thread.backend === "claude") return thread.id.slice(3);
  if (thread.backend !== "codex" || !thread.engineThreadId) throw new ProtocolError(ErrorCode.backend_unsupported, "as-ingress: unsupported thread backend");
  return thread.engineThreadId;
}
export function resolveThread(server: AgentServer, id: unknown): Thread {
  if (typeof id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: native thread UUID required");
  const thread = server.log.findEngine(id, "codex") ?? findClaudeThread(server, `th_${id}`);
  if (!thread) throw new ProtocolError(ErrorCode.thread_not_found, "as-ingress: unknown thread");
  return thread;
}
export function findClaudeThread(server: AgentServer, asId: string): Thread | undefined {
  try {
    const thread = server.log.thread(asId);
    return thread.backend === "claude" ? thread : undefined;
  } catch (error) {
    if (error instanceof ProtocolError && error.code === ErrorCode.thread_not_found) return undefined;
    throw error;
  }
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
  constructor(readonly server: AgentServer, readonly client: InProcessClient, readonly control: ControlClient, private readonly signal?: AbortSignal, readonly claudeThreads = false) {}
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
    if (options.model != null) {
      this.server.threads.model(options.model, thread.backend, thread.id);
      if (isClaudeModel(options.model) !== (thread.backend === "claude")) throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: changing backend requires a new thread");
    }
    if (thread.backend === "codex" && saved.fjContext && options.model != null && options.model !== "gpt-6-astra") throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: fj Codex requires gpt-6-astra");
  }
  private threadView(thread: Thread): NativeObject {
    if (thread.backend === "claude") return claudeThread(thread);
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
  private claudeResponse(thread: Thread, includeTurns = false): NativeObject {
    thread = this.server.threads.get(thread.id);
    const items = includeTurns ? this.server.log.snapshot(thread.id).items : [];
    return { ...claudeSettings(thread), thread: claudeThread(thread, includeTurns ? this.server.log.turns(thread.id).map(t => claudeTurn(t, items, nativeThreadId(thread))) : []) };
  }
  private claudeOnly(thread: Thread, method: string): void {
    if (thread.backend !== "claude") throw new ProtocolError(ErrorCode.method_not_found, `as-ingress: unsupported method ${method} on Codex threads`);
  }
  private input(p: NativeObject): ReturnType<typeof UserInputSchema.parse>[] {
    if (!Array.isArray(p.input)) throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: input array required");
    return p.input.map((part: NativeObject) => UserInputSchema.parse(part.type === "localImage" ? { type: "image", path: part.path, mime: "application/octet-stream" } : part));
  }
  private claudeOptions(options: Partial<StartThreadParams>, thread?: Thread): Partial<StartThreadParams> {
    // Native sandbox is a UI permission selector; Claude enforces AS permission
    // rather than accepting a Codex sandbox override.
    const { sandbox, ...rest } = options;
    if (sandbox === "read-only") rest.permission = "readonly";
    if (thread && rest.effort !== undefined && rest.effort !== this.server.log.options<StartThreadParams>(thread.id).effort)
      throw new ProtocolError(ErrorCode.method_not_found, "as-ingress: Claude 线程 effort 只在新建时生效");
    return rest;
  }
  private async claudeHistory(thread: Thread, method: string, p: NativeObject): Promise<NativeObject> {
    const direction = p.sortDirection ?? "desc", limit = p.limit ?? 100;
    if (!["asc", "desc"].includes(direction) || !Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: invalid history pagination");
    const scope = `${nativeThreadId(thread)}:${method}:${p.turnId ?? ""}`;
    let anchor: number | undefined, inclusive = false;
    if (p.cursor != null) {
      try { const c = JSON.parse(Buffer.from(p.cursor, "base64url").toString());
        if (c.scope !== scope || !Number.isSafeInteger(c.anchor) || c.anchor < 0 || typeof c.inclusive !== "boolean") throw new Error();
        anchor = c.anchor; inclusive = c.inclusive;
      } catch { throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: invalid history cursor"); }
    }
    const cursor = (anchor: number, inclusive: boolean) => Buffer.from(JSON.stringify({ scope, anchor, inclusive })).toString("base64url");
    const snapshot: Item[] = [];
    let asCursor: string | undefined;
    do {
      const page = await this.client.request("thread/items/list", { threadId: thread.id, direction: "asc", limit: 10000, ...(asCursor ? { cursor: asCursor } : {}) });
      snapshot.push(...page.items); asCursor = page.nextCursor ?? undefined;
    } while (asCursor);
    let rows: Array<{ ordinal: number; value: NativeObject }>;
    if (method === "thread/turns/list") {
      if (p.itemsView != null && !["full", "notLoaded", "summary"].includes(p.itemsView)) throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: invalid itemsView");
      rows = this.server.log.turns(thread.id).map(t => ({ ordinal: t.ordinal, value: p.itemsView === "notLoaded" ? { ...claudeTurn(t, [], nativeThreadId(thread)), itemsView: "notLoaded" } : claudeTurn(t, snapshot, nativeThreadId(thread)) }));
    } else {
      // Keep AS seq cursors private. Each page is an immutable ordered slice of
      // the AS snapshot, including secondary image/subagent presentation items.
      rows = snapshot.filter(i => p.turnId == null || i.turnId === p.turnId).flatMap(i => claudeItems(i, nativeThreadId(thread)).map((item, n) => ({ ordinal: i.seq * 4 + n, value: { turnId: i.turnId, item } })));
    }
    rows.sort((a, b) => (a.ordinal - b.ordinal) * (direction === "asc" ? 1 : -1));
    if (anchor !== undefined) rows = rows.filter(r => direction === "asc" ? inclusive ? r.ordinal >= anchor! : r.ordinal > anchor! : inclusive ? r.ordinal <= anchor! : r.ordinal < anchor!);
    const page = rows.slice(0, limit);
    return { data: page.map(r => r.value), nextCursor: rows.length > limit ? cursor(page.at(-1)!.ordinal, false) : null, backwardsCursor: page.length ? cursor(page[0]!.ordinal, true) : null };
  }
  async request(method: string, p: NativeObject = {}): Promise<NativeObject> {
    if (!this.claudeThreads && typeof p.threadId === "string" && !this.server.log.findEngine(p.threadId, "codex") && findClaudeThread(this.server, `th_${p.threadId}`))
      throw new ProtocolError(ErrorCode.method_not_found, "as-ingress: Claude threads are disabled by codex_ingress.claude_threads");
    if (CONTROL_METHODS.has(method)) {
      await this.paths(p);
      if (method === "account/read" && p.refreshToken === true) throw new ProtocolError(ErrorCode.unauthorized, "as-ingress: token refresh is unsupported");
      const result = await this.control.request(method, p);
      if (method === "model/list") return { ...result, data: [...result.data, ...(this.claudeThreads && result.nextCursor == null ? claudeModels : [])].filter((model: NativeObject) => {
        if (!this.claudeThreads && isClaudeModel(model.model)) return false;
        try { this.server.threads.model(model.model, isClaudeModel(model.model) ? "claude" : "codex", `ingress_${this.client.clientId}`); return true; } catch { return false; }
      }).map((model: NativeObject) => ({ ...model, serviceTiers: [], additionalSpeedTiers: [], defaultServiceTier: null })) };
      return result;
    }
    switch (method) {
      case "thread/start": {
        this.rejectExtras(p); const options = nativeOptions(p); await this.paths(p);
        if (!options.cwd && p.runtimeWorkspaceRoots?.length) options.cwd = p.runtimeWorkspaceRoots[0];
        const model = this.server.threads.model(options.model, "codex", `ingress_${this.client.clientId}`), backend = isClaudeModel(model) ? "claude" : "codex";
        if (backend === "claude" && !this.claudeThreads) throw new ProtocolError(ErrorCode.method_not_found, "as-ingress: Claude threads are disabled by codex_ingress.claude_threads");
        const selected = backend === "claude" ? this.claudeOptions(options) : options;
        const { thread } = await this.client.request("thread/start", { ...selected, model, backend, ...(backend === "codex" ? { serviceTier: "default" as const } : {}), permission: selected.permission ?? "default", ...(p.baseInstructions != null ? { systemPrompt: p.baseInstructions } : {}) });
        if (backend === "claude") return this.claudeResponse(thread);
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
        if (thread.backend === "claude") this.claudeOptions(options, thread);
        await this.guardThread(thread, options);
        // AS attach to a live thread intentionally keeps its saved settings.
        if (this.server.threads.live.has(thread.id)) {
          const effective = { ...saved, model: thread.model, cwd: thread.cwd, permission: thread.permission, sandbox: effectiveSandbox({ ...saved, permission: thread.permission }) };
          for (const key of ["model", "cwd", "sandbox", "permission", "effort"] as const) if (options[key] != null && options[key] !== effective[key]) throw new ProtocolError(ErrorCode.invalid_params, `as-ingress: live resume cannot override ${key}`);
        }
        // Repeating the saved permission is an attachment, not an escalation.
        const selected = thread.backend === "claude" ? this.claudeOptions(options) : { ...options };
        if (selected.permission === thread.permission) delete selected.permission;
        if (this.server.threads.live.has(thread.id)) await this.client.request("thread/attach", { threadId: thread.id });
        else await this.client.request("thread/resume", { ...selected, threadId: thread.id, backend: thread.backend });
        if (thread.backend === "claude") return { ...this.claudeResponse(thread, p.excludeTurns !== true), initialTurnsPage: p.initialTurnsPage ? await this.claudeHistory(thread, "thread/turns/list", p.initialTurnsPage) : null, turnsBackwardsCursor: null, itemsBackwardsCursor: null };
        const engine = this.engine(thread), response = engine.nativeThreadStart();
        const result: NativeObject = { ...response, ...await engine.nativeThreadRead(p.excludeTurns !== true), initialTurnsPage: null, turnsBackwardsCursor: null, itemsBackwardsCursor: null };
        if (result.thread.historyMode === "paginated") {
          // Same one-entry descending probes as upstream
          // paginated_resume_backwards_cursors; never translate opaque cursors.
          const turns = await engine.nativeThreadHistory("thread/turns/list", { limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
          const items = await engine.nativeThreadHistory("thread/items/list", { limit: 1, sortDirection: "desc" });
          result.turnsBackwardsCursor = turns.backwardsCursor;
          result.itemsBackwardsCursor = items.backwardsCursor;
        }
        if (p.initialTurnsPage != null) result.initialTurnsPage = await engine.nativeThreadHistory("thread/turns/list", p.initialTurnsPage);
        const title = this.server.threads.get(thread.id).title;
        if (title !== undefined) result.thread.name = title;
        return result;
      }
      case "turn/start": {
        this.rejectExtras(p); const thread = resolveThread(this.server, p.threadId);
        const saved = this.server.log.options<StartThreadParams>(thread.id);
        const options = nativeOptions(p, { ...saved, permission: thread.permission }); await this.paths(p);
        await this.guardThread(thread, { ...options, permission: options.permission ?? thread.permission });
        const input = this.input(p);
        for (const part of input) if (part.type === "image" || part.type === "file") await this.allowedPath(part.path);
        const engine = thread.backend === "codex" ? this.engine(thread) : undefined;
        const selected = thread.backend === "claude" ? this.claudeOptions(options, thread) : { ...options, sandbox: options.sandbox ?? saved.sandbox };
        // Omit an unchanged permission so AS applies its ordinary input rule.
        // Actual overrides still pass through AS escalation checks.
        if (selected.permission === thread.permission) delete selected.permission;
        const { turn } = await this.client.request("turn/start", { ...selected, threadId: thread.id, input, ...(p.clientUserMessageId ? { clientTurnId: p.clientUserMessageId } : {}) });
        if (!engine) return { turn: claudeTurn(turn, this.server.log.snapshot(thread.id).items, nativeThreadId(thread)) };
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
        const engine = thread.backend === "codex" ? this.engine(thread) : undefined;
        const nativeId = engine ? engine.nativeTurnId(turnId) ?? (p.turnId !== "" ? (await engine.waitNativeTurn(turnId, this.signal)).turn.id : undefined) : turnId;
        if (p.turnId !== "" && nativeId !== p.turnId) throw new NativeRpcError(-32600, `expected active turn id ${p.turnId} but found ${nativeId}`);
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
        if (thread.backend === "claude") return { thread: this.claudeResponse(thread, p.includeTurns === true).thread };
        const result = await this.engine(thread).nativeThreadRead(p.includeTurns === true);
        const title = this.server.threads.get(thread.id).title;
        if (title !== undefined) result.thread.name = title;
        return result;
      }
      case "thread/items/list":
      case "thread/turns/list": {
        const thread = resolveThread(this.server, p.threadId); await this.allowedPath(thread.cwd);
        await this.client.request("thread/read", { threadId: thread.id });
        if (thread.backend === "claude") return this.claudeHistory(thread, method, p);
        return this.engine(thread).nativeThreadHistory(method, p);
      }
      case "thread/list": {
        await this.paths(p);
        const result = await this.client.request("thread/list", { limit: 10000, ...(p.cwd ? { cwd: p.cwd } : {}) });
        let data = result.threads.filter(t => (this.claudeThreads && t.backend === "claude" || t.backend === "codex" && t.engineThreadId) && (p.archived == null || (t.status.type === "closed") === p.archived)).map(t => this.threadView(t));
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
        return { data: health.engines.filter(e => this.claudeThreads && e.backend === "claude" || e.backend === "codex" && e.engineThreadId).map(e => e.backend === "claude" ? e.threadId.slice(3) : e.engineThreadId) };
      }
      case "turn/steer": {
        const thread = resolveThread(this.server, p.threadId); this.claudeOnly(thread, method);
        await this.guardThread(thread, {});
        const input = this.input(p); for (const part of input) if (part.type === "image" || part.type === "file") await this.allowedPath(part.path);
        await this.client.request("turn/steer", { threadId: thread.id, expectedTurnId: p.expectedTurnId, input });
        return { turnId: p.expectedTurnId };
      }
      case "thread/settings/update": {
        const thread = resolveThread(this.server, p.threadId); this.claudeOnly(thread, method); this.rejectExtras(p);
        for (const key of Object.keys(p)) if (p[key] != null && !["threadId", "model", "approvalPolicy", "sandbox", "sandboxPolicy", "effort", "serviceTier", "approvalsReviewer", "collaborationMode"].includes(key)) throw new ProtocolError(ErrorCode.method_not_found, `as-ingress: unsupported Claude setting ${key}`);
        const options = nativeOptions(p, { permission: thread.permission }); await this.paths(p); await this.guardThread(thread, options);
        const selected = this.claudeOptions(options, thread);
        if (selected.model !== undefined) {
          const result = await this.client.request("thread/engineControl", { threadId: thread.id, subtype: "set_model", params: { model: selected.model } });
          if ((result.response as NativeObject)?.subtype === "error") throw new ProtocolError(ErrorCode.method_not_found, `as-ingress: Claude rejected model update: ${(result.response as NativeObject).error}`);
        }
        if (selected.permission !== undefined && selected.permission !== thread.permission) {
          const elevate = selected.permission === "full";
          if (elevate) await this.client.request("thread/lease/acquire", { threadId: thread.id, ttlMs: 10_000 });
          try { await this.client.request("thread/permission/set", { threadId: thread.id, permission: selected.permission }); }
          finally {
            // A disconnect clears our lease; an expired lease may already have
            // a new owner. Never release that owner's lease or mask the error.
            if (elevate && this.server.leases.read(thread.id)?.holder.clientId === this.client.clientId)
              await this.client.request("thread/lease/release", { threadId: thread.id });
          }
        }
        return {};
      }
      case "thread/compact/start": {
        const thread = resolveThread(this.server, p.threadId); this.claudeOnly(thread, method); await this.guardThread(thread, {});
        await this.client.request("thread/compact", { threadId: thread.id }); return {};
      }
      case "thread/fork": {
        const thread = resolveThread(this.server, p.threadId); this.claudeOnly(thread, method); await this.guardThread(thread, {});
        for (const key of Object.keys(p)) if (p[key] != null && !["threadId", "fromItemId"].includes(key)) throw new ProtocolError(ErrorCode.method_not_found, `as-ingress: unsupported Claude fork option ${key}`);
        const result = await this.client.request("thread/fork", { threadId: thread.id, ...(p.fromItemId ? { fromItemId: p.fromItemId } : {}) });
        return this.claudeResponse(result.thread, true);
      }
      case "thread/archive": {
        const thread = resolveThread(this.server, p.threadId); this.claudeOnly(thread, method); await this.guardThread(thread, {});
        return this.client.request("thread/close", { threadId: thread.id });
      }
      case "thread/unsubscribe": {
        const thread = resolveThread(this.server, p.threadId);
        await this.client.request("thread/detach", { threadId: thread.id }); return { status: "unsubscribed" };
      }
      default: throw new ProtocolError(ErrorCode.method_not_found, `as-ingress: unsupported method ${method}`);
    }
  }
}

import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, chmodSync, statSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { AgentServer } from "../../server/server.js";
import { CodexEngine } from "../../engines/codex.js";
import { MockEngine } from "../../engines/mock.js";
import { mapCodexDecision } from "../../engines/codex-mapper.js";
import { ServerRequestMethodSchema } from "../../protocol/index.js";
import { until } from "../../test-helpers.test.js";
import { readConfig, runDaemon } from "../../daemon/runtime.js";
import { resolveDaemonPaths } from "../../daemon/paths.js";
import { CodexSession, nativeDecision } from "./session.js";
import { nativeOptions, nativeThreadId, resolveThread } from "./router.js";
import { defaultCodexUnixPath, listenCodex, MAX_NATIVE_FRAME_BYTES } from "./listener.js";
import { NATIVE_METHOD_POLICY, methodPolicy, READONLY_OVERRIDE_DENY } from "./method-policy.js";
import { CONTROL_METHODS, ControlProcess, type NativeObject, type ControlClient } from "./control-process.js";

const cleanups: Array<() => void | Promise<void>> = [];

test("pinned experimental method table is exhaustive; every denied method rejects and audits for every permission", async () => {
  const schema = JSON.parse(readFileSync(new URL("../../../../../docs/agent-server/codex-schema/0.153.4/ClientRequest.json", import.meta.url), "utf8"));
  const methods: string[] = schema.oneOf.map((v: any) => v.properties.method.enum[0]);
  expect(Object.keys(NATIVE_METHOD_POLICY).sort()).toEqual(methods.sort());
  const documented = readFileSync(new URL("../../../../../docs/agent-server/codex-method-policy.md", import.meta.url), "utf8").split("readonly 追加 deny 表")[0];
  expect([...documented.matchAll(/^\| `([^`]+)` \|/gm)].map(m => m[1]).sort()).toEqual(methods.sort());
  for (const method of methods) {
    expect(["handshake", "control-read", "as-governed", "owner-read", "deny"]).toContain(methodPolicy(method));
    expect(CONTROL_METHODS.has(method)).toBe(methodPolicy(method) === "control-read");
  }
  const f = setup(), c = connection(f); await c.initialize();
  for (const permission of ["readonly", "default", "full"]) {
    const start = await c.session.client.request("thread/start", { backend: "codex", cwd: f.root, model: "gpt-6-astra", permission: permission as any });
    const threadId = nativeThreadId(start.thread);
    const calls = f.control.calls.length;
    const denied = [...methods.filter(m => methodPolicy(m) === "deny"), "workspace/create", "userVerification/verify", "future/execute", "toString", "__proto__"];
    for (const method of denied) {
      await c.session.receive({ id: `${permission}:${method}`, method, params: { threadId, path: "/", command: "touch forbidden" } });
      expect(c.frames.at(-1)?.error?.code).toBe(-32601);
      const audit = f.server.log.db.query("SELECT * FROM ingress_audit ORDER BY id DESC LIMIT 1").get() as any;
      expect(audit.method).toBe(method); expect(audit.client_id).toBe(c.session.client.clientId); expect(audit.thread_id).toBe(threadId);
    }
    expect(f.control.calls.length).toBe(calls);
    expect(f.server.log.turns(start.thread.id)).toHaveLength(0);
  }
  for (const method of CONTROL_METHODS) expect(methodPolicy(method)).toBe("control-read");
});

test("readonly explicit deny table blocks sandbox and reviewer overrides at every supported entry", async () => {
  const f = setup(), c = connection(f); await c.initialize();
  const { thread } = await c.request("thread/start", { cwd: f.root, model: "gpt-6-astra", approvalPolicy: "never", sandbox: "read-only" });
  for (const method of Object.keys(READONLY_OVERRIDE_DENY)) {
    for (const override of [{ sandbox: "workspace-write" }, { sandboxPolicy: { type: "dangerFullAccess" }, approvalPolicy: "never" }, { approvalsReviewer: "auto_review" }]) {
      await expect(c.request(method, { threadId: thread.id, input: [{ type: "text", text: "forbidden" }], ...override })).rejects.toThrow();
    }
  }
  const as = resolveThread(f.server, thread.id);
  expect(f.server.log.turns(as.id)).toHaveLength(0);
  expect(f.server.threads.get(as.id).permission).toBe("readonly");
  expect(f.server.log.db.query("SELECT count(*) AS n FROM ingress_audit").get()).toEqual({ n: 9 });
});

test("unix WebSocket uses CODEX_HOME namespace, private modes, and never replaces existing paths", async () => {
  expect(defaultCodexUnixPath({ CODEX_HOME: "/test/codex", HOME: "/else" })).toBe("/test/codex/agent-server/ingress.sock");
  expect(defaultCodexUnixPath({ HOME: "/test/home" })).toBe("/test/home/.codex/agent-server/ingress.sock");
  const f = setup(), path = join(f.root, "native", "ingress.sock");
  const listener = listenCodex(f.server, { token: "secret", unixPath: path, control: f.control });
  cleanups.push(() => listener.close());
  expect(listener.url).toBe("unix://" + path);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(join(f.root, "native")).mode & 0o777).toBe(0o700);
  const response = await fetch("http://localhost/", { unix: path });
  expect(response.status).toBe(426); // no bearer required; must still upgrade
  expect((await fetch("http://localhost/", { unix: path, headers: { Origin: "http://localhost" } })).status).toBe(403);
  expect(() => listenCodex(f.server, { token: "secret", unixPath: path, control: f.control })).toThrow("already exists");
  const publicDir = join(f.root, "public"); mkdirSync(publicDir, { mode: 0o755 });
  expect(() => listenCodex(f.server, { token: "secret", unixPath: join(publicDir, "sock"), control: f.control })).toThrow("0700");
});

test("native engine death clears activeTurn and close remains usable", async () => {
  const f = setup("hold"), c = connection(f); await c.initialize();
  const { thread } = await c.request("thread/start", { cwd: f.root, model: "gpt-6-astra" });
  await c.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "hold" }] });
  const as = resolveThread(f.server, thread.id), turnId = f.server.threads.queue(as.id).runningTurnId!;
  (f.engines[0] as any).process.kill("SIGKILL");
  await until(() => f.server.threads.get(as.id).status.type === "systemError");
  expect(f.server.threads.queue(as.id).runningTurnId).toBeNull();
  expect((f.engines[0] as any).active).toBeUndefined();
  expect(f.server.log.turn(turnId).status).toBe("failed");
  await expect(c.session.client.request("thread/close", { threadId: as.id })).resolves.toEqual({});
});

test("disconnect during native start acknowledgement leaves the daemon turn running to completion", async () => {
  const f = setup("hold-delayed"), c = connection(f); await c.initialize();
  const { thread } = await c.request("thread/start", { cwd: f.root, model: "gpt-6-astra" });
  const pending = c.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "hold" }] });
  const as = resolveThread(f.server, thread.id);
  await until(() => !!f.server.threads.queue(as.id).runningTurnId);
  const id = f.server.threads.queue(as.id).runningTurnId!;
  c.session.close(); await pending;
  await until(() => !!f.engines[0].nativeTurnId(id));
  expect(f.server.log.turn(id).status).toBe("inProgress");
  f.engines[0].receive({ method: "turn/completed", params: { threadId: thread.id, turn: { id: f.engines[0].nativeTurnId(id), status: "completed", items: [], error: null } } });
  await until(() => f.server.log.turn(id).status === "completed");
  expect(f.server.threads.live.has(as.id)).toBe(true);
});

test("codex_tui local tool calls go to one owner, remap IDs and survive owner disconnect without approval bypass", async () => {
  const f = setup("hold"), a = connection(f), b = connection(f); await a.initialize(); await b.initialize();
  const { thread } = await a.request("thread/start", { cwd: f.root, model: "gpt-6-astra" });
  const { turn } = await a.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "hold" }] });
  await b.request("thread/resume", { threadId: thread.id });
  const frame = { id: "local-1", method: "item/tool/call", params: { namespace: "codex_tui", tool: "local", arguments: { x: 1 }, callId: "call", threadId: thread.id, turnId: turn.id } };
  f.engines[0].receive(frame);
  await until(() => a.frames.some(f => f.method === "item/tool/call"));
  const first = a.frames.find(f => f.method === "item/tool/call")!;
  expect(first.id).not.toBe(frame.id); expect(first.params).toEqual(frame.params);
  expect(b.frames.some(f => f.method === "item/tool/call")).toBe(false);
  a.session.close();
  await until(() => b.frames.some(f => f.method === "item/tool/call"));
  const second = b.frames.find(f => f.method === "item/tool/call")!;
  expect(second.id).not.toBe(first.id);
  const sent: any[] = []; (f.engines[0] as any).write = (v: any) => sent.push(v);
  const result = { success: true, contentItems: [{ type: "inputText", text: "done" }] };
  await b.session.receive({ id: second.id, result });
  expect(sent).toEqual([{ id: frame.id, result }]);
  expect(f.engines[0].nativeToolCalls.size).toBe(0);
  expect(f.server.log.pendingRequests(resolveThread(f.server, thread.id).id)).toHaveLength(0);
  f.engines[0].receive({ ...frame, id: "blocked", params: { ...frame.params, namespace: "mcp" } });
  expect(sent.at(-1).error.message).toContain("Unknown Codex server request");
});

afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function temporary() {
  const root = realpathSync(mkdtempSync("/tmp/as-ingress-test-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true })); return root;
}
class FakeControl implements ControlClient {
  calls: Array<{ method: string; params?: NativeObject }> = [];
  closed = false;
  version = "0.153.4";
  async initialize() { this.calls.push({ method: "initialize" }); return { userAgent: `codex-tui/${this.version}`, codexHome: "/tmp/fake", platformFamily: "unix", platformOs: "macos" }; }
  async request(method: string, params?: NativeObject) { this.calls.push({ method, params }); return method === "model/list" ? { data: [{ id: "good", model: "gpt-6-astra" }, { id: "bad", model: "fable" }], nextCursor: null } : { marker: method }; }
  async close() { this.closed = true; }
}
function setup(scenario = "simple", requestTimeoutMs?: number, mixed = false) {
  const root = temporary(), control = new FakeControl(), engines: CodexEngine[] = [];
  const claude = new MockEngine();
  const server = new AgentServer({ databasePath: join(root, "db"), token: "secret", allowedRoots: [root], idleTimeoutMs: 0, engineFactory: backend => {
    if (mixed && backend === "claude") return claude;
    const nativeId = crypto.randomUUID();
    const engine = new CodexEngine({ requestTimeoutMs, spawnProcess: (_cmd, _args, opts) => spawn(process.execPath, [resolve(import.meta.dir, "../../../scripts/fixtures/fake-codex-app-server.ts")], {
      ...opts, env: { ...opts.env, FAKE_CODEX_SCENARIO: scenario, FAKE_CODEX_THREAD_ID: nativeId }, stdio: "pipe",
    }) }); engines.push(engine); return engine;
  } });
  cleanups.push(() => server.close());
  return { root, server, control, engines, claude, mixed };
}
function connection(f: ReturnType<typeof setup>) {
  const frames: NativeObject[] = [];
  const session = new CodexSession(f.server, f.control, { token: "secret", claudeThreads: f.mixed, send: frame => frames.push(frame) });
  cleanups.push(() => session.close());
  let id = 0;
  const request = async (method: string, params: NativeObject = {}) => {
    const key = ++id; await session.receive({ id: key, method, params });
    const response = frames.find(frame => frame.id === key && ("result" in frame || "error" in frame));
    if (response?.error) throw new Error(response.error.message);
    return response?.result;
  };
  const initialize = async () => { await request("initialize", { clientInfo: { name: "test", version: "0.153.4" } }); await session.receive({ method: "initialized" }); };
  return { session, frames, request, initialize };
}

test("native handshake gates requests and tolerates a pipelined initialized startup burst", async () => {
  const f = setup(), c = connection(f);
  await expect(c.request("model/list")).rejects.toThrow("initialize");
  const init = await c.request("initialize", { clientInfo: { name: "codex-tui", version: "0.153.4" } });
  expect(init).toEqual({ userAgent: "codex-tui/0.153.4", codexHome: "/tmp/fake", platformFamily: "unix", platformOs: "macos" });
  await expect(c.request("model/list")).rejects.toThrow("initialize");
  const initialized = c.session.receive({ method: "initialized" });
  const models = c.request("model/list");
  await initialized; expect((await models).data.map((m: NativeObject) => m.model)).toEqual(["gpt-6-astra"]);
  await expect(c.request("initialize", { clientInfo: { name: "test", version: "1" } })).rejects.toThrow("already initialized");
  const other = connection(f); await other.initialize(); expect(c.session.client.clientId).not.toBe(other.session.client.clientId);
  for (const frame of c.frames) expect(frame.jsonrpc).toBeUndefined();
});

test("version mismatch emits native warning and audit; invalid frames fail explicitly", async () => {
  const f = setup(); f.control.version = "99.0.0";
  const frames: NativeObject[] = [], audit: string[] = [];
  const c = new CodexSession(f.server, f.control, { token: "secret", send: x => frames.push(x), audit: x => audit.push(x) });
  cleanups.push(() => c.close());
  await c.receive({ id: 1, method: "initialize", params: { clientInfo: { name: "test", version: "1" } } });
  expect(frames.find(f => f.method === "warning")?.params.message).toContain("99.0.0"); expect(audit).toHaveLength(1);
  for (const raw of [null, [], { id: {}, method: "model/list" }, { id: 2, method: "model/list", params: [] }]) await c.receive(raw);
  expect(frames.filter(f => f.error)).toHaveLength(4);
});

test("four decision bridges preserve values and reject unsupported extensions", () => {
  for (const method of ServerRequestMethodSchema.options.slice(0, 2)) {
    for (const decision of ["accept", "acceptForSession", "decline", "cancel"]) {
      expect(mapCodexDecision(method, nativeDecision(method, { decision }) as any)).toEqual({ decision });
    }
    for (const decision of ["reject", "abort", "toString", "acceptWithExecpolicyAmendment", { applyNetworkPolicyAmendment: {} }]) expect(() => nativeDecision(method, { decision })).toThrow();
  }
  expect(nativeDecision("item/permissions/requestApproval", { permissions: { network: { enabled: true } }, scope: "session" })).toEqual({ permissions: { network: { enabled: true } }, scope: "thread" });
  expect(() => nativeDecision("item/permissions/requestApproval", { permissions: {}, scope: "thread" })).toThrow();
  expect(nativeDecision("item/tool/requestUserInput", { answers: { q: { answers: ["yes", "extra"] } } })).toEqual({ answers: { q: { answers: ["yes", "extra"] } } });
});

test("native UUID routes across connections; AS mutations own turn IDs, resume, interrupt and leases", async () => {
  const f = setup("hold"), a = connection(f), b = connection(f); await a.initialize(); await b.initialize();
  const first = await a.request("thread/start", { cwd: f.root, model: "gpt-6-astra", approvalPolicy: "on-request", sandbox: "workspace-write" });
  const second = await b.request("thread/start", { cwd: f.root, model: "gpt-6-astra" });
  const asThread = resolveThread(f.server, first.thread.id);
  expect(nativeThreadId(asThread)).toBe(first.thread.id); expect(asThread.id).toStartWith("th_");
  expect(resolveThread(f.server, second.thread.id).id).not.toBe(asThread.id);
  expect(() => resolveThread(f.server, asThread.id)).toThrow("UUID");
  expect(() => resolveThread(f.server, crypto.randomUUID())).toThrow("unknown");
  const turn = await a.request("turn/start", { threadId: first.thread.id, input: [{ type: "text", text: "wait" }] });
  const asTurn = f.server.threads.queue(asThread.id).runningTurnId!;
  expect(turn.turn.id).not.toBe(asTurn); expect(f.engines[0].nativeTurnId(asTurn)).toBe(turn.turn.id);
  await expect(b.request("turn/interrupt", { threadId: first.thread.id, turnId: "stale" })).rejects.toThrow(`expected active turn id stale but found ${turn.turn.id}`);
  expect(await b.request("turn/interrupt", { threadId: first.thread.id, turnId: turn.turn.id })).toEqual({});
  await until(() => f.server.log.turn(asTurn).status === "interrupted");
  await b.session.receive({ id: "late", method: "turn/interrupt", params: { threadId: first.thread.id, turnId: turn.turn.id } });
  expect(b.frames.find(frame => frame.id === "late")).toEqual({ id: "late", error: { code: -32600, message: "no active turn to interrupt" } });
  expect(await b.request("turn/interrupt", { threadId: first.thread.id, turnId: "" })).toEqual({});
  await b.session.receive({ id: "missing-turn", method: "turn/interrupt", params: { threadId: first.thread.id } });
  expect(b.frames.find(frame => frame.id === "missing-turn")?.error).toEqual({ code: -32600, message: "Invalid request: missing field `turnId`" });
  const resumed = await b.request("thread/resume", { threadId: first.thread.id }); expect(resumed.thread.id).toBe(first.thread.id);
  expect(f.engines).toHaveLength(2);
  const list = await a.request("thread/list", { limit: 1 }); expect(list.data).toHaveLength(1); expect(list.nextCursor).toBeString();
  expect((await a.request("thread/list", { cursor: list.nextCursor, limit: 1 })).data[0].id).not.toBe(list.data[0].id);
  await a.session.client.request("thread/lease/acquire", { threadId: asThread.id });
  await expect(b.request("thread/name/set", { threadId: first.thread.id, name: "blocked title" })).rejects.toThrow(`codex-tui:${a.session.client.clientId}`);
  await expect(b.request("turn/start", { threadId: first.thread.id, input: [{ type: "text", text: "blocked" }] })).rejects.toThrow(`codex-tui:${a.session.client.clientId}`);
  a.session.close(); expect(f.server.leases.read(asThread.id)).toBeUndefined();
  await b.request("thread/resume", { threadId: first.thread.id });
});

test("full Codex resume and input never acquire a lease; a peer lease still blocks input", async () => {
  const f = setup("hold"), a = connection(f), b = connection(f); await a.initialize(); await b.initialize();
  const { thread } = await a.request("thread/start", { cwd: f.root, model: "gpt-6-astra", approvalPolicy: "never", sandbox: "danger-full-access" });
  const as = resolveThread(f.server, thread.id), full = { threadId: thread.id, approvalPolicy: "never", sandbox: "danger-full-access" };
  for (const c of [a, b]) {
    expect((await c.request("thread/resume", full)).thread.id).toBe(thread.id);
    expect(f.server.leases.read(as.id)).toBeUndefined();
    expect(f.server.log.pendingRequests(as.id)).toEqual([]);
    expect(f.server.log.db.query("SELECT count(*) AS n FROM approvals WHERE thread_id = ?").get(as.id)).toEqual({ n: 0 });
  }
  const { turn } = await b.request("turn/start", { ...full, input: [{ type: "text", text: "ordinary full input" }] });
  expect(f.server.leases.read(as.id)).toBeUndefined();
  await a.session.client.request("thread/lease/acquire", { threadId: as.id });
  expect((await b.request("thread/resume", full)).thread.id).toBe(thread.id);
  await expect(b.request("turn/start", { ...full, input: [{ type: "text", text: "blocked" }] })).rejects.toThrow(`codex-tui:${a.session.client.clientId}`);
  expect(await b.request("turn/interrupt", { threadId: thread.id, turnId: turn.id })).toEqual({});
  expect(await b.session.client.request("thread/close", { threadId: as.id })).toEqual({});
  expect(f.server.leases.read(as.id)).toBeUndefined();
  // A cold native resume must also omit the unchanged full permission.
  expect((await b.request("thread/resume", full)).thread.id).toBe(thread.id);
  expect(f.server.leases.read(as.id)).toBeUndefined();
});

test("cold resume discards cross-backend defaults but applies same-backend models", async () => {
  const f = setup(), c = connection(f); await c.initialize();
  const { thread } = await c.request("thread/start", { cwd: f.root, model: "gpt-6-astra" });
  const asId = resolveThread(f.server, thread.id).id;
  await c.session.client.request("thread/close", { threadId: asId });
  const resumed = await c.request("thread/resume", { threadId: thread.id, model: "sonnet" });
  expect(resumed.model).toBe("gpt-6-astra");
  expect(resumed.thread.id).toBe(thread.id);
  expect(resolveThread(f.server, thread.id).backend).toBe("codex");
  await c.session.client.request("thread/close", { threadId: asId });
  expect((await c.request("thread/resume", { threadId: thread.id, model: "gpt-5.6-sol" })).model).toBe("gpt-5.6-sol");
  expect(c.frames.filter(f => f.method === "warning")).toHaveLength(1);
});

test("native thread names are trimmed, persisted and projected through read, list and resume", async () => {
  const f = setup(), c = connection(f); await c.initialize();
  const { thread } = await c.request("thread/start", { cwd: f.root, model: "gpt-6-astra" });
  expect(await c.request("thread/name/set", { threadId: thread.id, name: "  TUI title  " })).toEqual({});
  const asThread = resolveThread(f.server, thread.id);
  expect(f.server.log.thread(asThread.id).title).toBe("TUI title");
  expect(c.frames.some(frame => frame.method === "thread/name/updated" && frame.params.threadName === "TUI title")).toBe(true);
  expect((await c.request("thread/read", { threadId: thread.id })).thread.name).toBe("TUI title");
  expect((await c.request("thread/list")).data[0].name).toBe("TUI title");
  expect((await c.request("thread/resume", { threadId: thread.id })).thread.name).toBe("TUI title");
  await c.session.receive({ id: "empty-name", method: "thread/name/set", params: { threadId: thread.id, name: "  " } });
  expect(c.frames.find(frame => frame.id === "empty-name")?.error).toEqual({ code: -32600, message: "thread name must not be empty" });
});

for (const scenario of ["history-unsupported", "history-legacy"]) test(`${scenario}: fresh as/1 and native threads expose empty history and accept a turn after resume`, async () => {
  const f = setup(scenario), c = connection(f); await c.initialize();
  const as1 = f.server.connectInProcess(); cleanups.push(() => as1.close());
  await as1.request("initialize", { protocolVersion: "as/1", token: "secret", client: { name: "fj", version: "1", kind: "cli", label: "fj" }, capabilities: {} });
  await as1.notifyInitialized();
  const created = await as1.request("thread/start", { backend: "codex", cwd: f.root, model: "gpt-6-astra" });
  const native = await c.request("thread/start", { cwd: f.root, model: "gpt-6-astra" });
  for (const threadId of [created.thread.engineThreadId!, native.thread.id]) {
    expect(f.server.log.turns(resolveThread(f.server, threadId).id)).toHaveLength(0);
    expect((await c.request("thread/read", { threadId, includeTurns: true })).thread.turns).toEqual([]);
    const empty = { data: [], nextCursor: null, backwardsCursor: null };
    for (const method of ["thread/turns/list", "thread/items/list"]) {
      expect(await c.request(method, { threadId, limit: 1, sortDirection: "desc" })).toEqual(empty);
      await expect(c.request(method, { threadId, cursor: "invalid" })).rejects.toThrow();
    }
    await expect(c.request("thread/items/list", { threadId, turnId: "unknown" })).rejects.toThrow();
    const resumed = await c.request("thread/resume", { threadId, initialTurnsPage: { limit: 1, itemsView: "notLoaded" } });
    expect(resumed.thread.turns).toEqual([]);
    expect(resumed.initialTurnsPage).toEqual(empty);
    expect(resumed.turnsBackwardsCursor).toBeNull(); expect(resumed.itemsBackwardsCursor).toBeNull();
    expect((await c.request("thread/resume", { threadId, excludeTurns: true })).thread.turns).toEqual([]);
    const started = await c.request("turn/start", { threadId, input: [{ type: "text", text: "hello" }] });
    await until(() => c.frames.some(frame => frame.method === "turn/completed" && frame.params.threadId === threadId && frame.params.turn.id === started.turn.id));
    // The exact same native Unsupported error after dispatch is not empty history.
    for (const method of ["thread/turns/list", "thread/items/list", "thread/read"]) await expect(c.request(method, { threadId, includeTurns: true })).rejects.toThrow();
  }
});

test("history failures are never converted to empty pages or successful resume", async () => {
  const f = setup("history-failure"), c = connection(f); await c.initialize();
  const { thread } = await c.request("thread/start", { cwd: f.root, model: "gpt-6-astra" });
  for (const method of ["thread/read", "thread/resume", "thread/turns/list", "thread/items/list"]) await expect(c.request(method, { threadId: thread.id, includeTurns: true })).rejects.toThrow("history database is corrupt");
});

test("an imported native thread is not assumed empty just because AS has no turns", async () => {
  const f = setup("history-unsupported"), c = connection(f); await c.initialize();
  const threadId = crypto.randomUUID();
  const imported = await c.session.client.request("thread/resume", { engineThreadId: threadId, backend: "codex", cwd: f.root, model: "gpt-6-astra" });
  expect(f.server.log.turns(imported.thread.id)).toHaveLength(0);
  for (const method of ["thread/read", "thread/resume", "thread/turns/list", "thread/items/list"]) await expect(c.request(method, { threadId, includeTurns: true })).rejects.toThrow("not supported yet");
});

test("named interrupt waits for native acknowledgement and cannot interrupt a different turn during startup", async () => {
  const f = setup("hold-delayed"), c = connection(f); await c.initialize();
  const { thread } = await c.request("thread/start", { cwd: f.root, model: "gpt-6-astra" });
  const asThread = resolveThread(f.server, thread.id);
  const { turn } = await c.session.client.request("turn/start", { threadId: asThread.id, input: [{ type: "text", text: "hold" }] });
  expect(f.engines[0].nativeTurnId(turn.id)).toBeUndefined();
  await expect(c.request("turn/interrupt", { threadId: thread.id, turnId: "wrong" })).rejects.toThrow("expected active turn id wrong but found native-turn-");
  expect(f.server.log.turn(turn.id).status).toBe("inProgress");
  expect(c.frames.some(frame => frame.method === "turn/completed")).toBe(false);
  expect(await c.request("turn/interrupt", { threadId: thread.id, turnId: f.engines[0].nativeTurnId(turn.id) })).toEqual({});
  await until(() => f.server.log.turn(turn.id).status === "interrupted");
});

test("all four reverse requests go through broker, preserve raw native fields and resolve once", async () => {
  const f = setup("conversation"), c = connection(f); await c.initialize();
  const { thread } = await c.request("thread/start", { cwd: f.root, model: "gpt-6-astra" });
  await c.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "approvals" }] });
  const decisions = [{ decision: "acceptForSession" }, { decision: "decline" }, { permissions: { network: { enabled: true } }, scope: "session" }, { answers: { q: { answers: ["a"] } } }];
  for (let index = 0; index < 4; index++) {
    const method = ServerRequestMethodSchema.options[index];
    await until(() => c.frames.some(f => f.method === method && f.id));
    const frame = c.frames.find(f => f.method === method && f.id)!;
    expect(frame.params.threadId).toBe(thread.id); expect(frame.params.turnId).toStartWith("native-turn-");
    if (index === 0) { expect(frame.params.proposedExecpolicyAmendment).toEqual(["pwd"]); expect(frame.params.availableDecisions).toEqual(["accept", "acceptForSession", "decline", "cancel"]); }
    if (index === 3) expect(frame.params.questions[0].isOther).toBe(true);
    await c.session.receive({ id: frame.id, result: decisions[index] });
    expect(c.frames.filter(f => f.method === "serverRequest/resolved" && f.params.requestId === frame.id)).toHaveLength(1);
  }
  await until(() => c.frames.some(f => f.method === "turn/completed"));
  const rows = f.server.log.db.query("SELECT status,decided_by FROM approvals").all() as any[];
  expect(rows).toHaveLength(4); for (const row of rows) { expect(row.status).toBe("decided"); expect(JSON.parse(row.decided_by).label).toBe(`codex-tui:${c.session.client.clientId}`); }
  expect(c.frames.filter(f => f.method === "serverRequest/resolved")).toHaveLength(4);
});

test("a queued native turn that times out is cancelled through AS instead of executing later", async () => {
  const f = setup("hold", 60), c = connection(f); await c.initialize();
  const { thread } = await c.request("thread/start", { cwd: f.root, model: "gpt-6-astra" });
  await c.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "hold" }] });
  await expect(c.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "later" }] })).rejects.toThrow("acknowledgement timed out");
  const asThread = resolveThread(f.server, thread.id);
  expect(f.server.log.turns(asThread.id).map(t => t.status)).toEqual(["inProgress", "cancelled"]);
  expect(f.server.threads.queue(asThread.id).read()).toEqual([]);
});

test("native errors retain their full raw payload and do not duplicate the AS projection", async () => {
  const f = setup("native-error"), c = connection(f); await c.initialize();
  const { thread } = await c.request("thread/start", { cwd: f.root, model: "gpt-6-astra" });
  await c.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "retry" }] });
  await until(() => c.frames.some(f => f.method === "turn/completed"));
  const errors = c.frames.filter(f => f.method === "error");
  expect(errors).toHaveLength(1);
  expect(errors[0].params.error).toEqual({ message: "temporary provider error", codexErrorInfo: "serverOverloaded" });
  expect(errors[0].params.threadId).toBe(thread.id); expect(errors[0].params.willRetry).toBe(true);
});

test("other clients and expiration close pending native cards; reconnect replays broker requests", async () => {
  const f = setup("conversation"), a = connection(f), b = connection(f); await a.initialize(); await b.initialize();
  const { thread } = await a.request("thread/start", { cwd: f.root, model: "gpt-6-astra" });
  await a.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "approval" }] });
  await until(() => a.frames.some(f => f.id && f.method === "item/commandExecution/requestApproval"));
  await b.request("thread/resume", { threadId: thread.id });
  const requestA = a.frames.find(f => f.id && f.method === "item/commandExecution/requestApproval")!;
  const requestB = b.frames.find(f => f.id && f.method === "item/commandExecution/requestApproval")!;
  expect(requestA.id).not.toBe(requestB.id);
  await b.session.receive({ id: requestB.id, result: { decision: "acceptForSession" } });
  expect(a.frames.some(f => f.method === "serverRequest/resolved" && f.params.requestId === requestA.id)).toBe(true);
  await until(() => a.frames.some(f => f.id && f.method === "item/fileChange/requestApproval"));
  const pending = f.server.log.pendingRequests(resolveThread(f.server, thread.id).id)[0];
  f.server.approvals.expire(pending.params.requestId, "timeout");
  expect(a.frames.some(f => f.method === "serverRequest/resolved" && f.params.reason === "timeout")).toBe(true);
  expect(a.frames.some(f => f.method === "serverRequest/expired")).toBe(false);
});

test("model, cwd, reviewer, service tier, readonly and side-effect guards are fail-closed", async () => {
  const f = setup(), c = connection(f); await c.initialize();
  for (const method of ["command/exec", "fs/writeFile", "config/value/write", "thread/shellCommand", "item/tool/call", "account/logout", "review/start", "thread/delete"]) await expect(c.request(method)).rejects.toThrow("unsupported method");
  for (const options of [{ serviceTier: "priority" }, { approvalsReviewer: "auto_review" }, { config: { approval_policy: "never" } }, { model: "fable" }, { cwd: "/" }]) await expect(c.request("thread/start", { model: "gpt-6-astra", cwd: f.root, ...options })).rejects.toThrow();
  expect(f.engines).toHaveLength(0);
  const { thread } = await c.request("thread/start", { model: "gpt-6-astra", cwd: f.root, approvalPolicy: "never", sandbox: "read-only" });
  for (const options of [{ sandboxPolicy: { type: "workspaceWrite" } }, { approvalsReviewer: "auto_review" }, { serviceTier: "fast" }, { cwd: "/" }, { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }]) await expect(c.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "bad" }], ...options })).rejects.toThrow();
  await expect(c.request("thread/resume", { threadId: thread.id, approvalPolicy: "never", sandbox: "danger-full-access" })).rejects.toThrow("readonly");
  expect(f.server.log.turns(resolveThread(f.server, thread.id).id)).toHaveLength(0);
  for (const method of ["hooks/list", "skills/list", "plugin/list"]) await expect(c.request(method, { cwds: ["/"] })).rejects.toThrow("allowed_roots");
  expect(nativeOptions({ serviceTier: null, approvalsReviewer: "user", sandboxPolicy: { type: "readOnly" }, approvalPolicy: "never" })).toEqual({ sandbox: "read-only", permission: "readonly" });
  const turn = await c.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "read" }], approvalPolicy: "never" });
  expect(turn.turn.id).toStartWith("native-turn-");
  await until(() => f.server.log.turns(resolveThread(f.server, thread.id).id)[0].status === "completed");
  expect((await c.request("thread/resume", { threadId: thread.id, approvalPolicy: "never", sandbox: "read-only" })).thread.id).toBe(thread.id);
});

test("cold-start config uses AS guards, persists thread options and audits ignored keys without values", async () => {
  const f = setup("simple", undefined, true), c = connection(f); await c.initialize();
  const events: NativeObject[] = [];
  const publish = f.server.log.publish.bind(f.server.log);
  f.server.log.publish = frame => { events.push(frame); publish(frame); };
  for (const model of ["gpt-6-astra", "sonnet"]) {
    const { thread } = await c.request("thread/start", { config: { model, cwd: f.root, sandbox_mode: "read-only", approval_policy: "never", model_reasoning_effort: "high", personality: "friendly", tui: { status_line: ["SECRET"] }, web_search: "cached" } });
    const as = resolveThread(f.server, thread.id);
    expect(as).toMatchObject({ model, permission: "readonly", cwd: f.root, backend: model === "sonnet" ? "claude" : "codex" });
    expect(f.server.log.options(as.id)).toMatchObject({ effort: "high", personality: "friendly" });
    const audit = events.find(f => f.method === "thread/engineEvent" && f.params.threadId === as.id && f.params.subtype === "native_config_ignored");
    expect(audit?.params.payload.keys).toContain("tui");
    expect(JSON.stringify(audit)).not.toContain("SECRET");
    const persisted = f.server.log.db.query("SELECT reason FROM ingress_audit WHERE thread_id=? AND method='config/ignore'").get(as.id);
    expect(JSON.stringify(persisted)).toContain("tui");
    expect(JSON.stringify(persisted)).not.toContain("SECRET");
    await expect(c.request("thread/resume", { threadId: thread.id, config: { sandbox_mode: "danger-full-access", approval_policy: "never" } })).rejects.toThrow("readonly");
    await expect(c.request("thread/resume", { threadId: thread.id, config: { model_reasoning_effort: "medium", personality: "pragmatic", web_search: "cached" } })).resolves.toHaveProperty("thread.id", thread.id);
  }
  const count = f.engines.length;
  for (const config of [{ model: "fable" }, { cwd: "/" }, { service_tier: "priority" }, { approvals_reviewer: "auto_review" }, { "config/value/write": {} }, { personality: "invalid" }])
    await expect(c.request("thread/start", { model: "gpt-6-astra", cwd: f.root, ...("model" in config ? { model: null } : {}), ...("cwd" in config ? { cwd: null } : {}), config })).rejects.toThrow();
  expect(f.engines.length).toBe(count);
});

test("listener requires bearer on loopback upgrade, refuses origins and owns AS disconnect", async () => {
  const f = setup();
  expect(() => listenCodex(f.server, { token: "secret", hostname: "0.0.0.0" })).toThrow("loopback");
  const listener = listenCodex(f.server, { token: "secret", control: f.control }); cleanups.push(() => listener.close());
  expect(MAX_NATIVE_FRAME_BYTES).toBe(128 * 1024 * 1024);
  expect((await fetch(listener.url.replace("ws:", "http:"))).status).toBe(401);
  expect((await fetch(listener.url.replace("ws:", "http:"), { headers: { Authorization: "Bearer secret", Origin: "http://localhost" } })).status).toBe(403);
  expect((await fetch(listener.url.replace("ws:", "http:"), { headers: { Authorization: "Bearer secret" } })).status).toBe(426);
  const socket = new WebSocket(listener.url, { headers: { Authorization: "Bearer secret" } });
  cleanups.push(() => socket.close());
  const frames: any[] = []; socket.onmessage = event => frames.push(JSON.parse(String(event.data)));
  await until(() => socket.readyState === WebSocket.OPEN);
  socket.send("{"); await until(() => frames.length === 1); expect(frames[0].error.code).toBe(-32700);
  socket.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "test", version: "1" } } }));
  await until(() => frames.some(f => f.id === 1)); expect(frames.find(f => f.id === 1).result.userAgent).toBe("codex-tui/0.153.4");
  socket.send(JSON.stringify({ method: "initialized" }));
  socket.send(JSON.stringify({ id: 2, method: "account/read", params: { padding: "x".repeat(17 * 1024 * 1024) } }));
  await until(() => frames.some(f => f.id === 2)); expect(frames.find(f => f.id === 2).result.marker).toBe("account/read");
  await listener.close(); expect(f.control.closed).toBe(true);
});

test("control owns one threadless process, forwards only explicit readonly methods and closes pending calls", async () => {
  const root = temporary(), executable = join(root, "control.ts");
  writeFileSync(executable, `#!/usr/bin/env bun
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
createInterface({input:process.stdin}).on('line', line => {
  const f=JSON.parse(line); appendFileSync(${JSON.stringify(join(root, "trace"))}, line+'\\n');
  if(f.id && f.method !== 'environment/info') process.stdout.write(JSON.stringify({id:f.id,result:{userAgent:'codex/0.153.4',method:f.method,params:f.params,identity:Object.keys(process.env).filter(k=>k.startsWith('HERDR_')||k.startsWith('FENJUE_'))}})+'\\n');
});
`); chmodSync(executable, 0o700);
  const control = new ControlProcess({ executable, cwd: root, timeoutMs: 3000, env: { ...process.env, HERDR_AGENT: "unrelated", FENJUE_CID: "unrelated" } });
  cleanups.push(() => control.close());
  const [a, b] = await Promise.all([control.initialize(), control.initialize()]); expect(a).toEqual(b); expect(a.identity).toEqual([]);
  for (const method of CONTROL_METHODS) if (method !== "environment/info") expect((await control.request(method, { marker: "verbatim" })).params).toEqual({ marker: "verbatim" });
  await expect(control.request("thread/start", {})).rejects.toThrow("unsupported");
  const pending = control.request("environment/info").catch(error => error);
  await new Promise(resolve => setTimeout(resolve, 5)); await control.close(); expect(await pending).toBeInstanceOf(Error);
  const trace = readFileSync(join(root, "trace"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(trace.filter(f => f.method === "initialize")).toHaveLength(1); expect(trace.some(f => f.method.startsWith("thread/"))).toBe(false);
  expect(trace[1].method).toBe("initialized");
});

test("engine UUID lookup survives daemon restart without an ingress mapping table", async () => {
  const f = setup(), c = connection(f); await c.initialize();
  const { thread } = await c.request("thread/start", { cwd: f.root, model: "gpt-6-astra" });
  const original = resolveThread(f.server, thread.id).id;
  await c.request("thread/name/set", { threadId: thread.id, name: "survives restart" });
  c.session.close(); await f.server.close();
  const reopened = new AgentServer({ databasePath: join(f.root, "db"), allowedRoots: [f.root], idleTimeoutMs: 0 });
  cleanups.push(() => reopened.close());
  expect(resolveThread(reopened, thread.id).id).toBe(original);
  expect(resolveThread(reopened, thread.id).title).toBe("survives restart");
  expect(resolveThread(reopened, thread.id).meta?.nativeThreadData).toHaveProperty("id", thread.id);
});

test("one native connection alternates two owning processes and detached threads stop streaming", async () => {
  const f = setup(), c = connection(f); await c.initialize();
  const ids = [];
  for (let n = 0; n < 2; n++) ids.push((await c.request("thread/start", { cwd: f.root, model: "gpt-6-astra" })).thread.id);
  for (const id of [ids[0], ids[1], ids[0], ids[1]]) {
    const offset = c.frames.length;
    const turn = await c.request("turn/start", { threadId: id, input: [{ type: "text", text: id }] });
    await until(() => c.frames.slice(offset).some(f => f.method === "turn/completed"));
    const events = c.frames.slice(offset).filter(f => f.method?.startsWith("turn/") || f.method?.startsWith("item/"));
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) { expect(event.params.threadId).toBe(id); if (event.method === "turn/completed") expect(event.params.turn.id).toBe(turn.turn.id); }
  }
  const loaded = await c.request("thread/loaded/list", { limit: 1 });
  expect(loaded.data).toEqual([...ids].sort().slice(0, 1));
  expect((await c.request("thread/loaded/list", { cursor: loaded.nextCursor, limit: 0 })).data).toEqual([...ids].sort().slice(1));
  expect((await c.request("thread/loaded/list", { cursor: "ffffffff-ffff-ffff-ffff-ffffffffffff" })).data).toEqual([]);
  await c.request("thread/unsubscribe", { threadId: ids[1] });
  c.session.close();
  const reconnected = connection(f); await reconnected.initialize();
  expect([...reconnected.session.router.attached]).toEqual([resolveThread(f.server, ids[0]).id]);
  expect(f.engines).toHaveLength(2);
});

test("mixed Codex and Claude share a connection with independent pending approvals and interrupts", async () => {
  const f = setup("pending-status", undefined, true), c = connection(f); await c.initialize();
  const codex = (await c.request("thread/start", { cwd: f.root, model: "gpt-6-astra" })).thread.id;
  const claude = (await c.request("thread/start", { cwd: f.root, model: "sonnet" })).thread.id;
  const list = (await c.request("thread/list")).data;
  expect(list.find((t: NativeObject) => t.id === codex).modelProvider).toBe("fake");
  expect(list.find((t: NativeObject) => t.id === claude)).toMatchObject({ modelProvider: "claude", model: "sonnet" });
  expect((await c.request("thread/loaded/list")).data).toEqual([codex, claude].sort());
  const asClaude = resolveThread(f.server, claude);
  expect((await c.request("thread/resume", { threadId: codex, model: "sonnet" })).model).toBe("gpt-6-astra");
  expect((await c.request("thread/resume", { threadId: claude, model: "gpt-6-astra" })).model).toBe("sonnet");
  for (const [id, backend, model] of [[codex, "codex", "gpt-6-astra"], [claude, "claude", "sonnet"]])
    expect(c.frames).toContainEqual({ method: "warning", params: { threadId: id, message: `该线程为 ${backend}，已沿用 ${model}` } });
  for (const interrupted of [codex, claude]) {
    const offset = c.frames.length, decisions: unknown[] = [];
    const ct = (await c.request("turn/start", { threadId: codex, model: "sonnet", input: [{ type: "text", text: "codex approval" }] })).turn.id;
    const at = (await c.request("turn/start", { threadId: claude, collaborationMode: { mode: "default", settings: { model: "gpt-6-astra" } }, input: [{ type: "text", text: "claude approval" }] })).turn.id;
    await until(() => f.claude.sent.some(t => t.turnId === at));
    expect(f.claude.sent.find(t => t.turnId === at)!.options.model).not.toBe("gpt-6-astra");
    expect(resolveThread(f.server, codex).model).toBe("gpt-6-astra");
    expect(resolveThread(f.server, claude).model).toBe("sonnet");
    expect(c.frames.slice(offset).filter(f => f.method === "warning")).toHaveLength(2);
    const requestId = `ar_${crypto.randomUUID()}`;
    f.claude.emit({ type: "itemStarted", turnId: at, item: { id: `item-${at}`, type: "commandExecution", payload: { command: "pwd", cwd: f.root }, status: "inProgress" } });
    f.claude.emit({ type: "approval", request: { method: "item/commandExecution/requestApproval", params: { threadId: asClaude.id, turnId: at, itemId: `item-${at}`, requestId, command: "pwd", cwd: f.root, startedAtMs: 1 } }, respond: d => { decisions.push(d); } });
    await until(() => c.frames.slice(offset).filter(x => x.method === "item/commandExecution/requestApproval").length === 2);
    const cards = c.frames.slice(offset).filter(x => x.method === "item/commandExecution/requestApproval");
    const cc = cards.find(x => x.params.threadId === codex)!, ac = cards.find(x => x.params.threadId === claude)!;
    expect(cc.id).not.toBe(ac.id); expect(cc.params.turnId).toBe(ct); expect(ac.params.turnId).toBe(at);
    // Interrupt one engine while the other engine's approval is still pending.
    const peer = interrupted === codex ? claude : codex, peerCard = interrupted === codex ? ac : cc;
    await expect(c.request("turn/interrupt", { threadId: interrupted, turnId: interrupted === codex ? at : ct })).rejects.toThrow("expected active turn id");
    await c.request("turn/interrupt", { threadId: interrupted, turnId: interrupted === codex ? ct : at });
    await until(() => c.frames.slice(offset).some(x => x.method === "turn/completed" && x.params.threadId === interrupted));
    expect(c.frames.slice(offset).some(x => x.method === "turn/completed" && x.params.threadId === peer)).toBe(false);
    expect(c.frames.slice(offset).some(x => x.method === "serverRequest/resolved" && x.params.requestId === peerCard.id)).toBe(false);
    if (peer === claude) expect(decisions).toEqual([]);
    await c.session.receive({ id: peerCard.id, result: { decision: "accept" } });
    if (peer === claude) {
      await until(() => decisions.length === 1); expect(decisions).toEqual([{ decision: "accept" }]);
      f.claude.emit({ type: "turnCompleted", turnId: at, status: "completed" });
    }
    await until(() => c.frames.slice(offset).some(x => x.method === "turn/completed" && x.params.threadId === peer));
    expect(c.frames.slice(offset).find(x => x.method === "turn/completed" && x.params.threadId === peer)?.params.turn.status).toBe("completed");
    expect(c.frames.slice(offset).find(x => x.method === "serverRequest/resolved" && x.params.requestId === peerCard.id)?.params.threadId).toBe(peer);
  }
});

test("disconnect releases full lease, replays pending and offline resolved cards without killing either engine", async () => {
  const f = setup("conversation"), a = connection(f); await a.initialize();
  const { thread } = await a.request("thread/start", { cwd: f.root, model: "gpt-6-astra" });
  const as = resolveThread(f.server, thread.id);
  await a.session.client.request("thread/lease/acquire", { threadId: as.id });
  await a.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "approval" }] });
  await until(() => a.frames.some(f => f.method === "item/commandExecution/requestApproval"));
  const original = a.frames.find(f => f.method === "item/commandExecution/requestApproval")!;
  a.session.close();
  expect(f.server.leases.read(as.id)).toBeUndefined(); expect(f.server.threads.live.has(as.id)).toBe(true);
  const b = connection(f); await b.initialize();
  const pending = b.frames.find(f => f.method === "item/commandExecution/requestApproval")!;
  expect(pending.params).toEqual(original.params); expect(pending.id).not.toBe(original.id);
  expect(b.frames.some(f => f.method === "serverRequest/resolved" && f.params.requestId === original.id)).toBe(true);
  // An already-online observer decides after b disconnects, then the next
  // native connection must receive resolved, not a duplicate approval.
  const observer = connection(f); await observer.initialize(); await observer.request("thread/resume", { threadId: thread.id });
  b.session.close();
  const card = observer.frames.find(f => f.method === "item/commandExecution/requestApproval")!;
  await observer.session.receive({ id: card.id, result: { decision: "acceptForSession" } });
  await until(() => observer.frames.some(f => f.method === "item/fileChange/requestApproval"));
  const d = connection(f); await d.initialize();
  expect(d.frames.some(f => f.method === "serverRequest/resolved" && f.params.requestId === pending.id && f.params.reason === "decided")).toBe(true);
  expect(d.frames.some(f => f.method === "item/commandExecution/requestApproval")).toBe(false);
  expect(d.frames.some(f => f.method === "item/fileChange/requestApproval")).toBe(true);
  await d.session.client.request("thread/lease/acquire", { threadId: as.id });
  expect(f.server.leases.read(as.id)?.holder.clientId).toBe(d.session.client.clientId);
  expect(f.engines).toHaveLength(1);
});

test("reconnected full-permission input does not acquire an implicit lease", async () => {
  const f = setup(), a = connection(f); await a.initialize();
  const { thread } = await a.request("thread/start", { cwd: f.root, model: "gpt-6-astra", approvalPolicy: "never", sandbox: "danger-full-access" });
  const as = resolveThread(f.server, thread.id);
  expect(f.server.leases.read(as.id)).toBeUndefined();
  await a.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "first" }] });
  await until(() => f.server.threads.get(as.id).status.type === "idle");
  expect(f.server.leases.read(as.id)).toBeUndefined();
  a.session.close(); expect(f.server.leases.read(as.id)).toBeUndefined();
  const b = connection(f); await b.initialize();
  expect(f.server.leases.read(as.id)).toBeUndefined();
  await b.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "second" }] });
  expect(f.server.leases.read(as.id)).toBeUndefined();
  expect(f.engines).toHaveLength(1);
});

test("thread aggregation traverses every AS page, excludes archived by default, and resumes reverse anchors", async () => {
  const f = setup(), c = connection(f); await c.initialize();
  // Real durable rows beyond the as/1 page limit; no thousands of processes.
  f.server.log.transaction(() => { for (let n = 0; n < 10003; n++) {
    const id = `th_${crypto.randomUUID()}`;
    f.server.log.insertThread({ id, backend: "codex", engineThreadId: crypto.randomUUID(), cwd: f.root, createdAtMs: n * 1000,
      status: { type: n === 10002 ? "closed" : "idle" }, meta: { nativeThreadData: { createdAt: n, modelProvider: "test" } } }, {}, {});
  } });
  const first = await c.request("thread/list", { limit: 2 });
  expect(first.data.map((t: NativeObject) => t.createdAt)).toEqual([10001, 10000]);
  const second = await c.request("thread/list", { limit: 2, cursor: first.nextCursor });
  expect(second.data.map((t: NativeObject) => t.createdAt)).toEqual([9999, 9998]);
  const back = await c.request("thread/list", { limit: 2, sortDirection: "asc", cursor: second.backwardsCursor });
  expect(back.data.map((t: NativeObject) => t.createdAt)).toEqual([9999, 10000]);
  expect((await c.request("thread/list", { archived: true })).data.map((t: NativeObject) => t.createdAt)).toEqual([10002]);
  expect((await c.request("thread/list", { limit: 10000 })).data).toHaveLength(100);
  expect((await c.request("thread/list", { modelProviders: ["missing"] }))).toEqual({ data: [], nextCursor: null, backwardsCursor: null });
});

test("codex_ingress defaults off, validates config, and disabled endpoint bytes stay unchanged", async () => {
  const root = temporary(), paths = resolveDaemonPaths({ HOME: root, AGENT_SERVER_SOCKET_PATH: join(root, "sock") });
  const path = join(root, "config"); writeFileSync(path, "[codex_ingress]\n"); expect(readConfig(path).codex_ingress).toEqual({ enabled: false, port: 0, claude_threads: false });
  writeFileSync(path, "[codex_ingress]\nenabled = true\nport = -1\n"); expect(() => readConfig(path)).toThrow();
  const daemon = await runDaemon({ paths, logger: () => {}, serverOptions: { allowedRoots: [root] } }); cleanups.push(() => daemon.shutdown());
  expect(daemon.codexIngressUrl).toBeUndefined();
  expect(readFileSync(paths.endpointPath, "utf8")).toBe(JSON.stringify({ pid: process.pid, socketPath: paths.socketPath }) + "\n");
});

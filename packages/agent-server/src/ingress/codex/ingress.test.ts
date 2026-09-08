import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { AgentServer } from "../../server/server.js";
import { CodexEngine } from "../../engines/codex.js";
import { mapCodexDecision } from "../../engines/codex-mapper.js";
import { ServerRequestMethodSchema } from "../../protocol/index.js";
import { until } from "../../test-helpers.test.js";
import { readConfig, runDaemon } from "../../daemon/runtime.js";
import { resolveDaemonPaths } from "../../daemon/paths.js";
import { CodexSession, nativeDecision } from "./session.js";
import { nativeOptions, nativeThreadId, resolveThread } from "./router.js";
import { listenCodex, MAX_NATIVE_FRAME_BYTES } from "./listener.js";
import { CONTROL_METHODS, ControlProcess, type NativeObject, type ControlClient } from "./control-process.js";

const cleanups: Array<() => void | Promise<void>> = [];
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
function setup(scenario = "simple", requestTimeoutMs?: number) {
  const root = temporary(), control = new FakeControl(), engines: CodexEngine[] = [];
  const server = new AgentServer({ databasePath: join(root, "db"), token: "secret", allowedRoots: [root], idleTimeoutMs: 0, engineFactory: () => {
    const nativeId = crypto.randomUUID();
    const engine = new CodexEngine({ requestTimeoutMs, spawnProcess: (_cmd, _args, opts) => spawn(process.execPath, [resolve(import.meta.dir, "../../../scripts/fixtures/fake-codex-app-server.ts")], {
      ...opts, env: { ...opts.env, FAKE_CODEX_SCENARIO: scenario, FAKE_CODEX_THREAD_ID: nativeId }, stdio: "pipe",
    }) }); engines.push(engine); return engine;
  } });
  cleanups.push(() => server.close());
  return { root, server, control, engines };
}
function connection(f: ReturnType<typeof setup>) {
  const frames: NativeObject[] = [];
  const session = new CodexSession(f.server, f.control, { token: "secret", send: frame => frames.push(frame) });
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
  await initialized; expect((await models).data.map((m: NativeObject) => m.model)).toEqual(["gpt-6-astra", "sonnet", "opus"]);
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
  const list = await a.request("thread/list", { limit: 1 }); expect(list.data).toHaveLength(1); expect(list.nextCursor).toBe(list.data[0].id);
  expect((await a.request("thread/list", { cursor: list.nextCursor, limit: 1 })).data[0].id).not.toBe(list.data[0].id);
  await a.session.client.request("thread/lease/acquire", { threadId: asThread.id });
  await expect(b.request("thread/name/set", { threadId: first.thread.id, name: "blocked title" })).rejects.toThrow(`codex-tui:${a.session.client.clientId}`);
  await expect(b.request("turn/start", { threadId: first.thread.id, input: [{ type: "text", text: "blocked" }] })).rejects.toThrow(`codex-tui:${a.session.client.clientId}`);
  a.session.close(); expect(f.server.leases.read(asThread.id)).toBeUndefined();
  await b.request("thread/resume", { threadId: first.thread.id });
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
  for (const options of [{ sandboxPolicy: { type: "workspaceWrite" } }, { approvalsReviewer: "auto_review" }, { serviceTier: "fast" }, { cwd: "/" }, { model: "fable" }, { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }]) await expect(c.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "bad" }], ...options })).rejects.toThrow();
  await expect(c.request("thread/resume", { threadId: thread.id, approvalPolicy: "never", sandbox: "danger-full-access" })).rejects.toThrow("readonly");
  expect(f.server.log.turns(resolveThread(f.server, thread.id).id)).toHaveLength(0);
  for (const method of ["hooks/list", "skills/list", "plugin/list"]) await expect(c.request(method, { cwds: ["/"] })).rejects.toThrow("allowed_roots");
  expect(nativeOptions({ serviceTier: null, approvalsReviewer: "user", sandboxPolicy: { type: "readOnly" }, approvalPolicy: "never" })).toEqual({ sandbox: "read-only", permission: "readonly" });
  const turn = await c.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "read" }], approvalPolicy: "never" });
  expect(turn.turn.id).toStartWith("native-turn-");
  await until(() => f.server.log.turns(resolveThread(f.server, thread.id).id)[0].status === "completed");
  expect((await c.request("thread/resume", { threadId: thread.id, approvalPolicy: "never", sandbox: "read-only" })).thread.id).toBe(thread.id);
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

test("codex_ingress defaults off, validates config, and disabled endpoint bytes stay unchanged", async () => {
  const root = temporary(), paths = resolveDaemonPaths({ HOME: root, AGENT_SERVER_SOCKET_PATH: join(root, "sock") });
  const path = join(root, "config"); writeFileSync(path, "[codex_ingress]\n"); expect(readConfig(path).codex_ingress).toEqual({ enabled: false, port: 0 });
  writeFileSync(path, "[codex_ingress]\nenabled = true\nport = -1\n"); expect(() => readConfig(path)).toThrow();
  const daemon = await runDaemon({ paths, logger: () => {}, serverOptions: { allowedRoots: [root] } }); cleanups.push(() => daemon.shutdown());
  expect(daemon.codexIngressUrl).toBeUndefined();
  expect(readFileSync(paths.endpointPath, "utf8")).toBe(JSON.stringify({ pid: process.pid, socketPath: paths.socketPath }) + "\n");
});

import { afterEach, expect, test } from "bun:test";
import { AgentServer } from "../../server/server.js";
import { MockEngine } from "../../engines/mock.js";
import { until } from "../../test-helpers.test.js";
import { ErrorCode, type Item, type Thread, type Turn, type ServerRequestMethod } from "../../protocol/index.js";
import { claudeApproval, claudeAnswer, claudeItems, claudeNotification, claudeThread, claudeTurn } from "./claude-projection.js";
import { CodexSession } from "./session.js";
import { nativeThreadId, resolveThread } from "./router.js";
import type { NativeObject } from "./control-process.js";

const thread: Thread = { id: "th_12345678-1234-1234-1234-123456789012", backend: "claude", engineThreadId: "cli-session", status: { type: "idle" }, cwd: process.cwd(), model: "sonnet", permission: "default", createdAtMs: 1000 };
const tid = nativeThreadId(thread);
const turn: Turn = { id: "tn_1", threadId: thread.id, ordinal: 1, status: "completed", enqueuedAtMs: 1000 };
const item = (type: string, payload: NativeObject, status = "completed"): NativeObject => ({ id: "it_1", turnId: turn.id, seq: 1, startedAtMs: 1000, type, payload, status });
const fixtures: Array<[string, NativeObject, string[]]> = [
  ["userMessage", { content: [{ type: "text", text: "hello" }, { type: "image", path: "/tmp/a.png" }, { type: "bash", command: "pwd" }] }, ["userMessage"]],
  ["agentMessage", { text: "hello", phase: "final_answer" }, ["agentMessage"]],
  ["reasoning", { summary: "one\n\ntwo", text: "thought" }, ["reasoning"]],
  ["commandExecution", { command: "pwd", cwd: "/tmp", exitCode: 0, aggregatedOutput: "ok" }, ["commandExecution"]],
  ["fileChange", { status: "completed", changes: [{ path: "a", kind: "add", diff: "+a" }, { path: "b", kind: "delete" }] }, ["fileChange"]],
  ["toolCall", { name: "Read", input: { path: "a" }, output: "ok" }, ["dynamicToolCall"]],
  ["mcpToolCall", { server: "s", tool: "t", arguments: {}, result: { content: [{ type: "text", text: "ok" }] } }, ["mcpToolCall"]],
  ["subAgent", { kind: "agent", parentItemId: "toolu_a", phase: "future-phase", text: "hello" }, ["collabAgentToolCall", "subAgentActivity"]],
  ["subAgent", { kind: "bash", parentItemId: "toolu_b", phase: "completed", report: "done" }, ["dynamicToolCall"]],
  ["subAgent", { kind: "workflow", parentItemId: "toolu_w", phase: "running" }, ["dynamicToolCall"]],
  ["webSearch", { query: "query", results: [{ url: "example" }] }, ["webSearch"]],
  ["imageOutput", { paths: ["/tmp/a.png", "/tmp/b.png", "/tmp/c.png"] }, ["imageGeneration", "agentMessage"]],
  ["plan", { text: "plan", steps: [{ step: "one", status: "pending" }] }, ["plan"]],
  ["contextCompaction", {}, ["contextCompaction"]],
  ["error", { message: "broken", retryable: false }, []],
  ["futureType", { opaque: [1, 2] }, ["dynamicToolCall"]],
];
for (const [type, payload, types] of fixtures) test(`Claude ${type}/${payload.kind ?? ""}: native presentation retains payload`, () => {
  const output = claudeItems(item(type, payload), tid);
  expect(output.map(i => i.type)).toEqual(types);
  expect(output.every(i => typeof i.id === "string")).toBe(true);
  const frames = claudeNotification("item/completed", { threadId: thread.id, turnId: turn.id, itemId: "it_1", item: item(type, payload) }, thread, [turn], []);
  if (type === "error") { expect(frames).toHaveLength(1); expect(frames[0]?.method).toBe("error"); expect(frames[0]?.params.error.message).toBe("broken"); }
  else expect(frames.filter(f => f.method === "item/completed").map(f => f.params.item)).toEqual(output);
  for (const f of frames.filter(f => f.method === "item/completed")) expect(f.params.completedAtMs).toBe(1000);
  if (type === "contextCompaction") expect(frames.at(-1)?.method).toBe("thread/compacted");
  if (type === "plan") expect(frames.at(-1)?.params.plan).toEqual(payload.steps);
  if (type === "futureType") expect(output[0]).toMatchObject({ tool: "unknown", namespace: "as", arguments: { type, payload } });
  if (type === "subAgent" && payload.kind === "agent") expect(output[0]?.agentsStates.toolu_a.status).toBe("running");
  if (type === "reasoning") expect(output[0]?.summary).toEqual(["one\n\ntwo"]);
  if (type === "imageOutput") expect(output[1]?.text).toBe("/tmp/b.png\n/tmp/c.png");
});

test("Claude stream deltas, rejected states, secondary items, and turn/status/usage envelopes", () => {
  for (const [method, values, expected] of [
    ["item/agentMessage/delta", { delta: "a" }, { delta: "a" }],
    ["item/reasoning/textDelta", { delta: "t" }, { delta: "t", contentIndex: 0 }],
    ["item/reasoning/summaryTextDelta", { delta: "s" }, { delta: "s", summaryIndex: 0 }],
    ["item/commandExecution/outputDelta", { chunk: "err", stream: "stderr" }, { delta: "err" }],
    ["item/fileChange/patchUpdated", { changes: [{ path: "a", kind: "update" }] }, { changes: [{ path: "a", kind: { type: "update" }, diff: "" }] }],
  ] as const) {
    expect(claudeNotification(method, { turnId: turn.id, itemId: "it_1", ...values }, thread, [], [])[0]).toEqual({ method, params: { threadId: tid, turnId: turn.id, itemId: "it_1", ...expected } });
  }
  expect(claudeItems(item("commandExecution", { command: "x", cwd: "/tmp" }, "rejected"), tid)[0]?.status).toBe("declined");
  expect(claudeItems(item("fileChange", { changes: [], status: "rejected" }, "rejected"), tid)[0]?.status).toBe("declined");
  expect(claudeTurn({ ...turn, status: "cancelled" }, [], tid).status).toBe("interrupted");
  expect(claudeThread(thread).id).toBe(tid);
  for (const [as, native] of [["spawning", "active"], ["running", "active"], ["idle", "idle"], ["interrupted", "idle"], ["closed", "idle"], ["systemError", "systemError"]]) {
    expect(claudeNotification("thread/status/changed", { status: { type: as } }, thread, [], [])[0]?.params.status.type).toBe(native);
  }
  const usage = { inputTokens: 10, outputTokens: 5, cachedTokens: 3, cacheCreation: 2, usd: null, estimated: false, contextTokens: 15 };
  const f = claudeNotification("thread/tokenUsage/updated", { usage }, thread, [{ ...turn, usage }], [])[0]!;
  expect(f.params.tokenUsage.total).toEqual(f.params.tokenUsage.last);
  expect(f.params.tokenUsage.total.totalTokens).toBe(20);
});

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
async function setup(deniedModels?: string[], claudeThreads = true) {
  const engines: MockEngine[] = [];
  const server = new AgentServer({ databasePath: ":memory:", token: "secret", allowedRoots: [process.cwd()], idleTimeoutMs: 0, deniedModels,
    engineFactory: () => { const e = new MockEngine(); e.controlResponse = (subtype, params) => { if (subtype === "set_model") e.emit({ type: "modelChanged", model: String(params.model) }); return {}; }; engines.push(e); return e; } });
  cleanup.push(() => server.close());
  const frames: NativeObject[] = [];
  const c = new CodexSession(server, { initialize: async () => ({ userAgent: "codex-tui/0.153.4" }), request: async () => ({ data: [], nextCursor: null }), close: async () => {} }, { token: "secret", claudeThreads, send: f => frames.push(f) });
  cleanup.push(() => c.close()); let id = 0;
  async function rpc(method: string, params: NativeObject = {}) {
    const key = ++id; await c.receive({ id: key, method, params }); return frames.find(f => f.id === key && ("result" in f || "error" in f))!;
  }
  await rpc("initialize", { clientInfo: { name: "test", version: "1" } }); await c.receive({ method: "initialized" });
  return { server, c, frames, engines, rpc };
}

test("Claude model routing, persisted UUID, settings guards and explicit unsupported errors", async () => {
  const f = await setup();
  expect((await f.rpc("model/list")).result.data.map((m: NativeObject) => m.model)).toEqual(["sonnet", "opus"]);
  for (const model of ["fable", "claude-fable-5"]) expect((await f.rpc("thread/start", { model, cwd: process.cwd() })).error.code).toBe(ErrorCode.invalid_params);
  const started = (await f.rpc("thread/start", { model: "sonnet", cwd: process.cwd(), approvalPolicy: "on-request", sandbox: "workspace-write" })).result;
  const id = started.thread.id, as = resolveThread(f.server, id);
  expect(as.backend).toBe("claude"); expect(f.engines[0]?.options?.sandbox).toBeUndefined();
  expect(id).not.toBe(as.engineThreadId); expect(f.frames.find(x => x.method === "thread/started")?.params.thread.id).toBe(id);
  expect((await f.rpc("thread/resume", { threadId: id })).result.thread.turns).toEqual([]);
  expect((await f.rpc("thread/loaded/list")).result.data).toEqual([id]);
  expect((await f.rpc("thread/settings/update", { threadId: id, model: "opus" })).result).toEqual({});
  expect(f.frames.findLast(x => x.method === "thread/settings/updated")?.params.threadSettings.model).toBe("opus");
  expect(f.engines[0]?.controls.at(-1)).toEqual({ subtype: "set_model", params: { model: "opus" } });
  expect((await f.rpc("thread/settings/update", { threadId: id, model: "gpt-6-astra" })).error.code).toBe(ErrorCode.invalid_params);
  expect((await f.rpc("thread/settings/update", { threadId: id, effort: "high" })).error.code).toBe(-32601);
  expect((await f.rpc("thread/settings/update", { threadId: id, effort: "high" })).error.message).toContain("Claude 线程 effort 只在新建时生效");
  for (const method of ["thread/resume", "turn/start"]) {
    const error = (await f.rpc(method, { threadId: id, effort: "high", input: [{ type: "text", text: "hello" }] })).error;
    expect(error.code).toBe(-32601); expect(error.message).toContain("Claude 线程 effort 只在新建时生效");
  }
  for (const method of ["review/start", "thread/realtime/start", "thread/goal/set", "thread/memory/reset", "thread/inject_items", "thread/queue/add", "thread/backgroundTerminals/clean", "thread/delete"]) {
    const result = await f.rpc(method, { threadId: id }); expect(result.error.code).toBe(-32601); expect(result.error.message).toStartWith("as-ingress: ");
  }
  const ro = (await f.rpc("thread/start", { model: "sonnet", cwd: process.cwd(), sandbox: "read-only", approvalPolicy: "never" })).result.thread.id;
  for (const method of ["thread/settings/update", "turn/start", "thread/resume"]) expect((await f.rpc(method, { threadId: ro, approvalPolicy: "never", sandbox: "danger-full-access", ...(method === "turn/start" ? { input: [{ type: "text", text: "write" }] } : {}) })).error.code).toBe(ErrorCode.unauthorized);
  expect(f.engines[1]?.controls).toEqual([]);
  const denied = await setup(["sonnet"]); expect((await denied.rpc("model/list")).result.data.map((m: NativeObject) => m.model)).toEqual(["opus"]);
});

test("Claude real AS turns synthesize stream, resume history, paging, steer, compact and interrupt", async () => {
  const f = await setup(), id = (await f.rpc("thread/start", { model: "sonnet", cwd: process.cwd() })).result.thread.id;
  const as = resolveThread(f.server, id), e = f.engines[0]!;
  const t = (await f.rpc("turn/start", { threadId: id, input: [{ type: "text", text: "hello" }] })).result.turn;
  await until(() => e.sent.length === 1);
  e.emit({ type: "itemStarted", turnId: t.id, item: { id: "message", type: "agentMessage", payload: { text: "" }, status: "inProgress" } });
  e.emit({ type: "itemDelta", turnId: t.id, itemId: "message", kind: "text", text: "hello" });
  await until(() => f.frames.some(x => x.method === "item/agentMessage/delta"));
  expect((await f.rpc("turn/steer", { threadId: id, expectedTurnId: t.id, input: [{ type: "text", text: "more" }] })).result).toEqual({ turnId: t.id });
  expect(e.steered).toHaveLength(1);
  e.emit({ type: "itemCompleted", turnId: t.id, item: { id: "message", type: "agentMessage", payload: { text: "hello" }, status: "completed" } });
  e.emit({ type: "turnCompleted", turnId: t.id, status: "completed" });
  await until(() => f.frames.some(x => x.method === "turn/completed"));
  const resumed = (await f.rpc("thread/resume", { threadId: id })).result;
  expect(resumed.thread.turns[0].items.find((i: NativeObject) => i.id === "message").text).toBe("hello");
  const first = (await f.rpc("thread/items/list", { threadId: id, sortDirection: "asc", limit: 1 })).result;
  expect(first.data[0].item.type).toBe("userMessage"); expect(first.nextCursor).not.toBe("1");
  const next = (await f.rpc("thread/items/list", { threadId: id, sortDirection: "asc", limit: 1, cursor: first.nextCursor })).result;
  expect(next.data[0].item.text).toBe("hello"); expect(next.nextCursor).not.toBeNull(); // steer appended another user message
  const back = (await f.rpc("thread/items/list", { threadId: id, sortDirection: "desc", cursor: next.backwardsCursor })).result;
  expect(back.data.map((i: NativeObject) => i.item.type)).toEqual(["agentMessage", "userMessage"]);
  expect((await f.rpc("thread/items/list", { threadId: id, cursor: "1" })).error.code).toBe(ErrorCode.invalid_params);
  expect((await f.rpc("thread/turns/list", { threadId: id, itemsView: "notLoaded" })).result.data[0].items).toEqual([]);
  expect((await f.rpc("thread/compact/start", { threadId: id })).result).toEqual({});
  await until(() => e.sent.length === 2); expect(e.sent[1]?.input).toEqual([{ type: "text", text: "/compact" }]);
  const running = f.server.threads.queue(as.id).runningTurnId;
  expect((await f.rpc("turn/interrupt", { threadId: id, turnId: "wrong" })).error.code).toBe(-32600);
  expect((await f.rpc("turn/interrupt", { threadId: id, turnId: running })).result).toEqual({});
  await until(() => f.server.log.turn(running!).status === "interrupted");
  expect((await f.rpc("thread/archive", { threadId: id })).result).toEqual({});
  expect(f.server.threads.get(as.id).status.type).toBe("closed");
});

test("four Claude approvals without raw traverse the actual AS broker and close once", async () => {
  const f = await setup(), id = (await f.rpc("thread/start", { model: "sonnet", cwd: process.cwd() })).result.thread.id;
  const as = resolveThread(f.server, id), e = f.engines[0]!;
  const t = (await f.rpc("turn/start", { threadId: id, input: [{ type: "text", text: "approve" }] })).result.turn;
  await until(() => e.sent.length === 1);
  e.emit({ type: "itemStarted", turnId: t.id, item: { id: "toolu_a", type: "toolCall", payload: { name: "test", input: {} }, status: "inProgress" } });
  const cases: Array<[ServerRequestMethod, NativeObject, NativeObject, NativeObject]> = [
    ["item/commandExecution/requestApproval", { command: "pwd", cwd: process.cwd(), startedAtMs: 1 }, { decision: "decline" }, { decision: "reject" }],
    ["item/fileChange/requestApproval", { changes: [{ path: "a", kind: "add" }], startedAtMs: 1 }, { decision: "acceptForSession" }, { decision: "acceptForSession" }],
    ["item/permissions/requestApproval", { cwd: process.cwd(), permissions: { network: { enabled: true } }, startedAtMs: 1 }, { permissions: { network: { enabled: true } }, scope: "session" }, { permissions: { network: { enabled: true } }, scope: "thread" }],
    ["item/tool/requestUserInput", { isBlocking: true, questions: [{ id: "q", question: "Pick", multiSelect: true, options: [{ label: "one" }, { label: "two" }] }] }, { answers: { q: { answers: ["1, 2"] } } }, { answers: { q: { answers: ["one", "two"] } } }],
  ];
  for (const [method, extra, answer, expected] of cases) {
    const requestId = `ar_${crypto.randomUUID()}`, decisions: unknown[] = [];
    const p = { threadId: as.id, turnId: t.id, itemId: "toolu_a", requestId, ...extra };
    e.emit({ type: "approval", request: { method, params: p } as any, respond: d => { decisions.push(d); } });
    await until(() => f.frames.some(x => x.method === method && x.id != null));
    const frame = f.frames.findLast(x => x.method === method)!;
    expect(frame.params.threadId).toBe(id); expect(frame.params.data).toBeUndefined();
    expect(frame.params).toMatchObject(claudeApproval(method, p, as));
    await f.c.receive({ id: frame.id, result: answer });
    await until(() => decisions.length === 1); expect(decisions).toEqual([expected]);
    const resolved = f.frames.filter(x => x.method === "serverRequest/resolved" && x.params.requestId === frame.id);
    expect(resolved).toHaveLength(1); expect(resolved[0]?.params.threadId).toBe(id);
    expect(JSON.parse(f.server.log.approval(requestId)!.decided_by!).label).toStartWith("codex-tui:");
    await f.c.receive({ id: frame.id, result: answer }); expect(decisions).toHaveLength(1);
  }
});

for (const choice of ["allow", "deny"]) test(`generic Claude permissions: ${choice} via user input and broker`, async () => {
  const f = await setup(), id = (await f.rpc("thread/start", { model: "sonnet", cwd: process.cwd() })).result.thread.id;
  const as = resolveThread(f.server, id), e = f.engines[0]!;
  const t = (await f.rpc("turn/start", { threadId: id, input: [{ type: "text", text: "read" }] })).result.turn;
  await until(() => e.sent.length === 1);
  e.emit({ type: "itemStarted", turnId: t.id, item: { id: "read", type: "toolCall", payload: { name: "Read", input: { path: "/tmp/a" } }, status: "inProgress" } });
  const decisions: unknown[] = [];
  e.emit({ type: "approval", request: { method: "item/permissions/requestApproval", params: { requestId: "generic", threadId: as.id, turnId: t.id, itemId: "read", cwd: process.cwd(), startedAtMs: Date.now(), permissions: { toolName: "Read", input: { path: "/tmp/a" } } } }, respond: d => { decisions.push(d); } });
  await until(() => f.frames.some(x => x.method === "item/tool/requestUserInput"));
  const card = f.frames.find(x => x.method === "item/tool/requestUserInput")!;
  expect(card.params.questions[0]).toMatchObject({ header: "权限请求：Read", isOther: false, options: [{ label: "allow" }, { label: "deny" }] });
  expect(card.params.questions[0].question).toContain("/tmp/a");
  expect(f.frames.some(x => x.method === "item/permissions/requestApproval")).toBe(false);
  expect(f.server.log.approval("generic")?.status).toBe("pending"); expect(decisions).toEqual([]);
  await f.c.receive({ id: card.id, result: { answers: { permission: { answers: ["maybe"] } } } });
  expect(f.server.log.approval("generic")?.status).toBe("pending"); expect(decisions).toEqual([]);
  const result = { answers: { permission: { answers: [choice] } } };
  await f.c.receive({ id: card.id, result });
  expect(decisions).toEqual([{ permissions: choice === "allow" ? { toolName: "Read", input: { path: "/tmp/a" } } : {}, scope: "turn" }]);
  expect(JSON.parse(f.server.log.approval("generic")!.decided_by!).label).toStartWith("codex-tui:");
  expect(f.frames.filter(x => x.method === "serverRequest/resolved" && x.params.requestId === card.id)).toHaveLength(1);
  await f.c.receive({ id: card.id, result }); expect(decisions).toHaveLength(1);
});

test("Claude multiSelect uses numbered free text and decodes selected labels without changing single answers", () => {
  const p = { questions: [{ id: "multi", question: "Pick", multiSelect: true, options: [{ label: "red", description: "warm" }, { label: "blue" }] }, { id: "single", question: "Name" }] };
  const projected = claudeApproval("item/tool/requestUserInput", p, thread);
  expect(projected.questions[0].options).toBeNull(); expect(projected.questions[0].multiSelect).toBeUndefined();
  expect(projected.questions[0].question).toContain("1. red — warm\n2. blue\n可多选，逗号分隔");
  const result = { answers: { multi: { answers: ["2, 1，blue, custom"] }, single: { answers: ["a,b"] } } };
  expect(claudeAnswer("item/tool/requestUserInput", p, result)).toEqual({ answers: { multi: { answers: ["blue", "red", "custom"] }, single: { answers: ["a,b"] } } });
  expect(result.answers.multi.answers).toEqual(["2, 1，blue, custom"]);
  expect(() => claudeAnswer("item/tool/requestUserInput", p, { answers: { multi: { answers: ["3"] } } })).toThrow("out of range");
});

test("Claude rollback switch hides models and existing threads, rejects direct entry and suppresses projection", async () => {
  const f = await setup(undefined, false);
  const { thread } = await f.c.client.request("thread/start", { backend: "claude", model: "sonnet", cwd: process.cwd() });
  const id = nativeThreadId(thread);
  expect((await f.rpc("model/list")).result.data).toEqual([]);
  expect((await f.rpc("thread/list")).result.data).toEqual([]);
  expect((await f.rpc("thread/loaded/list")).result.data).toEqual([]);
  expect(f.frames.some(x => x.method === "thread/started")).toBe(false);
  const allThreads = f.server.log.allThreads;
  f.server.log.allThreads = () => { throw new Error("full table scan forbidden for direct requests"); };
  try {
    expect(resolveThread(f.server, id).id).toBe(thread.id);
    expect((await f.rpc("thread/read", { threadId: id })).error.code).toBe(-32601);
    expect((await f.rpc("thread/read", { threadId: crypto.randomUUID() })).error.code).toBe(ErrorCode.thread_not_found);
  } finally { f.server.log.allThreads = allThreads; }
  for (const method of ["thread/resume", "thread/read", "thread/items/list", "turn/start", "turn/steer", "thread/settings/update"])
    expect((await f.rpc(method, { threadId: id })).error.code).toBe(-32601);
  expect((await f.rpc("thread/start", { model: "sonnet", cwd: process.cwd() })).error.code).toBe(-32601);
  expect(f.server.log.allThreads()).toHaveLength(1);
  expect((await f.c.client.request("thread/list", {})).threads[0]?.id).toBe(thread.id);
});

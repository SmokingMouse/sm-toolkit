import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentServer } from "../server/server.js";
import { ItemSchema, NotificationSchemas, PendingServerRequestSchema, ServerRequestMethodSchema, ServerRequestSchemas, StartThreadParamsSchema, type Frame, type ServerRequestMethod, type ServerRequestResult } from "../protocol/index.js";
import { capture, client, input, until } from "../test-helpers.test.js";
import { CodexEngine, buildCodexThreadParams } from "./codex.js";
import { CodexEventMapper, codexUserInput, mapCodexDecision, mapCodexItem } from "./codex-mapper.js";
import type { EngineEvent } from "./session.js";

const fixture = resolve(import.meta.dir, "../../scripts/fixtures/fake-codex-app-server.ts");
test("N1: all Codex mapper error paths omit turnId before beginTurn", () => {
  const mapper = new CodexEventMapper();
  const batches = [
    mapper.map("item/started", { item: { id: "unknown", type: "futureItem" } }),
    mapper.map("item/agentMessage/delta", { itemId: "unknown", delta: "ignored" }),
    mapper.map("error", { error: { message: "early error" }, willRetry: false }),
  ];
  for (const batch of batches) {
    const errors = batch.filter(e => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).not.toHaveProperty("turnId");
    expect(NotificationSchemas.error.safeParse(errors[0]).success).toBe(true);
  }
});
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fake(scenario = "simple", options: { handshakeTimeoutMs?: number; version?: { userAgent?: unknown; cliVersion?: unknown } } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "as-codex-")), tracePath = join(directory, "wire.jsonl");
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const launches: Array<{ command: string; args: string[]; cwd?: string; env: NodeJS.ProcessEnv }> = [];
  let child: ReturnType<typeof spawn> | undefined;
  const engine = new CodexEngine({ ...options, spawnProcess: (command, args, opts) => {
    launches.push({ command, args, cwd: opts.cwd, env: { AS_TEST_MARKER: opts.env.AS_TEST_MARKER } });
    // Even if the production default executable changes, tests only start Bun.
    child = spawn(process.execPath, [fixture], { ...opts, env: { ...opts.env, FAKE_CODEX_SCENARIO: scenario, FAKE_CODEX_TRACE: tracePath, FAKE_CODEX_VERSION: options.version ? JSON.stringify(options.version) : undefined }, stdio: "pipe" });
    return child as ReturnType<NonNullable<import("./codex.js").CodexEngineOptions["spawnProcess"]>>;
  } });
  cleanup.push(() => engine.close("test"));
  const trace = (): Array<{ direction: string; frame: any }> => { try { return readFileSync(tracePath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
  return { engine, directory, launches, trace, get child() { return child; } };
}
function collect(engine: CodexEngine): EngineEvent[] {
  const events: EngineEvent[] = [];
  const consuming = (async () => { for await (const event of engine.events) events.push(event); })();
  cleanup.push(async () => { await engine.close("test"); await consuming; });
  return events;
}
const decision = (method: ServerRequestMethod): ServerRequestResult => method === "item/commandExecution/requestApproval" ? { decision: "acceptForSession" } : method === "item/fileChange/requestApproval" ? { decision: "reject" } : method === "item/permissions/requestApproval" ? { permissions: { network: { enabled: true } }, scope: "thread" } : { answers: { q: { answers: ["a"] } } };

const itemCases: Array<[Record<string, unknown>, string, Record<string, unknown>]> = [
  [{ type: "userMessage", content: [{ type: "text", text: "hi", text_elements: [] }] }, "userMessage", { content: input("hi") }],
  [{ type: "agentMessage", text: "hi", phase: "final_answer" }, "agentMessage", { text: "hi", phase: "final_answer" }],
  [{ type: "reasoning", summary: ["a", "b"], content: ["c"] }, "reasoning", { summary: "a\n\nb", text: "c" }],
  [{ type: "commandExecution", command: "pwd", cwd: "/tmp", status: "completed", commandActions: [], aggregatedOutput: "ok", exitCode: 0, durationMs: 3 }, "commandExecution", { command: "pwd", cwd: "/tmp", aggregatedOutput: "ok", exitCode: 0, durationMs: 3 }],
  [{ type: "fileChange", status: "declined", changes: [{ path: "/tmp/a", kind: { type: "add" }, diff: "+a" }] }, "fileChange", { changes: [{ path: "/tmp/a", kind: "add", diff: "+a" }], status: "rejected" }],
  [{ type: "functionCallOutput", name: "read", namespace: "files", output: "hello" }, "toolCall", { name: "read", namespace: "files", input: null, output: "hello" }],
  [{ type: "dynamicToolCall", tool: "test", arguments: { a: 1 }, status: "failed", contentItems: [{ type: "inputText", text: "error" }], success: false }, "toolCall", { name: "test", input: { a: 1 }, output: [{ type: "inputText", text: "error" }], isError: true }],
  [{ type: "mcpToolCall", server: "docs", tool: "search", arguments: { q: "test" }, status: "failed", error: { message: "failed" }, result: null }, "mcpToolCall", { server: "docs", tool: "search", arguments: { q: "test" }, error: { message: "failed" } }],
  [{ type: "collabAgentToolCall", tool: "spawnAgent", senderThreadId: "root", receiverThreadIds: ["child"], agentsStates: { child: { status: "completed", message: "done" } }, status: "completed" }, "subAgent", { kind: "agent", parentItemId: "it", phase: "completed" }],
  [{ type: "subAgentActivity", agentPath: "/root/child", agentThreadId: "child", kind: "completed" }, "subAgent", { kind: "agent", parentItemId: "it", phase: "completed" }],
  [{ type: "webSearch", query: "q", results: [{ title: "result" }] }, "webSearch", { query: "q", results: [{ title: "result" }] }],
  [{ type: "imageGeneration", status: "completed", result: "base64", savedPath: "/tmp/result.png" }, "imageOutput", { paths: ["/tmp/result.png"] }],
  [{ type: "plan", text: "1. Test" }, "plan", { text: "1. Test" }],
  [{ type: "contextCompaction" }, "contextCompaction", {}],
];
describe("Codex v2 mapper", () => {
  test.each(itemCases)("%j maps to %s with schema-valid payload", (native, type, payload) => {
    const item = mapCodexItem({ id: "it", ...native }, true);
    expect(item).toMatchObject({ id: "it", type, payload });
    expect(ItemSchema.safeParse({ ...item, seq: 1, turnId: "tn", startedAtMs: 1 }).success).toBe(true);
  });
  test("unknown items, patch kinds and malformed required fields fail explicitly", () => {
    for (const item of [{ id: "i", type: "futureItem" }, { id: "i", type: "commandExecution" }, { id: "i", type: "fileChange", changes: [{ path: "a", kind: { type: "future" }, diff: "" }] }]) expect(() => mapCodexItem(item)).toThrow(expect.objectContaining({ code: -32015 }));
  });
  test("rename maps to removal and addition; subagent activity links to spawn", () => {
    const item = mapCodexItem({ id: "i", type: "fileChange", status: "completed", changes: [{ path: "old", kind: { type: "update", move_path: "new" }, diff: "+x" }] });
    expect(item.payload).toMatchObject({ changes: [{ path: "old", kind: "delete" }, { path: "new", kind: "add" }] });
    const mapper = new CodexEventMapper(); mapper.beginTurn("tn");
    mapper.map("item/started", { item: { id: "parent", ...itemCases[8][0], status: "inProgress" } });
    expect(mapper.map("item/started", { item: { id: "activity", ...itemCases[9][0] } })[0]).toMatchObject({ item: { payload: { parentItemId: "parent" } } });
  });
  test.each(["accept", "acceptForSession", "reject", "abort"] as const)("decision %s has its native wire spelling", d => {
    for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"] as const) expect(mapCodexDecision(method, { decision: d })).toEqual({ decision: ({ accept: "accept", acceptForSession: "acceptForSession", reject: "decline", abort: "cancel" })[d] });
  });
  test("native policy amendments remain data, never become AS decisions", () => {
    expect(ServerRequestSchemas["item/commandExecution/requestApproval"].result.safeParse({ decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["pwd"] } } }).success).toBe(false);
  });
  test("thread model is inherited; effort, permission, sandbox, cwd and service tier are explicit", () => {
    const defaults = buildCodexThreadParams({ threadId: "th", backend: "codex" });
    expect(defaults).not.toHaveProperty("model"); expect(defaults).not.toHaveProperty("sandbox"); expect(defaults.serviceTier).toBe("default");
    const parsed = StartThreadParamsSchema.parse({ backend: "codex", cwd: "/tmp", model: "chosen-model", effort: "high", permission: "auto-edit", sandbox: "workspace-write" });
    expect(buildCodexThreadParams({ ...parsed, threadId: "th" })).toMatchObject({ model: "chosen-model", cwd: "/tmp", config: { model_reasoning_effort: "high" }, sandbox: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "user" });
    expect(() => buildCodexThreadParams({ backend: "codex", threadId: "th", permission: "readonly", sandbox: "danger-full-access" })).toThrow();
    expect(() => buildCodexThreadParams({ backend: "codex", threadId: "th", sandbox: "invalid" })).toThrow();
    expect(() => buildCodexThreadParams({ backend: "codex", threadId: "th", tools: ["Bash"] })).toThrow();
  });
  test("local attachments encode to v2 inputs without reading image bytes", () => {
    expect(codexUserInput([{ type: "image", path: "/tmp/not-present.png", mime: "image/png" }, { type: "file", path: "/tmp/note.txt", name: "note" }])).toEqual([{ type: "localImage", path: "/tmp/not-present.png" }, { type: "text", text: "Attached file (note): /tmp/note.txt", text_elements: [] }]);
  });
  test("new thread counts all cumulative usage; resume excludes inherited tokens", () => {
    const breakdown = (n: number) => ({ inputTokens: n, outputTokens: n, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0, totalTokens: n * 2 });
    for (const resumed of [false, true]) {
      const mapper = new CodexEventMapper(resumed); mapper.beginTurn("tn");
      mapper.map("thread/tokenUsage/updated", { tokenUsage: { last: breakdown(10), total: breakdown(30) } });
      const completed = mapper.map("turn/completed", { turn: { id: "native", status: "completed" } })[0];
      expect(completed).toMatchObject({ usage: { inputTokens: resumed ? 10 : 30, contextTokens: 20 } });
    }
  });
});

describe("Codex stdio process (scripted offline peer)", () => {
  test("midfork: native fork sends inclusive lastTurnId and returns an independent session", async () => {
    const f = fake(), events = collect(f.engine);
    await f.engine.spawn({ backend: "codex", threadId: "fork", cwd: f.directory, engineThreadId: "source-session", forkSession: true, forkPoint: "native-turn-boundary" });
    const request = f.trace().find(row => row.direction === "in" && row.frame.method === "thread/fork")!.frame;
    expect(request.params).toMatchObject({ threadId: "source-session", lastTurnId: "native-turn-boundary", excludeTurns: true });
    expect(f.engine.engineThreadId).not.toBe("source-session");
    await f.engine.sendTurn("next", input("continue"), { threadId: "fork", input: input("continue") });
    await until(() => events.some(event => event.type === "turnCompleted"));
    expect(events.find(event => event.type === "turnCompleted")).toMatchObject({ turnId: "next", status: "completed", forkPoint: expect.stringMatching(/^native-turn-/) });
  });
  test("midfork: seed creates a fresh session with role-labelled history and no model turn", async () => {
    const f = fake(), events = collect(f.engine);
    const seedHistory = [
      ItemSchema.parse({ id: "u", turnId: "old", seq: 1, startedAtMs: 0, type: "userMessage", payload: { content: input("old question") } }),
      ItemSchema.parse({ id: "a", turnId: "old", seq: 3, startedAtMs: 0, type: "agentMessage", payload: { text: "old answer" } }),
    ];
    await f.engine.spawn({ backend: "codex", threadId: "fork", cwd: f.directory, seedHistory, systemPrompt: "original system prompt" });
    const requests = f.trace().filter(row => row.direction === "in").map(row => row.frame);
    const start = requests.find(frame => frame.method === "thread/start");
    expect(start.params.baseInstructions).toBe("original system prompt");
    expect(JSON.parse(start.params.developerInstructions.split("\n")[1])).toEqual([{ role: "user", text: "old question" }, { role: "assistant", text: "old answer" }]);
    expect(start.params).not.toHaveProperty("threadId");
    expect(requests.some(frame => frame.method === "turn/start" || frame.method === "thread/fork")).toBe(false);
    expect(events.some(event => event.type === "itemStarted")).toBe(false);
    await f.engine.sendTurn("next", input("continue"), { threadId: "fork", input: input("continue") });
    await until(() => events.some(event => event.type === "turnCompleted"));
    expect(f.trace().find(row => row.direction === "in" && row.frame.method === "turn/start")!.frame.params.input[0].text).toBe("continue");
  });
  test("midfork: native fork rejects a peer that reuses the source identity", async () => {
    const f = fake("fork-reuses-source"); collect(f.engine);
    await expect(f.engine.spawn({ backend: "codex", threadId: "fork", cwd: f.directory, engineThreadId: "source", forkSession: true })).rejects.toMatchObject({ code: -32015 });
  });
  test("foundation Codex events: raw notifications occur once and new Claude inputs reject before dispatch", async () => {
    const f = fake(), events = collect(f.engine);
    await f.engine.spawn({ threadId: "th", backend: "codex", cwd: f.directory });
    const future = { method: "thread/futureNotice", params: { threadId: f.engine.engineThreadId, nested: [1, null] } };
    f.engine.receive(future);
    await f.engine.sendTurn("tn", input("go"), { threadId: "th", input: input("go") });
    await until(() => events.some(e => e.type === "turnCompleted"));
    expect(events.filter(e => e.type === "engineEvent" && e.subtype === "thread/futureNotice")).toEqual([{ type: "engineEvent", backend: "codex", subtype: "thread/futureNotice", payload: future }]);
    expect(events.filter(e => e.type === "engineEvent" && e.subtype === "turn/completed")).toHaveLength(1);
    expect(() => f.engine.validateTurn({ threadId: "th", input: [{ type: "bash", command: "pwd" }] })).toThrow("requires Claude");
    expect(() => f.engine.validateTurn({ threadId: "th", input: input("go"), permission: "plan" })).toThrow("require Claude");
    expect(() => buildCodexThreadParams({ threadId: "th", backend: "codex", autocompact: "auto" })).toThrow("requires Claude");
  });
  const realUserAgent = "sm_agent_server/0.153.4 (Mac OS 15.7.5; arm64) dumb (sm_agent_server; 0.1.0)";
  const versionCases = [
    { name: "codex-cli/x.y.z fallback", version: { userAgent: "codex-cli/0.153.4" }, warning: undefined },
    { name: "sm_agent_server/x.y.z real fallback", version: { userAgent: realUserAgent }, warning: undefined },
    { name: "cliVersion takes priority over mismatched userAgent", version: { userAgent: "codex-cli/99.0.0", cliVersion: "0.153.4" }, warning: undefined },
    { name: "cliVersion mismatch takes priority over matching userAgent", version: { userAgent: realUserAgent, cliVersion: "99.0.0" }, warning: "99.0.0" },
    { name: "both missing report unknown", version: {}, warning: "unknown" },
    { name: "empty cliVersion falls back to userAgent", version: { userAgent: realUserAgent, cliVersion: " " }, warning: undefined },
    { name: "unparseable userAgent reports unknown", version: { userAgent: "no version" }, warning: "unknown" },
    { name: "fallback mismatch remains visible", version: { userAgent: "another-client/99.0.0" }, warning: "99.0.0" },
  ];
  for (const resumed of [false, true]) test.each(versionCases)(`version on thread/${resumed ? "resume" : "start"}: $name`, async ({ version, warning }) => {
    const f = fake("simple", { version }), events = collect(f.engine);
    await f.engine.spawn({ threadId: "as-thread", backend: "codex", cwd: f.directory, ...(resumed ? { engineThreadId: "previous-native" } : {}) });
    await until(() => events.some(e => e.type === "metadata"));
    const errors = events.filter(e => e.type === "error");
    expect(errors).toHaveLength(warning ? 1 : 0);
    if (warning) expect(errors[0]).toMatchObject({ error: { code: -32015, message: `Codex version ${warning} differs from pinned schema 0.153.4` }, willRetry: false });
    expect(f.trace().filter(t => t.direction === "in").slice(0, 3).map(t => t.frame.method)).toEqual(["initialize", "initialized", resumed ? "thread/resume" : "thread/start"]);
  });
  test("initialize/initialized precede thread/start; one process serves two turns and attach", async () => {
    const f = fake(), events = collect(f.engine);
    await f.engine.spawn({ threadId: "as-thread", backend: "codex", cwd: f.directory });
    await f.engine.attach();
    for (const id of ["as-one", "as-two"]) { await f.engine.sendTurn(id, input(id), { threadId: "as-thread", input: input(id) }); await until(() => events.some(e => e.type === "turnCompleted" && e.turnId === id)); }
    expect(f.engine.engineThreadId).toBe("native-thread"); expect(f.launches).toHaveLength(1);
    expect(f.launches[0]).toMatchObject({ command: "codex", args: ["app-server", "--listen", "stdio://"], cwd: f.directory, env: { AS_TEST_MARKER: process.env.AS_TEST_MARKER } });
    const requests = f.trace().filter(t => t.direction === "in").map(t => t.frame);
    expect(requests.slice(0, 3).map(f => f.method)).toEqual(["initialize", "initialized", "thread/start"]);
    expect(requests[2].params).not.toHaveProperty("model");
    expect(events.filter(e => e.type === "turnCompleted").map(e => e.usage?.inputTokens)).toEqual([10, 10]);
    expect(events.filter(e => e.type === "usage").map(e => e.usage.inputTokens)).toEqual([10, 20]);
    expect(f.child?.stdin?.writableEnded).toBe(false);
  });
  test("resume uses native thread id and forwards model/effort through thread and turn config", async () => {
    const f = fake(), events = collect(f.engine);
    await f.engine.spawn({ threadId: "as-th", backend: "codex", engineThreadId: "previous-native", cwd: f.directory, model: "thread-model", effort: "high", permission: "readonly" });
    await f.engine.sendTurn("as-turn", input("go"), { threadId: "as-th", input: input("go"), model: "turn-model", effort: "low", cwd: f.directory, permission: "auto-edit", sandbox: "workspace-write" });
    await until(() => events.some(e => e.type === "turnCompleted"));
    const requests = f.trace().filter(t => t.direction === "in").map(t => t.frame);
    expect(requests.find(r => r.method === "thread/resume").params).toMatchObject({ threadId: "previous-native", excludeTurns: true, model: "thread-model", config: { model_reasoning_effort: "high" }, sandbox: "read-only", approvalPolicy: "never" });
    expect(requests.find(r => r.method === "turn/start").params).toMatchObject({ threadId: "previous-native", model: "turn-model", effort: "low", sandboxPolicy: { type: "workspaceWrite" }, approvalPolicy: "on-request" });
  });
  test("four reverse requests round trip; raw metadata survives and deltas complete with full text", async () => {
    const f = fake("conversation"), events = collect(f.engine);
    await f.engine.spawn({ threadId: "as-th", backend: "codex", cwd: f.directory });
    await f.engine.sendTurn("as-turn", input("go"), { threadId: "as-th", input: input("go") });
    for (let i = 0; i < 4; i++) {
      await until(() => events.filter(e => e.type === "approval").length > i);
      const approval = events.filter(e => e.type === "approval")[i];
      expect(PendingServerRequestSchema.safeParse(approval.request).success).toBe(true);
      expect(approval.request.params).toMatchObject({ threadId: "as-th", turnId: "as-turn" });
      await approval.respond(decision(approval.request.method)); await approval.respond(decision(approval.request.method));
    }
    await until(() => events.some(e => e.type === "turnCompleted"));
    const approvals = events.filter(e => e.type === "approval");
    expect(approvals[0].request.params.data?.raw).toMatchObject({ approvalId: "nested-approval", proposedExecpolicyAmendment: ["pwd"] });
    expect(approvals[1].request.params).toMatchObject({ changes: [{ kind: "update", diff: "-old\n+new" }] });
    expect(events.filter(e => e.type === "itemCompleted").map(e => e.item)).toEqual(expect.arrayContaining([expect.objectContaining({ type: "reasoning", payload: { summary: "Inspect\n\nVerify", text: "Reason" } }), expect.objectContaining({ type: "agentMessage", payload: { text: "你好，完成", phase: "final_answer" } })]));
    const responses = f.trace().filter(t => t.direction === "in" && "result" in t.frame);
    expect(responses.map(r => r.frame.id)).toEqual([71, "72", 73, "74"]);
    expect(events.filter(e => e.type === "itemDelta").map(e => e.kind)).toEqual(expect.arrayContaining(["summary", "reasoning", "stdout", "text"]));
  });
  test("steer and interrupt use native ids; acknowledgement does not finish the turn", async () => {
    const f = fake("hold"), events = collect(f.engine);
    await f.engine.spawn({ threadId: "as-th", backend: "codex", cwd: f.directory });
    await f.engine.sendTurn("as-turn", input("hold"), { threadId: "as-th", input: input("hold") });
    await f.engine.steer("as-turn", input("more")); await f.engine.interrupt("as-turn");
    expect(events.some(e => e.type === "turnCompleted")).toBe(false);
    await expect(f.engine.steer("as-turn", input("late"))).rejects.toMatchObject({ code: -32011 });
    await until(() => events.some(e => e.type === "turnCompleted"));
    expect(events.find(e => e.type === "turnCompleted")).toMatchObject({ turnId: "as-turn", status: "interrupted" });
    const requests = f.trace().filter(t => t.direction === "in").map(t => t.frame);
    expect(requests.find(r => r.method === "turn/steer").params.expectedTurnId).toMatch(/^native-turn-/);
    expect(requests.find(r => r.method === "turn/interrupt").params.turnId).toMatch(/^native-turn-/);
  });
  test("native request resolution expires the AS request and suppresses a late answer", async () => {
    const f = fake("cancel-request"), events = collect(f.engine);
    await f.engine.spawn({ threadId: "th", backend: "codex", cwd: f.directory });
    await f.engine.sendTurn("tn", input("go"), { threadId: "th", input: input("go") });
    await until(() => events.some(e => e.type === "approvalExpired"));
    const approval = events.find(e => e.type === "approval")!;
    await approval.respond({ answers: { q: { answers: ["late"] } } });
    expect(f.trace().some(t => t.direction === "in" && t.frame.id === 92)).toBe(false);
  });
  test("unknown server request gets -32015 and error notification without dropping the reply", async () => {
    const f = fake("unknown-request"), events = collect(f.engine);
    await f.engine.spawn({ threadId: "th", backend: "codex", cwd: f.directory });
    await f.engine.sendTurn("tn", input("go"), { threadId: "th", input: input("go") });
    await until(() => events.some(e => e.type === "turnCompleted"));
    expect(events.find(e => e.type === "error")).toMatchObject({ error: { code: -32015, data: { raw: expect.stringContaining("future/request") } }, willRetry: false });
    expect(f.trace().find(t => t.direction === "in" && t.frame.id === 911)?.frame.error.code).toBe(-32015);
  });
  test("native retryable error produces both error item and notification", async () => {
    const f = fake("native-error"), events = collect(f.engine);
    await f.engine.spawn({ threadId: "th", backend: "codex", cwd: f.directory });
    await f.engine.sendTurn("tn", input("go"), { threadId: "th", input: input("go") });
    await until(() => events.some(e => e.type === "turnCompleted"));
    expect(events.find(e => e.type === "error")).toMatchObject({ willRetry: true, error: { message: "temporary provider error" } });
    expect(events.filter(e => e.type === "itemCompleted").some(e => e.item.type === "error")).toBe(true);
  });
  test.each(["no-handshake", "bad-handshake"])("%s fails without starting a thread and reaps child", async scenario => {
    const f = fake(scenario, { handshakeTimeoutMs: 100 }), events = collect(f.engine);
    await expect(f.engine.spawn({ threadId: "th", backend: "codex", cwd: f.directory })).rejects.toMatchObject({ code: scenario === "no-handshake" ? -32004 : -32015 });
    await until(() => events.some(e => e.type === "exit"));
    await f.engine.close("test");
    expect(f.child?.exitCode !== null || f.child?.signalCode !== null).toBe(true);
    expect(f.trace().some(t => t.frame.method === "thread/start")).toBe(false);
  });
});

function integrated(scenario: string, approvalTimeoutMs?: number) {
  const peers: ReturnType<typeof fake>[] = [];
  const server = new AgentServer({ databasePath: ":memory:", allowedRoots: [tmpdir()], idleTimeoutMs: 0, approvalTimeoutMs, engineFactory: () => {
    const peer = fake(peers.length ? "simple" : scenario); peers.push(peer); return peer.engine;
  } });
  cleanup.push(() => server.close());
  return { server, peers };
}
describe("Codex through AS core", () => {
  test("pendingRequests: fake child, read-only observer, snapshot, four kinds and decidedBy; legacy stays connected", async () => {
    const { server } = integrated("conversation");
    const owner = await client(server, "phone", [...ServerRequestMethodSchema.options]);
    const legacy = await client(server, "legacy", []), legacyFrames = capture(legacy);
    const observer = server.connectInProcess(), observerFrames = capture(observer);
    const init = await observer.request("initialize", { protocolVersion: "as/1", client: { name: "display", label: "display", kind: "test", version: "1" }, capabilities: { pendingRequests: true } });
    await observer.notifyInitialized(); expect(init.capabilities.pendingRequests).toBe(true);
    const { thread } = await owner.request("thread/start", { backend: "codex", cwd: tmpdir() });
    await observer.request("thread/attach", { threadId: thread.id }); await legacy.request("thread/attach", { threadId: thread.id });
    const cards = capture(owner);
    const { turn } = await owner.request("turn/start", { threadId: thread.id, input: input("go") });
    await until(() => server.log.pendingRequests(thread.id).length === 1);
    const snapshot = await observer.request("thread/attach", { threadId: thread.id, sinceSeq: 99999 });
    expect(snapshot.items.every(i => i.status === "inProgress")).toBe(true);
    expect(snapshot.pendingRequests).toHaveLength(1);
    expect(snapshot.pendingRequests[0].state).toMatchObject({ threadId: thread.id, turnId: turn.id, kind: "commandExecution", status: "pending", decidedBy: null });
    const respond = (frame: Frame) => { if ("id" in frame && "method" in frame && ServerRequestMethodSchema.safeParse(frame.method).success) void owner.respond(frame.id, decision(frame.method as ServerRequestMethod)); };
    owner.onFrame(respond); for (const card of cards) respond(card);
    await until(() => server.log.turn(turn.id).status === "completed");
    const updates = observerFrames.filter(f => "method" in f && f.method === "thread/pendingRequests").map(f => NotificationSchemas["thread/pendingRequests"].parse((f as any).params));
    expect(updates).toHaveLength(8);
    expect(updates.filter(p => p.status === "pending").map(p => p.kind)).toEqual(["commandExecution", "fileChange", "permissions", "userInput"]);
    for (let i = 0; i < updates.length; i += 2) {
      expect(updates[i].createdAtMs).toBeGreaterThan(0); expect(updates[i + 1].updatedAtMs).toBeGreaterThanOrEqual(updates[i].createdAtMs);
      expect(updates[i + 1]).toEqual({ ...updates[i], status: "resolved", decidedBy: { clientId: owner.clientId, label: "phone" }, updatedAtMs: updates[i + 1].updatedAtMs });
    }
    expect(observerFrames.some(f => "id" in f && "method" in f && ServerRequestMethodSchema.safeParse(f.method).success)).toBe(false);
    expect(legacyFrames.some(f => "method" in f && f.method === "thread/pendingRequests")).toBe(false);
    await legacy.request("server/health", {}); expect(legacy.closed).toBe(false);
    expect((await observer.request("thread/attach", { threadId: thread.id })).pendingRequests).toEqual([]);
  });
  test.each(["pending-status", "pending-withdraw"])("pendingRequests: fake child %s publishes expired with reason", async scenario => {
    const { server } = integrated(scenario, scenario === "pending-status" ? 40 : 10000);
    const owner = await client(server, "owner"), observer = server.connectInProcess(), frames = capture(observer);
    await observer.request("initialize", { protocolVersion: "as/1", client: { name: "display", label: "display", kind: "test", version: "1" }, capabilities: { pendingRequests: true } }); await observer.notifyInitialized();
    const { thread } = await owner.request("thread/start", { backend: "codex", cwd: tmpdir() });
    await observer.request("thread/attach", { threadId: thread.id });
    const { turn } = await owner.request("turn/start", { threadId: thread.id, input: input("go") });
    await until(() => server.log.turn(turn.id).status === "completed");
    const updates = frames.filter(f => "method" in f && f.method === "thread/pendingRequests").map(f => NotificationSchemas["thread/pendingRequests"].parse((f as any).params));
    expect(updates.map(p => p.status)).toEqual(["pending", "expired"]);
    expect(updates[1]).toMatchObject({ requestId: updates[0].requestId, threadId: thread.id, turnId: turn.id, kind: "commandExecution", decidedBy: null, reason: scenario === "pending-status" ? "timeout" : "engine_resolved" });
    expect((await observer.request("thread/attach", { threadId: thread.id })).pendingRequests).toEqual([]);
  });
  test("native user items appear once, attachments/clientTurnId survive, and all approvals reach AS clients", async () => {
    const { server } = integrated("conversation"), c = await client(server, "codex-test", [...ServerRequestMethodSchema.options]), frames = capture(c);
    c.onFrame(frame => { if ("id" in frame && "method" in frame && ServerRequestMethodSchema.safeParse(frame.method).success) void c.respond(frame.id, decision(frame.method as ServerRequestMethod)); });
    const { thread } = await c.request("thread/start", { backend: "codex", cwd: tmpdir(), effort: "high" });
    const content = [...input("go"), { type: "image" as const, path: "/tmp/image.png", mime: "image/png" }, { type: "file" as const, path: "/tmp/file.txt" }];
    const { turn } = await c.request("turn/start", { threadId: thread.id, input: content, clientTurnId: "client-turn" });
    await until(() => server.log.turn(turn.id).status === "completed");
    const items = server.log.readItems(thread.id);
    expect(items.filter(i => i.type === "userMessage")).toHaveLength(1);
    expect(items.find(i => i.type === "userMessage")?.payload).toEqual({ content, clientTurnId: "client-turn" });
    const cursors = items.flatMap(i => [i.seq, i.completedSeq!]);
    expect(new Set(cursors).size).toBe(cursors.length);
    expect(cursors.toSorted((a, b) => a - b)).toEqual(cursors.map((_, i) => i + 1));
    expect(frames.filter(f => "method" in f && f.method === "serverRequest/resolved")).toHaveLength(4);
    for (const method of ["thread/tokenUsage/updated", "item/fileChange/patchUpdated", "turn/plan/updated", "turn/diff/updated"]) expect(frames.some(f => "method" in f && f.method === method)).toBe(true);
    expect(server.log.turn(turn.id).usage).toMatchObject({ inputTokens: 10, contextTokens: 13 });
    expect(server.threads.get(thread.id).status.type).toBe("idle");
  });
  test("interrupt retains FIFO and waits for native completion before dispatching next turn", async () => {
    const { server, peers } = integrated("hold"), c = await client(server);
    const { thread } = await c.request("thread/start", { backend: "codex", cwd: tmpdir() });
    const first = await c.request("turn/start", { threadId: thread.id, input: input("hold") });
    const next = await c.request("turn/start", { threadId: thread.id, input: input("complete") });
    await c.request("turn/steer", { threadId: thread.id, expectedTurnId: first.turn.id, input: input("more"), clientTurnId: "steered-client-id" });
    await c.request("turn/interrupt", { threadId: thread.id, turnId: first.turn.id });
    expect(server.log.turn(next.turn.id).status).toBe("queued");
    await until(() => server.log.turn(next.turn.id).status === "completed");
    expect(server.log.turn(first.turn.id).status).toBe("interrupted");
    expect(server.log.readItems(thread.id).filter(i => i.type === "userMessage")).toHaveLength(3);
    expect(server.log.readItems(thread.id).find(i => i.type === "userMessage" && i.id.startsWith("steer-"))?.payload).toMatchObject({ clientTurnId: "steered-client-id" });
    const trace = peers[0].trace();
    const completion = trace.findIndex(t => t.direction === "out" && t.frame.method === "turn/completed");
    const starts = trace.flatMap((t, i) => t.direction === "in" && t.frame.method === "turn/start" ? [i] : []);
    expect(starts[1]).toBeGreaterThan(completion);
  });
  test("crash freezes queue, fails partial items, expires approval, and resume consumes the preserved turn", async () => {
    const { server, peers } = integrated("crash"), c = await client(server, "offline", ["item/tool/requestUserInput"]), frames = capture(c);
    const { thread } = await c.request("thread/start", { backend: "codex", cwd: tmpdir() });
    const first = await c.request("turn/start", { threadId: thread.id, input: input("crash") });
    const next = await c.request("turn/start", { threadId: thread.id, input: input("complete") });
    await until(() => server.threads.get(thread.id).status.type === "systemError");
    expect(server.threads.queue(thread.id).isFrozen).toBe(true);
    expect(server.log.turn(first.turn.id)).toMatchObject({ status: "failed", error: { code: -32004, data: { stderr: expect.stringContaining("scripted crash") } } });
    expect(server.threads.queue(thread.id).read().map(t => t.turnId)).toEqual([next.turn.id]);
    expect(server.log.turn(next.turn.id).status).toBe("queued");
    expect(server.log.readItems(thread.id).find(i => i.type === "agentMessage")).toMatchObject({ status: "failed", payload: { text: "partial" } });
    expect(frames.some(f => "method" in f && f.method === "serverRequest/expired")).toBe(true);
    const resumed = await c.request("thread/resume", { threadId: thread.id });
    expect(resumed.attached).toBe(false); expect(resumed.thread.engineThreadId).toBe(thread.engineThreadId);
    await until(() => server.log.turn(next.turn.id).status === "completed");
    expect(peers).toHaveLength(2);
    expect(peers[1].trace().some(t => t.direction === "in" && t.frame.method === "thread/resume")).toBe(true);
  });
  test.each(["unknown-item", "unknown-request", "version-mismatch"])("C1/C2: %s reports -32015 while thread and next turn survive", async scenario => {
    const { server, peers } = integrated(scenario), c = await client(server), frames: Frame[] = capture(c);
    const { thread } = await c.request("thread/start", { backend: "codex", cwd: tmpdir() });
    const first = await c.request("turn/start", { threadId: thread.id, input: input("go") });
    await until(() => server.log.turn(first.turn.id).status === "completed");
    expect(frames.some(f => "method" in f && f.method === "error" && f.params.error.code === -32015)).toBe(true);
    const next = await c.request("turn/start", { threadId: thread.id, input: input("again") });
    await until(() => server.log.turn(next.turn.id).status === "completed");
    expect(server.threads.get(thread.id).status.type).toBe("idle");
    expect(peers).toHaveLength(1);
  });
  test.each(["system-error"])("%s produces AS error and systemError", async scenario => {
    const { server } = integrated(scenario), c = await client(server), frames: Frame[] = capture(c);
    const { thread } = await c.request("thread/start", { backend: "codex", cwd: tmpdir() });
    await c.request("turn/start", { threadId: thread.id, input: input("go") });
    await until(() => server.threads.get(thread.id).status.type === "systemError");
    expect(frames.some(f => "method" in f && f.method === "error" && f.params.error.code === -32004)).toBe(true);
  });
});

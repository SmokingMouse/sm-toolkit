import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventType, type AgentEvent } from "@smokingmouse/agent";
import { ClaudeEngine, buildClaudeLaunch, claudeUserMessage } from "./claude.js";
import { ClaudeEventMapper, mapPermissionDecision, mapPermissionRequest } from "./claude-mapper.js";
import { ItemSchema, PendingServerRequestSchema } from "../protocol/index.js";
import type { EngineEvent } from "./session.js";
import { input, until } from "../test-helpers.test.js";

const event = (type: AgentEvent["type"], data: Record<string, unknown> = {}): AgentEvent => ({ type, data, backend: "claude", sessionId: "sid" });
const cost = { usd: null, inputTokens: 10, outputTokens: 2, cachedTokens: 3, cacheCreation: 1, estimated: false, contextTokens: 14 };
const toolCases = [
  ["Bash", { command: "pwd" }, "commandExecution"], ["Write", { file_path: "/tmp/a", content: "hi" }, "fileChange"],
  ["Edit", { file_path: "/tmp/a", old_string: "x", new_string: "y" }, "fileChange"],
  ["MultiEdit", { file_path: "/tmp/a", edits: [{ old_string: "x", new_string: "y" }] }, "fileChange"],
  ["Read", { file_path: "/tmp/a" }, "toolCall"], ["mcp__server__read", { query: "q" }, "mcpToolCall"],
  ["WebSearch", { query: "q" }, "webSearch"], ["ExitPlanMode", { plan: "one" }, "plan"],
] as const;
describe("Claude AgentEvent mapping (no real CLI)", () => {
  test("reasoning and text aggregate; tool boundaries create a new answer item", () => {
    const m = new ClaudeEventMapper("/tmp"); m.beginTurn("tn"); const events: EngineEvent[] = [];
    for (const e of [event(EventType.Thinking, { text: "think" }), event(EventType.TextChunk, { text: "hello " }), event(EventType.TextChunk, { text: "world" }), event(EventType.ToolCall, { id: "bash", name: "Bash", input: { command: "pwd" } }), event(EventType.ToolCallDone, { id: "bash", output: "/tmp", isError: false, exitCode: 0 }), event(EventType.TextChunk, { text: "final" }), event(EventType.Result, { text: "final", cost })]) events.push(...m.map(e));
    const completed = events.filter(e => e.type === "itemCompleted"); expect(completed.map(e => e.item.type)).toEqual(["reasoning", "agentMessage", "commandExecution", "agentMessage"]);
    expect(completed[1].item.payload).toEqual({ text: "hello world" }); expect(completed[3].item.payload).toEqual({ text: "final" }); expect(completed[1].item.id).not.toBe(completed[3].item.id);
    expect(events.at(-1)).toMatchObject({ type: "turnCompleted", status: "completed", usage: cost });
    for (const e of completed) expect(ItemSchema.safeParse({ ...e.item, seq: 1, turnId: "tn", startedAtMs: 1 }).success).toBe(true);
  });
  test.each(toolCases)("%s maps to %s and retains identity through result", (name, data, type) => {
    const m = new ClaudeEventMapper("/tmp"); m.beginTurn("tn");
    const started = m.map(event(EventType.ToolCall, { id: "tool", name, input: data }));
    expect(started.at(-1)).toMatchObject({ type: "itemStarted", item: { id: "tool", type } });
    const completed = m.map(event(EventType.ToolCallDone, { id: "tool", output: "done", isError: false }));
    expect(completed.at(-1)).toMatchObject({ type: "itemCompleted", item: { id: "tool", type, status: "completed" } });
  });
  test("failed MCP/tool results retain error output", () => {
    const m = new ClaudeEventMapper(); m.beginTurn("tn"); m.map(event(EventType.ToolCall, { id: "mcp", name: "mcp__s__t", input: {} }));
    expect(m.map(event(EventType.ToolCallDone, { id: "mcp", output: "denied", isError: true }))[0]).toMatchObject({ item: { status: "failed", payload: { error: "denied" } } });
  });
  test.each(["local_agent", "local_bash", "local_workflow"])("task %s preserves parent, kind and report", taskType => {
    const m = new ClaudeEventMapper(); m.beginTurn("tn");
    const start = m.map(event(EventType.Task, { taskId: "task", toolUseId: "parent", taskType, phase: "started" }));
    expect(start[0]).toMatchObject({ item: { type: "subAgent", payload: { parentItemId: "parent", kind: taskType.slice(6) } } });
    const done = m.map(event(EventType.Task, { taskId: "task", toolUseId: "parent", phase: "completed", summary: "report" }));
    expect(done.at(-1)).toMatchObject({ type: "itemCompleted", item: { payload: { report: "report", kind: taskType.slice(6) } } });
  });
  test("file_change, image_output, error, session id and result fallback are preserved", () => {
    const m = new ClaudeEventMapper(); m.beginTurn("tn");
    expect(m.map(event(EventType.SessionStart))[0]).toEqual({ type: "metadata", engineThreadId: "sid" });
    expect(m.map(event(EventType.FileChange, { changes: [{ path: "a", kind: "delete" }] })).at(-1)).toMatchObject({ item: { type: "fileChange", payload: { changes: [{ path: "a", kind: "delete" }] } } });
    expect(m.map(event(EventType.ImageOutput, { paths: ["/tmp/image.png"] })).at(-1)).toMatchObject({ item: { type: "imageOutput" } });
    expect(m.map(event(EventType.Result, { text: "nonstreamed", cost }))[0]).toMatchObject({ item: { type: "agentMessage", payload: { text: "nonstreamed" } } });
    m.beginTurn("tn2"); expect(m.map(event(EventType.Error, { message: "failed" })).at(-1)).toMatchObject({ type: "turnCompleted", status: "failed" });
  });
  test("permission arriving before assistant envelope does not duplicate tool item", () => {
    const m = new ClaudeEventMapper(); m.beginTurn("tn"); const call = event(EventType.ToolCall, { id: "tool", name: "Bash", input: { command: "pwd" } });
    expect(m.map(call)).toHaveLength(1); expect(m.map(call)).toHaveLength(0);
  });
  test("unknown tool result fails explicitly with protocol error", () => {
    const m = new ClaudeEventMapper(); m.beginTurn("tn"); expect(() => m.map(event(EventType.ToolCallDone, { id: "missing" }))).toThrow("tool result without tool call");
  });
  test("four permission request shapes and native decisions round trip", () => {
    const names = ["Bash", "Write", "Read", "AskUserQuestion"];
    for (const toolName of names) {
      const req = { requestId: "ar", toolUseId: "it", toolName, input: { command: "pwd", file_path: "/tmp/a", questions: [{ question: "Pick", options: [{ label: "a" }] }] } };
      const mapped = mapPermissionRequest(req, "th", "tn", "/tmp", 1); expect(PendingServerRequestSchema.safeParse(mapped).success).toBe(true);
    }
    const req = { requestId: "ar", toolUseId: "it", toolName: "AskUserQuestion", input: { questions: [{ question: "Pick" }] } };
    expect(mapPermissionDecision(req, { answers: { q_0: { answers: ["a"] } } })).toMatchObject({ behavior: "allow", updatedInput: { answers: { Pick: "a" } } });
    expect(mapPermissionDecision(req, { decision: "reject" }).behavior).toBe("deny"); expect(mapPermissionDecision(req, { permissions: {}, scope: "turn" }).behavior).toBe("deny");
    expect(mapPermissionDecision(req, { decision: "acceptForSession" }).behavior).toBe("allow");
  });
  test("native fork argv, permissions.ask and stream-json persist across turns", () => {
    const launch = buildClaudeLaunch({ threadId: "th", backend: "claude", model: "opus", engineThreadId: "sid", forkSession: true, cwd: "/tmp", permission: "default" });
    expect(launch.args).toContain("--fork-session"); expect(launch.args).toContain("--resume"); expect(launch.args).toContain("--input-format"); expect(launch.args).toContain("--permission-prompt-tool");
    expect(JSON.parse(launch.args[launch.args.indexOf("--settings") + 1])).toEqual({ permissions: { ask: ["*"] } });
    expect(claudeUserMessage(input("text"))).toEqual({ type: "user", message: { role: "user", content: input("text") } });
  });
});

/** In-memory fake child: exercises control frame mapping without spawning any process. */
function fakeProcess(onUser: (send: (frame: unknown) => void, frame: any) => void) {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough(), stderr = new PassThrough(); const written: any[] = [];
  const send = (frame: unknown) => stdout.write(JSON.stringify(frame) + "\n");
  const stdin = new Writable({ write(chunk, _encoding, callback) {
    const frame = JSON.parse(chunk.toString()); written.push(frame);
    queueMicrotask(() => {
      if (frame.type === "control_request") send({ type: "control_response", response: { subtype: "success", request_id: frame.request_id, response: {} } });
      else if (frame.type === "user") onUser(send, frame);
    }); callback();
  } });
  Object.assign(child, { stdout, stderr, stdin, exitCode: null, signalCode: null, kill: () => { if (child.exitCode === null) { Object.assign(child, { exitCode: 0 }); queueMicrotask(() => { stdout.end(); stderr.end(); child.emit("close", 0); }); } return true; } });
  return { child, written, send };
}
describe("Claude native frame exchange (fake child only)", () => {
  test("one spawn, initialize handshake, two user messages, result never closes stdin", async () => {
    let spawns = 0;
    const fake = fakeProcess(send => {
      send({ type: "system", subtype: "init", session_id: "session-native" });
      send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } } });
      send({ type: "result", result: "hello", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 });
    });
    const engine = new ClaudeEngine({ spawnProcess: () => { spawns++; return fake.child; } }); const events: EngineEvent[] = [];
    const consuming = (async () => { for await (const event of engine.events) events.push(event); })();
    await engine.spawn({ threadId: "th", backend: "claude", cwd: "/tmp" });
    await engine.sendTurn("tn1", input("one"), { threadId: "th", input: input("one") }); await until(() => events.some(e => e.type === "turnCompleted" && e.turnId === "tn1"));
    expect(fake.child.stdin.writableEnded).toBe(false); await engine.attach();
    await engine.sendTurn("tn2", input("two"), { threadId: "th", input: input("two") }); await until(() => events.some(e => e.type === "turnCompleted" && e.turnId === "tn2"));
    expect(spawns).toBe(1); expect(fake.written.filter(f => f.type === "user")).toHaveLength(2); expect(engine.engineThreadId).toBe("session-native");
    await engine.close("test"); await consuming;
  });
  test("can_use_tool maps to reverse request and winner maps to native response", async () => {
    const fake = fakeProcess(send => send({ type: "control_request", request_id: "native-ar", request: { subtype: "can_use_tool", tool_use_id: "tool", tool_name: "Bash", input: { command: "pwd" } } }));
    const engine = new ClaudeEngine({ spawnProcess: () => fake.child }); const events: EngineEvent[] = [];
    const consuming = (async () => { for await (const event of engine.events) events.push(event); })();
    await engine.spawn({ threadId: "th", backend: "claude", cwd: "/tmp" }); await engine.sendTurn("tn", input("go"), { threadId: "th", input: input("go") });
    await until(() => events.some(e => e.type === "approval"));
    const approval = events.find(e => e.type === "approval")!; expect(approval.request).toMatchObject({ method: "item/commandExecution/requestApproval", params: { requestId: expect.stringContaining("ar_"), itemId: "tool" } });
    await approval.respond({ decision: "accept" }); expect(fake.written.at(-1)).toMatchObject({ type: "control_response", response: { request_id: "native-ar", response: { behavior: "allow", updatedInput: { command: "pwd" } } } });
    await engine.close("test"); await consuming;
  });
  test("interrupt waits for native result before permitting a new turn", async () => {
    const fake = fakeProcess(() => {}); const engine = new ClaudeEngine({ spawnProcess: () => fake.child }); const events: EngineEvent[] = [];
    const consuming = (async () => { for await (const event of engine.events) events.push(event); })();
    await engine.spawn({ threadId: "th", backend: "claude", cwd: "/tmp" }); await engine.sendTurn("tn", input("go"), { threadId: "th", input: input("go") }); await engine.interrupt("tn");
    expect(events.some(e => e.type === "turnCompleted")).toBe(false);
    fake.send({ type: "result", is_error: true, result: "interrupted" }); await until(() => events.some(e => e.type === "turnCompleted"));
    expect(events.at(-1)).toMatchObject({ type: "turnCompleted", status: "interrupted" }); await engine.close("test"); await consuming;
  });
  test("unknown native frame emits engine_protocol_error", async () => {
    const fake = fakeProcess(() => {}); const engine = new ClaudeEngine({ spawnProcess: () => fake.child }); const events: EngineEvent[] = [];
    const consuming = (async () => { for await (const event of engine.events) events.push(event); })();
    await engine.spawn({ threadId: "th", backend: "claude", cwd: "/tmp" }); fake.send({ type: "unrecognized" }); await until(() => events.some(e => e.type === "exit"));
    expect(events.at(-1)).toMatchObject({ type: "exit", error: { code: -32015 } }); await engine.close("test"); await consuming;
  });
  test("assistant text is preserved when partials and result text are absent", async () => {
    const fake = fakeProcess(send => { send({ type: "assistant", message: { content: [{ type: "text", text: "full answer" }, { type: "thinking", thinking: "" }] } }); send({ type: "result", result: "", usage: {} }); });
    const engine = new ClaudeEngine({ spawnProcess: () => fake.child }); const events: EngineEvent[] = [];
    const consuming = (async () => { for await (const event of engine.events) events.push(event); })();
    await engine.spawn({ threadId: "th", backend: "claude", cwd: "/tmp" }); await engine.sendTurn("tn", input("go"), { threadId: "th", input: input("go") }); await until(() => events.some(e => e.type === "turnCompleted"));
    expect(events.find(e => e.type === "itemCompleted")).toMatchObject({ item: { type: "agentMessage", payload: { text: "full answer" } } }); await engine.close("test"); await consuming;
  });
  test("native cancellation retracts the logical request and suppresses its late decision", async () => {
    const fake = fakeProcess(send => send({ type: "control_request", request_id: "cancel-ar", request: { subtype: "can_use_tool", tool_use_id: "tool", tool_name: "Bash", input: { command: "pwd" } } }));
    const engine = new ClaudeEngine({ spawnProcess: () => fake.child }); const events: EngineEvent[] = [];
    const consuming = (async () => { for await (const event of engine.events) events.push(event); })();
    await engine.spawn({ threadId: "th", backend: "claude", cwd: "/tmp" }); await engine.sendTurn("tn", input("go"), { threadId: "th", input: input("go") }); await until(() => events.some(e => e.type === "approval"));
    const approval = events.find(e => e.type === "approval")!; fake.send({ type: "control_cancel_request", request_id: "cancel-ar" }); await until(() => events.some(e => e.type === "approvalExpired"));
    expect(events.at(-1)).toMatchObject({ type: "approvalExpired", requestId: approval.request.params.requestId });
    await approval.respond({ decision: "accept" }); expect(fake.written.filter(f => f.type === "control_response")).toHaveLength(0); await engine.close("test"); await consuming;
  });
});

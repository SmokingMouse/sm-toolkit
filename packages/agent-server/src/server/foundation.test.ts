import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";
import { AgentServer } from "./server.js";
import { ClaudeEngine } from "../engines/claude.js";
import { MockEngine } from "../engines/mock.js";
import { MethodSchemas, NotificationSchemas } from "../protocol/index.js";
import { capture, client, input, until } from "../test-helpers.test.js";

function childFixture() {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough(), stderr = new PassThrough(), written: any[] = [];
  const send = (frame: unknown) => stdout.write(JSON.stringify(frame) + "\n");
  const stdin = new Writable({ write(chunk, _encoding, callback) {
    const frame = JSON.parse(chunk.toString()); written.push(frame);
    if (frame.type === "control_request") queueMicrotask(() => send({ type: "control_response", response: { subtype: "success", request_id: frame.request_id, response: frame.request.subtype === "set_permission_mode" ? { mode: frame.request.mode } : { echo: frame.request } } }));
    callback();
  } });
  Object.assign(child, { stdout, stderr, stdin, exitCode: null, signalCode: null, kill: () => { Object.assign(child, { exitCode: 0 }); queueMicrotask(() => child.emit("close", 0)); return true; } });
  return { child, send, written };
}
function fixture() {
  let peer = childFixture(), spawned = false;
  let argv: string[] = [];
  const server = new AgentServer({ databasePath: ":memory:", allowedRoots: [process.cwd()], idleTimeoutMs: 0, engineFactory: backend => backend === "claude" ? new ClaudeEngine({ spawnProcess: (_command, args) => { if (spawned) peer = childFixture(); spawned = true; argv = args; return peer.child; } }) : new MockEngine() });
  return { server, send: (frame: unknown) => peer.send(frame), get written() { return peer.written; }, argv: () => argv };
}

test("P1-1: escalation requires an owned live lease on every permission entry point", async () => {
  const f = fixture();
  try {
    const owner = await client(f.server, "owner"), stranger = await client(f.server, "stranger");
    const { thread } = await owner.request("thread/start", { backend: "claude", permission: "plan" });
    expect(f.argv()).not.toContain("--allow-dangerously-skip-permissions");
    const calls = [
      ["thread/permission/set", { threadId: thread.id, permission: "bypassPermissions" }],
      ["thread/permission/set", { threadId: thread.id, permission: "full" }],
      ["thread/engineControl", { threadId: thread.id, subtype: "set_permission_mode", params: { mode: "dontAsk" } }],
      ["thread/engineControl", { threadId: thread.id, subtype: "set_permission_mode", params: { mode: "plan", ultraplan: true } }],
      ["turn/start", { threadId: thread.id, input: input("go"), permission: "bypassPermissions" }],
      ["thread/resume", { threadId: thread.id, permission: "bypassPermissions" }],
    ] as const;
    const count = f.written.length;
    for (const [method, params] of calls) await expect(stranger.request(method, params)).rejects.toMatchObject({ code: -32005 });
    expect(f.written).toHaveLength(count);
    await owner.request("thread/lease/acquire", { threadId: thread.id });
    for (const [method, params] of calls) await expect(stranger.request(method, params)).rejects.toMatchObject({ code: -32012 });
    expect((await owner.request("thread/permission/set", { threadId: thread.id, permission: "dontAsk" })).thread.permission).toBe("dontAsk");
    await owner.request("thread/engineControl", { threadId: thread.id, subtype: "set_permission_mode", params: { mode: "bypassPermissions" } });
    expect(f.written.at(-1).request).toEqual({ subtype: "set_permission_mode", mode: "bypassPermissions" });
    await owner.request("thread/lease/release", { threadId: thread.id });
    await expect(owner.request("thread/permission/set", { threadId: thread.id, permission: "dontAsk" })).rejects.toMatchObject({ code: -32005 });
    await owner.request("thread/lease/acquire", { threadId: thread.id, ttlMs: 1 });
    await new Promise(resolve => setTimeout(resolve, 5));
    await expect(owner.request("thread/permission/set", { threadId: thread.id, permission: "dontAsk" })).rejects.toMatchObject({ code: -32005 });
  } finally { await f.server.close(); }
});

test("P2-1: invalid Claude effort rejects start, live resume and turn before native writes", async () => {
  const f = fixture();
  try {
    const c = await client(f.server);
    for (const effort of ["banana", "bogus", "HIGH", " "]) await expect(c.request("thread/start", { backend: "claude", effort })).rejects.toMatchObject({ code: -32602 });
    expect(f.written).toHaveLength(0);
    const { thread } = await c.request("thread/start", { backend: "claude", effort: "xhigh" });
    expect(f.argv()[f.argv().indexOf("--effort") + 1]).toBe("xhigh");
    const count = f.written.length;
    await expect(c.request("thread/resume", { threadId: thread.id, effort: "banana" })).rejects.toMatchObject({ code: -32602 });
    await expect(c.request("turn/start", { threadId: thread.id, effort: "banana", input: input("go") })).rejects.toMatchObject({ code: -32602 });
    expect(f.written).toHaveLength(count);
  } finally { await f.server.close(); }
});

test("P2-3: unnegotiated connections receive permission changes but not engineEvent", async () => {
  const f = fixture();
  try {
    const old = await client(f.server, "old"), frames = capture(old);
    const { thread } = await old.request("thread/start", { backend: "claude" });
    f.send({ type: "system", subtype: "new_notice" });
    await old.request("thread/permission/set", { threadId: thread.id, permission: "plan" });
    expect(frames.some(n => "method" in n && n.method === "thread/permission/changed")).toBe(true);
    expect(frames.some(n => "method" in n && n.method === "thread/engineEvent")).toBe(false);
    expect(old.closed).toBe(false); expect((await old.request("server/health", {})).threads.idle).toBe(1);
  } finally { await f.server.close(); }
});

test("P2-4: set_model updates thread and saved options, then respawns with the selected model", async () => {
  const f = fixture();
  try {
    const c = await client(f.server), notices = capture(c);
    const { thread } = await c.request("thread/start", { backend: "claude", model: "sonnet" });
    f.send({ type: "system", subtype: "init", session_id: "native-model-session" });
    await c.request("thread/engineControl", { threadId: thread.id, subtype: "set_model", params: { model: "opus" } });
    expect(f.server.threads.get(thread.id).model).toBe("opus");
    expect(f.server.log.options<any>(thread.id).model).toBe("opus");
    expect(notices.some(n => "method" in n && n.method === "thread/metadata/updated" && n.params.model === "opus")).toBe(true);
    await c.request("thread/close", { threadId: thread.id });
    const resumed = await c.request("thread/resume", { threadId: thread.id });
    expect(resumed.attached).toBe(false); expect(resumed.thread.model).toBe("opus");
    expect(f.argv()[f.argv().indexOf("--model") + 1]).toBe("opus");
    expect(f.argv()[f.argv().indexOf("--resume") + 1]).toBe("native-model-session");
  } finally { await f.server.close(); }
});

test("P2-5: permission aliases normalize in results, notifications and saved options", async () => {
  const f = fixture();
  try {
    const c = await client(f.server), notices = capture(c);
    const { thread } = await c.request("thread/start", { backend: "claude", permission: "full" });
    await c.request("thread/lease/acquire", { threadId: thread.id });
    for (const [permission, canonical] of [["auto-edit", "acceptEdits"], ["full", "bypassPermissions"]] as const) {
      const changed = await c.request("thread/permission/set", { threadId: thread.id, permission });
      expect(changed.thread.permission).toBe(canonical);
      expect(f.server.log.options<any>(thread.id).permission).toBe(canonical);
      expect(notices.some(n => "method" in n && n.method === "thread/permission/changed" && n.params.permission === canonical)).toBe(true);
      expect(f.written.at(-1).request.mode).toBe(canonical);
    }
  } finally { await f.server.close(); }
});

test("P2-5: AS autocompact rejects CLI shorthand and forwards explicit token counts", async () => {
  const f = fixture();
  try {
    const c = await client(f.server);
    for (const autocompact of ["500k", "200", 200, 999, 99999, 1000001, 100000.5]) await expect(c.request("thread/start", { backend: "claude", autocompact } as any)).rejects.toMatchObject({ code: -32602 });
    expect(f.written).toHaveLength(0);
    for (const autocompact of ["auto", 100000, 1000000] as const) {
      await c.request("thread/start", { backend: "claude", autocompact });
      expect(f.argv()[f.argv().indexOf("--autocompact") + 1]).toBe(String(autocompact));
    }
  } finally { await f.server.close(); }
});

test("foundation RPC: capabilities, hot permission persistence, effort shape, lease and backend refusals", async () => {
  const f = fixture();
  try {
    const c = await client(f.server), notices = capture(c);
    const { thread } = await c.request("thread/start", { backend: "claude", permission: "plan", effort: "high" });
    expect(thread.permission).toBe("plan");
    await c.request("thread/lease/acquire", { threadId: thread.id });
    const changed = await c.request("thread/permission/set", { threadId: thread.id, permission: "dontAsk" });
    expect(changed.thread.permission).toBe("dontAsk");
    expect(f.server.log.options<any>(thread.id).permission).toBe("dontAsk");
    expect(notices.some(n => "method" in n && n.method === "thread/permission/changed")).toBe(true);
    const result = await c.request("thread/effort/set", { threadId: thread.id, maxThinkingTokens: 4096, thinkingDisplay: null });
    expect(result).toMatchObject({ type: "control_response", response: { response: { echo: { subtype: "set_max_thinking_tokens", max_thinking_tokens: 4096, thinking_display: null } } } });
    await c.request("thread/engineControl", { threadId: thread.id, subtype: "set_permission_mode", params: { mode: "acceptEdits" } });
    expect((await c.request("thread/read", { threadId: thread.id })).thread.permission).toBe("acceptEdits");
    const holder = await client(f.server, "holder");
    await c.request("thread/lease/release", { threadId: thread.id });
    await holder.request("thread/lease/acquire", { threadId: thread.id });
    for (const [method, params] of [
      ["thread/permission/set", { threadId: thread.id, permission: "plan" }],
      ["thread/effort/set", { threadId: thread.id, maxThinkingTokens: null }],
      ["thread/engineControl", { threadId: thread.id, subtype: "mcp_status", params: {} }],
      ["thread/compact", { threadId: thread.id }],
    ] as const) await expect(c.request(method, params)).rejects.toMatchObject({ code: -32012 });
    const codex = await c.request("thread/start", { backend: "codex" });
    for (const [method, params] of [
      ["thread/engineControl", { threadId: codex.thread.id, subtype: "mcp_status", params: {} }],
      ["thread/permission/set", { threadId: codex.thread.id, permission: "plan" }],
      ["thread/effort/set", { threadId: codex.thread.id, maxThinkingTokens: null }],
      ["thread/compact", { threadId: codex.thread.id }],
    ] as const) await expect(c.request(method, params)).rejects.toMatchObject({ code: -32016 });
  } finally { await f.server.close(); }
});

test("foundation compact: slash frame, autocompact argv, queue ordering and clientTurnId deduplication", async () => {
  const f = fixture();
  try {
    const c = await client(f.server);
    const { thread } = await c.request("thread/start", { backend: "claude", autocompact: 200000 });
    expect(f.argv()[f.argv().indexOf("--autocompact") + 1]).toBe("200000");
    await c.request("turn/start", { threadId: thread.id, input: input("first") });
    const compact = { threadId: thread.id, instructions: "keep decisions", clientTurnId: "compact-id" };
    const queued = await c.request("thread/compact", compact);
    expect(queued.turn.status).toBe("queued");
    expect((await c.request("thread/compact", compact)).deduplicated).toBe(true);
    expect(f.written.filter(frame => frame.type === "user")).toHaveLength(1);
    f.send({ type: "result", result: "done", usage: {} });
    await until(() => f.written.filter(frame => frame.type === "user").length === 2);
    expect(f.written.at(-1)).toEqual({ type: "user", message: { role: "user", content: input("/compact keep decisions") } });
    f.send({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual" } });
    f.send({ type: "result", result: "", usage: {} });
    await until(() => f.server.threads.get(thread.id).status.type === "idle");
    expect((await c.request("thread/attach", { threadId: thread.id })).items.some(item => item.type === "contextCompaction")).toBe(true);
  } finally { await f.server.close(); }
});

test("foundation legacy compatibility: opt-in native events and bash snapshots remain readable without capability", async () => {
  const f = fixture();
  try {
    const old = await client(f.server, "old"), oldFrames = capture(old), modern = f.server.connectInProcess();
    const initialized = await modern.request("initialize", { protocolVersion: "as/1", client: { name: "new", version: "1", kind: "test", label: "new" }, capabilities: { engineEvents: true, bashInput: true } });
    expect(initialized.capabilities.engine?.engineEvents).toBe(true);
    await modern.notifyInitialized(); const modernFrames = capture(modern);
    const { thread } = await modern.request("thread/start", { backend: "claude" });
    await old.request("thread/attach", { threadId: thread.id });
    f.send({ type: "system", subtype: "future_unknown", nested: { untouched: [1, null] } });
    await until(() => modernFrames.some(n => "method" in n && n.method === "thread/engineEvent"));
    expect(oldFrames.some(n => "method" in n && n.method === "thread/engineEvent")).toBe(false);
    await modern.request("turn/start", { threadId: thread.id, input: [{ type: "bash", command: "pwd" }] });
    await until(() => f.written.some(frame => frame.type === "bash_command"));
    f.send({ type: "user", isReplay: true, message: { content: "<bash-stdout>/tmp</bash-stdout><bash-stderr></bash-stderr><bash-exit-code>0</bash-exit-code>" } });
    await until(() => f.server.threads.get(thread.id).status.type === "idle");
    const legacy = await old.request("thread/attach", { threadId: thread.id });
    const current = await modern.request("thread/attach", { threadId: thread.id });
    // Frozen pre-foundation UserInput variants (6b0f179/Trellis as-client).
    const legacyInput = z.discriminatedUnion("type", [z.object({ type: z.literal("text"), text: z.string() }), z.object({ type: z.literal("image"), path: z.string(), mime: z.string() }), z.object({ type: z.literal("file"), path: z.string(), mime: z.string().optional(), name: z.string().optional() })]);
    for (const item of legacy.items) if (item.type === "userMessage") expect(z.array(legacyInput).parse(item.payload.content)).toEqual(input("!pwd"));
    expect(current.items.find(item => item.type === "userMessage")?.payload).toEqual({ content: [{ type: "bash", command: "pwd" }] });
    expect(old.closed).toBe(false); expect((await old.request("server/health", {})).threads.idle).toBe(1);
  } finally { await f.server.close(); }
});

test("foundation schemas: strict new envelopes reject unknown keys and malformed budgets", () => {
  for (const [method, params] of [
    ["thread/engineControl", { threadId: "th", subtype: "mcp_status", params: {}, extra: true }],
    ["thread/permission/set", { threadId: "th", permission: "plan", extra: true }],
    ["thread/effort/set", { threadId: "th", maxThinkingTokens: 1.5 }],
    ["thread/effort/set", { threadId: "th", maxThinkingTokens: -1 }],
    ["thread/compact", { threadId: "th", extra: true }],
  ] as const) expect(MethodSchemas[method].params.safeParse(params).success).toBe(false);
  expect(NotificationSchemas["thread/engineEvent"].safeParse({ threadId: "th", backend: "claude", subtype: "new", payload: {}, extra: true }).success).toBe(false);
});

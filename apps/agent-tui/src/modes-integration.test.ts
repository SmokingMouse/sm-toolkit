import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AgentServer, MockEngine } from "@smokingmouse/agent-server";
import { AgentClient } from "@smokingmouse/agent-server/client";
import { ConnectionManager, listenUnix } from "@smokingmouse/agent-server/transport";
import { ProtocolError, type JsonObject, type ServerRequestResult } from "@smokingmouse/agent-server/protocol";
import { bindClient, TuiModel } from "./model.js";
import { Controller } from "./controller.js";
import { nativePermission, type Permission } from "./modes.js";
import { render } from "./render.js";

// Test-only engine exercises the real AS RPC/lease/item paths without a real CLI.
class ModeEngine extends MockEngine {
  permissions: Permission[] = [];
  controls: Array<{ subtype: string; params: JsonObject }> = [];
  rejectControl = false;
  rejectPermission = false;
  assertLease = () => {};
  async setPermission(permission: Permission): Promise<void> {
    if (["full", "bypassPermissions", "dontAsk"].includes(permission)) this.assertLease();
    if (this.rejectPermission) throw new Error("permission policy denied");
    this.permissions.push(permission);
    this.emit({ type: "permissionChanged", permission: nativePermission(permission) });
    await Bun.sleep(0);
  }
  async engineControl(subtype: string, params: JsonObject): Promise<JsonObject> {
    this.controls.push({ subtype, params });
    if (!this.rejectControl && subtype === "set_model") { this.emit({ type: "modelChanged", model: String(params.model) }); await Bun.sleep(0); }
    return { type: "control_response", response: this.rejectControl ? { subtype: "error", error: "control policy denied" } : { subtype: "success", response: {} } };
  }
}
async function wait(check: () => boolean): Promise<void> {
  const until = Date.now() + 5000;
  while (!check()) { if (Date.now() > until) throw new Error("mode test condition timed out"); await Bun.sleep(10); }
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup(permission: Permission = "default") {
  const home = mkdtempSync("/tmp/tui-modes-"), engine = new ModeEngine();
  const server = new AgentServer({ databasePath: join(home, "db"), token: "test", allowedRoots: [home], engineFactory: () => engine, idleTimeoutMs: 0 });
  const manager = new ConnectionManager(server), listener = listenUnix(manager, { path: join(home, "sock") });
  const clients: AgentClient[] = [];
  cleanups.push(async () => { clients.forEach(c => c.close()); listener.close(); await server.close(); rmSync(home, { recursive: true, force: true }); });
  async function connect(label: string) {
    const client = new AgentClient({ transport: "unix", path: listener.path }, { token: "test", client: { name: label, label, kind: "test", version: "1" }, capabilities: { engineEvents: true, serverRequests: ["item/permissions/requestApproval"] }, reconnect: false });
    clients.push(client); const model = new TuiModel(); bindClient(client, model);
    const controller = new Controller(client, model, () => {});
    await client.connect(); return { client, model, controller };
  }
  const a = await connect("terminal"), b = await connect("phone");
  a.model.launchPermission = permission;
  const { thread } = await a.client.request("thread/start", { backend: "claude", cwd: home, permission });
  for (const client of clients) await client.request("thread/attach", { threadId: thread.id });
  engine.assertLease = () => { if (!server.leases.read(thread.id)) throw new ProtocolError(-32005, "lease required"); };
  const command = async (text: string) => { a.model.input = text; await a.controller.key("\r", { name: "return" }); };
  return { home, engine, server, a, b, thread, command, connect };
}

test("P1-1 readonly cycle and picker preserve launch restrictions without any RPC", async () => {
  const { a, engine, server, thread, command } = await setup("readonly");
  await a.controller.key("", { name: "tab", shift: true });
  expect(a.model.thread?.permission).toBe("readonly"); expect(engine.permissions).toHaveLength(0);
  expect(server.log.options<any>(thread.id).permission).toBe("readonly");
  await command("/permissions");
  expect(a.model.permissionChoices).toEqual(["readonly"]);
  expect(render(a.model)).toContain("> 1. readonly (当前)");
  await a.controller.key("\r", { name: "return" });
  expect(engine.permissions).toHaveLength(0); expect(server.leases.read(thread.id)).toBeUndefined();
});

test("P1-3 launch permission remains authoritative after remote changes and unknown attach hides bypass", async () => {
  const { a, b, thread, engine } = await setup("full");
  engine.emit({ type: "permissionChanged", permission: "default" });
  await wait(() => a.model.thread?.permission === "default");
  await a.client.request("thread/attach", { threadId: thread.id });
  expect(a.model.bypassAvailable).toBe(true); expect(b.model.bypassAvailable).toBe(false);
  engine.emit({ type: "permissionChanged", permission: "bypassPermissions" });
  await wait(() => b.model.thread?.permission === "bypassPermissions");
  expect(b.model.bypassAvailable).toBe(false); expect(render(b.model, 220)).toContain("bypass 上限未知，已隐藏");
  a.model.launchPermission = "plan"; expect(a.model.bypassAvailable).toBe(false);
});

test("P1-4 dontAsk is gated by launch eligibility and uses a released escalation lease", async () => {
  const { a, b, server, thread, command } = await setup("full");
  expect(b.model.permissionChoices).not.toContain("dontAsk");
  a.model.launchPermission = "default";
  await command("/permissions"); expect(a.model.permissionChoices).not.toContain("dontAsk");
  expect(a.model.permissionPicker).toBe(-1);
  await a.controller.key("\r", { name: "return" }); expect(a.model.message).toContain("显式选择");
  await a.controller.key("", { name: "escape" });
  a.model.launchPermission = "full";
  await command("/permissions"); await a.controller.key("5"); await a.controller.key("\r", { name: "return" });
  expect(a.model.thread?.permission).toBe("dontAsk"); expect(server.leases.read(thread.id)).toBeUndefined();
});

test("P1-2 normal controls leave phone input available and escalation releases short lease on success and error", async () => {
  const { a, b, engine, thread, server, command } = await setup("full");
  for (const text of ["/effort high", "/model opus"]) { await command(text); expect(server.leases.read(thread.id)).toBeUndefined(); }
  for (const expected of ["default", "acceptEdits", "plan", "bypassPermissions"]) {
    await a.controller.key("", { name: "tab", shift: true }); expect(a.model.thread?.permission).toBe(expected);
    expect(server.leases.read(thread.id)).toBeUndefined();
  }
  await b.client.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "phone still works" }] });
  expect(engine.sent).toHaveLength(1);
  await a.controller.key("", { name: "tab", shift: true });
  engine.rejectPermission = true;
  // An escalation failure must release as well.
  await command("/permissions"); await a.controller.key("4"); await a.controller.key("\r", { name: "return" });
  expect(server.leases.read(thread.id)).toBeUndefined(); expect(a.model.thread?.permission).toBe("default");
});

test("mode commands use leases, preserve input/state on rejection, and retry takeover", async () => {
  const { a, b, thread, engine, command } = await setup();
  await b.client.request("thread/lease/acquire", { threadId: thread.id });
  await command("/model opus"); expect(a.model.input).toBe("/model opus");
  expect(a.model.message).toContain("另一客户端持有控制权（phone）"); expect(engine.controls).toHaveLength(0);
  await b.client.request("thread/lease/release", { threadId: thread.id });
  await command("/takeover"); expect(a.model.message).toContain("已接管");
  await command("/model opus"); expect(a.model.thread?.model).toBe("opus");
  await command("/effort high"); expect(engine.controls.at(-1)).toEqual({ subtype: "set_max_thinking_tokens", params: { max_thinking_tokens: 32768 } });
  expect(a.model.effort).toBe("high");
  engine.rejectControl = true;
  await command("/effort max"); expect(a.model.effort).toBe("high"); expect(a.model.input).toBe("/effort max");
  await command("/model forbidden"); expect(a.model.thread?.model).toBe("opus"); expect(a.model.message).toContain("policy denied");
  await command("/effort invalid"); expect(a.model.message).toContain("用法");
  engine.rejectPermission = true;
  await a.controller.key("", { name: "tab", shift: true }); expect(a.model.thread?.permission).toBe("default");
  engine.rejectPermission = false;
  await a.controller.key("", { name: "tab", shift: true }); expect(a.model.thread?.permission).toBe("acceptEdits");
  await wait(() => b.model.thread?.permission === "acceptEdits"); expect(b.model.message).toBe("");
  await command("/release"); await b.client.request("thread/lease/acquire", { threadId: thread.id });
  expect(engine.sent).toHaveLength(0);
});

test("bypass survives mode changes and reattach; dontAsk is picker-only and cancel makes no RPC", async () => {
  const { a, thread, engine, command } = await setup("bypassPermissions");
  await a.controller.key("", { name: "tab", shift: true });
  expect(a.model.thread?.permission).toBe("default");
  await a.client.request("thread/attach", { threadId: thread.id }); expect(a.model.bypassAvailable).toBe(true);
  for (const expected of ["acceptEdits", "plan", "bypassPermissions"]) {
    await a.controller.key("", { name: "tab", shift: true }); expect(a.model.thread?.permission).toBe(expected);
  }
  await command("/permissions"); await a.controller.key("5"); await a.controller.key("\r", { name: "return" });
  expect(a.model.thread?.permission).toBe("dontAsk");
  await a.controller.key("", { name: "tab", shift: true }); expect(a.model.thread?.permission).toBe("default");
  const count = engine.permissions.length;
  await command("/permissions"); await a.controller.key("", { name: "escape" }); expect(engine.permissions).toHaveLength(count);
});

test("P2-1 real expired escalation gate is unauthorized, not already_resolved", async () => {
  const { a, server, thread } = await setup("full");
  a.model.thread!.permission = "plan";
  const request = a.client.request.bind(a.client);
  a.client.request = async (method, params) => {
    if (method === "thread/permission/set") server.leases.clear(thread.id);
    return request(method, params);
  };
  await a.controller.key("", { name: "tab", shift: true });
  expect(a.model.thread?.permission).toBe("plan");
  expect(a.model.message).toContain("有效控制租约"); expect(a.model.message).not.toContain("审批已被处理");
});

test("P2-2 takeover rejects a live holder then succeeds after expiry and disconnect", async () => {
  const { a, b, server, thread, command } = await setup();
  await b.client.request("thread/lease/acquire", { threadId: thread.id, ttlMs: 100 });
  await command("/takeover"); expect(a.model.message).toContain("另一客户端持有控制权（phone）");
  expect(server.leases.read(thread.id)?.holder.clientId).toBe(b.client.clientId);
  await Bun.sleep(120);
  await command("/takeover"); expect(server.leases.read(thread.id)?.holder.clientId).toBe(a.client.clientId);
  expect(render(a.model, 220)).toContain("持有控制权至");
  await command("/release");
  await b.client.request("thread/lease/acquire", { threadId: thread.id }); b.client.close();
  await wait(() => !server.leases.read(thread.id));
  await command("/takeover"); expect(server.leases.read(thread.id)?.holder.clientId).toBe(a.client.clientId);
});

test("P2-3 model metadata synchronizes peers and fresh attach; unsupported effort state stays explicitly local", async () => {
  const { a, b, thread, command, connect } = await setup();
  await command("/model gpt-5"); await wait(() => b.model.thread?.model === "gpt-5");
  expect(b.model.contextWindow).toBe(400_000);
  await command("/effort high"); expect(render(a.model, 220)).toContain("high（本端设置）");
  expect(b.model.effort).toBeUndefined();
  await a.client.request("thread/attach", { threadId: thread.id }); expect(a.model.effort).toBeUndefined();
  b.model.input = "/effort low"; await b.controller.key("\r", { name: "return" });
  expect(b.model.effort).toBe("low"); b.client.close(); expect(b.model.effort).toBeUndefined();
  await command("/model opus");
  const c = await connect("reconnected"); await c.client.request("thread/attach", { threadId: thread.id });
  expect(c.model.thread?.model).toBe("opus"); expect(c.model.effort).toBeUndefined();
  expect(c.model.contextWindow).toBe(200_000);
});

test("P2-4 remote permission notification preserves local queue feedback", async () => {
  const { a, b, command } = await setup();
  await command("work"); await command("queued"); expect(a.model.message).toBe("已排队 #1");
  await b.controller.key("", { name: "tab", shift: true });
  await wait(() => a.model.thread?.permission === "acceptEdits");
  expect(a.model.message).toBe("已排队 #1"); expect(b.model.message).toBe("权限模式：acceptEdits");
});

test("compact lost response retries with one queued turn and does not invent a boundary", async () => {
  const { a, command, engine } = await setup();
  const request = a.client.request.bind(a.client); let lose = true;
  a.client.request = async (method, params) => {
    const result = await request(method, params);
    if (method === "thread/compact" && lose) { lose = false; throw new Error("response lost"); }
    return result;
  };
  await command("/compact keep decisions"); expect(a.model.input).toBe("/compact keep decisions");
  await command("/compact keep decisions"); expect(a.model.input).toBe("");
  expect(engine.sent).toHaveLength(1); expect(engine.sent[0].input).toEqual([{ type: "text", text: "/compact keep decisions" }]);
  expect(render(a.model)).not.toContain("── Context compacted");
});

test("P2-1 ExitPlanMode losing approval never switches permission or suggests takeover", async () => {
  const { a, b, command, engine, thread, home } = await setup("plan");
  await command("work"); const turnId = engine.sent[0].turnId;
  engine.emit({ type: "itemStarted", turnId, item: { id: "plan", type: "plan", payload: { text: "Review" } } });
  engine.emit({ type: "approval", request: { method: "item/permissions/requestApproval", params: { requestId: "race-plan", threadId: thread.id, turnId, itemId: "plan", cwd: home, startedAtMs: Date.now(), permissions: { toolName: "ExitPlanMode", input: {} } } }, respond() {} });
  await wait(() => !!a.model.activeCard && !!b.model.activeCard);
  // The unified lease excludes rivals after acquisition. Race before a's acquire instead.
  const request = a.client.request.bind(a.client);
  a.client.request = async (method, params) => {
    if (method === "thread/lease/acquire") {
      await b.controller.key("n");
      await wait(() => a.model.cards.get("race-plan")?.state === "resolved");
    }
    return request(method, params);
  };
  await a.controller.key("y");
  await a.client.request("server/health", {});
  expect(a.model.thread?.permission).toBe("plan"); expect(engine.permissions).toHaveLength(0);
  expect(a.model.message).not.toContain("/takeover");
});

for (const [key, scope] of [["y", "turn"], ["s", "session"]] as const) test(`P2-5 ExitPlanMode ${key} preserves ${scope} scope and reject leaves plan`, async () => {
  const { a, engine, thread, home, command } = await setup("plan");
  await command("work"); await wait(() => engine.sent.length === 1);
  const turnId = engine.sent[0].turnId;
  engine.emit({ type: "itemStarted", turnId, item: { id: "plan", type: "plan", payload: { text: "Build feature" } } });
  let answer: ServerRequestResult | undefined;
  const approval = (requestId: string) => engine.emit({ type: "approval", request: { method: "item/permissions/requestApproval", params: { requestId, threadId: thread.id, turnId, itemId: "plan", cwd: home, startedAtMs: Date.now(), permissions: { toolName: "ExitPlanMode", input: { plan: "Build feature" } } } }, respond(result) { answer = result; } });
  approval("deny-plan"); await wait(() => !!a.model.activeCard);
  expect(render(a.model)).toContain("退出 Plan mode 审批");
  await a.controller.key("n"); await wait(() => !!answer); expect(a.model.thread?.permission).toBe("plan");
  answer = undefined; approval("allow-plan"); await wait(() => a.model.activeCard?.request.params.requestId === "allow-plan");
  await a.controller.key(key);
  expect(answer).toMatchObject({ permissions: { toolName: "ExitPlanMode" }, scope });
  expect(a.model.thread?.permission).toBe("default"); expect(engine.permissions).toEqual(["default"]);
});

test("PTY modes: Shift+Tab three-state cycle, permissions, effort, model, compact boundary and denied lease", async () => {
  const { home, engine, a, b, thread } = await setup();
  const state = join(home, "state"), tokenDir = join(state, "sm-toolkit", "agent-server");
  mkdirSync(tokenDir, { recursive: true }); writeFileSync(join(tokenDir, "token"), "test\n");
  let screen = ""; const decoder = new TextDecoder();
  const proc = Bun.spawn([process.execPath, resolve(import.meta.dir, "../bin/agent-tui"), "--attach", thread.id, "--socket", join(home, "sock")], {
    env: { ...process.env, HOME: home, XDG_STATE_HOME: state, HERDR_PANE_ID: "", TERM: "xterm-256color" },
    terminal: { cols: 220, rows: 32, data(_terminal, data) { screen += decoder.decode(data, { stream: true }); } },
  });
  const key = (text: string) => { screen = ""; proc.terminal!.write(text); };
  try {
    await wait(() => screen.includes(thread.id.slice(0, 11)));
    for (const mode of ["acceptEdits", "plan", "default"]) { key("\x1b[Z"); await wait(() => screen.includes(`mode ${mode} |`)); expect(engine.permissions.at(-1)).toBe(mode); }
    key("/permissions \r"); await wait(() => screen.includes("3. plan"));
    expect(screen).not.toContain("4. dontAsk");
    key("3\r"); await wait(() => screen.includes("mode plan |"));
    key("\x1b[Z"); await wait(() => screen.includes("mode default |"));
    key("/effort high\r"); await wait(() => screen.includes("effort high（本端设置） |"));
    key("\t"); await wait(() => screen.includes("effort max（本端设置） |"));
    expect(engine.controls.at(-1)).toEqual({ subtype: "set_max_thinking_tokens", params: { max_thinking_tokens: 65536 } });
    key("/model gpt-5\r"); await wait(() => screen.includes("model gpt-5 |")); expect(screen).toContain("~400000");
    key("/compact \r"); await wait(() => engine.sent.length === 1);
    expect(engine.sent[0].input).toEqual([{ type: "text", text: "/compact" }]);
    const turnId = engine.sent[0].turnId;
    engine.emit({ type: "itemStarted", turnId, item: { id: "compact", type: "contextCompaction", payload: {} } });
    engine.emit({ type: "itemCompleted", turnId, item: { id: "compact", type: "contextCompaction", payload: {} } });
    engine.emit({ type: "turnCompleted", turnId, status: "completed" });
    await wait(() => screen.includes("── Context compacted · compact_boundary ──"));
    key("/release \r"); await wait(() => screen.includes("已释放控制权"));
    await b.client.request("thread/lease/acquire", { threadId: thread.id });
    key("\x1b[Z"); await wait(() => screen.includes("另一客户端持有控制权（phone）")); expect(screen).toContain("/takeover");
    await b.client.request("thread/lease/release", { threadId: thread.id });
    key("/takeover \r"); await wait(() => screen.includes("已接管控制权"));
    key("\x1b[Z"); await wait(() => screen.includes("mode acceptEdits |"));
    key("\x03\x03"); expect(await Promise.race([proc.exited, Bun.sleep(3000).then(() => -100)])).toBe(0);
    expect(a.model.thread?.permission).toBe("acceptEdits");
  } finally { if (proc.exitCode === null) proc.kill(); await proc.exited; proc.terminal?.close(); }
}, 20000);

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
    this.assertLease();
    if (this.rejectPermission) throw new Error("permission policy denied");
    this.permissions.push(permission);
    this.emit({ type: "permissionChanged", permission: nativePermission(permission) });
    await Bun.sleep(0);
  }
  async engineControl(subtype: string, params: JsonObject): Promise<JsonObject> {
    this.assertLease(); this.controls.push({ subtype, params });
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
  const { thread } = await a.client.request("thread/start", { backend: "claude", cwd: home, permission });
  for (const client of clients) await client.request("thread/attach", { threadId: thread.id });
  engine.assertLease = () => { if (!server.leases.read(thread.id)) throw new ProtocolError(-32014, "lease required"); };
  const command = async (text: string) => { a.model.input = text; await a.controller.key("\r", { name: "return" }); };
  return { home, engine, server, a, b, thread, command };
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

test("mode commands use leases, preserve input/state on rejection, and retry takeover", async () => {
  const { a, b, thread, engine, command } = await setup();
  await b.client.request("thread/lease/acquire", { threadId: thread.id });
  await command("/model opus"); expect(a.model.input).toBe("/model opus");
  expect(a.model.message).toContain("另一客户端持有控制权（phone）"); expect(engine.controls).toHaveLength(0);
  await b.client.request("thread/lease/release", { threadId: thread.id });
  await command("/takeover"); expect(a.model.message).toContain("已接管");
  await command("/model opus"); expect(a.model.liveModel).toBe("opus");
  await command("/effort high"); expect(engine.controls.at(-1)).toEqual({ subtype: "set_max_thinking_tokens", params: { max_thinking_tokens: 32768 } });
  expect(a.model.effort).toBe("high");
  engine.rejectControl = true;
  await command("/effort max"); expect(a.model.effort).toBe("high"); expect(a.model.input).toBe("/effort max");
  await command("/model forbidden"); expect(a.model.liveModel).toBe("opus"); expect(a.model.message).toContain("policy denied");
  await command("/effort invalid"); expect(a.model.message).toContain("用法");
  engine.rejectPermission = true;
  await a.controller.key("", { name: "tab", shift: true }); expect(a.model.thread?.permission).toBe("default");
  engine.rejectPermission = false;
  await a.controller.key("", { name: "tab", shift: true }); expect(a.model.thread?.permission).toBe("acceptEdits");
  await wait(() => b.model.thread?.permission === "acceptEdits"); expect(b.model.message).toContain("acceptEdits");
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

test("future -32014 lease gate keeps effort unchanged and exposes takeover", async () => {
  const { a, command } = await setup();
  const request = a.client.request.bind(a.client);
  a.client.request = async (method, params) => {
    if (method === "thread/effort/set") throw new ProtocolError(-32014, "lease required");
    return request(method, params);
  };
  await command("/effort high");
  expect(a.model.effort).toBeUndefined(); expect(a.model.input).toBe("/effort high");
  expect(a.model.message).toContain("另一客户端持有控制权"); expect(a.model.message).toContain("/takeover");
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

test("ExitPlanMode losing approval during lease acquisition never switches permission", async () => {
  const { a, b, command, engine, thread, home } = await setup("plan");
  await command("work"); const turnId = engine.sent[0].turnId;
  engine.emit({ type: "itemStarted", turnId, item: { id: "plan", type: "plan", payload: { text: "Review" } } });
  engine.emit({ type: "approval", request: { method: "item/permissions/requestApproval", params: { requestId: "race-plan", threadId: thread.id, turnId, itemId: "plan", cwd: home, startedAtMs: Date.now(), permissions: { toolName: "ExitPlanMode", input: {} } } }, respond() {} });
  await wait(() => !!a.model.activeCard && !!b.model.activeCard);
  const request = a.client.request.bind(a.client);
  a.client.request = async (method, params) => {
    if (method === "thread/lease/acquire") { await b.controller.key("n"); await wait(() => a.model.cards.get("race-plan")?.state === "resolved"); }
    return request(method, params);
  };
  await a.controller.key("y");
  expect(a.model.thread?.permission).toBe("plan"); expect(engine.permissions).toHaveLength(0);
  expect(a.model.message).toContain("另一客户端处理");
});

test("ExitPlanMode approval changes mode only after winning server confirmation; reject leaves plan", async () => {
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
  await a.controller.key("y");
  expect(answer).toMatchObject({ permissions: { toolName: "ExitPlanMode" }, scope: "turn" });
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
    await wait(() => screen.includes(thread.id));
    for (const mode of ["acceptEdits", "plan", "default"]) { key("\x1b[Z"); await wait(() => screen.includes(`mode ${mode} |`)); expect(engine.permissions.at(-1)).toBe(mode); }
    key("/permissions\r"); await wait(() => screen.includes("4. dontAsk"));
    key("4\r"); await wait(() => screen.includes("mode dontAsk |"));
    key("\x1b[Z"); await wait(() => screen.includes("mode default |"));
    key("/effort high\r"); await wait(() => screen.includes("effort high |"));
    key("\t"); await wait(() => screen.includes("effort max |"));
    expect(engine.controls.at(-1)).toEqual({ subtype: "set_max_thinking_tokens", params: { max_thinking_tokens: 65536 } });
    key("/model gpt-5\r"); await wait(() => screen.includes("model gpt-5 |")); expect(screen).toContain("~400000");
    key("/compact\r"); await wait(() => engine.sent.length === 1);
    expect(engine.sent[0].input).toEqual([{ type: "text", text: "/compact" }]);
    const turnId = engine.sent[0].turnId;
    engine.emit({ type: "itemStarted", turnId, item: { id: "compact", type: "contextCompaction", payload: {} } });
    engine.emit({ type: "itemCompleted", turnId, item: { id: "compact", type: "contextCompaction", payload: {} } });
    engine.emit({ type: "turnCompleted", turnId, status: "completed" });
    await wait(() => screen.includes("── Context compacted · compact_boundary ──"));
    key("/release\r"); await wait(() => screen.includes("已释放控制权"));
    await b.client.request("thread/lease/acquire", { threadId: thread.id });
    key("\x1b[Z"); await wait(() => screen.includes("另一客户端持有控制权（phone）")); expect(screen).toContain("/takeover");
    await b.client.request("thread/lease/release", { threadId: thread.id });
    key("/takeover\r"); await wait(() => screen.includes("已接管控制权"));
    key("\x1b[Z"); await wait(() => screen.includes("mode acceptEdits |"));
    key("\x03\x03"); expect(await Promise.race([proc.exited, Bun.sleep(3000).then(() => -100)])).toBe(0);
    expect(a.model.thread?.permission).toBe("acceptEdits");
  } finally { if (proc.exitCode === null) proc.kill(); await proc.exited; proc.terminal?.close(); }
}, 20000);

import { expect, test } from "bun:test";
import type { AgentClient } from "@smokingmouse/agent-server/client";
import { ThreadSchema, MethodSchemas, type Thread } from "@smokingmouse/agent-server/protocol";
import { Controller } from "./controller.js";
import { TuiModel } from "./model.js";
import { sortThreads } from "./sessions.js";
import { render } from "./render.js";

const thread = (id: string): Thread => ({ id, backend: "claude", cwd: "/tmp", model: "test-model", engineThreadId: null, createdAtMs: 1, status: { type: "idle" } });
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function setup() {
  const model = new TuiModel(); model.thread = thread("old"); model.connection = "connected";
  const calls: Array<[string, any]> = [];
  const client = { state: "connected", async request(method: string, params: any) {
    calls.push([method, params]);
    if (method === "thread/list") return { threads: [thread("old"), thread("new")], nextCursor: null };
    if (method === "thread/items/list") return { items: [], nextCursor: null };
    if (method === "thread/attach") return { thread: thread(params.threadId), items: [], queue: [], pendingRequests: [], nextSeq: 1 };
    return { thread: thread("new") };
  } } as unknown as AgentClient;
  return { model, calls, client, controller: new Controller(client, model, () => {}) };
}
test("selector sorts recent activity first with stable id tie break without mutating input", () => {
  const entries = ["b", "a", "c"].map((id, i) => ({ thread: thread(id), title: id, updatedAtMs: i === 2 ? 2 : 1 }));
  expect(sortThreads(entries).map(e => e.thread.id)).toEqual(["c", "a", "b"]);
  expect(entries.map(e => e.thread.id)).toEqual(["b", "a", "c"]);
});
test("P1-1: picker retains all short lists and scrolls only past the viewport, including wrapped entries", () => {
  const { model } = setup();
  const entries = Array.from({ length: 12 }, (_, i) => ({ thread: thread(`th_${String(i).padStart(8, "0")}`), title: `TITLE${i}`, updatedAtMs: 0 }));
  model.picker = { entries: entries.slice(0, 3), index: 1 };
  for (const entry of entries.slice(0, 3)) expect(render(model, 120, 30)).toContain(entry.thread.id);
  expect(model.picker.offset).toBe(0);
  model.picker = { entries, index: 0 };
  render(model, 120, 10);
  model.picker.index = 2;
  expect(render(model, 120, 10)).toContain(entries[0].thread.id); expect(model.picker.offset).toBe(0);
  model.picker.index = 7;
  const scrolled = render(model, 120, 10);
  expect(scrolled).toContain(`> ${entries[7].thread.id}`); expect(scrolled).toContain(entries[6].thread.id);
  expect(scrolled).not.toContain(entries[0].thread.id); expect(model.picker.offset).toBeGreaterThan(0);
  model.picker.index = 6; const offset = model.picker.offset; render(model, 120, 10); expect(model.picker.offset).toBe(offset);
  model.picker.index = 0; expect(render(model, 120, 10)).toContain(`> ${entries[0].thread.id}`); expect(model.picker.offset).toBe(0);
  model.picker.index = 8;
  const narrow = render(model, 40, 14);
  expect(narrow).toContain(`> ${entries[8].thread.id}`);
  expect(narrow.split("\n")).toHaveLength(14); expect(narrow.split("\n").every(line => Bun.stringWidth(line) < 40)).toBe(true);
  render(model, 180, 30); expect(model.picker.offset).toBe(0);
});
test("Ctrl-N starts in current cwd, attaches, detaches old and clears thread view only", async () => {
  const { model, controller, calls } = setup(); model.input = "draft"; model.activeTurnId = "old-turn";
  model.items.set("old", { id: "old", type: "agentMessage", turnId: "t", seq: 1, startedAtMs: 0, payload: { text: "OLD" } });
  await controller.key("\x0e", { ctrl: true, name: "n" });
  expect(calls.map(c => c[0])).toEqual(["thread/start", "thread/attach", "thread/detach"]);
  expect(calls[0][1]).toMatchObject({ cwd: "/tmp", backend: "claude", model: "test-model" });
  expect(model.thread?.id).toBe("new"); expect(model.items.size).toBe(0); expect(model.activeTurnId).toBeUndefined(); expect(model.input).toBe("draft");
});
test("Ctrl-T selector handles bounded arrows, Enter and Esc without sending turns", async () => {
  const { model, controller, calls } = setup();
  await controller.key("\x14", { ctrl: true, name: "t" });
  await controller.key(undefined, { name: "up" }); expect(model.picker?.index).toBe(0);
  await controller.key(undefined, { name: "down" }); await controller.key(undefined, { name: "down" }); expect(model.picker?.index).toBe(1);
  await controller.key(undefined, { name: "up" });
  await controller.key(undefined, { name: "return" }); expect(model.thread?.id).toBe("new"); expect(model.picker).toBeUndefined();
  await controller.key(undefined, { ctrl: true, name: "t" }); await controller.key(undefined, { name: "escape" });
  expect(model.picker).toBeUndefined(); expect(calls.some(c => c[0] === "turn/start")).toBe(false);
});
test("session commands are consumed locally; failed attach preserves current view and input", async () => {
  for (const command of ["/new", "/clear", "/fork", "/threads", "/resume", "/resume new"]) {
    const { model, controller, calls } = setup(); model.input = command; await controller.submit();
    expect(model.input).toBe(""); expect(calls.some(c => c[0] === "turn/start")).toBe(false);
  }
  const { model, controller, client } = setup();
  client.request = async () => { throw new Error("missing thread"); };
  model.input = "/resume missing"; await controller.key(undefined, { name: "return" });
  expect(model.thread?.id).toBe("old"); expect(model.input).toBe("/resume missing"); expect(model.message).toBe("missing thread");
});
test("P0-1/P2-2/P2-3: slow start, list and attach discard all in-flight keys with feedback", async () => {
  for (const [command, method] of [["/new", "thread/start"], ["/threads", "thread/list"], ["/resume new", "thread/attach"]]) {
    const { model, controller, client, calls } = setup(), pending = gate(), original = client.request.bind(client);
    client.request = async (name, params) => { if (name === method) await pending.promise; return original(name, params); };
    model.input = command;
    const operation = controller.key(undefined, { name: "return" });
    expect(model.input).toBe("");
    for (const c of "hello world/new".repeat(10)) await controller.key(c);
    await controller.key(undefined, { name: "return" });
    await controller.key(undefined, { ctrl: true, name: "n" });
    await controller.sessions.run("/new");
    expect(model.discardNote).toContain("已丢弃"); expect(model.input).toBe("");
    pending.release(); await operation;
    expect(model.input).toBe(""); expect(model.discardNote).toContain("按键已丢弃");
    expect(calls.filter(c => c[0] === "turn/start")).toHaveLength(0);
    expect(calls.filter(c => c[0] === "thread/start")).toHaveLength(command === "/new" ? 1 : 0);
  }
});
test("P2-6: Esc during picker attach is explicitly rejected and does not pretend to cancel", async () => {
  const { model, controller, client } = setup(), pending = gate(), original = client.request.bind(client);
  await controller.sessions.run("/threads");
  client.request = async (method, params) => { if (method === "thread/attach") await pending.promise; return original(method, params); };
  const operation = controller.key(undefined, { name: "return" });
  expect(render(model, 120, 20)).toContain("Esc 不取消在途操作");
  await controller.key(undefined, { name: "escape" });
  expect(model.picker).toBeDefined(); expect(model.thread?.id).toBe("old"); expect(model.discardNote).toContain("已丢弃");
  pending.release(); await operation;
  expect(model.thread?.id).toBe("new"); expect(model.picker).toBeUndefined();
});
test("P2-a: threads completion replaces in-flight text with one completion and discard notice", async () => {
  const { model, controller, client } = setup(), pending = gate(), original = client.request.bind(client);
  client.request = async (method, params) => { if (method === "thread/list") await pending.promise; return original(method, params); };
  const operation = controller.sessions.run("/threads");
  await controller.key("x"); pending.release(); await operation;
  expect(model.message).toBe("已加载 2 个会话");
  expect(render(model, 120, 20).match(/按键已丢弃/g)).toHaveLength(1);
  expect(model.message).not.toContain("进行中");
});
test("P2-b: failed session command preserves both error and discarded-input notice", async () => {
  const { model, controller, client } = setup(), pending = gate();
  client.request = async () => { await pending.promise; throw new Error("engine spawn failed"); };
  model.input = "/new";
  const operation = controller.key(undefined, { name: "return" });
  await controller.key("lost keys"); pending.release(); await operation;
  expect(model.input).toBe("/new"); expect(model.message).toBe("engine spawn failed");
  const screen = render(model, 80, 24);
  expect(screen).toContain("engine spawn failed"); expect(screen).toContain("按键已丢弃"); expect(screen.split("\n")).toHaveLength(24);
});
test("P2-5: an empty daemon list gives Enter feedback and Esc dismisses it", async () => {
  const { model, controller, client, calls } = setup(), original = client.request.bind(client);
  client.request = async (method, params) => {
    const result = await original(method, params);
    if (method === "thread/list" && "threads" in result) result.threads = [];
    return result;
  };
  await controller.sessions.run("/threads");
  expect(render(model, 120, 20)).toContain("daemon 中没有会话");
  await controller.key(undefined, { name: "return" }); expect(model.message).toContain("没有可选择的会话");
  expect(calls.filter(c => c[0] === "thread/attach")).toHaveLength(0);
  await controller.key(undefined, { name: "escape" }); expect(model.picker).toBeUndefined();
});
test("P2-3: paginated history retains late completions of older items in activity ordering", async () => {
  const { model, controller, client } = setup();
  client.request = (async (method: string, params: any) => {
    if (method === "thread/list") return { threads: [thread("old")], nextCursor: null };
    if (method === "thread/items/list") return params.cursor
      ? { items: [{ id: "prompt", type: "userMessage", seq: 2, startedAtMs: 200, turnId: "t", payload: { content: [{ type: "text", text: "first prompt" }] } }], nextCursor: null }
      : { items: [{ id: "long-tool", type: "agentMessage", seq: 1, startedAtMs: 100, completedAtMs: 500, turnId: "t", payload: { text: "late completion" } }], nextCursor: "next" };
    throw new Error(method);
  }) as AgentClient["request"];
  await controller.sessions.run("/threads");
  expect(model.picker?.entries[0].updatedAtMs).toBe(500);
  expect(model.picker?.entries[0].title).toBe("first prompt");
});
test("P0-2: resume reopens closed and systemError engines and refreshes snapshot", async () => {
  for (const status of ["closed", "systemError"] as const) {
    const { client, model, controller, calls } = setup(), original = client.request.bind(client);
    let resumed = false;
    client.request = async (method, params) => {
      const result = await original(method, params);
      if (method === "thread/resume") resumed = true;
      if (method === "thread/attach" && "thread" in result) result.thread.status = { type: resumed ? "idle" : status };
      return result;
    };
    model.thread!.status = { type: status };
    expect(render(model, 120, 20)).toContain("可恢复 · /resume");
    await controller.sessions.run("/resume", "old");
    expect(calls.map(c => c[0])).toEqual(["thread/attach", "thread/resume", "thread/attach"]);
    expect(model.thread?.status.type).toBe("idle");
    expect(render(model, 120, 20)).not.toContain("可恢复");
  }
});
test("P2-1/P2-4: actual protocol strips private engine options; status does not invent permission", () => {
  const options = { permission: "readonly", effort: "high", sandbox: "restricted", systemPrompt: "private", tools: ["Read"] };
  const parsed = ThreadSchema.parse({ ...thread("old"), ...options });
  const config = MethodSchemas["server/config/read"].result.parse({ allowed_roots: ["/tmp"], maxQueuedTurns: 10, orphanTimeoutMs: 0, idleTimeoutMs: 0, ...options });
  for (const field of Object.keys(options)) { expect(field in parsed).toBe(false); expect(field in config).toBe(false); }
  const { model } = setup(); model.thread = parsed;
  expect(render(model, 120, 20)).not.toContain("permission");
});
test("picker escapes titles and status includes current cwd and model", () => {
  const { model } = setup();
  model.picker = { index: 0, entries: [{ thread: thread("new"), title: "bad\x1b[2Jtitle", updatedAtMs: 1 }] };
  const screen = render(model, 120, 20);
  for (const value of ["old", "cwd /tmp", "model test-model", "badtitle", "1970-01-01"]) expect(screen).toContain(value);
  expect(screen).not.toContain("permission");
  expect(screen).not.toContain("\x1b");
});

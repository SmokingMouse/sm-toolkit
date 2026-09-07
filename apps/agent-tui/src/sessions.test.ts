import { expect, test } from "bun:test";
import type { AgentClient } from "@smokingmouse/agent-server/client";
import type { Thread } from "@smokingmouse/agent-server/protocol";
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
    expect(model.message).toContain("已丢弃"); expect(model.input).toBe("");
    pending.release(); await operation;
    expect(model.input).toBe(""); expect(model.message).toContain("按键已丢弃");
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
  expect(model.picker).toBeDefined(); expect(model.thread?.id).toBe("old"); expect(model.message).toContain("Esc 也不取消");
  pending.release(); await operation;
  expect(model.thread?.id).toBe("new"); expect(model.picker).toBeUndefined();
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
test("status shows permission only when present in thread state; picker escapes titles", () => {
  const { model } = setup();
  model.picker = { index: 0, entries: [{ thread: thread("new"), title: "bad\x1b[2Jtitle", updatedAtMs: 1 }] };
  const screen = render(model, 120, 20);
  for (const value of ["old", "cwd /tmp", "model test-model", "badtitle", "1970-01-01"]) expect(screen).toContain(value);
  expect(screen).not.toContain("permission");
  Object.assign(model.thread!, { permission: "readonly" });
  expect(render(model, 120, 20)).toContain("permission readonly");
  expect(screen).not.toContain("\x1b");
});

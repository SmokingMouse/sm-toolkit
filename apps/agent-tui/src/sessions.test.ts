import { expect, test } from "bun:test";
import type { AgentClient } from "@smokingmouse/agent-server/client";
import type { Thread } from "@smokingmouse/agent-server/protocol";
import { Controller } from "./controller.js";
import { TuiModel } from "./model.js";
import { sortThreads } from "./sessions.js";
import { render } from "./render.js";

const thread = (id: string): Thread => ({ id, backend: "claude", cwd: "/tmp", model: "test-model", engineThreadId: null, createdAtMs: 1, status: { type: "idle" } });
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
test("status includes thread cwd model and explicit unavailable permission; picker escapes titles", () => {
  const { model } = setup();
  model.picker = { index: 0, entries: [{ thread: thread("new"), title: "bad\x1b[2Jtitle", updatedAtMs: 1 }] };
  const screen = render(model, 120, 20);
  for (const value of ["old", "cwd /tmp", "model test-model", "permission unknown", "badtitle", "1970-01-01"]) expect(screen).toContain(value);
  expect(screen).not.toContain("\x1b");
});

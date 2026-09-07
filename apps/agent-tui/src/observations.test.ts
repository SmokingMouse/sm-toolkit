import { expect, test } from "bun:test";
import type { Item } from "@smokingmouse/agent-server/protocol";
import { classifyEvent, rebuildTasks } from "./observations.js";
import { TuiModel } from "./model.js";
import { plain, render, renderTimeline } from "./render.js";

test("observation categories retain unknown JSON and highlight retries, limits and failed hooks", () => {
  for (const [subtype, category] of [["stop_hook_summary", "hook"], ["hook_started", "hook"], ["local_command", "command"], ["api_retry", "retry"], ["rate_limit_event", "rate_limit"], ["model_refusal_fallback", "fallback"], ["memory_loaded", "memory"], ["away_summary", "summary"]]) {
    expect(classifyEvent(subtype, { message: "hello" }, 123)).toMatchObject({ category, time: 123, summary: "hello" });
  }
  const payload = { nested: { value: [1, "two\nthree"] }, surprise: true };
  expect(classifyEvent("future", payload).summary).toBe(JSON.stringify(payload));
  for (const subtype of ["api_retry", "rate_limit", "model_refusal_fallback"]) expect(classifyEvent(subtype, {}).error).toBe(true);
  expect(classifyEvent("hook_response", { exitCode: 1, stderr: "bad" })).toMatchObject({ error: true, summary: "bad" });
  expect(classifyEvent("stop_hook_summary", { hook_errors: ["bad"] }).error).toBe(true);
  expect(classifyEvent("hook_started", {}).error).toBe(false);
});
const tool = (id: string, seq: number, name: string, input: unknown, output?: unknown): Item => ({ id, seq, turnId: "t", startedAtMs: 0, status: "completed", type: "toolCall", payload: { name, input: input as never, output: output as never } });
test("P1-1: newlines and ANSI in every observation field cannot overflow a fixed-height frame", () => {
  const model = new TuiModel(), hostile = "one\ntwo\nthree\x1b[2J\x1b]52;c;clipboard\x07\r\x00";
  model.tasksVisible = true; model.logExpanded = true;
  model.items.set("task", tool("task", 1, "TaskCreate", { id: hostile, subject: hostile, status: hostile }));
  model.items.set("sub", { id: hostile, seq: 2, turnId: "t", startedAtMs: 0, status: "inProgress", type: "subAgent", payload: { kind: "agent", parentItemId: hostile, phase: hostile, text: hostile } });
  model.logs.push(classifyEvent(hostile, { message: hostile })); model.message = hostile; model.input = hostile;
  for (const rows of [4, 8, 30]) for (const columns of [20, 100]) {
    const frame = render(model, columns, rows);
    expect(frame.split("\n")).toHaveLength(rows);
    expect(frame.split("\n").every(line => Bun.stringWidth(line) < columns)).toBe(true);
    expect(frame).not.toContain("\x1b"); expect(frame).not.toContain("\x07");
  }
});
test("task replay handles create/update/list/delete, duplicate snapshots and failed calls", () => {
  const items = new Map<string, Item>();
  const create = tool("create", 1, "TaskCreate", { subject: "first" });
  items.set(create.id, create); items.set(create.id, structuredClone(create));
  expect([...rebuildTasks(items.values()).values()]).toEqual([{ id: "1", title: "first", status: "pending", inferred: true }]);
  items.set("update", tool("update", 2, "TaskUpdate", { taskId: "1", status: "in_progress", subject: "renamed" }));
  expect(rebuildTasks(items.values()).get("1")).toMatchObject({ title: "renamed", status: "in_progress" });
  items.set("list", tool("list", 3, "TaskList", { tasks: [{ id: "8", subject: "from list", status: "pending" }] }));
  items.set("bad", { ...tool("bad", 4, "TaskUpdate", { taskId: "8", status: "completed" }), status: "failed" });
  expect([...rebuildTasks(items.values()).values()]).toEqual([{ id: "8", title: "from list", status: "pending" }]);
  items.set("delete", tool("delete", 5, "TaskUpdate", { taskId: "8", status: "deleted" }));
  expect(rebuildTasks(items.values()).size).toBe(0);
  expect(rebuildTasks([tool("x", 1, "TaskCreate", { subject: "actual" }, { task: { id: "22" } })]).get("22")?.inferred).toBeUndefined();
  expect(rebuildTasks([tool("x", 1, "TaskUpdate", { taskId: "9", status: "completed" })]).get("9")?.title).toBe("标题未知");
  expect(rebuildTasks([tool("x", 1, "TaskCreate", { subject: "x" }), tool("l", 2, "TaskList", {})]).size).toBe(1);
});
test("subagents nest beneath parent tools, fold individually and render orphan/cycle safely", () => {
  const model = new TuiModel();
  const sub = (id: string, parentItemId: string, seq: number): Item => ({ id, seq, turnId: "t", startedAtMs: 0, status: "inProgress", type: "subAgent", payload: { kind: "agent", parentItemId, phase: "working", text: `${id} body` } });
  for (const item of [sub("child", "parent", 1), tool("parent", 2, "Agent", {}), sub("nested", "child", 3), sub("orphan", "missing", 4)]) model.items.set(item.id, item);
  const lines = renderTimeline(model);
  expect(lines.indexOf("Tool Agent")).toBeLessThan(lines.findIndex(l => l.includes("SubAgent child")));
  expect(lines).toContain("      nested body");
  expect(lines.join("\n")).toContain("parent missing");
  model.collapsedAgents.add("child");
  expect(renderTimeline(model).join("\n")).not.toContain("child body");
  expect(renderTimeline(model).join("\n")).not.toContain("nested body");
  model.items.set("loop", sub("loop", "loop", 5));
  expect(renderTimeline(model).filter(l => l.includes("SubAgent loop"))).toHaveLength(1);
});
test("log reconnect warning survives snapshots; panel viewports preserve size and sanitize terminal input", () => {
  const model = new TuiModel();
  model.thread = { id: "th", backend: "claude", engineThreadId: null, cwd: "/tmp", createdAtMs: 0, status: { type: "idle" } };
  model.setConnection("connected"); model.setConnection("reconnecting"); model.setConnection("connected");
  model.snapshot({ thread: model.thread, items: [], queue: [], pendingRequests: [] } as never);
  for (let i = 0; i < 30; i++) model.notification({ jsonrpc: "2.0", method: "thread/engineEvent", params: { threadId: "th", backend: "claude", subtype: "api_retry", payload: { message: `event-${i}\x1b]52;c;evil\x07` } } });
  model.notification({ jsonrpc: "2.0", method: "thread/engineEvent", params: { threadId: "other", backend: "claude", subtype: "x", payload: {} } });
  expect(model.logs).toHaveLength(30);
  expect(render(model)).toContain("重连后可能缺失"); expect(render(model)).not.toContain("event-29");
  model.logExpanded = true; model.tasksVisible = true;
  expect(render(model, 100, 30, true)).toContain("\x1b[31m");
  expect(render(model)).toContain("event-29"); model.logScroll = 15;
  expect(render(model)).not.toContain("event-29");
  for (const rows of [4, 5, 8, 15, 30]) for (const columns of [8, 30, 100]) {
    const output = render(model, columns, rows, true);
    expect(output.split("\n")).toHaveLength(rows);
    expect(output.split("\n").every(l => Bun.stringWidth(plain(l)) < columns)).toBe(true);
    expect(output).not.toContain("evil");
  }
});

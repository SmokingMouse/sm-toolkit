import { expect, test } from "bun:test";
import type { Item } from "@smokingmouse/agent-server/protocol";
import { forkEntries, itemSummary } from "./fork.js";
import { TuiModel } from "./model.js";
import { Controller } from "./controller.js";
import type { AgentClient } from "@smokingmouse/agent-server/client";
import { render } from "./render.js";

const item = (id: string, seq: number, text = id): Item => ({ id, seq, type: "agentMessage", turnId: "turn", startedAtMs: 1, payload: { text } });
test("fork summaries normalize multiline text, strip terminal controls and truncate Unicode safely", () => {
  expect(itemSummary(item("i", 1, "a\n \x1b[2Jb\t c"))).toBe("Agent: a b c");
  const summary = itemSummary(item("i", 1, "😀".repeat(100)), 12);
  expect(Array.from(summary)).toHaveLength(12); expect(summary).toBe("Agent: 😀😀😀😀…");
  expect(itemSummary({ ...item("cmd", 2), type: "commandExecution", payload: { command: "pwd", cwd: "/tmp" } })).toContain("$ pwd");
  expect(itemSummary({ ...item("files", 3), type: "fileChange", payload: { changes: [{ kind: "update", path: "file.ts" }] } })).toContain("update file.ts");
});
test("fork selector sorts by seq and stable id without mutating source, includes all item kinds and live boundaries", () => {
  const items = [item("z", 9), item("b", 2), { ...item("a", 2), status: "inProgress" as const }];
  expect(forkEntries(items).map(e => [e.itemId, e.seq, e.type])).toEqual([["a", 2, "agentMessage"], ["b", 2, "agentMessage"], ["z", 9, "agentMessage"]]);
  expect(items.map(i => i.id)).toEqual(["z", "b", "a"]);
});
function setup(supported: boolean) {
  const model = new TuiModel(); model.connection = "connected";
  model.thread = { id: "source", backend: "claude", engineThreadId: null, cwd: "/tmp", createdAtMs: 1, status: { type: "idle" } };
  const calls: Array<[string, any]> = [];
  const client = { state: "connected", initializeResult: { capabilities: { midThreadFork: supported } }, onStateChange: () => () => {}, onNotification: () => () => {}, async request(method: string, params: any) {
    calls.push([method, params]);
    if (method === "thread/items/list") return params.cursor ? { items: [item("first", 1)], nextCursor: null } : { items: [item("last", 20)], nextCursor: "page2" };
    if (method === "thread/fork") return { thread: { ...model.thread, id: "branch" } };
    if (method === "thread/attach") return { thread: { ...model.thread, id: params.threadId }, items: [], queue: [], pendingRequests: [], nextSeq: 1 };
    return {};
  } } as unknown as AgentClient;
  return { model, calls, controller: new Controller(client, model, () => {}) };
}
test("fork selection fetches all pages, navigates, cancels, and sends fromItemId before switching", async () => {
  const { model, calls, controller } = setup(true);
  await controller.sessions.run("/fork");
  expect(model.forkPicker?.entries.map(e => e.itemId)).toEqual(["first", "last"]);
  expect(render(model, 120, 20)).toContain("#1 first | agentMessage | Agent: first");
  await controller.key(undefined, { name: "escape" }); expect(model.forkPicker).toBeUndefined();
  expect(calls.some(c => c[0] === "thread/fork")).toBe(false);
  await controller.sessions.run("/fork");
  await controller.key(undefined, { name: "down" }); await controller.key(undefined, { name: "up" });
  await controller.key(undefined, { name: "return" });
  expect(calls.find(c => c[0] === "thread/fork")?.[1]).toMatchObject({ threadId: "source", fromItemId: "first" });
  expect(model.thread?.id).toBe("branch"); expect(model.forkPicker).toBeUndefined();
  expect(calls.at(-1)).toEqual(["thread/detach", { threadId: "source" }]);
});
test("fork direct id bypasses picker; missing capability offers only explicit tip action", async () => {
  const direct = setup(true); await direct.controller.sessions.run("/fork", "first");
  expect(direct.calls[0][1]).toMatchObject({ fromItemId: "first" }); expect(direct.model.thread?.id).toBe("branch");
  for (const argument of ["", "first"]) {
    const { model, calls, controller } = setup(false);
    await controller.sessions.run("/fork", argument);
    expect(model.message).toBe("当前 daemon 不支持从中间分叉"); expect(calls).toHaveLength(0);
    expect(model.forkPicker?.entries).toHaveLength(1);
    expect(render(model, 120, 20)).toContain("末尾分叉");
    await controller.key(undefined, { name: "return" });
    expect(calls[0][0]).toBe("thread/fork"); expect(calls[0][1].fromItemId).toBeUndefined();
    expect(model.thread?.id).toBe("branch");
  }
});
test("fork picker scrolls selected multiline row into narrow viewport without render mutations", () => {
  const { model, controller } = setup(true);
  model.forkPicker = { threadId: "source", entries: forkEntries(Array.from({ length: 30 }, (_, i) => item(`i${i}`, i, "long text ".repeat(20)))), index: 20 };
  controller.resize(60, 18);
  const before = JSON.stringify(model.forkPicker), screen = render(model, 60, 18);
  expect(screen).toContain("> #20 i20"); expect(screen.split("\n")).toHaveLength(18);
  expect(JSON.stringify(model.forkPicker)).toBe(before);
});

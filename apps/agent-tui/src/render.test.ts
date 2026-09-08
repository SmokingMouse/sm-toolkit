import { expect, test } from "bun:test";
import type { Item, PendingServerRequest } from "@smokingmouse/agent-server/protocol";
import { TuiModel, type RequestCard } from "./model.js";
import { plain, render, renderCard, renderItem, wrap } from "./render.js";

const common = { id: "i", turnId: "t", seq: 1, startedAtMs: 0, status: "completed" as const };
const samples: Item[] = [
  { ...common, type: "userMessage", payload: { content: [{ type: "text", text: "你好" }, { type: "file", path: "/tmp/a.ts" }] } },
  { ...common, type: "agentMessage", status: "inProgress", payload: { text: "Hello 世界" } },
  { ...common, type: "reasoning", payload: { summary: "Check", text: "Detailed thought" } },
  { ...common, type: "commandExecution", payload: { command: "pwd", cwd: "/tmp", aggregatedOutput: "discard\n1\n2\n3\n4\n5\n6", exitCode: 0 } },
  { ...common, type: "fileChange", payload: { status: "completed", changes: [{ path: "a.ts", kind: "add" }, { path: "b.ts", kind: "delete" }] } },
  { ...common, type: "toolCall", payload: { name: "read", namespace: "fs", input: { path: "a.ts" }, output: "content" } },
  { ...common, type: "mcpToolCall", status: "failed", payload: { server: "local", tool: "search", arguments: {}, error: "offline" } },
  { ...common, type: "subAgent", payload: { kind: "agent", parentItemId: "parent", phase: "working", progress: "50%", report: "checked" } },
  { ...common, type: "error", payload: { message: "failed", code: -1, retryable: false } },
  { ...common, type: "webSearch", payload: { query: "Bun", results: ["result"] } },
  { ...common, type: "imageOutput", payload: { paths: ["/tmp/image.png"] } },
  { ...common, type: "plan", payload: { text: "Build", steps: [{ step: "test", status: "pending" }] } },
  { ...common, type: "contextCompaction", payload: {} },
];
test("all item types render stable text, folded and expanded reasoning", () => {
  expect(samples.map(i => renderItem(i).join("\n")).join("\n\n")).toMatchSnapshot();
  expect(renderItem(samples[2], true)).toEqual(["Reasoning: Check", "Detailed thought"]);
  expect(renderItem(samples[3]).join()).not.toContain("discard");
});
function model(): TuiModel {
  const m = new TuiModel(); m.connection = "connected";
  m.thread = { id: "th_demo", backend: "codex", engineThreadId: null, status: { type: "running" }, cwd: "/tmp", createdAtMs: 0 };
  m.items.set("user", { ...samples[0], id: "user" }); m.items.set("answer", { ...samples[1], id: "answer", seq: 2 });
  m.usage = { usd: null, inputTokens: 10, outputTokens: 4, cachedTokens: 3, cacheCreation: 0, estimated: false, contextTokens: null };
  m.queue = [{ turnId: "q", position: 0, enqueuedAtMs: 0, preview: "next" }]; m.input = "new input"; return m;
}
const base = { requestId: "request", threadId: "th_demo", turnId: "turn", itemId: "item", startedAtMs: 0 };
test("approval and question cards show contents and resolutions", () => {
  const requests: PendingServerRequest[] = [
    { method: "item/commandExecution/requestApproval", params: { ...base, command: "ls", cwd: "/tmp", reason: "inspect" } },
    { method: "item/fileChange/requestApproval", params: { ...base, changes: [{ path: "a.ts", kind: "update" }], grantRoot: "/tmp" } },
    { method: "item/permissions/requestApproval", params: { ...base, cwd: "/tmp", permissions: { network: { enabled: true } } } },
    { method: "item/tool/requestUserInput", params: { ...base, isBlocking: true, questions: [{ id: "q", question: "Choose", multiSelect: true, options: [{ label: "One", description: "first" }, { label: "Two" }] }] } },
  ];
  const cards: RequestCard[] = requests.map(request => ({ request, state: "pending", question: 0, answers: { q: { answers: ["Two"] } }, draft: "" }));
  expect(cards.map(c => renderCard(c).join("\n")).join("\n\n")).toMatchSnapshot();
  expect(renderCard({ ...cards[0], state: "resolved", note: "已由 phone 处理" })).toEqual(["[request] 已由 phone 处理"]);
});
test("fixed header, footer, queue and active card viewport snapshots", () => {
  const m = model(); expect(render(m, 110, 16)).toMatchSnapshot();
  m.request({ method: "item/commandExecution/requestApproval", params: { ...base, command: "ls", cwd: "/tmp" } });
  expect(render(m, 70, 14)).toMatchSnapshot();
  m.scroll = 100; const lines = render(m, 30, 8).split("\n");
  expect(lines).toHaveLength(8); expect(lines.every(l => Bun.stringWidth(l) < 30)).toBe(true);
});
test("untrusted output cannot inject OSC titles, clipboard or terminal control", () => {
  expect(plain("safe\x1b]52;c;payload\x07\x1b[2J\x1b]0;fake\x1b\\text\x00")).toBe("safetext");
  expect(wrap("你好🙂abc", 5)).toEqual(["你好", "🙂abc"]);
  expect(wrap("a\u0301bc", 2)).toEqual(["áb", "c"]);
  expect(wrap("中", 1)).toEqual([""]);
});
test("status priority is blocked, working, idle", () => {
  const m = model(); expect(m.agentState).toBe("working");
  m.connection = "reconnecting"; expect(m.agentState).toBe("blocked");
  m.connection = "connected"; m.thread!.status = { type: "idle" }; expect(m.agentState).toBe("idle");
  m.thread!.status = { type: "systemError" }; expect(m.agentState).toBe("blocked");
});

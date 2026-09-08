import { expect, test } from "bun:test";
import { blockedEngineCommands, controlPayload, engineCommand, renderEngineResult } from "./engine-commands.js";
import { render, plain, renderTimeline, scrollLimit } from "./render.js";
import { TuiModel } from "./model.js";
import { Controller } from "./controller.js";
import type { AgentClient } from "@smokingmouse/agent-server/client";
import { help } from "./options.js";

test("native commands use allowlisted subtypes and explicit rewind UUIDs; unknown skills pass through", () => {
  expect(engineCommand("/rewind", ["native-id", "latest-id"])).toEqual({ command: "/rewind", subtype: "rewind_conversation", params: { target_message_uuid: "native-id", last_seen_user_message_uuid: "latest-id" } });
  expect(() => engineCommand("/rewind", [])).toThrow("原生消息 UUID");
  expect(() => engineCommand("/mcp", ["toggle"])).toThrow("用法");
  expect(() => engineCommand("/add-dir", ["/tmp"])).toThrow("白名单");
  expect(engineCommand("/custom-skill", [])).toBeUndefined();
  expect(engineCommand("/toString", [])).toBeUndefined();
});

test("control response unwrap rejects errors and renders rewind refusal without success claims", () => {
  expect(controlPayload({ response: { subtype: "success", response: { text: "ok" } } })).toEqual({ text: "ok" });
  expect(() => controlPayload({ response: { subtype: "error", error: "policy denied" } })).toThrow("policy denied");
  expect(() => controlPayload({})).toThrow("success");
  expect(renderEngineResult("/rewind", { rewound: false, error: "target not found" }).lines[0].text).toBe("未回滚：target not found");
  expect(renderEngineResult("/rewind", { rewound: true }).lines[0].text).toContain("引擎确认");
});

test("native context bar, nested usage table, MCP status and text results", () => {
  expect(renderEngineResult("/context", { totalTokens: 50, rawMaxTokens: 100, categories: [{ name: "messages", tokens: 40 }] }).lines.map(l => l.text).join("\n")).toContain("50% · 50 / 100");
  expect(renderEngineResult("/context", {}).lines[0].text).toContain("?%");
  expect(renderEngineResult("/usage", { session: { total_cost_usd: 1.2, model_usage: { sonnet: { inputTokens: 10 } } }, rate_limits: null }).lines.map(l => l.text)).toContain("session.model_usage.sonnet.inputTokens | 10");
  expect(renderEngineResult("/mcp", { mcpServers: [{ name: "search", status: "connected" }, { name: "broken", status: "failed", error: "offline" }] }).lines.map(l => l.text)).toEqual(["[connected] search", "[failed] broken · offline"]);
  expect(renderEngineResult("/mcp", { mcpServers: [] }).lines[0].text).toContain("没有 MCP");
  expect(renderEngineResult("/cost", { text: "Total cost: $1" }).lines[0].text).toBe("Total cost: $1");
  expect(renderEngineResult("/btw", { response: "answer" }).lines[0].text).toBe("answer");
});

test("diff panel highlights native hunks after sanitization and wrapping; supports paging and monochrome", () => {
  const model = new TuiModel();
  model.enginePanel = renderEngineResult("/diff", { hunks: [{ path: "a.ts", hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new\x1b[2J", ...Array.from({ length: 40 }, (_, i) => ` context ${i}`)] }] }], skippedLarge: ["big"], restricted: ["secret"] });
  const colored = render(model, 80, 30, true);
  expect(colored).toContain("\x1b[31m-old\x1b[0m"); expect(colored).toContain("\x1b[32m+new\x1b[0m");
  expect(colored).not.toContain("\x1b[2J"); expect(colored).toContain("@@ -1,1 +1,1 @@");
  expect(render(model, 80, 30, false)).not.toContain("\x1b");
  model.scroll = 999;
  expect(render(model, 80, 30)).toContain("restricted");
  for (const line of render(model, 15, 8, true).split("\n")) expect(Bun.stringWidth(plain(line))).toBeLessThan(15);
  expect(renderEngineResult("/diff", { hunks: [] }).lines[0].text).toBe("工作区无差异");
  expect(renderEngineResult("/diff", { diff: null }).lines[0].text).toContain("差异不可用");
  expect(renderEngineResult("/diff", { diff: { hunks: [], perFileStats: [{ path: "binary", isBinary: true }] } }).lines[0].text).toContain("binary");
  expect(renderEngineResult("/diff", { diff: { hunks: [{ path: "a", hunks: [{ lines: ["+native"] }] }] } }).lines.at(-1)).toEqual({ text: "+native", tone: "add" });
});

test("cmds-review P2-2 help blocked list is generated from command rejection source", () => {
  for (const name of blockedEngineCommands) { expect(help).toContain(name); expect(() => engineCommand(name, [])).toThrow("白名单"); }
});

test("cmds-review P2-4 result/card/history scroll have separate bounded viewports after paging and resize", async () => {
  const model = new TuiModel(); model.connection = "connected";
  model.thread = { id: "source", backend: "claude", engineThreadId: null, cwd: "/tmp", createdAtMs: 1, status: { type: "idle" } };
  const client = { onStateChange: () => () => {} } as unknown as AgentClient;
  const controller = new Controller(client, model, () => {});
  try {
    model.items.set("history", { id: "history", seq: 1, turnId: "turn", startedAtMs: 1, type: "agentMessage", payload: { text: "old line\n".repeat(100) } });
    model.scroll = 30;
    model.enginePanel = renderEngineResult("/diff", { diff: Array.from({ length: 100 }, (_, i) => `+${i}`).join("\n") });
    controller.resize(80, 20);
    expect(model.scroll).toBe(0);
    for (let i = 0; i < 20; i++) await controller.key(undefined, { name: "pagedown" });
    expect(model.scroll).toBe(scrollLimit(model, 80, 20));
    const bottom = model.scroll;
    await controller.key(undefined, { name: "pageup" }); expect(model.scroll).toBe(bottom - 10);
    controller.resize(80, 120); expect(model.scroll).toBe(0);
    controller.resize(80, 20);
    model.scroll = 15;
    model.request({ method: "item/commandExecution/requestApproval", params: { threadId: "source", turnId: "turn", itemId: "history", requestId: "card", startedAtMs: 1, command: "long\n".repeat(30), cwd: "/tmp" } });
    expect(model.scroll).toBe(0);
    for (let i = 0; i < 20; i++) await controller.key(undefined, { name: "pagedown" });
    expect(model.scroll).toBe(scrollLimit(model, 80, 20));
    model.activeCard!.state = "resolved"; expect(model.scroll).toBe(15);
    await controller.key(undefined, { name: "escape" }); expect(model.scroll).toBe(30);
  } finally { controller.dispose(); }
});

test("cmds-review P2-3 rewind audit markers retain events, invalidate context usage and survive reattach", () => {
  const model = new TuiModel();
  const thread = { id: "source", backend: "claude" as const, engineThreadId: null, cwd: "/tmp", createdAtMs: 1, status: { type: "idle" as const } };
  model.thread = thread;
  const item = { id: "old", seq: 1, turnId: "turn", startedAtMs: 1, type: "agentMessage" as const, payload: { text: "old-context" } };
  model.items.set(item.id, item);
  model.usage = { inputTokens: 1, outputTokens: 1, cachedTokens: 0, cacheCreation: 0, usd: 1, estimated: false, contextTokens: 100 };
  model.recordRewind("native-target");
  expect(model.items.get("old")).toBe(item); expect(model.usage.contextTokens).toBeNull();
  expect(model.usage.usd).toBe(1);
  model.select({ thread: { ...thread, id: "other" }, items: [], pendingRequests: [], queue: [], nextSeq: 1 });
  expect(model.rewinds).toHaveLength(0);
  model.select({ thread, items: [item], pendingRequests: [], queue: [], nextSeq: 2 });
  expect(renderTimeline(model).join("\n")).toContain("引擎已回滚至 native-target");
  expect(renderTimeline(model).join("\n")).toContain("[回滚前审计] Agent: old-context");
});

import { expect, test } from "bun:test";
import { contextUsage, controlError, controlSuccess, estimatedContextWindow, nextEffort, nextPermission, permissionModes } from "./modes.js";
import { TuiModel } from "./model.js";
import { render, renderItem } from "./render.js";

test("permission cycle table excludes dontAsk and gates bypass, including legacy aliases", () => {
  expect(permissionModes(false)).toEqual(["default", "acceptEdits", "plan"]);
  expect(permissionModes(true)).toEqual(["default", "acceptEdits", "plan", "bypassPermissions"]);
  for (const bypass of [false, true]) {
    const modes = permissionModes(bypass);
    modes.forEach((mode, index) => expect(nextPermission(mode, bypass)).toBe(modes[(index + 1) % modes.length]));
    expect(nextPermission("dontAsk", bypass)).toBe("default");
    expect(nextPermission("readonly", bypass)).toBe("readonly");
  }
  expect(nextPermission("auto-edit", false)).toBe("plan");
  expect(nextPermission("full", true)).toBe("default");
  expect(nextPermission(undefined, false)).toBe("acceptEdits");
  expect([undefined, "low", "medium", "high", "max"].map(e => nextEffort(e as any))).toEqual(["low", "medium", "high", "max", "low"]);
});

test("context bar handles unknown, zero, threshold, overflow and invalid windows", () => {
  expect(contextUsage(null, 200_000)).toEqual({ bar: "??????????", warning: false });
  expect(contextUsage(0, 200_000)).toEqual({ bar: "░░░░░░░░░░", percent: 0, warning: false });
  expect(contextUsage(160_000, 200_000)).toEqual({ bar: "████████░░", percent: 80, warning: false });
  expect(contextUsage(160_001, 200_000).warning).toBe(true);
  expect(contextUsage(300_000, 200_000)).toEqual({ bar: "██████████", percent: 150, warning: true });
  for (const n of [0, -1, NaN, Infinity]) expect(contextUsage(20, n).percent).toBeUndefined();
  expect(estimatedContextWindow("gpt-5")).toBe(400_000);
  expect(estimatedContextWindow("sonnet[1m]")).toBe(1_000_000);
  expect(estimatedContextWindow("unknown-model")).toBe(200_000);
});

test("context warning is colored only above 80 percent, sanitized and width bounded", () => {
  const model = new TuiModel();
  model.thread = { id: "th", backend: "claude", status: { type: "idle" }, engineThreadId: null, cwd: "/tmp", createdAtMs: 0, model: "sonnet\x1b[2J" };
  model.usage = { contextTokens: 160_000, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheCreation: 0, estimated: false, usd: null };
  expect(render(model, 160)).not.toContain("\x1b[33m");
  model.usage.contextTokens++;
  expect(render(model, 160)).toContain("\x1b[33m");
  expect(render(model, 160)).toContain("~200000");
  expect(render(model, 160)).not.toContain("\x1b[2J");
  for (const rows of [4, 5, 8]) {
    const lines = render(model, 32, rows).split("\n");
    expect(lines).toHaveLength(rows); expect(lines.every(line => Bun.stringWidth(line) < 32)).toBe(true);
  }
});

test("plan rendering keeps text and step status, supports folding, and compact is a separator", () => {
  const item = { id: "plan", turnId: "turn", seq: 1, startedAtMs: 0, status: "completed" as const, type: "plan" as const, payload: { text: "Plan text", steps: [{ step: "Review", status: "completed" as const }, { step: "Build", status: "inProgress" as const }] } };
  expect(renderItem(item).join("\n")).toContain("[completed] Review");
  expect(renderItem(item).join("\n")).toContain("[inProgress] Build");
  expect(renderItem(item, false, false).join("\n")).not.toContain("Plan text");
  expect(renderItem(item, false, false).join("\n")).toContain("2 steps");
});

test("native errors are not success and lease messages identify the holder and takeover", () => {
  expect(() => controlSuccess({ response: { subtype: "success" } })).not.toThrow();
  expect(() => controlSuccess({ response: { subtype: "error", error: "policy" } })).toThrow("policy");
  expect(() => controlSuccess({})).toThrow("success");
  for (const code of [-32012]) {
    const text = controlError({ code, data: { holder: { label: "phone" } } }, true);
    expect(text).toContain("另一客户端持有控制权（phone）"); expect(text).toContain("/takeover");
  }
  expect(controlError({ code: -32014 }, true)).toContain("审批已被处理");
  expect(controlError({ code: -32014 }, true)).not.toContain("/takeover");
  expect(controlError({ code: -32005, message: "an active thread lease is required for permission escalation" }, true)).toContain("有效控制租约");
});

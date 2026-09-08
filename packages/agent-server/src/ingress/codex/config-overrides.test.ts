import { expect, test } from "bun:test";
import { splitConfigOverrides, THREAD_CONFIG_FIELDS, LOCAL_CONFIG_FIELDS } from "./config-overrides.js";
import { nativeOptions } from "./router.js";
import { buildCodexThreadParams } from "../../engines/codex.js";
import { buildClaudeLaunch } from "../../engines/claude.js";

test("thread config table maps every key; native fields take precedence", () => {
  for (const [key, target] of Object.entries(THREAD_CONFIG_FIELDS)) {
    const value = target === "serviceTier" ? "default" : target === "approvalsReviewer" ? "user" : "example";
    expect(splitConfigOverrides({ config: { [key]: value } })).toEqual({ params: { [target]: value }, ignored: [] });
  }
  expect(splitConfigOverrides({ model: "sonnet", config: { model: "gpt-6-astra" } }).params.model).toBe("sonnet");
  expect(splitConfigOverrides({ model: null, config: { model: "sonnet" } }).params.model).toBe("sonnet");
});

test("local preferences are ignored by key only; global/unknown config names reject specifically", () => {
  for (const key of [...LOCAL_CONFIG_FIELDS, "tui.status_line", "history.max_bytes"])
    expect(splitConfigOverrides({ config: { [key]: "secret-not-in-audit" } })).toEqual({ params: {}, ignored: [key] });
  for (const key of ["mcp_servers", "hooks", "notify", "model_providers", "model_provider", "projects", "config/value/write", "future_option", "__proto__"])
    expect(() => splitConfigOverrides({ config: { [key]: {} } })).toThrow(`config.${key}`);
  for (const config of [[], "bad", 123]) expect(() => splitConfigOverrides({ config })).toThrow("config must be an object");
});

test("mapped permission pairs retain full/readonly guards and non-default tiers cannot be hidden", () => {
  for (const [sandbox_mode, approval_policy, permission] of [["read-only", "never", "readonly"], ["danger-full-access", "never", "full"], ["workspace-write", "on-request", "auto-edit"], ["workspace-write", "untrusted", "default"]]) {
    expect(nativeOptions(splitConfigOverrides({ config: { sandbox_mode, approval_policy } }).params).permission).toBe(permission);
  }
  expect(() => nativeOptions(splitConfigOverrides({ config: { sandbox_mode: "workspace-write", approval_policy: "never" } }).params)).toThrow("never requires");
  expect(() => splitConfigOverrides({ serviceTier: "default", config: { service_tier: "priority" } })).toThrow("config.service_tier");
  expect(() => splitConfigOverrides({ config: { approvals_reviewer: "auto_review" } })).toThrow("config.approvals_reviewer");
});

test("thread effort, personality and search reach engine launch options", () => {
  const options = nativeOptions(splitConfigOverrides({ config: { model_reasoning_effort: "high", personality: "friendly", web_search: "disabled" } }).params);
  const codex = buildCodexThreadParams({ ...options, threadId: "test", backend: "codex" });
  expect(codex.config).toEqual({ model_reasoning_effort: "high", web_search: "disabled" });
  expect(codex.personality).toBe("friendly");
  const claude = buildClaudeLaunch({ ...options, model: "sonnet", threadId: "test", backend: "claude" });
  expect(claude.args).toContain("high");
  expect(claude.args).toContain("Use a friendly communication style.");
  expect(claude.args).toContain("WebSearch");
  const readonly = buildClaudeLaunch({ ...options, model: "sonnet", threadId: "test", backend: "claude", permission: "readonly" });
  expect(readonly.args).toContain("Edit,Write,MultiEdit,NotebookEdit,WebSearch");
});

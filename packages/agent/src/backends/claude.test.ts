import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearEndpointsCache } from "@smokingmouse/llm";
import {
  claudeEnvironmentSkillArgs,
  claudeInitializeRequest,
  claudeInputMode,
  claudeMaxTurnsArgs,
  claudeSettingSourceArgs,
  resolveClaudeModel,
} from "./claude.js";
import { scheduleInitialStdin } from "./stream-lines.js";
import { resolveClaudeModel as publicResolveClaudeModel } from "../index.js";

describe("Claude environment Skill isolation", () => {
  test("keeps Runtime customizations by default", () => {
    expect(claudeEnvironmentSkillArgs()).toEqual([]);
  });

  test("uses Claude safe mode when environment Skills are disabled", () => {
    expect(claudeEnvironmentSkillArgs(false)).toEqual([
      "--safe-mode",
      "--disable-slash-commands",
    ]);
  });
});

describe("resolveClaudeModel", () => {
  const previousPath = process.env.SM_ENDPOINTS_PATH;
  const previousKey = process.env.SM_AGENT_TEST_KEY;
  const dir = mkdtempSync(join(tmpdir(), "sm-agent-claude-model-"));
  const configPath = join(dir, "endpoints.yaml");

  beforeAll(() => {
    writeFileSync(
      configPath,
      [
        "providers:",
        "  test-provider:",
        "    api_key_env: SM_AGENT_TEST_KEY",
        "    anthropic_url: https://example.test/anthropic",
        "    models: [resolved-model]",
        "    claude:",
        "      env:",
        "        CLAUDE_CODE_MAX_CONTEXT_TOKENS: '4242'",
        "        ANTHROPIC_API_KEY: ''",
        "default: resolved-model",
      ].join("\n"),
    );
    process.env.SM_ENDPOINTS_PATH = configPath;
    process.env.SM_AGENT_TEST_KEY = "secret-for-test";
    clearEndpointsCache();
  });

  afterAll(() => {
    if (previousPath === undefined) delete process.env.SM_ENDPOINTS_PATH;
    else process.env.SM_ENDPOINTS_PATH = previousPath;
    if (previousKey === undefined) delete process.env.SM_AGENT_TEST_KEY;
    else process.env.SM_AGENT_TEST_KEY = previousKey;
    clearEndpointsCache();
    rmSync(dir, { recursive: true, force: true });
  });

  test("passes native tier aliases through without consulting endpoints.yaml", () => {
    expect(publicResolveClaudeModel).toBe(resolveClaudeModel);
    process.env.SM_ENDPOINTS_PATH = join(dir, "does-not-exist.yaml");
    clearEndpointsCache();
    try {
      expect(resolveClaudeModel("opus")).toEqual({ model: "opus" });
      expect(resolveClaudeModel("claude-opus")).toEqual({ model: "opus" });
    } finally {
      process.env.SM_ENDPOINTS_PATH = configPath;
      clearEndpointsCache();
    }
  });

  test("resolves endpoints.yaml model and merges provider claude.env", () => {
    expect(resolveClaudeModel("test-provider")).toEqual({
      model: "resolved-model",
      env: {
        ANTHROPIC_BASE_URL: "https://example.test/anthropic",
        ANTHROPIC_AUTH_TOKEN: "secret-for-test",
        ANTHROPIC_API_KEY: "",
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: "4242",
      },
    });
  });

  test("passes unresolved models through without env", () => {
    expect(resolveClaudeModel("future-claude-alias")).toEqual({
      model: "future-claude-alias",
    });
  });
});

describe("Claude settingSources argv", () => {
  test("joins array sources with commas", () => {
    expect(claudeSettingSourceArgs(["user", "project"])).toEqual([
      "--setting-sources",
      "user,project",
    ]);
  });

  test("true preserves the CLI default by omitting the flag", () => {
    expect(claudeSettingSourceArgs(true)).toEqual([]);
  });

  test("false and an empty array preserve the isolated argv path", () => {
    expect(claudeSettingSourceArgs(false)).toEqual([
      "--setting-sources=",
      "--strict-mcp-config",
    ]);
    expect(claudeSettingSourceArgs([])).toEqual(claudeSettingSourceArgs(false));
  });
});

describe("Claude maxTurns argv", () => {
  test("omits the flag by default and serializes one turn", () => {
    expect(claudeMaxTurnsArgs(undefined)).toEqual([]);
    expect(claudeMaxTurnsArgs(1)).toEqual(["--max-turns", "1"]);
  });

  test("rejects non-positive and non-finite values", () => {
    for (const value of [0, -1, Number.NaN]) {
      expect(() => claudeMaxTurnsArgs(value)).toThrow("maxTurns must be a positive integer");
    }
  });
});

describe("Claude initialize skills payload", () => {
  test("uses persistent stream-json stdin when initialize is required", () => {
    expect(claudeInputMode(false, true, false)).toEqual({
      streamJsonInput: true,
      persistentStdin: true,
    });
  });

  test("omits skills when the option is absent", () => {
    const serialized = JSON.stringify(claudeInitializeRequest(undefined));
    expect(serialized).not.toContain('"skills"');
  });

  test("preserves an explicit empty whitelist", () => {
    expect((claudeInitializeRequest([]) as any).request.skills).toEqual([]);
  });

  test("serializes a non-empty whitelist verbatim", () => {
    expect((claudeInitializeRequest(["pdf"]) as any).request.skills).toEqual(["pdf"]);
  });
});

test("delayed stdin does not write until the injected scheduler fires", () => {
  expect(claudeInputMode(false, false, true)).toEqual({
    streamJsonInput: true,
    persistentStdin: true,
  });
  let scheduledDelay = -1;
  let scheduled: (() => void) | undefined;
  let writes = 0;
  scheduleInitialStdin(
    () => writes++,
    300,
    ((callback: () => void, delayMs: number) => {
      scheduled = callback;
      scheduledDelay = delayMs;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }),
  );
  expect(writes).toBe(0);
  expect(scheduledDelay).toBe(300);
  scheduled!();
  expect(writes).toBe(1);
});

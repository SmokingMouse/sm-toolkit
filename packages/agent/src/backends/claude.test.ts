import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearEndpointsCache } from "@smokingmouse/llm";
import {
  ClaudeBackend,
  claudeAskToolsArgs,
  claudeEnvironmentSkillArgs,
  claudeInitializeRequest,
  claudeInputMode,
  claudeMcpConfig,
  claudeMcpServerPlan,
  claudeMaxTurnsArgs,
  claudeSettingSourceArgs,
  ClaudeSdkMcpTransport,
  extractResultText,
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

describe("Claude askTools argv", () => {
  test("keeps the existing omitted and named-list behavior", () => {
    expect(claudeAskToolsArgs(undefined)).toEqual([]);
    expect(claudeAskToolsArgs([])).toEqual([]);
    expect(claudeAskToolsArgs(["Bash"])).toEqual([
      "--settings",
      JSON.stringify({ permissions: { ask: ["Bash"] } }),
    ]);
  });

  test("maps full interception to the CLI permission wildcard", () => {
    expect(claudeAskToolsArgs("all")).toEqual([
      "--settings",
      JSON.stringify({ permissions: { ask: ["*"] } }),
    ]);
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

  test("serializes sdk MCP server names only when present", () => {
    expect(JSON.stringify(claudeInitializeRequest(undefined))).not.toContain("sdkMcpServers");
    expect((claudeInitializeRequest(undefined, ["embedded"]) as any).request.sdkMcpServers).toEqual([
      "embedded",
    ]);
  });
});

describe("Claude mcpServers planning", () => {
  test("generates no config without external servers", () => {
    const plan = claudeMcpServerPlan(undefined, undefined, false);
    expect(claudeMcpConfig(plan.configServers)).toBeUndefined();
  });

  test("generates an HTTP mcp-config", () => {
    const plan = claudeMcpServerPlan(
      { remote: { type: "http", url: "https://example.test/mcp", headers: { Authorization: "x" } } },
      undefined,
      false,
    );
    expect(claudeMcpConfig(plan.configServers)).toEqual({
      mcpServers: {
        remote: {
          type: "http",
          url: "https://example.test/mcp",
          headers: { Authorization: "x" },
        },
      },
    });
  });

  test("generates a stdio mcp-config", () => {
    const plan = claudeMcpServerPlan(
      { local: { type: "stdio", command: "node", args: ["server.js"], env: { TOKEN: "x" } } },
      undefined,
      false,
    );
    expect(claudeMcpConfig(plan.configServers)).toEqual({
      mcpServers: {
        local: {
          type: "stdio",
          command: "node",
          args: ["server.js"],
          env: { TOKEN: "x" },
        },
      },
    });
  });

  test("rejects sdk servers without persistent stdin", () => {
    expect(() =>
      claudeMcpServerPlan(
        { embedded: { type: "sdk", instance: { connect: async () => {} } } },
        undefined,
        false,
      ),
    ).toThrow("sdk mcpServers require interactive persistent stdin");
  });

  test("rejects a second --mcp-config source", () => {
    for (const extraArgs of [["--mcp-config", "legacy.json"], ["--mcp-config=legacy.json"]]) {
      expect(() =>
        claudeMcpServerPlan(
          { remote: { type: "http", url: "https://example.test/mcp" } },
          extraArgs,
          false,
        ),
      ).toThrow("mcpServers conflicts with extraArgs --mcp-config");
    }
  });
});

describe("Claude SDK MCP transport", () => {
  test("routes CLI requests to the instance and returns its JSON-RPC response", async () => {
    const transport = new ClaudeSdkMcpTransport("embedded", () => undefined);
    transport.onmessage = (message) => {
      void transport.send({ jsonrpc: "2.0", id: message.id, result: { canary: true } });
    };
    await expect(
      transport.receive({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} }),
    ).resolves.toEqual({ jsonrpc: "2.0", id: 7, result: { canary: true } });
    await transport.close();
  });

  test("acks notifications and wraps instance-initiated messages for the CLI", async () => {
    const writes: any[] = [];
    const transport = new ClaudeSdkMcpTransport("embedded", () => ({
      write: (message) => writes.push(message),
      end: () => {},
    }));
    const notifications: unknown[] = [];
    transport.onmessage = (message) => notifications.push(message);
    const notification = { jsonrpc: "2.0" as const, method: "notifications/initialized" };
    await expect(transport.receive(notification)).resolves.toEqual({
      jsonrpc: "2.0",
      result: {},
      id: 0,
    });
    expect(notifications).toEqual([notification]);

    const log = { jsonrpc: "2.0" as const, method: "notifications/message", params: { level: "info" } };
    await transport.send(log);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      type: "control_request",
      request: { subtype: "mcp_message", server_name: "embedded", message: log },
    });
    await transport.close();
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

/**
 * 静默死亡 → 显式 Error。claude 可执行文件没跑起来(shim 找不到真身 exit 127 /
 * PATH 解析失败)时零 stdout 秒退,修复前流"干净地"结束、零事件 —— 上游把启动失败
 * 当正常空回复(2026-08-18 Fisher 生产实录)。用假 claude 脚本确定性复现。
 */
describe("ClaudeBackend silent process death", () => {
  test("零输出退出 → 恰好一个 Error 事件,带 exit code 与 stderr 死因", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-agent-fake-claude-"));
    writeFileSync(
      join(dir, "claude"),
      "#!/bin/sh\necho 'fake shim: real claude not found' >&2\nexit 127\n",
      { mode: 0o755 },
    );
    try {
      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      // env.PATH 只含假目录:spawn 按子进程 env 解析可执行文件,只找得到假 claude。
      for await (const e of new ClaudeBackend().run("hi", { env: { PATH: dir } })) {
        events.push(e as never);
      }
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("error");
      const msg = String(events[0]!.data.message);
      expect(msg).toContain("exited with code 127");
      expect(msg).toContain("real claude not found");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extractResultText (tool_result content 两副面孔)", () => {
  test("string content 原样返回(内置工具形态)", () => {
    expect(extractResultText("hello")).toBe("hello");
    expect(extractResultText("")).toBe(""); // 空串是合法输出,不折算成 null
  });

  test("MCP content block 数组提取 text 并拼接", () => {
    expect(
      extractResultText([
        { type: "text", text: "订单 123: 已付款" },
        { type: "text", text: "第二段" },
      ]),
    ).toBe("订单 123: 已付款\n第二段");
  });

  test("数组里混入非 text block 时跳过,全部无 text 时 null", () => {
    expect(extractResultText([{ type: "image", data: "…" }])).toBeNull();
    expect(extractResultText([{ type: "image" }, { type: "text", text: "x" }])).toBe("x");
  });

  test("null/undefined/对象 → null", () => {
    expect(extractResultText(null)).toBeNull();
    expect(extractResultText(undefined)).toBeNull();
    expect(extractResultText({ foo: 1 })).toBeNull();
  });
});

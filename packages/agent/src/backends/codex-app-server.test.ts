import { describe, expect, test } from "bun:test";
import {
  appServerCost,
  appServerThreadOptions,
  appServerToolCall,
  appServerToolResult,
  codexTransportPlan,
} from "./codex-app-server.js";

describe("codexTransportPlan", () => {
  test("defaults to app-server", () => {
    expect(codexTransportPlan(undefined, {})).toBe("app-server");
  });
  test("explicit exec wins over everything", () => {
    expect(codexTransportPlan("exec", {})).toBe("exec");
  });
  test("environmentSkills=false forces exec (flags unverified on app-server)", () => {
    expect(codexTransportPlan(undefined, { environmentSkills: false })).toBe("exec");
    expect(codexTransportPlan("app-server", { environmentSkills: false })).toBe("exec");
  });
  test("extraArgs (exec CLI escape hatch) forces exec", () => {
    expect(codexTransportPlan(undefined, { extraArgs: ["--output-schema", "/tmp/s.json"] })).toBe("exec");
    expect(codexTransportPlan(undefined, { extraArgs: [] })).toBe("app-server");
  });
  test("ephemeral resume forces exec (thread/resume has no ephemeral param)", () => {
    expect(codexTransportPlan(undefined, { persistence: false, resume: "t-1" })).toBe("exec");
    // ephemeral fresh(persistence=false 无 resume)与普通 resume 都留在 app-server
    expect(codexTransportPlan(undefined, { persistence: false })).toBe("app-server");
    expect(codexTransportPlan(undefined, { resume: "t-1" })).toBe("app-server");
  });
});

describe("appServerThreadOptions — 与 buildCodexArgs 逐档对齐(安全红线)", () => {
  test("readonly → read-only sandbox, never approvals, no config", () => {
    const o = appServerThreadOptions({
      policy: "readonly",
      additionalWritableDirs: ["/x"], // readonly 忽略额外可写目录,同 exec
      sandboxNetworkAccess: true,
    });
    expect(o).toEqual({ sandbox: "read-only", approvalPolicy: "never" });
  });
  test("full → danger-full-access, never approvals, no config", () => {
    const o = appServerThreadOptions({
      policy: "full",
      additionalWritableDirs: ["/x"],
      sandboxNetworkAccess: false,
    });
    expect(o).toEqual({ sandbox: "danger-full-access", approvalPolicy: "never" });
  });
  for (const policy of ["auto-edit", "default"] as const) {
    test(`${policy} → workspace-write + explicit network_access=false`, () => {
      const o = appServerThreadOptions({
        policy,
        additionalWritableDirs: [],
        sandboxNetworkAccess: false,
      });
      expect(o.sandbox).toBe("workspace-write");
      expect(o.approvalPolicy).toBe("never");
      // network_access 必须显式写(exec 对 workspace-write 恒传 -c,防旧 thread 配置漂移)
      expect(o.config).toEqual({ sandbox_workspace_write: { network_access: false } });
    });
  }
  test("workspace-write 携带去重后的 writable_roots + network on", () => {
    const o = appServerThreadOptions({
      policy: "auto-edit",
      additionalWritableDirs: ["/a", "/b", "/a"],
      sandboxNetworkAccess: true,
    });
    expect(o.config).toEqual({
      sandbox_workspace_write: { network_access: true, writable_roots: ["/a", "/b"] },
    });
  });
  test("权限确认:仅 default+approvals → untrusted;其余档位不受回调影响", () => {
    const base = { additionalWritableDirs: [], sandboxNetworkAccess: false };
    expect(appServerThreadOptions({ ...base, policy: "default", approvals: true }).approvalPolicy).toBe(
      "untrusted",
    );
    expect(appServerThreadOptions({ ...base, policy: "default" }).approvalPolicy).toBe("never");
    // 审批只在 default 档激活:full 是 YOLO、auto-edit 是自动批、readonly 是硬沙箱
    expect(appServerThreadOptions({ ...base, policy: "auto-edit", approvals: true }).approvalPolicy).toBe(
      "never",
    );
    expect(appServerThreadOptions({ ...base, policy: "full", approvals: true }).approvalPolicy).toBe(
      "never",
    );
    expect(appServerThreadOptions({ ...base, policy: "readonly", approvals: true }).approvalPolicy).toBe(
      "never",
    );
  });
});

describe("appServerToolCall / appServerToolResult", () => {
  test("commandExecution → shell(对齐 exec 路径命名)", () => {
    expect(appServerToolCall({ type: "commandExecution", command: "ls -la" })).toEqual({
      name: "shell",
      input: "ls -la",
    });
    expect(
      appServerToolResult({
        type: "commandExecution",
        status: "completed",
        aggregatedOutput: "out",
        exitCode: 0,
      }),
    ).toEqual({ output: "out", isError: false });
    expect(
      appServerToolResult({ type: "commandExecution", status: "completed", exitCode: 2 }).isError,
    ).toBe(true);
    expect(appServerToolResult({ type: "commandExecution", status: "declined" }).isError).toBe(true);
  });
  test("mcpToolCall → 工具名透传,result JSON 化", () => {
    expect(appServerToolCall({ type: "mcpToolCall", tool: "search", arguments: { q: 1 } })).toEqual({
      name: "search",
      input: { q: 1 },
    });
    expect(
      appServerToolResult({ type: "mcpToolCall", status: "completed", result: { ok: true } }),
    ).toEqual({ output: '{"ok":true}', isError: false });
    expect(appServerToolResult({ type: "mcpToolCall", status: "failed" }).isError).toBe(true);
  });
  test("collabAgentToolCall(multi_agent)→ 工具名 + spawn 元数据可见", () => {
    const call = appServerToolCall({
      type: "collabAgentToolCall",
      tool: "wait",
      prompt: "compute 2+2",
      receiverThreadIds: ["t-2"],
    });
    expect(call?.name).toBe("wait");
    expect(call?.input).toEqual({ prompt: "compute 2+2", receiverThreadIds: ["t-2"], model: null });
  });
  test("collab 完成时 agentsStates 作为输出可见;空则 null", () => {
    expect(
      appServerToolResult({
        type: "collabAgentToolCall",
        status: "completed",
        agentsStates: { "t-2": { status: "completed" } },
      }).output,
    ).toBe('{"t-2":{"status":"completed"}}');
    expect(
      appServerToolResult({ type: "collabAgentToolCall", status: "completed", agentsStates: {} })
        .output,
    ).toBeNull();
  });
  test("webSearch / dynamicToolCall / imageGeneration 覆盖", () => {
    expect(appServerToolCall({ type: "webSearch", query: "q" })).toEqual({
      name: "web_search",
      input: "q",
    });
    expect(appServerToolCall({ type: "dynamicToolCall", tool: "t", arguments: {} })?.name).toBe("t");
    expect(
      appServerToolResult({ type: "imageGeneration", status: "completed", savedPath: "/p.png" }),
    ).toEqual({ output: "/p.png", isError: false });
  });
  test("非工具 item 返回 null(agentMessage/reasoning/fileChange/subAgentActivity)", () => {
    for (const type of ["agentMessage", "reasoning", "plan", "fileChange", "subAgentActivity", "userMessage"]) {
      expect(appServerToolCall({ type })).toBeNull();
    }
  });
});

describe("appServerCost", () => {
  test("input 含 cache 命中 → 净 input;cacheWrite → cacheCreation;context 取 last", () => {
    const c = appServerCost({
      total: {
        inputTokens: 50_000,
        cachedInputTokens: 14_000,
        cacheWriteInputTokens: 200,
        outputTokens: 100,
        totalTokens: 50_100,
      },
      last: { inputTokens: 30_000, outputTokens: 40 },
    });
    expect(c.inputTokens).toBe(36_000);
    expect(c.cachedTokens).toBe(14_000);
    expect(c.cacheCreation).toBe(200);
    expect(c.outputTokens).toBe(100);
    expect(c.contextTokens).toBe(30_000);
    expect(c.estimated).toBe(true);
    expect(c.usd).toBeCloseTo(36_000 * (1.25 / 1e6) + 100 * (10 / 1e6), 6);
  });
  test("usage 缺失时零值兜底,contextTokens 报 null 而非假 0", () => {
    const c = appServerCost(null);
    expect(c.inputTokens).toBe(0);
    expect(c.contextTokens).toBeNull();
  });
});

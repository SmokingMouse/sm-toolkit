import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ErrorCode, ErrorCodeSchema, ErrorDataSchema, FrameSchema, ItemSchema, MethodSchemas, PendingServerRequestSchema, ProtocolError, ServerRequestSchemas, UsageSchema, UserInputSchema, rpcError } from "./index.js";

describe("AS v1 protocol", () => {
  const frames = [
    { jsonrpc: "2.0", id: 1, method: "thread/read", params: { threadId: "th_1" } },
    { jsonrpc: "2.0", id: "1", result: { ok: true } },
    { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse", data: { retryable: false } } },
    { jsonrpc: "2.0", method: "initialized", params: {} },
  ];
  test.each(frames)("round trips frame %#", frame => expect(FrameSchema.parse(JSON.parse(JSON.stringify(frame)))).toEqual(frame));
  test("rejects mixed envelopes, missing params, fractional IDs and non-JSON values", () => {
    for (const frame of [{ ...frames[0], result: {} }, { jsonrpc: "2.0", id: 1, method: "x" }, { ...frames[0], id: 1.5 }, { ...frames[0], params: { f: () => {} } }]) expect(FrameSchema.safeParse(frame).success).toBe(false);
  });
  test.each(Object.entries(ErrorCode))("error code %s is fixed and round trips", (name, code) => {
    expect(ErrorCodeSchema.parse(code)).toBe(code);
    const error = new ProtocolError(code, name, { threadId: "th", retryable: true });
    expect(rpcError(error)).toEqual({ code, message: name, data: { threadId: "th", retryable: true } });
  });
  test("error data requires retryable and retains diagnostics", () => {
    expect(Object.keys(ErrorCode)).toHaveLength(21);
    expect(ErrorCodeSchema.safeParse(-32099).success).toBe(false);
    expect(ErrorDataSchema.safeParse({ threadId: "th" }).success).toBe(false);
    expect(ErrorDataSchema.parse({ retryable: false, stderr: "tail", raw: "raw", holder: { clientId: "c", label: "web" } }).stderr).toBe("tail");
  });
  test("Usage mirrors Cost, including nullable usd and contextTokens", () => {
    const usage = { usd: null, inputTokens: 1, outputTokens: 2, cachedTokens: 3, cacheCreation: 4, estimated: false, contextTokens: null };
    expect(UsageSchema.parse(usage)).toEqual(usage);
    expect(UsageSchema.safeParse({ ...usage, inputTokens: -1 }).success).toBe(false);
  });
  test("attachments require absolute paths", () => {
    expect(UserInputSchema.parse({ type: "image", path: "/tmp/test.png", mime: "image/png" }).type).toBe("image");
    expect(UserInputSchema.safeParse({ type: "file", path: "../relative" }).success).toBe(false);
  });
  test("resume requires an identity; fork retains fromItemId", () => {
    expect(MethodSchemas["thread/resume"].params.safeParse({}).success).toBe(false);
    expect(MethodSchemas["thread/resume"].params.parse({ engineThreadId: "sid" })).toEqual({ engineThreadId: "sid" });
    expect(MethodSchemas["thread/fork"].params.parse({ threadId: "t", fromItemId: "it" }).fromItemId).toBe("it");
    expect(MethodSchemas["turn/steer"].params.safeParse({ threadId: "t", input: [{ type: "text", text: "hi" }] }).success).toBe(false);
  });
  test("all thirteen item variants have typed payloads; finalStart is absent", () => {
    const payloads = {
      userMessage: { content: [{ type: "text", text: "hi" }] }, agentMessage: { text: "hi" }, reasoning: { text: "think" },
      commandExecution: { command: "pwd", cwd: "/tmp" }, fileChange: { changes: [{ path: "/tmp/a", kind: "add" }], status: "completed" },
      toolCall: { name: "Read", input: {} }, mcpToolCall: { server: "s", tool: "read", arguments: {} },
      subAgent: { kind: "bash", parentItemId: "it_parent", phase: "started" }, webSearch: { query: "q" },
      imageOutput: { paths: [] }, plan: { text: "plan" }, contextCompaction: {}, error: { message: "x", retryable: false },
    };
    for (const [type, payload] of Object.entries(payloads)) {
      const item = { id: "it", type, seq: 1, turnId: "tn", startedAtMs: 1, payload };
      expect(ItemSchema.parse(JSON.parse(JSON.stringify(item)))).toEqual(item);
    }
    expect(ItemSchema.safeParse({ id: "it", type: "agentMessage", seq: 1, turnId: "tn", startedAtMs: 1, payload: {} }).success).toBe(false);
    expect(JSON.stringify(ItemSchema.parse({ id: "it", type: "agentMessage", seq: 1, turnId: "tn", startedAtMs: 1, payload: { text: "x", finalStart: 2 } }))).not.toContain("finalStart");
  });
  test("reverse requests discriminate params and validate their decision result", () => {
    const params = { requestId: "ar", threadId: "t", turnId: "tn", itemId: "it", startedAtMs: 1, cwd: "/tmp", command: "pwd" };
    expect(PendingServerRequestSchema.parse({ method: "item/commandExecution/requestApproval", params })).toEqual({ method: "item/commandExecution/requestApproval", params });
    expect(ServerRequestSchemas["item/commandExecution/requestApproval"].result.safeParse({ decision: "yes" }).success).toBe(false);
    expect(ServerRequestSchemas["item/tool/requestUserInput"].result.parse({ answers: { q: { answers: ["yes"] } } }).answers.q.answers).toEqual(["yes"]);
  });
  test("generated schema includes methods, notifications, four reverse requests and error enum", () => {
    const schema = JSON.parse(readFileSync(new URL("../../schema/as-v1.json", import.meta.url), "utf8"));
    expect(schema.$defs["method:thread/fork:params"].properties.fromItemId.type).toBe("string");
    expect(schema.$defs["notification:thread/queue/changed"].properties.queue.type).toBe("array");
    expect(Object.keys(schema.$defs).filter(k => k.startsWith("serverRequest:")).length).toBe(8);
    expect(JSON.stringify(schema)).not.toContain("finalStart");
  });
  test("all generated JSON pointers resolve and resume identity is required in schema", () => {
    const schema = JSON.parse(readFileSync(new URL("../../schema/as-v1.json", import.meta.url), "utf8"));
    function visit(value: unknown): void {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (key === "$ref" && typeof child === "string" && child.startsWith("#/")) {
          const target = child.slice(2).split("/").reduce((node: any, key: string) => node?.[key.replaceAll("~1", "/").replaceAll("~0", "~")], schema);
          expect(target, child).toBeDefined();
        } else visit(child);
      }
    }
    visit(schema);
    expect(schema.$defs["method:thread/resume:params"].anyOf.map((variant: any) => variant.required)).toEqual([["threadId"], ["engineThreadId"]]);
  });
});

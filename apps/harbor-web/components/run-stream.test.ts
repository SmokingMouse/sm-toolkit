/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { foldFrames, toolSummary, type LogItem } from "./run-stream";
import type { RunStreamFrame } from "../lib/api";

type FrameEvent = Extract<RunStreamFrame, { kind: "event" }>["event"];

function ev(type: string, data: Record<string, unknown>): RunStreamFrame {
  const event: FrameEvent = { type: type as FrameEvent["type"], backend: "claude", sessionId: "s1234567", data };
  return { kind: "event", seq: 0, event };
}

function toolOf(items: LogItem[]) {
  const t = items.find((i) => i.kind === "tool");
  if (!t || t.kind !== "tool") throw new Error("no tool item");
  return t;
}

describe("toolSummary", () => {
  test("文件类工具给路径", () => {
    expect(toolSummary("Read", { file_path: "/a/b.ts" })).toBe("/a/b.ts");
    expect(toolSummary("Edit", { file_path: "/a/b.ts", old_string: "x", new_string: "y" })).toBe("/a/b.ts");
  });
  test("Bash 优先 description，退回命令首行", () => {
    expect(toolSummary("Bash", { command: "ls -la", description: "List files" })).toBe("List files");
    expect(toolSummary("Bash", { command: "ls -la\ngrep foo" })).toBe("ls -la");
  });
  test("Grep 给 /pattern/ + path；未知工具退化 JSON", () => {
    expect(toolSummary("Grep", { pattern: "foo", path: "/src" })).toBe("/foo/ /src");
    expect(toolSummary("mcp__x__y", { a: 1 })).toBe('{"a":1}');
  });
  test("超长摘要压成一行并截断", () => {
    const s = toolSummary("Read", { file_path: `/x/${"very/".repeat(60)}f.ts` });
    expect(s.length).toBeLessThanOrEqual(111);
    expect(s.endsWith("…")).toBe(true);
    expect(s.includes("\n")).toBe(false);
  });
});

describe("foldFrames", () => {
  test("连续 text_chunk 折叠成一条", () => {
    const items = foldFrames([ev("text_chunk", { text: "# hi" }), ev("text_chunk", { text: "\nbody" })]);
    expect(items).toEqual([{ kind: "text", text: "# hi\nbody" }]);
  });
  test("tool_call_done 按 id 回填状态与输出", () => {
    const items = foldFrames([
      ev("tool_call", { id: "t1", name: "Bash", input: { command: "ls" } }),
      ev("tool_call_done", { id: "t1", output: "file.ts", stderr: null, isError: false }),
    ]);
    const t = toolOf(items);
    expect(t.status).toBe("done");
    expect(t.output).toBe("file.ts");
    expect(t.summary).toBe("ls");
  });
  test("isError → error 态并保留 stderr", () => {
    const items = foldFrames([
      ev("tool_call", { id: "t1", name: "Read", input: { file_path: "/x" } }),
      ev("tool_call_done", { id: "t1", output: null, stderr: "ENOENT", isError: true }),
    ]);
    const t = toolOf(items);
    expect(t.status).toBe("error");
    expect(t.stderr).toBe("ENOENT");
  });
  test("无 id 的工具（codex）不挂 running 假态", () => {
    const t = toolOf(foldFrames([ev("tool_call", { name: "shell", input: "ls" })]));
    expect(t.status).toBe("done");
    expect(t.id).toBeNull();
  });
  test("未知 id 的 done 静默忽略", () => {
    const items = foldFrames([ev("tool_call_done", { id: "ghost", output: "x", isError: false })]);
    expect(items).toEqual([]);
  });
  test("超长输出截断并打标", () => {
    const items = foldFrames([
      ev("tool_call", { id: "t1", name: "Bash", input: { command: "yes" } }),
      ev("tool_call_done", { id: "t1", output: "y".repeat(5000), isError: false }),
    ]);
    const t = toolOf(items);
    expect(t.outputTruncated).toBe(true);
    expect(t.output?.length).toBe(3000);
  });
});

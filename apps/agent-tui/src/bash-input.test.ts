import { expect, test } from "bun:test";
import { bashInput } from "./bash-input.js";
import { renderItem } from "./render.js";

test("shell input stays standalone and preserves shell syntax without file expansion", () => {
  expect(bashInput("! printf '@missing'\n pwd", [])).toEqual([{ type: "bash", command: "printf '@missing'\n pwd" }]);
  expect(bashInput("hello!", [])).toBeUndefined();
  expect(() => bashInput("!  ", [])).toThrow("用法");
  expect(() => bashInput("!pwd", [{}])).toThrow("不能携带图片");
});

test("shell item renders command, sanitized stdout/stderr and exit code", () => {
  const lines = renderItem({ id: "bash", turnId: "turn", seq: 1, startedAtMs: 0, status: "completed", type: "commandExecution", payload: { command: "pwd", cwd: "/tmp", aggregatedOutput: "ok\n\x1b[2Jstderr", exitCode: 2 } });
  expect(lines).toContain("$ pwd"); expect(lines).toContain("stderr"); expect(lines).toContain("  exit: 2");
  expect(lines.join("\n")).not.toContain("\x1b");
});

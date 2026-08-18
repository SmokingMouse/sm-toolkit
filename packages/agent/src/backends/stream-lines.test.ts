import { describe, expect, test } from "bun:test";
import { streamLines } from "./stream-lines.js";

/**
 * exitSink:子进程零 stdout 死亡时,caller 必须能拿到死因。
 * 2026-08-18 Fisher 生产实录:claude shim 找不到真身 → stderr 一句话 + exit 127 +
 * 零 stdout,streamLines 视角是"流干净地结束",上游把启动失败当成了正常空回复。
 */
describe("streamLines exitSink", () => {
  test("零输出非零退出:exitSink 拿到 code,stderrSink 拿到死因", async () => {
    const stderrSink = { text: "" };
    const exitSink: { code?: number | null; spawnError?: string } = {};
    const lines: string[] = [];
    for await (const l of streamLines("sh", ["-c", "echo 'shim: real claude not found' >&2; exit 127"], {
      stderrSink,
      exitSink,
    })) {
      lines.push(l);
    }
    expect(lines).toEqual([]);
    expect(exitSink.code).toBe(127);
    expect(stderrSink.text).toContain("real claude not found");
    expect(exitSink.spawnError).toBeUndefined();
  });

  test("spawn 不到可执行文件:不 crash,spawnError 写入 exitSink 与 stderrSink", async () => {
    const stderrSink = { text: "" };
    const exitSink: { code?: number | null; spawnError?: string } = {};
    const lines: string[] = [];
    // 无监听的 ChildProcess 'error' 在 Node 下是 uncaught —— 这条测试同时锁住
    // "挂了监听所以进程不死"这个修复本身。
    for await (const l of streamLines("definitely-not-a-real-binary-xyz", [], { stderrSink, exitSink })) {
      lines.push(l);
    }
    expect(lines).toEqual([]);
    // 报错文案随 runtime 变(Node: "spawn ... ENOENT" / Bun: "Executable not found
    // in $PATH"),只断言死因里带着找不到的那个名字。
    expect(exitSink.spawnError ?? "").toContain("definitely-not-a-real-binary-xyz");
    expect(stderrSink.text).toContain("definitely-not-a-real-binary-xyz");
  });

  test("正常退出:行照常吐,exitSink.code = 0", async () => {
    const exitSink: { code?: number | null; spawnError?: string } = {};
    const lines: string[] = [];
    for await (const l of streamLines("sh", ["-c", "echo hello"], { exitSink })) {
      lines.push(l);
    }
    expect(lines).toEqual(["hello"]);
    expect(exitSink.code).toBe(0);
  });
});

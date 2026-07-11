/**
 * 流式读 CLI stdout 的每一行 —— claude/codex 两个后端共用的 spawn+readline 骨架。
 * 移植自 agent-gateway src/backends.ts 的 streamLines()。
 */

import { spawn } from "node:child_process";
import * as readline from "node:readline";

/** 交互通道:交互模式下 caller 通过它向常开的 stdin 写 control_response / user 消息,
 * 并在 turn 结束(或 abort)时主动关 stdin 收尾。 */
export interface StdinChannel {
  /** 向 stdin 写一行(自动补 \n)。 */
  write: (obj: unknown) => void;
  /** 关闭 stdin,让进程收尾退出。 */
  end: () => void;
}

export async function* streamLines(
  cmd: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: Record<string, string>;
    stdinData?: string;
    signal?: AbortSignal;
    // 可选 stderr 收集槽。传入时 streamLines 把 stderr 缓冲进 .text(尾部
    // 截断到 4KB),供 caller 在 CLI 报错而 stdout 无信息量(如 result.result
    // 为空)时拼进 fallback message。不传则照旧 drain。
    stderrSink?: { text: string };
    // 交互模式:stdin 常开、不立即 end()。传入此对象时 streamLines 把 write/end
    // 通道挂到它的 .channel 上供 caller 双向通信(初始 prompt 也走它写入)。
    // 不传则照旧:有 stdinData 就写完即 end、否则 ignore stdin。
    interactive?: { channel?: StdinChannel };
  } = {},
): AsyncGenerator<string> {
  const interactive = !!opts.interactive;
  const proc = spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : undefined,
    stdio: [opts.stdinData || interactive ? "pipe" : "ignore", "pipe", "pipe"],
  });
  if (interactive && proc.stdin) {
    // 交互模式:暴露常开的写通道,stdin 不立即 end —— 只在 caller 显式 end()
    // (turn 结束)或 abort 时关闭。初始 prompt 若由 stdinData 给则立即写入(不 end),
    // 让 claude 拿到 prompt 后才开始产出(否则 for-await 循环会死等首行 → 死锁)。
    opts.interactive!.channel = {
      write: (obj: unknown) => {
        if (proc.stdin && proc.stdin.writable) {
          proc.stdin.write(JSON.stringify(obj) + "\n");
        }
      },
      end: () => {
        if (proc.stdin && !proc.stdin.destroyed) proc.stdin.end();
      },
    };
    if (opts.stdinData) proc.stdin.write(opts.stdinData); // 写但不 end
  } else if (opts.stdinData && proc.stdin) {
    proc.stdin.write(opts.stdinData);
    proc.stdin.end();
  }
  const onAbort = () => proc.kill("SIGTERM");
  opts.signal?.addEventListener("abort", onAbort);
  if (opts.stderrSink) {
    // 缓冲 stderr,尾部保留最近 4KB(错误信息通常在末尾)。
    const sink = opts.stderrSink;
    proc.stderr?.on("data", (chunk: Buffer) => {
      sink.text = (sink.text + chunk.toString()).slice(-4096);
    });
  } else {
    proc.stderr?.resume(); // drain，非 JSON 噪音走 stderr
  }
  const rl = readline.createInterface({ input: proc.stdout! });
  try {
    for await (const line of rl) {
      const s = line.trim();
      if (s) yield s;
    }
    await new Promise<void>((res) => proc.on("close", () => res()));
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    if (!proc.killed) proc.kill("SIGTERM");
  }
}

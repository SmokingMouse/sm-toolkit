/**
 * run 事件流终端渲染：text 逐 token 直写，工具调用一行摘要（dim），
 * result 打 cost 摘要，失败红字给出 error（1.8「失败 run 显示 error 分类」）。
 */

import type { Run, RunStreamFrame } from "../protocol.js";
import type { Cost } from "@sm/agent";

export const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
};

function fmtCost(cost: Cost | null | undefined): string {
  if (!cost) return "cost 未知";
  const usd = cost.usd != null ? `$${cost.usd.toFixed(4)}` : "$?";
  return `${usd} · in ${cost.inputTokens} / out ${cost.outputTokens} / cached ${cost.cachedTokens}`;
}

export function fmtRunCost(run: Run): string {
  if (!run.cost) return "";
  const usd = run.cost.usd != null ? `$${run.cost.usd.toFixed(4)}` : "$?";
  return `${usd} · in ${run.cost.inputTokens} / out ${run.cost.outputTokens}`;
}

export class RunRenderer {
  private inText = false;
  private inThinking = false;

  private breakText(): void {
    if (this.inText) {
      process.stdout.write("\n");
      this.inText = false;
    }
  }

  private endThinking(): void {
    if (this.inThinking) {
      process.stdout.write(`${c.reset}\n`);
      this.inThinking = false;
    }
  }

  /** 渲染一帧；done 帧返回 run 终态（供调用方定退出码），其余返回 null */
  frame(f: RunStreamFrame): Run | null {
    if (f.kind !== "event" || f.event.type !== "thinking") this.endThinking();
    if (f.kind === "done") {
      this.breakText();
      const run = f.run;
      if (run.status === "succeeded") {
        // result 事件已渲染 cost，这里不重复
      } else if (run.status === "failed") {
        process.stdout.write(`${c.red}✗ run 失败：${run.error ?? "（无 error 信息）"}${c.reset}\n`);
      } else if (run.status === "canceled") {
        process.stdout.write(`${c.yellow}⊘ run 已取消${c.reset}\n`);
      }
      return run;
    }

    const ev = f.event;
    switch (ev.type) {
      case "session_start": {
        this.breakText();
        const sid = (ev.sessionId ?? "").slice(0, 8);
        process.stdout.write(`${c.dim}◈ session ${sid} model=${String(ev.data.model ?? "?")}${c.reset}\n`);
        break;
      }
      case "text_chunk": {
        process.stdout.write(String(ev.data.text ?? ""));
        this.inText = true;
        break;
      }
      case "thinking": {
        // 思考流灰显（effort 高时可达分钟级，不显则 watch 全程失明像卡死）
        if (!this.inThinking) {
          this.breakText();
          process.stdout.write(c.dim);
          this.inThinking = true;
        }
        process.stdout.write(String(ev.data.text ?? ""));
        break;
      }
      case "tool_call": {
        this.breakText();
        const input = JSON.stringify(ev.data.input ?? {});
        process.stdout.write(
          `${c.dim}⚙ ${String(ev.data.name)} ${input.length > 100 ? input.slice(0, 100) + "…" : input}${c.reset}\n`,
        );
        break;
      }
      case "tool_call_done": {
        if (ev.data.isError) {
          this.breakText();
          const out = String(ev.data.stderr ?? ev.data.output ?? "").slice(0, 200);
          process.stdout.write(`${c.dim}${c.red}  ↳ 工具报错：${out}${c.reset}\n`);
        }
        break;
      }
      case "result": {
        this.breakText();
        process.stdout.write(`${c.dim}── ${fmtCost(ev.data.cost as Cost | null)}${c.reset}\n`);
        break;
      }
      case "error": {
        this.breakText();
        process.stdout.write(`${c.red}✗ ${String(ev.data.message ?? "backend error")}${c.reset}\n`);
        break;
      }
      // file_change / image_output：P1 终端渲染无特殊处理，忽略
    }
    return null;
  }
}

export function fmtAgo(ts: number | null): string {
  if (!ts) return "-";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s前`;
  if (s < 3600) return `${Math.round(s / 60)}m前`;
  if (s < 86400) return `${Math.round(s / 3600)}h前`;
  return `${Math.round(s / 86400)}d前`;
}

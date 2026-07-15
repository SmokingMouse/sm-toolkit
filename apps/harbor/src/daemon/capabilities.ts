/**
 * 设备能力探测：已装 CLI 版本 + 本机 endpoints.yaml 可用模型清单。
 * server 建 agent 时用这份清单校验 model（harbor.md §8「endpoints.yaml 各机不一致」对策）。
 * endpoints 同时上报裸模型名和 "provider:model" 限定 id 两种形式，与 @sm/llm 解析规则对齐。
 */

import { spawnSync } from "node:child_process";
import { loadEndpoints, listEndpoints } from "@sm/llm";
import type { DeviceCapabilities } from "../protocol.js";

function cliVersion(cmd: string): string | null {
  try {
    const r = spawnSync(cmd, ["--version"], { encoding: "utf-8", timeout: 10_000 });
    if (r.status !== 0 || !r.stdout) return null;
    // "2.1.207 (Claude Code)" → "2.1.207"；"codex-cli 0.142.2" → "0.142.2"
    const out = r.stdout.trim();
    return /\d+\.\d+[^\s]*/.exec(out)?.[0] ?? out.split(/\s+/)[0] ?? null;
  } catch {
    return null;
  }
}

export function detectCapabilities(): DeviceCapabilities {
  const clis: Record<string, string> = {};
  const claude = cliVersion("claude");
  if (claude) clis.claude = claude;
  const codex = cliVersion("codex");
  if (codex) clis.codex = codex;

  let endpoints: string[] = [];
  try {
    const infos = listEndpoints(loadEndpoints());
    endpoints = [...infos.map((i) => i.name), ...infos.map((i) => `${i.provider}:${i.model}`)];
  } catch {
    // endpoints.yaml 缺失/坏 → 空清单；agent 仍可用裸 tier 别名或 CLI 默认模型
  }
  return { clis, endpoints };
}

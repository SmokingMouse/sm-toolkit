/**
 * 短随机 id：<prefix>_<base36 x10>（~52 bit 熵，个人规模无碰撞之虞）。
 * 全 text 存储（防 19 位整数 JSON 精度坑）；CLI 支持前缀匹配，所以要短、可打。
 */

import { randomBytes } from "node:crypto";

const PREFIXES = {
  device: "dev",
  agent: "ag",
  conversation: "c",
  run: "r",
  automation: "auto",
  approval: "ap",
  skill: "sk",
  delivery: "del",
  deploymentJob: "depjob",
  deploymentLease: "lease",
  workspace: "ws",
  repository: "repo",
  repositoryMount: "mount",
} as const;

export function newId(kind: keyof typeof PREFIXES): string {
  const bytes = randomBytes(8);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return `${PREFIXES[kind]}_${n.toString(36).slice(0, 10).padStart(10, "0")}`;
}

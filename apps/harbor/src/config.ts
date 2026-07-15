/**
 * 三端共用配置：env 优先，回退 ~/.harbor.yaml，再回退默认值。
 * 跨设备场景 env 每台机器重复设很烦，所以给一个极简 yaml 落点。
 *
 * ~/.harbor.yaml 示例：
 *   server_url: http://100.x.x.x:7777   # CLI/daemon 指向 server（Tailscale 内网）
 *   token: <shared secret>
 *   device_name: mac-studio             # daemon 用，缺省 hostname
 */

import { readFileSync, existsSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { DEFAULT_PORT } from "./protocol.js";

interface HarborFileConfig {
  server_url?: string;
  token?: string;
  device_name?: string;
}

let _file: HarborFileConfig | null = null;

function fileConfig(): HarborFileConfig {
  if (_file) return _file;
  const p = resolve(process.env.HOME ?? "~", ".harbor.yaml");
  _file = existsSync(p) ? ((parseYaml(readFileSync(p, "utf-8")) as HarborFileConfig) ?? {}) : {};
  return _file;
}

export function serverUrl(): string {
  return (
    process.env.HARBOR_SERVER_URL ?? fileConfig().server_url ?? `http://127.0.0.1:${DEFAULT_PORT}`
  );
}

/** serverUrl 的 ws 形态（daemon 连 /ws 用） */
export function serverWsUrl(): string {
  const u = new URL(serverUrl());
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/ws";
  return u.toString();
}

export function token(): string {
  const t = process.env.HARBOR_TOKEN ?? fileConfig().token;
  if (!t) {
    throw new Error(
      "HARBOR_TOKEN 未设置（env 或 ~/.harbor.yaml 的 token 字段）——server/daemon/CLI 共享同一个 secret",
    );
  }
  return t;
}

export function deviceName(): string {
  return process.env.HARBOR_DEVICE_NAME ?? fileConfig().device_name ?? hostname();
}

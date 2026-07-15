/**
 * 三端共用配置：env 优先，回退 ~/.harbor.yaml，再回退默认值。
 * 跨设备场景 env 每台机器重复设很烦，所以给一个极简 yaml 落点。
 *
 * ~/.harbor.yaml 示例：
 *   server_url: http://100.x.x.x:7777   # CLI/daemon 指向 server（Tailscale 内网）
 *   token: <shared secret>
 *   device_name: mac-studio             # daemon 用，缺省 hostname
 *   feishu:                             # server 用（P2 飞书入口）；缺省 = 入口关闭
 *     app_id: cli_xxx
 *     app_secret: xxx
 *     admin_user_id: ou_xxx             # 唯一有权指挥 bot 的人（send-gate ACL）
 *     bot_name: Harbor
 *     allowed_chats: []                 # automation 播报白名单群，默认空 = 不播报
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
  feishu?: {
    app_id?: string;
    app_secret?: string;
    admin_user_id?: string;
    bot_name?: string;
    allowed_chats?: string[];
  };
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

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  /** 唯一有权指挥 bot 的飞书 user id；空 = 开放（不建议） */
  adminUserId: string;
  botName: string;
  /** automation 播报白名单群（send-gate 场景③）；默认空 = 不播报 */
  allowedChats: string[];
}

/** 飞书入口配置；app_id/app_secret 不全 → null（入口关闭，server 只跑 CLI/REST 面） */
export function feishuConfig(): FeishuConfig | null {
  const f = fileConfig().feishu ?? {};
  const appId = process.env.HARBOR_FEISHU_APP_ID ?? f.app_id;
  const appSecret = process.env.HARBOR_FEISHU_APP_SECRET ?? f.app_secret;
  if (!appId || !appSecret) return null;
  return {
    appId,
    appSecret,
    adminUserId: process.env.HARBOR_FEISHU_ADMIN ?? f.admin_user_id ?? "",
    botName: f.bot_name ?? "Harbor",
    allowedChats: f.allowed_chats ?? [],
  };
}

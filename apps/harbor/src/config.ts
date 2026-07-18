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
 *   github:                            # server-only Delivery provider；缺省 = 仅 manual 可用
 *     token: github_pat_xxx
 *     custom_bots:                      # optional：Workspace 专属 Bot（key = workspace id/slug）
 *       ws_personal:
 *         app_id: cli_custom
 *         app_secret: xxx
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
  workspace?: string;
  feishu?: {
    app_id?: string;
    app_secret?: string;
    admin_user_id?: string;
    bot_name?: string;
    allowed_chats?: string[];
    custom_bots?: Record<
      string,
      {
        app_id?: string;
        app_secret?: string;
        admin_user_id?: string;
        bot_name?: string;
        allowed_chats?: string[];
      }
    >;
  };
  codebase?: {
    webhook_secret?: string;
  };
  github?: {
    token?: string;
  };
}

let _file: HarborFileConfig | null = null;

function fileConfig(): HarborFileConfig {
  if (_file) return _file;
  const p = resolve(process.env.HOME ?? "~", ".harbor.yaml");
  _file = existsSync(p)
    ? ((parseYaml(readFileSync(p, "utf-8")) as HarborFileConfig) ?? {})
    : {};
  return _file;
}

export function serverUrl(): string {
  return (
    process.env.HARBOR_SERVER_URL ??
    fileConfig().server_url ??
    `http://127.0.0.1:${DEFAULT_PORT}`
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
  return (
    process.env.HARBOR_DEVICE_NAME ?? fileConfig().device_name ?? hostname()
  );
}

/** CLI 默认作用域；可用 --workspace 在单次命令覆盖。 */
export function workspace(): string | undefined {
  return process.env.HARBOR_WORKSPACE ?? fileConfig().workspace;
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

export interface GitHubConfig {
  token: string;
}

/** GitHub Delivery 凭证只从 server 配置读取；不全时返回 null，让 manual provider 独立启动。 */
export function githubConfig(): GitHubConfig | null {
  const configured = process.env.HARBOR_GITHUB_TOKEN ?? fileConfig().github?.token;
  const githubToken = configured?.trim();
  return githubToken ? { token: githubToken } : null;
}

export interface FeishuBotProfile {
  mode: "global" | "custom";
  workspaceKey: string | null;
  config: FeishuConfig;
}

/** 一个 global Bot + N 个 Workspace custom Bot；secret 只从 server 配置读取，不进数据库/REST。 */
export function feishuBotProfiles(): FeishuBotProfile[] {
  const profiles: FeishuBotProfile[] = [];
  const global = feishuConfig();
  if (global)
    profiles.push({ mode: "global", workspaceKey: null, config: global });
  for (const [workspaceKey, value] of Object.entries(
    fileConfig().feishu?.custom_bots ?? {},
  )) {
    if (!value.app_id || !value.app_secret) continue;
    profiles.push({
      mode: "custom",
      workspaceKey,
      config: {
        appId: value.app_id,
        appSecret: value.app_secret,
        adminUserId: value.admin_user_id ?? "",
        botName: value.bot_name ?? "Harbor",
        allowedChats: value.allowed_chats ?? [],
      },
    });
  }
  return profiles;
}

export interface CodebaseConfig {
  /** Codebase webhook 独立 secret；不复用高权限 HARBOR_TOKEN。 */
  webhookSecret: string;
}

export function codebaseConfig(): CodebaseConfig | null {
  const value =
    process.env.HARBOR_CODEBASE_WEBHOOK_SECRET ??
    fileConfig().codebase?.webhook_secret;
  return value ? { webhookSecret: value } : null;
}

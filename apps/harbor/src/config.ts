/**
 * 三端共用配置：env 优先，回退 ~/.harbor.yaml，再回退默认值。
 * 跨设备场景 env 每台机器重复设很烦，所以给一个极简 yaml 落点。
 *
 * ~/.harbor.yaml 示例：
 *   server_url: http://100.x.x.x:7777   # CLI/daemon 指向 server（Tailscale 内网）
 *   token: <shared secret>
 *   device_name: mac-studio             # daemon 用，缺省 hostname
 *   database_path: /srv/harbor/harbor.db # server/self-deployer durable queue；缺省 ~/.harbor/harbor.db
 *   feishu:                             # server 用（P2 飞书入口）；缺省 = 入口关闭
 *     app_id: cli_xxx
 *     app_secret: xxx
 *     admin_user_id: ou_xxx             # 唯一有权指挥 bot 的人（send-gate ACL）
 *     bot_name: Harbor
 *     allowed_chats: []                 # automation 播报白名单群，默认空 = 不播报
 *   github:                            # server-only GitHub App；不接受 PAT/user token 配置
 *     app:
 *       app_id: "123456"
 *       client_id: Iv1.xxxxxxxxxxxxxxxx
 *       client_secret: <oauth client secret>
 *       slug: harbor-automation
 *       private_key_path: /Users/me/.harbor/github-app.pem
 *     webhook_secret: <random secret>
 *   # feishu.custom_bots 可为特定 Workspace 配置独立 Bot。
 *   self_deploy_target:               # Harbor-only sidecar target；敏感字段不进 DB/REST
 *       id: local-harbor
 *       name: Local Harbor
 *       provider: local-launchd
 *       repository_id: repo_xxx
 *       repository_path: /Users/me/.harbor/deploy/repository.git
 *       releases_path: /Users/me/.harbor/deploy/releases
 *       current_symlink_path: /Users/me/.harbor/deploy/current
 *       sqlite_path: /Users/me/.harbor/harbor.db
 *       state_path: /Users/me/.harbor/deploy/state
 *       source: { remote: origin, url: https://github.com/me/harbor.git, allowed_refs: [refs/heads/main] }
 *       command_timeout_ms: 1800000
 *       steps: { install: [[bun, install, --frozen-lockfile]], build: [[bun, run, build]], test: [[bun, test]] }
 *       services:
 *         - { id: server, role: server, label: com.example.harbor.server, domain: gui/501, plist_path: /Users/me/Library/LaunchAgents/com.example.harbor.server.plist, template_path: /Users/me/.harbor/deploy/server.plist.tpl, template_sha256: <64 hex> }
 *         - { id: daemon, role: daemon, label: com.example.harbor.daemon, domain: gui/501, plist_path: /Users/me/Library/LaunchAgents/com.example.harbor.daemon.plist, template_path: /Users/me/.harbor/deploy/daemon.plist.tpl, template_sha256: <64 hex> }
 *       # secret value 只由 self-deployer 从 env 解析；server 只读取这个非敏感 reference。
 *       health: { url: http://127.0.0.1:7777/api/health, headers: { Authorization: { env: HARBOR_DEPLOY_HEALTH_AUTH } }, timeout_ms: 30000, interval_ms: 500 }
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync, lstatSync, realpathSync, type Stats } from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { DEFAULT_PORT } from "./protocol.js";

interface HarborFileConfig {
  server_url?: string;
  public_url?: string;
  token?: string;
  device_name?: string;
  workspace?: string;
  database_path?: string;
  deployment_maintenance_path?: string;
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
    app?: {
      app_id?: string | number;
      client_id?: string;
      client_secret?: string;
      slug?: string;
      private_key_path?: string;
    };
    webhook_secret?: string;
  };
  self_deploy_target?: unknown;
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

export interface HarborPublicAuthConfig {
  origin: string;
  rpId: string;
  rpName: string;
  secureCookie: boolean;
}

/** WebAuthn/Origin 真相只来自管理员配置，绝不相信请求 Host header。 */
export function parsePublicAuthConfig(raw: string | undefined): HarborPublicAuthConfig {
  if (!raw) throw new Error("HARBOR_PUBLIC_URL 未设置（env 或 ~/.harbor.yaml public_url）——Passkey RP/Origin 禁止从请求 Host 推断");
  const url = new URL(raw);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("HARBOR_PUBLIC_URL 必须是 https；仅 localhost 开发允许 http");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("HARBOR_PUBLIC_URL 只能包含 origin，不允许凭证、path、query 或 fragment");
  }
  return {
    origin: url.origin,
    rpId: url.hostname,
    rpName: "Harbor",
    secureCookie: url.protocol === "https:",
  };
}

export function publicAuthConfig(): HarborPublicAuthConfig {
  return parsePublicAuthConfig(process.env.HARBOR_PUBLIC_URL ?? fileConfig().public_url);
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

/** CLI 默认作用域；可用 --workspace 在单次命令覆盖。 */
export function workspace(): string | undefined {
  return process.env.HARBOR_WORKSPACE ?? fileConfig().workspace;
}

/** server 与独立 deploy worker 必须指向同一 durable queue DB。 */
export function databasePath(): string {
  return process.env.HARBOR_DB ?? fileConfig().database_path ?? resolve(process.env.HOME ?? "~", ".harbor/harbor.db");
}

/** 这台 Harbor host 的稳定全局 maintenance sentinel；不得依赖任何 target state_path。 */
export function deploymentMaintenancePath(): string {
  const configured = process.env.HARBOR_DEPLOYMENT_MAINTENANCE_PATH
    ?? fileConfig().deployment_maintenance_path
    ?? resolve(process.env.HOME ?? "~", ".harbor/deployment/maintenance.json");
  if (!isAbsolute(configured) || resolve(configured) !== configured || dirname(configured) === configured) {
    throw new Error("deployment maintenance path 必须是非根目录下的 canonical 绝对路径");
  }
  return configured;
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

export interface GitHubAppConfig {
  appId: string;
  clientId: string;
  clientSecret: string;
  slug: string;
  privateKey: string;
  privateKeyPath: string;
  webhookSecret: string;
}

interface GitHubAppEnvironment {
  HARBOR_GITHUB_APP_ID?: string;
  HARBOR_GITHUB_APP_CLIENT_ID?: string;
  HARBOR_GITHUB_APP_CLIENT_SECRET?: string;
  HARBOR_GITHUB_APP_SLUG?: string;
  HARBOR_GITHUB_APP_PRIVATE_KEY_PATH?: string;
  HARBOR_GITHUB_WEBHOOK_SECRET?: string;
}

/** GitHub App private key 是 server credential：只接受当前 uid 拥有的 canonical 0600 普通文件。 */
export function readGitHubAppPrivateKey(path: string, expectedUid = process.getuid?.()): string {
  if (!isAbsolute(path) || resolve(path) !== path || dirname(path) === path) {
    throw new Error("github.app.private_key_path 必须是非根目录下的 canonical 绝对路径");
  }
  const metadata = lstatSync(path);
  assertPrivateConfigMetadata(metadata, expectedUid, "GitHub App private key");
  if (realpathSync(path) !== path) throw new Error("GitHub App private key 路径不能包含 symlink component");
  const value = readFileSync(path, "utf8").trim();
  if (!/^-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+-----END (?:RSA )?PRIVATE KEY-----$/.test(value)) {
    throw new Error("GitHub App private key 不是 PEM private key");
  }
  return `${value}\n`;
}

/** 纯 parser 供测试/部署预检注入；任一 App 字段出现时必须完整配置，拒绝半启用。 */
export function parseGitHubAppConfig(
  value: HarborFileConfig["github"] | undefined,
  environment: GitHubAppEnvironment = { ...process.env } as GitHubAppEnvironment,
  readPrivateKey: (path: string) => string = readGitHubAppPrivateKey,
): GitHubAppConfig | null {
  const app = value?.app ?? {};
  const rawAppId = environment.HARBOR_GITHUB_APP_ID ?? app.app_id;
  const rawApp = {
    appId: rawAppId === undefined ? "" : String(rawAppId).trim(),
    clientId: (environment.HARBOR_GITHUB_APP_CLIENT_ID ?? app.client_id ?? "").trim(),
    clientSecret: (environment.HARBOR_GITHUB_APP_CLIENT_SECRET ?? app.client_secret ?? "").trim(),
    slug: (environment.HARBOR_GITHUB_APP_SLUG ?? app.slug ?? "").trim().toLowerCase(),
    privateKeyPath: (environment.HARBOR_GITHUB_APP_PRIVATE_KEY_PATH ?? app.private_key_path ?? "").trim(),
  };
  // Rolling migration：旧版本允许单独配置 repository webhook secret。它不能在 App
  // 字段尚未落盘时把新 server 误判成“半配置”，否则首次部署永远无法启动。
  if (Object.values(rawApp).every((entry) => !entry)) return null;
  const raw = {
    ...rawApp,
    webhookSecret: (environment.HARBOR_GITHUB_WEBHOOK_SECRET ?? value?.webhook_secret ?? "").trim(),
  };
  const missing = Object.entries(raw).filter(([, entry]) => !entry).map(([key]) => key);
  if (missing.length) throw new Error(`GitHub App 配置不完整：缺少 ${missing.join(", ")}`);
  if (!/^[1-9][0-9]*$/.test(raw.appId)) throw new Error("github.app.app_id 必须是正整数 GitHub App id");
  if (!/^[A-Za-z0-9_.-]{3,128}$/.test(raw.clientId)) throw new Error("github.app.client_id 格式不正确");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(raw.slug)) throw new Error("github.app.slug 格式不正确");
  if (raw.clientSecret.length < 16) throw new Error("github.app.client_secret 长度不足");
  if (raw.webhookSecret.length < 16) throw new Error("github.webhook_secret 长度不足");
  return { ...raw, privateKey: readPrivateKey(raw.privateKeyPath) };
}

/** GitHub Delivery/OAuth 只支持 GitHub App；未配置时 manual/codebase provider 独立启动。 */
export function githubAppConfig(): GitHubAppConfig | null {
  return parseGitHubAppConfig(fileConfig().github);
}

/** GitHub App webhook 使用独立 secret；不复用高权限 HARBOR_TOKEN。 */
export function githubWebhookSecret(): string {
  return (
    process.env.HARBOR_GITHUB_WEBHOOK_SECRET ??
    fileConfig().github?.webhook_secret ??
    ""
  ).trim();
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

export type DeploymentServiceRole = "server" | "daemon";

export interface DeploymentServiceConfig {
  id: string;
  role: DeploymentServiceRole;
  label: string;
  domain: string;
  plistPath: string;
  templatePath: string;
  /** 管理员冻结的 template 内容 hash；worker 每次启动/执行均复验。 */
  templateSha256: string;
}

export interface SecretReference {
  env: string;
}

export interface LocalLaunchdDeploymentTargetConfig {
  id: string;
  name: string;
  provider: "local-launchd";
  repositoryId: string;
  repositoryPath: string;
  releasesPath: string;
  currentSymlinkPath: string;
  sqlitePath: string;
  statePath: string;
  source: { remote: string; remoteUrl: string; allowedRefs: string[] };
  steps: { install: string[][]; build: string[][]; test: string[][] };
  environment: Record<string, string>;
  services: DeploymentServiceConfig[];
  health: {
    url: string;
    headerRefs: Record<string, SecretReference>;
    /** 仅进程内存在；fingerprint/DB/REST/audit 不得使用。 */
    headers: Record<string, string>;
    timeoutMs: number;
    intervalMs: number;
  };
  commandTimeoutMs: number;
  /** 只覆盖非敏感 topology；用于拒绝 server/worker 配置漂移。 */
  fingerprint: string;
  /** release manifest 的非敏感 contract hash；与 build policy fingerprint 分离。 */
  manifestHash: string;
}

export type DeploymentTargetConfig = LocalLaunchdDeploymentTargetConfig;

/** Harbor-only target 纯 parser，供测试注入；不会读取真实 HOME。 */
export function parseSelfDeployTarget(
  value: unknown,
  secretEnvironment: Record<string, string | undefined> = {},
  options: { resolveSecrets?: boolean; maintenancePath?: string } = {},
): DeploymentTargetConfig | null {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) throw new Error("self_deploy_target 必须是单个 object");
  const parsed = [value].map((item) => {
    const raw = record(item, "self_deploy_target");
    const id = requiredString(raw.id, "self_deploy_target.id");
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) {
      throw new Error(`deployment target id "${id}" 只能使用小写字母、数字、._-，且最长 64 字符`);
    }
    if (raw.provider !== "local-launchd") {
      throw new Error(`deployment target "${id}" provider 只支持 local-launchd`);
    }
    const health = record(raw.health, `deployment target "${id}" health`);
    const source = record(raw.source, `deployment target "${id}" source`);
    const steps = raw.steps === undefined ? {} : record(raw.steps, `deployment target "${id}" steps`);
    const environment = raw.environment === undefined
      ? {}
      : Object.fromEntries(Object.entries(record(raw.environment, `deployment target "${id}" environment`)).map(([key, candidate]) => {
          if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error(`deployment target "${id}" environment key "${key}" 格式不正确`);
          if (/^(HARBOR|GITHUB)_/.test(key) || /(TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL)/.test(key)) {
            throw new Error(`deployment target "${id}" environment.${key} 属于保留/敏感变量；build steps 不得接收 Harbor/GitHub/credential env`);
          }
          if (typeof candidate !== "string") throw new Error(`deployment target "${id}" environment.${key} 必须是字符串`);
          return [key, candidate];
        }));
    const healthHeaderRefs = health.headers === undefined
      ? {}
      : Object.fromEntries(Object.entries(record(health.headers, `deployment target "${id}" health.headers`)).map(([key, candidate]) => {
          if (!/^[A-Za-z0-9-]{1,128}$/.test(key)) throw new Error(`deployment target "${id}" health header name 无效`);
          const reference = record(candidate, `deployment target "${id}" health.headers.${key}`);
          const env = requiredString(reference.env, `deployment target "${id}" health.headers.${key}.env`);
          if (!/^[A-Z_][A-Z0-9_]*$/.test(env)) throw new Error(`deployment target "${id}" health secret env reference 无效`);
          const secret = secretEnvironment[env];
          if (options.resolveSecrets !== false && !secret) throw new Error(`deployment target "${id}" health secret env ${env} 未配置`);
          return [key, { env } satisfies SecretReference];
        }));
    const healthHeaders = options.resolveSecrets === false
      ? {}
      : Object.fromEntries(Object.entries(healthHeaderRefs).map(([key, reference]) => [key, secretEnvironment[reference.env]!]));
    const absolute = (key: string, candidate: unknown) => {
      const path = requiredString(candidate, `deployment target "${id}" ${key}`);
      if (!isAbsolute(path)) throw new Error(`deployment target "${id}" ${key} 必须是绝对路径`);
      if (resolve(path) !== path) throw new Error(`deployment target "${id}" ${key} 必须是 lexical canonical 绝对路径`);
      return path;
    };
    let healthUrl: URL;
    try {
      healthUrl = new URL(requiredString(health.url, `deployment target "${id}" health.url`));
    } catch {
      throw new Error(`deployment target "${id}" health.url 格式不正确`);
    }
    if (healthUrl.protocol !== "http:" && healthUrl.protocol !== "https:") {
      throw new Error(`deployment target "${id}" health.url 只支持 http/https`);
    }
    if (healthUrl.username || healthUrl.password) throw new Error(`deployment target "${id}" health.url 禁止内嵌凭证`);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(healthUrl.hostname)) {
      throw new Error(`deployment target "${id}" health.url 必须指向 loopback host`);
    }
    const repositoryPath = absolute("repository_path", raw.repository_path);
    const releasesPath = absolute("releases_path", raw.releases_path);
    const currentSymlinkPath = absolute("current_symlink_path", raw.current_symlink_path);
    const sqlitePath = absolute("sqlite_path", raw.sqlite_path);
    const statePath = absolute("state_path", raw.state_path);
    if (!Array.isArray(raw.services) || raw.services.length < 2) {
      throw new Error(`deployment target "${id}" services 必须显式包含 server + daemon`);
    }
    const serviceIds = new Set<string>();
    const serviceLabels = new Set<string>();
    const services = raw.services.map((candidate, serviceIndex): DeploymentServiceConfig => {
      const service = record(candidate, `deployment target "${id}" services[${serviceIndex}]`);
      const serviceId = requiredString(service.id, `deployment target "${id}" services[${serviceIndex}].id`);
      if (!/^[a-z][a-z0-9_-]{0,31}$/.test(serviceId) || serviceIds.has(serviceId)) throw new Error(`deployment target "${id}" service id 无效或重复`);
      serviceIds.add(serviceId);
      const role = requiredString(service.role, `deployment target "${id}" services[${serviceIndex}].role`);
      if (role !== "server" && role !== "daemon") throw new Error(`deployment target "${id}" service role 只支持 server/daemon`);
      const label = requiredString(service.label, `deployment target "${id}" services[${serviceIndex}].label`);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(label)) throw new Error(`deployment target "${id}" service label 格式不正确`);
      const domain = requiredString(service.domain, `deployment target "${id}" services[${serviceIndex}].domain`);
      if (!/^gui\/\d+$/.test(domain)) throw new Error(`deployment target "${id}" service domain 只支持 gui/<uid>`);
      const labelIdentity = `${domain}/${label}`;
      if (serviceLabels.has(labelIdentity)) throw new Error(`deployment target "${id}" service label 重复`);
      serviceLabels.add(labelIdentity);
      const templateSha256 = requiredString(service.template_sha256, `deployment target "${id}" services[${serviceIndex}].template_sha256`).toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(templateSha256)) throw new Error(`deployment target "${id}" service template_sha256 无效`);
      return {
        id: serviceId,
        role,
        label,
        domain,
        plistPath: absolute(`services[${serviceIndex}].plist_path`, service.plist_path),
        templatePath: absolute(`services[${serviceIndex}].template_path`, service.template_path),
        templateSha256,
      };
    });
    if (services.filter((service) => service.role === "server").length !== 1 || !services.some((service) => service.role === "daemon")) {
      throw new Error(`deployment target "${id}" services 必须恰有一个 server 且至少一个 daemon`);
    }
    assertDeploymentPathsDisjoint(id, {
      repositoryPath, releasesPath, currentSymlinkPath, sqlitePath, statePath,
      ...Object.fromEntries(services.flatMap((service) => [
        [`${service.id}.plistPath`, service.plistPath],
        [`${service.id}.templatePath`, service.templatePath],
      ])),
    });
    const parsedSteps = {
      install: argvList(steps.install, `deployment target "${id}" steps.install`),
      build: argvList(steps.build, `deployment target "${id}" steps.build`),
      test: argvList(steps.test, `deployment target "${id}" steps.test`),
    };
    const configuredSecrets = Object.values(healthHeaders).filter(Boolean);
    for (const [key, environmentValue] of Object.entries(environment)) {
      if (credentialLike(environmentValue) || configuredSecrets.some((secret) => environmentValue.includes(secret))) {
        throw new Error(`deployment target "${id}" environment.${key} 禁止包含 credential-like value 或配置 secret`);
      }
    }
    for (const argv of [...parsedSteps.install, ...parsedSteps.build, ...parsedSteps.test]) {
      if (argv.some((arg) => credentialLike(arg) || configuredSecrets.some((secret) => arg.includes(secret)))) {
        throw new Error(`deployment target "${id}" step argv 禁止包含 credential-like 参数或配置 secret`);
      }
    }
    const remote = requiredString(source.remote, `deployment target "${id}" source.remote`);
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(remote)) throw new Error(`deployment target "${id}" source.remote 无效`);
    const remoteUrl = requiredString(source.url, `deployment target "${id}" source.url`);
    if (credentialLike(remoteUrl)) throw new Error(`deployment target "${id}" source.url 禁止 userinfo/credential`);
    if (!Array.isArray(source.allowed_refs) || source.allowed_refs.length === 0) throw new Error(`deployment target "${id}" source.allowed_refs 必须非空`);
    const allowedRefs = source.allowed_refs.map((ref, refIndex) => {
      const parsed = requiredString(ref, `deployment target "${id}" source.allowed_refs[${refIndex}]`);
      if (!/^refs\/heads\/[A-Za-z0-9._\/-]+$/.test(parsed) || parsed.includes("..") || parsed.includes("//") || parsed.endsWith("/")) {
        throw new Error(`deployment target "${id}" allowed ref 必须是固定 remote refs/heads/*`);
      }
      return parsed;
    }).sort();
    const healthTimeoutMs = positiveInt(health.timeout_ms, 30_000, `deployment target "${id}" health.timeout_ms`);
    const healthIntervalMs = positiveInt(health.interval_ms, 500, `deployment target "${id}" health.interval_ms`);
    const commandTimeoutMs = positiveInt(raw.command_timeout_ms, 30 * 60_000, `deployment target "${id}" command_timeout_ms`);
    const manifest = {
      version: 1,
      targetId: id,
      repositoryId: requiredString(raw.repository_id, `deployment target "${id}" repository_id`),
      source: { remote, remoteUrl, allowedRefs },
      services: services.map((service) => ({ ...service })),
      health: { url: healthUrl.toString(), timeoutMs: healthTimeoutMs, intervalMs: healthIntervalMs, headerRefs: healthHeaderRefs },
      paths: { repositoryPath, releasesPath, currentSymlinkPath, sqlitePath, statePath },
    };
    const topology = {
      ...manifest,
      provider: "local-launchd" as const,
      steps: parsedSteps,
      environment: Object.fromEntries(Object.entries(environment).sort(([left], [right]) => left.localeCompare(right))),
      commandTimeoutMs,
    };
    const repositoryId = manifest.repositoryId;
    return {
      id,
      name: optionalString(raw.name) ?? id,
      provider: "local-launchd" as const,
      repositoryId,
      repositoryPath,
      releasesPath,
      currentSymlinkPath,
      sqlitePath,
      statePath,
      source: { remote, remoteUrl, allowedRefs },
      steps: parsedSteps,
      environment,
      services,
      health: {
        url: healthUrl.toString(),
        headerRefs: healthHeaderRefs,
        headers: healthHeaders,
        timeoutMs: healthTimeoutMs,
        intervalMs: healthIntervalMs,
      },
      commandTimeoutMs,
      fingerprint: createHash("sha256").update(JSON.stringify(topology)).digest("hex"),
      manifestHash: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    };
  });
  const target = parsed[0]!;
  if (options.maintenancePath) assertMaintenancePathDisjoint(target, options.maintenancePath);
  return target;
}

/** env JSON 优先；server 必须 resolveSecrets=false，secret value 只存在 self-deployer 内存。 */
export function harborSelfDeployTarget(options: { resolveSecrets?: boolean } = {}): DeploymentTargetConfig | null {
  const envTarget = process.env.HARBOR_SELF_DEPLOY_TARGET_JSON;
  let raw = fileConfig().self_deploy_target;
  if (envTarget !== undefined) {
    try { raw = JSON.parse(envTarget); }
    catch { throw new Error("HARBOR_SELF_DEPLOY_TARGET_JSON 不是合法 JSON"); }
  }
  return parseSelfDeployTarget(raw, process.env, {
    resolveSecrets: options.resolveSecrets,
    maintenancePath: deploymentMaintenancePath(),
  });
}

function assertMaintenancePathDisjoint(target: DeploymentTargetConfig, maintenancePath: string): void {
  if (!isAbsolute(maintenancePath) || resolve(maintenancePath) !== maintenancePath) {
    throw new Error("deployment maintenance path 必须是 canonical 绝对路径");
  }
  const paths = [target.repositoryPath, target.releasesPath, target.currentSymlinkPath, target.sqlitePath, target.statePath,
    ...target.services.flatMap((service) => [service.plistPath, service.templatePath])];
  if (paths.some((path) => pathsConflict(path, maintenancePath))) {
    throw new Error(`deployment target "${target.id}" host path 与稳定 maintenance sentinel 冲突或互相包含`);
  }
}

function pathsConflict(left: string, right: string): boolean {
  if (left === right) return true;
  const leftRelative = relative(left, right);
  const rightRelative = relative(right, left);
  return (!!leftRelative && !leftRelative.startsWith("..") && !isAbsolute(leftRelative))
    || (!!rightRelative && !rightRelative.startsWith("..") && !isAbsolute(rightRelative));
}

function credentialLike(value: string): boolean {
  return /(?:authorization\s*[:=]|\b(?:bearer|basic)\s+\S+|(?:token|password|secret|credential)\s*[:=]\s*\S+)/i.test(value)
    || /(?:^|[-_])(?:authorization|auth|token|password|passwd|secret|credential)(?:$|[-_:=])/i.test(value)
    || /^(?:bearer|basic)$/i.test(value.trim())
    || /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i.test(value);
}

/** deploy worker 每次进程启动都必须复验 YAML 本身，不能复用 setup 时的旧结论。 */
export function validateDeploymentWorkerConfigFile(
  path = resolve(process.env.HOME ?? "~", ".harbor.yaml"),
  expectedUid = process.getuid?.(),
): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`deploy worker 配置 ${path} 必须是 canonical 绝对路径`);
  // env可以提供target，但只要YAML存在，database/sentinel等其余worker配置仍可能
  // 从该文件读取，因此每次进程启动都必须复验；只有文件确实不存在且target完全来自env才跳过。
  if (!existsSync(path) && process.env.HARBOR_SELF_DEPLOY_TARGET_JSON !== undefined) return;
  let metadata: Stats;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    throw new Error(`deploy worker 配置 ${path} 无法读取：${error instanceof Error ? error.message : String(error)}`);
  }
  assertPrivateConfigMetadata(metadata, expectedUid, path);
  assertTrustedConfigComponents(path, expectedUid);
  if (realpathSync(path) !== path) throw new Error(`deploy worker 配置 ${path} 不能包含 symlink component`);
  const parent = dirname(path);
  const parentMetadata = lstatSync(parent);
  if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()
    || (expectedUid !== undefined && parentMetadata.uid !== expectedUid)
    || (parentMetadata.mode & 0o022) !== 0
    || realpathSync(parent) !== parent) {
    throw new Error(`deploy worker 配置父目录 ${parent} 必须是当前 uid 拥有、不可写篡改的 canonical non-symlink directory`);
  }
}

function assertTrustedConfigComponents(path: string, expectedUid: number | undefined): void {
  const components: string[] = [];
  for (let current = path;; current = dirname(current)) {
    components.push(current);
    if (dirname(current) === current) break;
  }
  components.reverse();
  for (let index = 0; index < components.length; index++) {
    const component = components[index]!;
    const metadata = lstatSync(component);
    const leaf = index === components.length - 1;
    if (metadata.isSymbolicLink() || (!leaf && !metadata.isDirectory())) {
      throw new Error(`deploy worker 配置路径含不可信 component ${component}`);
    }
    if (expectedUid !== undefined && metadata.uid !== expectedUid && metadata.uid !== 0) {
      throw new Error(`deploy worker 配置 component ${component} owner 不可信`);
    }
    if ((metadata.mode & 0o022) !== 0) {
      const trustedStickySystemParent = !leaf && metadata.uid === 0 && (metadata.mode & 0o1000) !== 0;
      if (!trustedStickySystemParent) throw new Error(`deploy worker 配置 component ${component} 不能 group/world writable`);
    }
  }
}

export function assertPrivateConfigMetadata(
  metadata: Pick<Stats, "isFile" | "isSymbolicLink" | "uid" | "mode">,
  expectedUid: number | undefined,
  label = "~/.harbor.yaml",
): void {
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`${label} 必须是 non-symlink regular file`);
  if (expectedUid !== undefined && metadata.uid !== expectedUid) throw new Error(`${label} owner 必须是当前 deploy worker uid`);
  if ((metadata.mode & 0o777) !== 0o600) throw new Error(`${label} 权限必须精确为 0600`);
}

function assertDeploymentPathsDisjoint(id: string, paths: Record<string, string>): void {
  const entries = Object.entries(paths);
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [leftName, left] = entries[i]!;
      const [rightName, right] = entries[j]!;
      if (left === right) throw new Error(`deployment target "${id}" ${leftName}/${rightName} 不能指向同一路径`);
      const leftOwnsRight = relative(left, right) && !relative(left, right).startsWith("..") && !isAbsolute(relative(left, right));
      const rightOwnsLeft = relative(right, left) && !relative(right, left).startsWith("..") && !isAbsolute(relative(right, left));
      if (leftOwnsRight || rightOwnsLeft) {
        throw new Error(`deployment target "${id}" ${leftName}/${rightName} 必须互不包含`);
      }
    }
  }
  for (const [name, path] of entries) {
    if (dirname(path) === path) throw new Error(`deployment target "${id}" ${name} 不能是文件系统根目录`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 必须是非空字符串`);
  return value.trim();
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function argvList(value: unknown, label: string): string[][] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} 必须是 argv 数组列表`);
  return value.map((candidate, index) => {
    if (!Array.isArray(candidate) || candidate.length === 0 || candidate.some((arg) => typeof arg !== "string" || !arg)) {
      throw new Error(`${label}[${index}] 必须是非空字符串 argv 数组`);
    }
    return [...candidate] as string[];
  });
}

function positiveInt(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Error(`${label} 必须是正整数`);
  return value;
}

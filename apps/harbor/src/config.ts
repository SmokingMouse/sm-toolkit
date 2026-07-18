/**
 * 三端共用配置：env 优先，回退 ~/.harbor.yaml，再回退默认值。
 * 跨设备场景 env 每台机器重复设很烦，所以给一个极简 yaml 落点。
 *
 * ~/.harbor.yaml 示例：
 *   server_url: http://100.x.x.x:7777   # CLI/daemon 指向 server（Tailscale 内网）
 *   token: <shared secret>
 *   device_name: mac-studio             # daemon 用，缺省 hostname
 *   database_path: /srv/harbor/harbor.db # server/deploy worker durable queue；缺省 ~/.harbor/harbor.db
 *   feishu:                             # server 用（P2 飞书入口）；缺省 = 入口关闭
 *     app_id: cli_xxx
 *     app_secret: xxx
 *     admin_user_id: ou_xxx             # 唯一有权指挥 bot 的人（send-gate ACL）
 *     bot_name: Harbor
 *     allowed_chats: []                 # automation 播报白名单群，默认空 = 不播报
 *   github:                            # server-only SCM Delivery provider；缺省 = 仅 manual 可用
 *     token: github_pat_xxx
 *   deployment_targets:               # server/独立 deploy worker 共用；敏感字段不进 DB/REST
 *     - id: local-harbor
 *       name: Local Harbor
 *       provider: local-launchd
 *       repository_id: repo_xxx
 *       repository_path: /Users/me/.harbor/deploy/repository.git
 *       releases_path: /Users/me/.harbor/deploy/releases
 *       current_symlink_path: /Users/me/.harbor/deploy/current
 *       sqlite_path: /Users/me/.harbor/harbor.db
 *       state_path: /Users/me/.harbor/deploy/state
 *       command_timeout_ms: 1800000
 *       steps: { install: [[bun, install, --frozen-lockfile]], build: [[bun, run, build]], test: [[bun, test]] }
 *       launchd: { label: com.example.harbor, domain: gui/501, plist_path: /Users/me/Library/LaunchAgents/com.example.harbor.plist, template_path: /Users/me/.harbor/deploy/harbor.plist.tpl }
 *       health: { url: http://127.0.0.1:7777/api/health, headers: { Authorization: Bearer xxx }, timeout_ms: 30000, interval_ms: 500 }
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync, lstatSync, type Stats } from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { DEFAULT_PORT } from "./protocol.js";

interface HarborFileConfig {
  server_url?: string;
  token?: string;
  device_name?: string;
  workspace?: string;
  database_path?: string;
  feishu?: {
    app_id?: string;
    app_secret?: string;
    admin_user_id?: string;
    bot_name?: string;
    allowed_chats?: string[];
  };
  github?: {
    token?: string;
  };
  deployment_targets?: unknown;
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

/** CLI 默认作用域；可用 --workspace 在单次命令覆盖。 */
export function workspace(): string | undefined {
  return process.env.HARBOR_WORKSPACE ?? fileConfig().workspace;
}

/** server 与独立 deploy worker 必须指向同一 durable queue DB。 */
export function databasePath(): string {
  return process.env.HARBOR_DB ?? fileConfig().database_path ?? resolve(process.env.HOME ?? "~", ".harbor/harbor.db");
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
  steps: { install: string[][]; build: string[][]; test: string[][] };
  environment: Record<string, string>;
  launchd: { label: string; domain: string; plistPath: string; templatePath: string };
  health: { url: string; headers: Record<string, string>; timeoutMs: number; intervalMs: number };
  commandTimeoutMs: number;
  /** 只覆盖非敏感 topology；用于拒绝 server/worker 配置漂移。 */
  fingerprint: string;
}

export type DeploymentTargetConfig = LocalLaunchdDeploymentTargetConfig;

/** 纯 parser 供测试注入；不会读取真实 HOME。 */
export function parseDeploymentTargets(value: unknown): DeploymentTargetConfig[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("deployment_targets 必须是数组");
  const seen = new Set<string>();
  return value.map((item, index) => {
    const raw = record(item, `deployment_targets[${index}]`);
    const id = requiredString(raw.id, `deployment_targets[${index}].id`);
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) {
      throw new Error(`deployment target id "${id}" 只能使用小写字母、数字、._-，且最长 64 字符`);
    }
    if (seen.has(id)) throw new Error(`deployment target id "${id}" 重复`);
    seen.add(id);
    if (raw.provider !== "local-launchd") {
      throw new Error(`deployment target "${id}" provider 只支持 local-launchd`);
    }
    const launchd = record(raw.launchd, `deployment target "${id}" launchd`);
    const health = record(raw.health, `deployment target "${id}" health`);
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
    const healthHeaders = health.headers === undefined
      ? {}
      : Object.fromEntries(Object.entries(record(health.headers, `deployment target "${id}" health.headers`)).map(([key, candidate]) => {
          if (typeof candidate !== "string") throw new Error(`deployment target "${id}" health.headers.${key} 必须是字符串`);
          return [key, candidate];
        }));
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
    const plistPath = absolute("launchd.plist_path", launchd.plist_path);
    const templatePath = absolute("launchd.template_path", launchd.template_path);
    assertDeploymentPathsDisjoint(id, {
      repositoryPath, releasesPath, currentSymlinkPath, sqlitePath, statePath, plistPath, templatePath,
    });
    const label = requiredString(launchd.label, `deployment target "${id}" launchd.label`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(label)) throw new Error(`deployment target "${id}" launchd.label 格式不正确`);
    const domain = requiredString(launchd.domain, `deployment target "${id}" launchd.domain`);
    if (!/^gui\/\d+$/.test(domain)) throw new Error(`deployment target "${id}" launchd.domain 只支持 gui/<uid>`);
    const parsedSteps = {
      install: argvList(steps.install, `deployment target "${id}" steps.install`),
      build: argvList(steps.build, `deployment target "${id}" steps.build`),
      test: argvList(steps.test, `deployment target "${id}" steps.test`),
    };
    const configuredSecrets = [...Object.values(environment), ...Object.values(healthHeaders)].filter(Boolean);
    for (const argv of [...parsedSteps.install, ...parsedSteps.build, ...parsedSteps.test]) {
      if (argv.some((arg) => configuredSecrets.some((secret) => arg.includes(secret)))) {
        throw new Error(`deployment target "${id}" step argv 禁止包含 environment/health header secret；请通过显式非敏感 env 传递`);
      }
    }
    const topology = {
      id,
      provider: "local-launchd",
      repositoryId: requiredString(raw.repository_id, `deployment target "${id}" repository_id`),
      repositoryPath,
      releasesPath,
      currentSymlinkPath,
      sqlitePath,
      statePath,
      steps: parsedSteps,
      environmentKeys: Object.keys(environment).sort(),
      launchd: { label, domain, plistPath, templatePath },
      healthHeaderKeys: Object.keys(healthHeaders).sort(),
    };
    return {
      id,
      name: optionalString(raw.name) ?? id,
      provider: "local-launchd" as const,
      repositoryId: topology.repositoryId,
      repositoryPath,
      releasesPath,
      currentSymlinkPath,
      sqlitePath,
      statePath,
      steps: parsedSteps,
      environment,
      launchd: {
        label,
        domain,
        plistPath,
        templatePath,
      },
      health: {
        url: healthUrl.toString(),
        headers: healthHeaders,
        timeoutMs: positiveInt(health.timeout_ms, 30_000, `deployment target "${id}" health.timeout_ms`),
        intervalMs: positiveInt(health.interval_ms, 500, `deployment target "${id}" health.interval_ms`),
      },
      commandTimeoutMs: positiveInt(raw.command_timeout_ms, 30 * 60_000, `deployment target "${id}" command_timeout_ms`),
      fingerprint: createHash("sha256").update(JSON.stringify(topology)).digest("hex"),
    };
  });
}

/** env JSON 优先；缺省读取 yaml。返回新对象，调用方不得持久化完整配置。 */
export function deploymentTargets(): DeploymentTargetConfig[] {
  const configured = process.env.HARBOR_DEPLOYMENT_TARGETS_JSON;
  if (configured !== undefined) {
    try {
      return parseDeploymentTargets(JSON.parse(configured));
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("HARBOR_DEPLOYMENT_TARGETS_JSON 不是合法 JSON");
      throw error;
    }
  }
  return parseDeploymentTargets(fileConfig().deployment_targets);
}

/** deploy worker 每次进程启动都必须复验 YAML 本身，不能复用 setup 时的旧结论。 */
export function validateDeploymentWorkerConfigFile(
  path = resolve(process.env.HOME ?? "~", ".harbor.yaml"),
  expectedUid = process.getuid?.(),
): void {
  if (process.env.HARBOR_DEPLOYMENT_TARGETS_JSON !== undefined) return;
  let metadata: Stats;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    throw new Error(`deploy worker 配置 ${path} 无法读取：${error instanceof Error ? error.message : String(error)}`);
  }
  assertPrivateConfigMetadata(metadata, expectedUid, path);
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

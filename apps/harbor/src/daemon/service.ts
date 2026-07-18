/**
 * harbord 本机用户级服务管理。
 *
 * macOS: launchd LaunchAgent（~/Library/LaunchAgents）
 * Linux: systemd --user（~/.config/systemd/user）
 *
 * service definition 不携带 token；共享配置仍只落 ~/.harbor.yaml（0600）。
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, normalize, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type ServicePlatform = "darwin" | "linux";

export interface DaemonSetupOptions {
  serverUrl?: string;
  token?: string;
  deviceName?: string;
}

export interface DaemonServiceStatus {
  platform: ServicePlatform;
  installed: boolean;
  loaded: boolean;
  running: boolean;
  state: string;
  pid: number | null;
  definitionPath: string;
  stdoutPath: string | null;
  stderrPath: string | null;
}

interface ServiceContext {
  platform: ServicePlatform;
  home: string;
  bunPath: string;
  daemonEntry: string;
  pathEnv: string;
  definitionPath: string;
  stdoutPath: string | null;
  stderrPath: string | null;
}

const LAUNCHD_LABEL = "com.smokingmouse.harbor.daemon";
const SYSTEMD_UNIT = "harbord.service";
const decoder = new TextDecoder();

function servicePlatform(): ServicePlatform {
  const override = process.env.HARBOR_SERVICE_PLATFORM;
  const platform = override ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error(`harbor daemon 暂只支持 macOS launchd / Linux systemd（当前 ${platform}）`);
  }
  return platform;
}

function serviceContext(): ServiceContext {
  const platform = servicePlatform();
  const home = process.env.HARBOR_SERVICE_HOME ?? process.env.HOME ?? homedir();
  const bunPath = process.env.HARBOR_BUN_PATH ?? process.execPath;
  const daemonEntry = process.env.HARBOR_DAEMON_ENTRY ?? resolve(import.meta.dir, "main.ts");
  const pathEnv = process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
  const logDir = resolve(home, ".harbor");
  return platform === "darwin"
    ? {
        platform,
        home,
        bunPath,
        daemonEntry,
        pathEnv,
        definitionPath: resolve(home, "Library/LaunchAgents", `${LAUNCHD_LABEL}.plist`),
        stdoutPath: resolve(logDir, "harbord.log"),
        stderrPath: resolve(logDir, "harbord.err.log"),
      }
    : {
        platform,
        home,
        bunPath,
        daemonEntry,
        pathEnv,
        definitionPath: resolve(home, ".config/systemd/user", SYSTEMD_UNIT),
        stdoutPath: null,
        stderrPath: null,
      };
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** service 的 PATH 必须能再次找到启动它的 bun；bun dirname 置顶并按规范化路径稳定去重。 */
export function buildDaemonServicePath(bunPath: string, inheritedPath: string): string {
  const entries = [dirname(bunPath), ...inheritedPath.split(delimiter)].filter(Boolean);
  const seen = new Set<string>();
  return entries
    .filter((entry) => {
      const normalized = normalize(entry);
      const key = normalized.length > 1 ? normalized.replace(/[\\/]+$/, "") : normalized;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(delimiter);
}

export function renderLaunchAgent(input: {
  home: string;
  bunPath: string;
  daemonEntry: string;
  pathEnv: string;
  stdoutPath: string;
  stderrPath: string;
}): string {
  const pathEnv = buildDaemonServicePath(input.bunPath, input.pathEnv);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(input.bunPath)}</string>
    <string>${xml(input.daemonEntry)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(input.home)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${xml(input.home)}</string>
    <key>PATH</key><string>${xml(pathEnv)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>3</integer>
  <key>StandardOutPath</key><string>${xml(input.stdoutPath)}</string>
  <key>StandardErrorPath</key><string>${xml(input.stderrPath)}</string>
</dict>
</plist>
`;
}

export function renderSystemdUnit(input: {
  home: string;
  bunPath: string;
  daemonEntry: string;
  pathEnv: string;
}): string {
  const pathEnv = buildDaemonServicePath(input.bunPath, input.pathEnv);
  return `[Unit]
Description=Harbor device daemon
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
ExecStart=${systemdQuote(input.bunPath)} ${systemdQuote(input.daemonEntry)}
WorkingDirectory=${systemdQuote(input.home)}
Environment=${systemdQuote(`HOME=${input.home}`)}
Environment=${systemdQuote(`PATH=${pathEnv}`)}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;
}

function atomicWrite(path: string, content: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, content, { mode });
  renameSync(temp, path);
  chmodSync(path, mode);
}

function configPath(home: string): string {
  return resolve(home, ".harbor.yaml");
}

/** setup 所需配置写入 YAML；保留 feishu 等不相关字段。 */
export function prepareDaemonConfig(home: string, options: DaemonSetupOptions): string {
  const path = configPath(home);
  const existing = existsSync(path)
    ? ((parseYaml(readFileSync(path, "utf8")) as Record<string, unknown> | null) ?? {})
    : {};
  if (options.serverUrl) existing.server_url = options.serverUrl;
  if (options.deviceName) existing.device_name = options.deviceName;
  if (options.token) existing.token = options.token;
  if (!existing.token && process.env.HARBOR_TOKEN) existing.token = process.env.HARBOR_TOKEN;
  if (!existing.token) {
    throw new Error("缺少共享 token：请传 --token <secret>，或先在 ~/.harbor.yaml 配置 token");
  }
  atomicWrite(path, stringifyYaml(existing), 0o600);
  return path;
}

interface CommandResult {
  ok: boolean;
  out: string;
}

function command(argv: string[], allowFailure = false): CommandResult {
  const result = Bun.spawnSync(argv, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const stdout = decoder.decode(result.stdout).trim();
  const stderr = decoder.decode(result.stderr).trim();
  const out = [stdout, stderr].filter(Boolean).join("\n");
  const ok = result.exitCode === 0;
  if (!ok && !allowFailure) {
    throw new Error(`${argv.join(" ")} 失败${out ? `：${out}` : ""}`);
  }
  return { ok, out };
}

function launchdTarget(): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("无法取得当前用户 uid");
  return `gui/${uid}`;
}

export async function setupDaemonService(options: DaemonSetupOptions): Promise<DaemonServiceStatus> {
  const ctx = serviceContext();
  prepareDaemonConfig(ctx.home, options);
  mkdirSync(resolve(ctx.home, ".harbor"), { recursive: true });

  if (ctx.platform === "darwin") {
    atomicWrite(
      ctx.definitionPath,
      renderLaunchAgent({
        home: ctx.home,
        bunPath: ctx.bunPath,
        daemonEntry: ctx.daemonEntry,
        pathEnv: ctx.pathEnv,
        stdoutPath: ctx.stdoutPath!,
        stderrPath: ctx.stderrPath!,
      }),
      0o644,
    );
    const domain = launchdTarget();
    command(["launchctl", "bootout", `${domain}/${LAUNCHD_LABEL}`], true);
    command(["launchctl", "bootstrap", domain, ctx.definitionPath]);
    command(["launchctl", "enable", `${domain}/${LAUNCHD_LABEL}`]);
    command(["launchctl", "kickstart", "-k", `${domain}/${LAUNCHD_LABEL}`]);
  } else {
    atomicWrite(
      ctx.definitionPath,
      renderSystemdUnit({
        home: ctx.home,
        bunPath: ctx.bunPath,
        daemonEntry: ctx.daemonEntry,
        pathEnv: ctx.pathEnv,
      }),
      0o644,
    );
    command(["systemctl", "--user", "daemon-reload"]);
    command(["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT]);
  }
  return daemonServiceStatus();
}

export function daemonServiceStatus(): DaemonServiceStatus {
  const ctx = serviceContext();
  if (ctx.platform === "darwin") {
    const result = command(["launchctl", "print", `${launchdTarget()}/${LAUNCHD_LABEL}`], true);
    const state = result.out.match(/\bstate = ([^\n]+)/)?.[1]?.trim() ?? (result.ok ? "loaded" : "not loaded");
    const pidText = result.out.match(/\bpid = (\d+)/)?.[1];
    const pid = pidText ? Number(pidText) : null;
    return {
      platform: ctx.platform,
      installed: existsSync(ctx.definitionPath),
      loaded: result.ok,
      running: result.ok && state === "running",
      state,
      pid,
      definitionPath: ctx.definitionPath,
      stdoutPath: ctx.stdoutPath,
      stderrPath: ctx.stderrPath,
    };
  }

  const active = command(["systemctl", "--user", "is-active", SYSTEMD_UNIT], true);
  const show = command(
    ["systemctl", "--user", "show", SYSTEMD_UNIT, "--property=MainPID,LoadState,ActiveState", "--no-pager"],
    true,
  );
  const values = Object.fromEntries(
    show.out
      .split("\n")
      .map((line) => line.split("=", 2))
      .filter((pair) => pair.length === 2),
  );
  const pid = Number(values.MainPID ?? 0) || null;
  const state = values.ActiveState ?? (active.out || "not loaded");
  return {
    platform: ctx.platform,
    installed: existsSync(ctx.definitionPath),
    loaded: values.LoadState === "loaded",
    running: active.ok && active.out === "active",
    state,
    pid,
    definitionPath: ctx.definitionPath,
    stdoutPath: null,
    stderrPath: null,
  };
}

export async function showDaemonLogs(lines = 100, follow = false): Promise<number> {
  const ctx = serviceContext();
  const safeLines = Math.min(10_000, Math.max(1, Math.floor(lines)));
  const argv =
    ctx.platform === "darwin"
      ? [
          "tail",
          "-n",
          String(safeLines),
          ...(follow ? ["-f"] : []),
          ctx.stdoutPath!,
          ctx.stderrPath!,
        ]
      : [
          "journalctl",
          "--user",
          "-u",
          SYSTEMD_UNIT,
          "-n",
          String(safeLines),
          "--no-pager",
          ...(follow ? ["-f"] : []),
        ];
  const child = Bun.spawn(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env });
  return child.exited;
}

export function uninstallDaemonService(): DaemonServiceStatus {
  const ctx = serviceContext();
  if (ctx.platform === "darwin") {
    command(["launchctl", "bootout", `${launchdTarget()}/${LAUNCHD_LABEL}`], true);
  } else {
    command(["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT], true);
  }
  if (existsSync(ctx.definitionPath)) unlinkSync(ctx.definitionPath);
  if (ctx.platform === "linux") command(["systemctl", "--user", "daemon-reload"], true);
  return daemonServiceStatus();
}

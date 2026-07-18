import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { databasePath, deploymentMaintenancePath, deploymentTargets, validateDeploymentWorkerConfigFile } from "../config.js";
import { buildDaemonServicePath } from "../daemon/service.js";

const LABEL = "com.smokingmouse.harbor.deploy-worker";
const decoder = new TextDecoder();

export interface DeploymentWorkerServiceStatus {
  installed: boolean;
  loaded: boolean;
  running: boolean;
  state: string;
  pid: number | null;
  definitionPath: string;
  stdoutPath: string;
  stderrPath: string;
}

function context() {
  if ((process.env.HARBOR_SERVICE_PLATFORM ?? process.platform) !== "darwin") {
    throw new Error("Local launchd deploy worker 只支持 macOS LaunchAgent");
  }
  const home = process.env.HARBOR_SERVICE_HOME ?? process.env.HOME ?? homedir();
  const bunPath = process.env.HARBOR_BUN_PATH ?? process.execPath;
  const workerEntry = process.env.HARBOR_DEPLOY_WORKER_ENTRY ?? resolve(import.meta.dir, "main.ts");
  const logDir = resolve(home, ".harbor");
  return {
    home,
    bunPath,
    workerEntry,
    pathEnv: process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    databasePath: databasePath(),
    maintenancePath: deploymentMaintenancePath(),
    definitionPath: resolve(home, "Library/LaunchAgents", `${LABEL}.plist`),
    stdoutPath: resolve(logDir, "deploy-worker.log"),
    stderrPath: resolve(logDir, "deploy-worker.err.log"),
  };
}

export function renderDeploymentWorkerLaunchAgent(input: {
  home: string; bunPath: string; workerEntry: string; pathEnv: string; databasePath: string; maintenancePath?: string; stdoutPath: string; stderrPath: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(input.bunPath)}</string><string>${xml(input.workerEntry)}</string></array>
  <key>WorkingDirectory</key><string>${xml(input.home)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>${xml(input.home)}</string>
    <key>PATH</key><string>${xml(buildDaemonServicePath(input.bunPath, input.pathEnv))}</string>
    <key>HARBOR_DB</key><string>${xml(input.databasePath)}</string>
    <key>HARBOR_DEPLOYMENT_MAINTENANCE_PATH</key><string>${xml(input.maintenancePath ?? resolve(input.home, ".harbor/deployment/maintenance.json"))}</string>
  </dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>3</integer>
  <key>StandardOutPath</key><string>${xml(input.stdoutPath)}</string>
  <key>StandardErrorPath</key><string>${xml(input.stderrPath)}</string>
</dict></plist>
`;
}

export function setupDeploymentWorkerService(): DeploymentWorkerServiceStatus {
  if (process.env.HARBOR_DEPLOYMENT_TARGETS_JSON) {
    throw new Error("LaunchAgent 不会把当前 shell env 安全持久化；请把 deployment_targets 写入权限 0600 的 ~/.harbor.yaml 后再 setup");
  }
  const serviceHome = process.env.HARBOR_SERVICE_HOME ?? process.env.HOME ?? homedir();
  validateDeploymentWorkerConfigFile(resolve(serviceHome, ".harbor.yaml"));
  const ctx = context();
  const safeTargets = deploymentTargets({ resolveSecrets: false });
  if (safeTargets.length === 0) throw new Error("请先在 env 或 ~/.harbor.yaml 配置 deployment_targets");
  // LaunchAgent 不继承当前交互 shell 的临时 env。credential value 不写 plist；管理员必须
  // 先把 reference 写入当前 gui launchd manager（worker 只在进程内收到它）。
  for (const envName of new Set(safeTargets.flatMap((target) => Object.values(target.health.headerRefs).map((ref) => ref.env)))) {
    const credential = command(["launchctl", "getenv", envName], true);
    if (!credential.ok || !credential.out) {
      throw new Error(`health credential env ${envName} 未注入 launchd manager；请先安全执行 launchctl setenv ${envName} <secret>`);
    }
  }
  atomicWrite(ctx.definitionPath, renderDeploymentWorkerLaunchAgent(ctx));
  const domain = launchdDomain();
  command(["launchctl", "bootout", `${domain}/${LABEL}`], true);
  command(["launchctl", "bootstrap", domain, ctx.definitionPath]);
  command(["launchctl", "enable", `${domain}/${LABEL}`]);
  command(["launchctl", "kickstart", "-k", `${domain}/${LABEL}`]);
  return deploymentWorkerServiceStatus();
}

export function deploymentWorkerServiceStatus(): DeploymentWorkerServiceStatus {
  const ctx = context();
  const result = command(["launchctl", "print", `${launchdDomain()}/${LABEL}`], true);
  const state = result.out.match(/\bstate = ([^\n]+)/)?.[1]?.trim() ?? (result.ok ? "loaded" : "not loaded");
  const pidText = result.out.match(/\bpid = (\d+)/)?.[1];
  return {
    installed: existsSync(ctx.definitionPath),
    loaded: result.ok,
    running: result.ok && state === "running",
    state,
    pid: pidText ? Number(pidText) : null,
    definitionPath: ctx.definitionPath,
    stdoutPath: ctx.stdoutPath,
    stderrPath: ctx.stderrPath,
  };
}

export async function showDeploymentWorkerLogs(lines = 100, follow = false): Promise<number> {
  const ctx = context();
  const safeLines = Math.min(10_000, Math.max(1, Math.floor(lines)));
  return Bun.spawn(["tail", "-n", String(safeLines), ...(follow ? ["-f"] : []), ctx.stdoutPath, ctx.stderrPath], {
    stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env,
  }).exited;
}

export function uninstallDeploymentWorkerService(): DeploymentWorkerServiceStatus {
  const ctx = context();
  command(["launchctl", "bootout", `${launchdDomain()}/${LABEL}`], true);
  if (existsSync(ctx.definitionPath)) unlinkSync(ctx.definitionPath);
  return deploymentWorkerServiceStatus();
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, content, { mode: 0o600 });
  renameSync(temp, path);
}

function launchdDomain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("无法取得当前用户 uid");
  return `gui/${uid}`;
}

function command(argv: string[], allowFailure = false): { ok: boolean; out: string } {
  const result = Bun.spawnSync(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: process.env });
  const out = [decoder.decode(result.stdout).trim(), decoder.decode(result.stderr).trim()].filter(Boolean).join("\n");
  if (result.exitCode !== 0 && !allowFailure) throw new Error(`${argv.join(" ")} 失败${out ? `：${out}` : ""}`);
  return { ok: result.exitCode === 0, out };
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

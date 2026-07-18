import { join } from "node:path";
import type { DeploymentJob } from "../protocol.js";
import type { DeploymentTargetConfig } from "../config.js";

export interface DeploymentFileSystem {
  mkdir(path: string): Promise<void>;
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  readLink(path: string): Promise<string | null>;
  symlink(target: string, path: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface DeploymentProcess {
  run(argv: string[], options: { cwd?: string; env: Record<string, string> }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface LaunchdControl {
  bootout(domain: string, label: string): Promise<void>;
  bootstrap(domain: string, plistPath: string): Promise<void>;
}

export interface SqliteBackupControl {
  backup(databasePath: string, backupPath: string): Promise<void>;
  restore(backupPath: string, databasePath: string): Promise<void>;
}

export interface HealthClient {
  get(url: string, headers: Record<string, string>): Promise<{ status: number }>;
}

export interface DeploymentClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface DeploymentExecutorDeps {
  fs: DeploymentFileSystem;
  process: DeploymentProcess;
  launchd: LaunchdControl;
  sqlite: SqliteBackupControl;
  health: HealthClient;
  clock: DeploymentClock;
}

export interface DeploymentExecutionHooks {
  checkpoint(value: string): Promise<void>;
}

export interface DeploymentExecutionResult {
  status: "succeeded" | "failed";
  log: string;
  error: string | null;
  rollbackComplete: boolean;
}

class DeploymentFailure extends Error {}

const CUTOVER_CHECKPOINTS = new Set(["cutover_started", "old_stopped", "backup_created", "switched", "new_started", "rolling_back"]);

/** Local launchd pipeline。所有副作用通过 deps 注入，单测不会接触本机 launchd/FS/HTTP/clock。 */
export class LocalLaunchdDeploymentExecutor {
  constructor(private readonly deps: DeploymentExecutorDeps) {}

  async execute(
    job: DeploymentJob,
    target: DeploymentTargetConfig,
    hooks: DeploymentExecutionHooks,
  ): Promise<DeploymentExecutionResult> {
    const log: string[] = [];
    const sensitive = [
      target.repositoryPath,
      target.releasesPath,
      target.currentSymlinkPath,
      target.sqlitePath,
      target.statePath,
      target.launchd.plistPath,
      target.launchd.templatePath,
      target.health.url,
      ...Object.values(target.environment),
      ...Object.values(target.health.headers),
    ].filter(Boolean).sort((a, b) => b.length - a.length);
    const record = (value: string) => {
      const safe = redact(value, sensitive);
      if (safe) log.push(safe);
    };
    const releasePath = join(target.releasesPath, `${job.id}-g${job.generation}-a${job.attempt}`);
    const statePath = join(target.statePath, job.id, `attempt-${job.attempt}`);
    let cutoverStarted = false;
    let backupCreated = false;

    try {
      if (!/^[a-f0-9]{40,64}$/i.test(job.revision)) throw new DeploymentFailure("job revision 不是完整 commit id");
      if (job.attempt > 1 && CUTOVER_CHECKPOINTS.has(job.checkpoint)) {
        record(`检测到上次 attempt 在 ${job.checkpoint} 崩溃，先恢复旧 release`);
        const previousState = join(target.statePath, job.id, `attempt-${job.attempt - 1}`);
        const previousBackup = await this.deps.fs.exists(join(previousState, "database.sqlite"));
        await this.rollback(target, previousState, previousBackup, record);
        await hooks.checkpoint("rolled_back");
      }

      await this.deps.fs.mkdir(target.releasesPath);
      await this.deps.fs.mkdir(statePath);
      await hooks.checkpoint("preparing");
      const resolved = await this.command(
        ["git", "-C", target.repositoryPath, "rev-parse", "--verify", `${job.revision}^{commit}`],
        target,
        undefined,
        record,
      );
      if (resolved.stdout.trim().toLowerCase() !== job.revision.toLowerCase()) {
        throw new DeploymentFailure("configured repository 解析出的 commit 与 job revision 不一致");
      }
      await this.command(
        ["git", "-C", target.repositoryPath, "worktree", "add", "--detach", releasePath, job.revision],
        target,
        undefined,
        record,
      );
      for (const group of [target.steps.install, target.steps.build, target.steps.test]) {
        for (const argv of group) {
          await hooks.checkpoint("preparing");
          await this.command(argv, target, releasePath, record);
        }
      }
      await hooks.checkpoint("prepared");

      const oldPlist = await this.deps.fs.readText(target.launchd.plistPath);
      const oldCurrent = await this.deps.fs.readLink(target.currentSymlinkPath);
      await this.deps.fs.writeText(join(statePath, "old.plist"), oldPlist);
      await this.deps.fs.writeText(join(statePath, "old-current"), oldCurrent ?? "");
      await hooks.checkpoint("cutover_started");
      cutoverStarted = true;
      await this.deps.launchd.bootout(target.launchd.domain, target.launchd.label);
      await hooks.checkpoint("old_stopped");

      const databaseBackup = join(statePath, "database.sqlite");
      await this.deps.sqlite.backup(target.sqlitePath, databaseBackup);
      backupCreated = true;
      await hooks.checkpoint("backup_created");

      const template = await this.deps.fs.readText(target.launchd.templatePath);
      if (!template.includes("{{release_path}}")) {
        throw new DeploymentFailure("launchd plist template 缺少 {{release_path}} 占位符");
      }
      const nextPlist = template.replaceAll("{{release_path}}", xml(releasePath));
      await atomicWrite(this.deps.fs, target.launchd.plistPath, nextPlist, `${job.id}-${job.attempt}`);
      await atomicSymlink(this.deps.fs, target.currentSymlinkPath, releasePath, `${job.id}-${job.attempt}`);
      await hooks.checkpoint("switched");

      await this.deps.launchd.bootstrap(target.launchd.domain, target.launchd.plistPath);
      await hooks.checkpoint("new_started");
      await this.waitForHealth(target, hooks, record);
      await hooks.checkpoint("healthy");
      record(`deployment ${job.id} generation ${job.generation} health passed`);
      return { status: "succeeded", log: truncateLog(log), error: null, rollbackComplete: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      record(`deployment failed: ${reason}`);
      let rollbackComplete = !cutoverStarted;
      if (cutoverStarted) {
        try {
          await hooks.checkpoint("rolling_back");
          await this.rollback(target, statePath, backupCreated, record);
          await hooks.checkpoint("rolled_back");
          rollbackComplete = true;
        } catch (rollbackError) {
          rollbackComplete = false;
          record(`rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      return {
        status: "failed",
        log: truncateLog(log),
        error: redact(`${reason}${rollbackComplete ? "" : "; rollback incomplete"}`, sensitive).slice(0, 4_000),
        rollbackComplete,
      };
    }
  }

  private async command(
    argv: string[],
    target: DeploymentTargetConfig,
    cwd: string | undefined,
    record: (line: string) => void,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    if (argv.length === 0 || argv.some((arg) => typeof arg !== "string" || !arg)) throw new DeploymentFailure("deployment argv 无效");
    const result = await this.deps.process.run(argv, { cwd, env: { ...target.environment } });
    record(`$ ${argv.join(" ")}`);
    if (result.stdout) record(result.stdout);
    if (result.stderr) record(result.stderr);
    if (result.exitCode !== 0) throw new DeploymentFailure(`command exited ${result.exitCode}`);
    return result;
  }

  private async waitForHealth(
    target: DeploymentTargetConfig,
    hooks: DeploymentExecutionHooks,
    record: (line: string) => void,
  ): Promise<void> {
    const deadline = this.deps.clock.now() + target.health.timeoutMs;
    let last = "no response";
    while (this.deps.clock.now() <= deadline) {
      try {
        const response = await this.deps.health.get(target.health.url, target.health.headers);
        last = `HTTP ${response.status}`;
        if (response.status >= 200 && response.status < 300) return;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
      await hooks.checkpoint("new_started");
      await this.deps.clock.sleep(target.health.intervalMs);
    }
    record(`health failed: ${last}`);
    throw new DeploymentFailure(`health check timeout (${last})`);
  }

  private async rollback(
    target: DeploymentTargetConfig,
    statePath: string,
    restoreDatabase: boolean,
    record: (line: string) => void,
  ): Promise<void> {
    const errors: string[] = [];
    try {
      await this.deps.launchd.bootout(target.launchd.domain, target.launchd.label);
    } catch (error) {
      // 可能表示进程已崩溃/尚未加载；仍继续恢复 definition/DB 并尝试 bootstrap 旧 service。
      record(`rollback bootout warning: ${message(error)}`);
    }
    try {
      const oldPlist = await this.deps.fs.readText(join(statePath, "old.plist"));
      await atomicWrite(this.deps.fs, target.launchd.plistPath, oldPlist, "rollback");
      const oldCurrent = await this.deps.fs.readText(join(statePath, "old-current"));
      if (oldCurrent) await atomicSymlink(this.deps.fs, target.currentSymlinkPath, oldCurrent, "rollback");
      else await this.deps.fs.remove(target.currentSymlinkPath);
    } catch (error) {
      errors.push(`restore definition/release: ${message(error)}`);
    }
    if (restoreDatabase) {
      try {
        await this.deps.sqlite.restore(join(statePath, "database.sqlite"), target.sqlitePath);
      } catch (error) {
        errors.push(`restore SQLite backup: ${message(error)}`);
        // DB 不确定时不能启动可能不兼容的旧程序。
        throw new DeploymentFailure(errors.join("; "));
      }
    }
    if (errors.length > 0) throw new DeploymentFailure(errors.join("; "));
    await this.deps.launchd.bootstrap(target.launchd.domain, target.launchd.plistPath);
    await this.waitForHealth(target, { checkpoint: async () => {} }, record);
    record("旧 service definition/release/SQLite 已恢复并通过 health check");
  }
}

async function atomicWrite(fs: DeploymentFileSystem, path: string, content: string, suffix: string): Promise<void> {
  const temp = `${path}.tmp-${suffix}`;
  await fs.writeText(temp, content);
  await fs.rename(temp, path);
}

async function atomicSymlink(fs: DeploymentFileSystem, path: string, target: string, suffix: string): Promise<void> {
  const temp = `${path}.tmp-${suffix}`;
  await fs.remove(temp);
  await fs.symlink(target, temp);
  await fs.rename(temp, path);
}

function redact(value: string, sensitive: string[]): string {
  let safe = value;
  for (const secret of sensitive) safe = safe.replaceAll(secret, "[redacted]");
  return safe;
}

function truncateLog(lines: string[]): string {
  const value = lines.join("\n");
  if (value.length <= 32_000) return value;
  return `${value.slice(0, 31_960)}\n…[truncated]`;
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

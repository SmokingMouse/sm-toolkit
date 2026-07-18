import { basename, join } from "node:path";
import type { DeploymentTargetConfig } from "../config.js";
import type {
  DeploymentJob,
  DeploymentMaintenanceGate,
  DeploymentMaintenancePhase,
} from "../protocol.js";
import type { DeploymentMaintenanceSentinel } from "./maintenance.js";
import { sameMaintenanceIdentity } from "./maintenance.js";

export interface DeploymentFileSystem {
  mkdir(path: string, mode: number): Promise<void>;
  readText(path: string): Promise<string>;
  writeText(path: string, content: string, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** 只把 ENOENT 映射为 null；regular file、EACCES 与其他错误必须抛出。 */
  readLink(path: string): Promise<string | null>;
  symlink(target: string, path: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface DeploymentProcessOptions {
  cwd?: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxCaptureBytes: number;
  onOutput(stream: "stdout" | "stderr", chunk: string): void;
}

export interface DeploymentProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface DeploymentProcess {
  run(argv: string[], options: DeploymentProcessOptions): Promise<DeploymentProcessResult>;
}

export interface LaunchdServiceState {
  loaded: boolean;
  label: string | null;
  state: string;
  pid: number | null;
}

export interface LaunchdControl {
  inspect(domain: string, label: string): Promise<LaunchdServiceState>;
  bootout(domain: string, label: string): Promise<void>;
  bootstrap(domain: string, plistPath: string): Promise<void>;
  isPidAlive(pid: number): Promise<boolean>;
}

export interface SqliteBackupControl {
  backup(databasePath: string, backupPath: string): Promise<void>;
  restore(backupPath: string, databasePath: string): Promise<void>;
}

export interface HealthClient {
  get(url: string, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number; body: unknown }>;
}

export interface DeploymentClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface DeploymentTargetValidator {
  validate(target: DeploymentTargetConfig): Promise<void>;
}

export interface DeploymentExecutorDeps {
  fs: DeploymentFileSystem;
  process: DeploymentProcess;
  launchd: LaunchdControl;
  sqlite: SqliteBackupControl;
  health: HealthClient;
  clock: DeploymentClock;
  validator: DeploymentTargetValidator;
  maintenance: DeploymentMaintenanceSentinel;
}

export interface DeploymentExecutionHooks {
  checkpoint(value: string, metadata?: { newServicePid?: number | null }): Promise<void>;
  getMaintenance(): Promise<DeploymentMaintenanceGate | null>;
  activateMaintenance(input: { rollbackAttempt: number; baselineRevision: string }): Promise<DeploymentMaintenanceGate>;
  updateMaintenance(
    phase: DeploymentMaintenancePhase,
    expectedRevision: string,
    metadata?: { checkpoint?: string; newServicePid?: number | null },
  ): Promise<DeploymentMaintenanceGate>;
  restoreMaintenance(
    gate: DeploymentMaintenanceGate,
    phase: DeploymentMaintenancePhase,
    expectedRevision: string,
  ): Promise<DeploymentMaintenanceGate>;
}

export interface DeploymentExecutionResult {
  status: "succeeded" | "failed" | "needs_recovery";
  log: string;
  error: string | null;
  rollbackComplete: boolean;
  gate: DeploymentMaintenanceGate | null;
}

class DeploymentFailure extends Error {}
class StopProofFailure extends DeploymentFailure {}

/** Local launchd pipeline。所有 host 副作用都可注入；测试不会触碰真实 FS/process/launchd/HTTP/clock。 */
export class LocalLaunchdDeploymentExecutor {
  constructor(private readonly deps: DeploymentExecutorDeps) {}

  validateTarget(target: DeploymentTargetConfig): Promise<void> {
    return this.deps.validator.validate(target);
  }

  async execute(
    job: DeploymentJob,
    target: DeploymentTargetConfig,
    hooks: DeploymentExecutionHooks,
  ): Promise<DeploymentExecutionResult> {
    const logger = this.logger(target);
    if (job.targetFingerprint !== target.fingerprint) {
      return this.failure(logger, "job target fingerprint 与当前 worker 配置不一致", false, null);
    }
    if (job.checkpoint === "healthy") return this.resumeHealthy(job, target, hooks, logger);
    if (job.rollbackAttempt !== null) {
      return this.recoverOriginalBaseline(job, target, hooks, logger, "上次 worker 在 maintenance 中崩溃");
    }

    const releasePath = join(target.releasesPath, `${job.id}-g${job.generation}-a${job.attempt}`);
    const statePath = join(target.statePath, job.id, `attempt-${job.attempt}`);
    let gate: DeploymentMaintenanceGate | null = null;
    let oldPid: number | null = null;
    let newPid: number | null = null;
    let stopped = false;
    let backupCreated = false;

    try {
      await this.deps.validator.validate(target);
      this.assertJob(job);
      await this.deps.fs.mkdir(target.releasesPath, 0o700);
      await this.deps.fs.mkdir(join(target.statePath, job.id), 0o700);
      await this.deps.fs.mkdir(statePath, 0o700);
      await hooks.checkpoint("preparing");

      const resolved = await this.command(
        ["git", "-C", target.repositoryPath, "rev-parse", "--verify", `${job.revision}^{commit}`],
        target,
        undefined,
        logger,
      );
      if (resolved.stdout.trim().toLowerCase() !== job.revision.toLowerCase()) {
        throw new DeploymentFailure("configured repository 解析出的 commit 与 job revision 不一致");
      }
      await this.command(
        ["git", "-C", target.repositoryPath, "worktree", "add", "--detach", releasePath, job.revision],
        target,
        undefined,
        logger,
      );
      for (const group of [target.steps.install, target.steps.build, target.steps.test]) {
        for (const argv of group) {
          await hooks.checkpoint("preparing");
          await this.command(argv, target, releasePath, logger);
        }
      }
      await hooks.checkpoint("prepared");

      const oldState = await this.requireRunningService(target);
      oldPid = oldState.pid;
      const oldPlist = await this.deps.fs.readText(target.launchd.plistPath);
      const oldCurrent = await this.deps.fs.readLink(target.currentSymlinkPath);
      if (!oldCurrent) throw new DeploymentFailure("current release symlink 不存在，无法建立 rollback baseline");
      const baseline = await this.command(
        ["git", "-C", oldCurrent, "rev-parse", "--verify", "HEAD^{commit}"],
        target,
        undefined,
        logger,
      );
      const baselineRevision = baseline.stdout.trim().toLowerCase();
      if (!/^[a-f0-9]{40,64}$/.test(baselineRevision)) throw new DeploymentFailure("旧 release 无法解析 exact baseline revision");
      await this.deps.fs.writeText(join(statePath, "old.plist"), oldPlist, 0o600);
      await this.deps.fs.writeText(join(statePath, "old-current"), oldCurrent, 0o600);
      await this.deps.fs.writeText(join(statePath, "baseline-revision"), `${baselineRevision}\n`, 0o600);

      gate = await hooks.activateMaintenance({ rollbackAttempt: job.attempt, baselineRevision });
      await this.deps.maintenance.write(target, gate);
      await this.stopAndProve(target, oldPid, logger);
      stopped = true;
      await hooks.checkpoint("old_stopped");

      const databaseBackup = join(statePath, "database.sqlite");
      await this.deps.sqlite.backup(target.sqlitePath, databaseBackup);
      backupCreated = true;
      await hooks.checkpoint("backup_created");

      const template = await this.deps.fs.readText(target.launchd.templatePath);
      for (const placeholder of ["{{release_path}}", "{{revision}}", "{{target_fingerprint}}"] as const) {
        if (!template.includes(placeholder)) throw new DeploymentFailure(`launchd plist template 缺少 ${placeholder} 占位符`);
      }
      const nextPlist = template
        .replaceAll("{{release_path}}", xml(releasePath))
        .replaceAll("{{revision}}", xml(job.revision))
        .replaceAll("{{target_fingerprint}}", xml(job.targetFingerprint));
      await atomicWrite(this.deps.fs, target.launchd.plistPath, nextPlist, `${job.id}-${job.attempt}`);
      await atomicSymlink(this.deps.fs, target.currentSymlinkPath, releasePath, `${job.id}-${job.attempt}`);
      await hooks.checkpoint("switched");

      await this.deps.launchd.bootstrap(target.launchd.domain, target.launchd.plistPath);
      const nextState = await this.waitForRunningService(target);
      newPid = nextState.pid;
      gate = await hooks.updateMaintenance("deploying", job.revision, { checkpoint: "new_started", newServicePid: newPid });
      await this.deps.maintenance.write(target, gate);
      await this.waitForHealth(target, gate, newPid, hooks, logger);
      gate = await hooks.updateMaintenance("healthy", job.revision, { checkpoint: "healthy", newServicePid: newPid });
      await this.deps.maintenance.write(target, gate);
      logger.record(`deployment ${job.id} generation ${job.generation} exact revision health passed`);
      return { status: "succeeded", log: logger.value(), error: null, rollbackComplete: true, gate };
    } catch (error) {
      const reason = message(error);
      logger.record(`deployment failed: ${reason}`);
      if (!gate) return this.failure(logger, reason, true, null);
      if (error instanceof StopProofFailure && !stopped) {
        return this.markNeedsRecovery(target, hooks, gate, logger, `${reason}; old service stop proof incomplete`);
      }
      try {
        return await this.rollback(
          job,
          target,
          hooks,
          gate,
          join(target.statePath, job.id, `attempt-${gate.rollbackAttempt}`),
          backupCreated,
          newPid,
          logger,
          reason,
        );
      } catch (rollbackError) {
        return this.markNeedsRecovery(target, hooks, gate, logger, `${reason}; rollback incomplete: ${message(rollbackError)}`);
      }
    }
  }

  async releaseMaintenance(target: DeploymentTargetConfig, gate: DeploymentMaintenanceGate): Promise<void> {
    await this.deps.maintenance.clear(target, gate);
  }

  readMaintenance(target: DeploymentTargetConfig): Promise<DeploymentMaintenanceGate | null> {
    return this.deps.maintenance.read(target);
  }

  /** DB terminal commit 后、host sentinel clear 前崩溃：重新验证运行态后只清 sentinel，不重写 Delivery。 */
  async releaseTerminalMaintenance(
    job: DeploymentJob,
    target: DeploymentTargetConfig,
    gate: DeploymentMaintenanceGate,
  ): Promise<void> {
    await this.deps.validator.validate(target);
    if (job.targetId !== gate.targetId || job.id !== gate.jobId || job.generation !== gate.generation
      || job.revision !== gate.revision || job.targetFingerprint !== gate.targetFingerprint) {
      throw new Error("terminal job 与 maintenance sentinel identity 不一致");
    }
    const expectedRevision = job.status === "succeeded" ? job.revision : job.baselineRevision;
    if (!expectedRevision || gate.expectedRevision !== expectedRevision) throw new Error("terminal sentinel expected revision 不匹配");
    const service = job.status === "succeeded" && job.newServicePid
      ? (await this.isExactRunningService(target, job.newServicePid) ? { pid: job.newServicePid } : null)
      : await this.waitForRunningService(target);
    if (!service) throw new Error("terminal service label/PID 无法重新证明");
    await this.waitForHealth(target, gate, service.pid, dummyHooks, this.logger(target), false);
    await this.deps.maintenance.clear(target, gate);
  }

  async recoverOriginalBaseline(
    job: DeploymentJob,
    target: DeploymentTargetConfig,
    hooks: DeploymentExecutionHooks,
    logger = this.logger(target),
    reason = "管理员 recovery",
  ): Promise<DeploymentExecutionResult> {
    await this.deps.validator.validate(target);
    let databaseGate = await hooks.getMaintenance();
    let fileGate = await this.deps.maintenance.read(target);
    if (databaseGate && !fileGate && databaseGate.jobId === job.id && databaseGate.targetFingerprint === job.targetFingerprint) {
      await this.deps.maintenance.write(target, databaseGate);
      fileGate = databaseGate;
    }
    if (databaseGate && fileGate && sameMaintenanceIdentity(databaseGate, fileGate)
      && (databaseGate.phase !== fileGate.phase || databaseGate.expectedRevision !== fileGate.expectedRevision)) {
      if ((databaseGate.phase === "rolling_back" || databaseGate.phase === "needs_recovery")
        && databaseGate.expectedRevision === databaseGate.baselineRevision) {
        // phase 先落 DB 后落 host sentinel；DB-first crash 可安全补写同一冻结 identity。
        await this.deps.maintenance.write(target, databaseGate);
        fileGate = databaseGate;
      } else if ((fileGate.phase === "rolling_back" || fileGate.phase === "needs_recovery")
        && fileGate.expectedRevision === fileGate.baselineRevision
        && databaseGate.phase === "deploying" && databaseGate.expectedRevision === databaseGate.revision) {
        // SQLite restore 会把 DB gate 回退到 backup 时点；host sentinel 保留更晚的原 anchor rollback phase。
        databaseGate = await hooks.restoreMaintenance(fileGate, fileGate.phase, fileGate.baselineRevision);
      }
    }
    if (!databaseGate || !fileGate || !sameMaintenanceIdentity(databaseGate, fileGate)
      || databaseGate.phase !== fileGate.phase || databaseGate.expectedRevision !== fileGate.expectedRevision) {
      return this.failure(logger, "DB/file maintenance gate 无法证明同一 rollback anchor", false, fileGate ?? databaseGate);
    }
    if (databaseGate.jobId !== job.id || databaseGate.targetFingerprint !== job.targetFingerprint
      || job.rollbackAttempt !== databaseGate.rollbackAttempt || job.baselineRevision !== databaseGate.baselineRevision) {
      return this.failure(logger, "job 与原始 maintenance rollback anchor 不一致", false, databaseGate);
    }
    const statePath = join(target.statePath, job.id, `attempt-${databaseGate.rollbackAttempt}`);
    const databaseBackup = join(statePath, "database.sqlite");
    return this.rollback(
      job,
      target,
      hooks,
      databaseGate,
      statePath,
      await this.deps.fs.exists(databaseBackup),
      job.newServicePid,
      logger,
      reason,
    ).catch((error) => this.markNeedsRecovery(target, hooks, databaseGate, logger, `${reason}; rollback incomplete: ${message(error)}`));
  }

  private async resumeHealthy(
    job: DeploymentJob,
    target: DeploymentTargetConfig,
    hooks: DeploymentExecutionHooks,
    logger: BoundedDeploymentLog,
  ): Promise<DeploymentExecutionResult> {
    await this.deps.validator.validate(target);
    const databaseGate = await hooks.getMaintenance();
    let fileGate = await this.deps.maintenance.read(target);
    if (databaseGate && !fileGate && databaseGate.jobId === job.id && databaseGate.targetFingerprint === job.targetFingerprint) {
      await this.deps.maintenance.write(target, databaseGate);
      fileGate = databaseGate;
    }
    if (databaseGate && fileGate && sameMaintenanceIdentity(databaseGate, fileGate)
      && databaseGate.phase === "healthy" && databaseGate.expectedRevision === job.revision
      && fileGate.phase === "deploying" && fileGate.expectedRevision === job.revision) {
      // healthy checkpoint 先原子落 DB；若进程在 sentinel write 前崩溃，用同一 identity 补写后再重验。
      await this.deps.maintenance.write(target, databaseGate);
      fileGate = databaseGate;
    }
    const validGate = databaseGate && fileGate && sameMaintenanceIdentity(databaseGate, fileGate)
      && databaseGate.phase === "healthy" && fileGate.phase === "healthy"
      && databaseGate.expectedRevision === job.revision && fileGate.expectedRevision === job.revision;
    if (validGate && job.newServicePid && await this.isExactRunningService(target, job.newServicePid)) {
      try {
        await this.waitForHealth(target, databaseGate, job.newServicePid, hooks, logger);
        logger.record("healthy checkpoint 在 worker restart 后以 exact revision + label/PID 重新验证");
        return { status: "succeeded", log: logger.value(), error: null, rollbackComplete: true, gate: databaseGate };
      } catch (error) {
        logger.record(`healthy recovery validation failed: ${message(error)}`);
      }
    }
    return this.recoverOriginalBaseline(job, target, hooks, logger, "healthy checkpoint 无法重新证明 exact revision");
  }

  private async rollback(
    job: DeploymentJob,
    target: DeploymentTargetConfig,
    hooks: DeploymentExecutionHooks,
    originalGate: DeploymentMaintenanceGate,
    statePath: string,
    restoreDatabase: boolean,
    expectedNewPid: number | null,
    logger: BoundedDeploymentLog,
    reason: string,
  ): Promise<DeploymentExecutionResult> {
    let gate = await hooks.updateMaintenance("rolling_back", originalGate.baselineRevision, { checkpoint: "rolling_back" });
    await this.deps.maintenance.write(target, gate);

    // 未证明 new/target service 与其 launchd PID 全部停止前，禁止触碰 plist/symlink/DB。
    await this.stopAndProve(target, expectedNewPid, logger);
    const oldPlist = await this.deps.fs.readText(join(statePath, "old.plist"));
    const oldCurrent = (await this.deps.fs.readText(join(statePath, "old-current"))).trim();
    const baselineRevision = (await this.deps.fs.readText(join(statePath, "baseline-revision"))).trim().toLowerCase();
    if (!oldCurrent || baselineRevision !== originalGate.baselineRevision) throw new DeploymentFailure("rollback anchor 文件与冻结 baseline 不一致");
    await atomicWrite(this.deps.fs, target.launchd.plistPath, oldPlist, "rollback");
    await atomicSymlink(this.deps.fs, target.currentSymlinkPath, oldCurrent, "rollback");
    if (restoreDatabase) await this.deps.sqlite.restore(join(statePath, "database.sqlite"), target.sqlitePath);

    // SQLite restore 会回退 lease/checkpoint；用冻结 identity 恢复 gate，仍不解除 maintenance。
    gate = await hooks.restoreMaintenance(originalGate, "rolling_back", baselineRevision);
    await this.deps.maintenance.write(target, gate);
    await this.deps.launchd.bootstrap(target.launchd.domain, target.launchd.plistPath);
    const baselineState = await this.waitForRunningService(target);
    await this.waitForHealth(target, gate, baselineState.pid, hooks, logger, false);
    logger.record("旧 service definition/release/SQLite 已恢复，并通过 exact baseline revision + label/PID health");
    return {
      status: "failed",
      log: logger.value(),
      error: redact(`${reason}; rolled back to ${baselineRevision}`, this.sensitive(target)).slice(0, 4_000),
      rollbackComplete: true,
      gate,
    };
  }

  private async markNeedsRecovery(
    target: DeploymentTargetConfig,
    hooks: DeploymentExecutionHooks,
    gate: DeploymentMaintenanceGate,
    logger: BoundedDeploymentLog,
    reason: string,
  ): Promise<DeploymentExecutionResult> {
    logger.record(reason);
    let durableGate: DeploymentMaintenanceGate = { ...gate, phase: "needs_recovery", updatedAt: this.deps.clock.now() };
    try {
      durableGate = await hooks.updateMaintenance("needs_recovery", gate.expectedRevision, { checkpoint: "rollback_incomplete" });
    } catch {
      try {
        durableGate = await hooks.restoreMaintenance(gate, "needs_recovery", gate.expectedRevision);
      } catch {
        // DB 可能不可用；host sentinel 仍是最后一道写闸。
      }
    }
    await this.deps.maintenance.write(target, durableGate);
    return this.failure(logger, reason, false, durableGate);
  }

  private async command(
    argv: string[],
    target: DeploymentTargetConfig,
    cwd: string | undefined,
    logger: BoundedDeploymentLog,
  ): Promise<DeploymentProcessResult> {
    if (argv.length === 0 || argv.some((arg) => typeof arg !== "string" || !arg)) throw new DeploymentFailure("deployment argv 无效");
    logger.record(`$ ${basename(argv[0]!)} [${Math.max(0, argv.length - 1)} args redacted]`);
    const result = await this.deps.process.run(argv, {
      cwd,
      env: { ...target.environment },
      timeoutMs: target.commandTimeoutMs,
      maxCaptureBytes: 8_192,
      onOutput: (_stream, chunk) => logger.record(chunk),
    });
    if (result.timedOut) throw new DeploymentFailure(`command timeout after ${target.commandTimeoutMs}ms`);
    if (result.exitCode !== 0) throw new DeploymentFailure(`command exited ${result.exitCode}`);
    return result;
  }

  private async stopAndProve(
    target: DeploymentTargetConfig,
    expectedPid: number | null,
    logger: BoundedDeploymentLog,
  ): Promise<void> {
    const before = await this.deps.launchd.inspect(target.launchd.domain, target.launchd.label);
    this.assertLaunchdIdentity(before, target.launchd.label);
    if (!before.loaded) {
      if (before.pid !== null) throw new StopProofFailure("launchctl reports unloaded but still has PID");
      if (expectedPid && await this.deps.launchd.isPidAlive(expectedPid)) throw new StopProofFailure(`target PID ${expectedPid} still alive`);
      logger.record("launchd target already unloaded and PID absence proved");
      return;
    }
    if (!before.pid) throw new StopProofFailure("launchd target loaded but PID is absent/ambiguous");
    if (expectedPid && before.pid !== expectedPid) throw new StopProofFailure(`launchd PID changed from ${expectedPid} to ${before.pid}`);
    try {
      await this.deps.launchd.bootout(target.launchd.domain, target.launchd.label);
    } catch (error) {
      throw new StopProofFailure(`bootout failed: ${message(error)}`);
    }
    const deadline = this.deps.clock.now() + Math.min(target.health.timeoutMs, 30_000);
    while (this.deps.clock.now() <= deadline) {
      const state = await this.deps.launchd.inspect(target.launchd.domain, target.launchd.label);
      this.assertLaunchdIdentity(state, target.launchd.label);
      const oldPidAlive = await this.deps.launchd.isPidAlive(before.pid);
      if (!state.loaded && state.pid === null && !oldPidAlive) {
        logger.record(`launchd ${target.launchd.label} bootout complete; PID ${before.pid} exited`);
        return;
      }
      if (!state.loaded && state.pid !== null) throw new StopProofFailure("launchctl unloaded/PID state ambiguous");
      await this.deps.clock.sleep(Math.min(100, target.health.intervalMs));
    }
    throw new StopProofFailure(`无法证明 launchd ${target.launchd.label} 与 PID ${before.pid} 已停止`);
  }

  private async requireRunningService(target: DeploymentTargetConfig): Promise<LaunchdServiceState & { pid: number }> {
    const state = await this.deps.launchd.inspect(target.launchd.domain, target.launchd.label);
    this.assertLaunchdIdentity(state, target.launchd.label);
    if (!state.loaded || state.state !== "running" || !state.pid || !(await this.deps.launchd.isPidAlive(state.pid))) {
      throw new DeploymentFailure("旧 launchd service 必须 loaded/running 且 PID 存活，才能建立 rollback baseline");
    }
    return state as LaunchdServiceState & { pid: number };
  }

  private async waitForRunningService(target: DeploymentTargetConfig): Promise<LaunchdServiceState & { pid: number }> {
    const deadline = this.deps.clock.now() + target.health.timeoutMs;
    while (this.deps.clock.now() <= deadline) {
      const state = await this.deps.launchd.inspect(target.launchd.domain, target.launchd.label);
      this.assertLaunchdIdentity(state, target.launchd.label);
      if (state.loaded && state.state === "running" && state.pid && await this.deps.launchd.isPidAlive(state.pid)) {
        return state as LaunchdServiceState & { pid: number };
      }
      await this.deps.clock.sleep(target.health.intervalMs);
    }
    throw new DeploymentFailure(`launchd ${target.launchd.label} 未进入 running/PID alive`);
  }

  private async isExactRunningService(target: DeploymentTargetConfig, expectedPid: number): Promise<boolean> {
    const state = await this.deps.launchd.inspect(target.launchd.domain, target.launchd.label);
    this.assertLaunchdIdentity(state, target.launchd.label);
    return state.loaded && state.state === "running" && state.pid === expectedPid && await this.deps.launchd.isPidAlive(expectedPid);
  }

  private assertLaunchdIdentity(state: LaunchdServiceState, expectedLabel: string): void {
    if (state.loaded && state.label !== expectedLabel) throw new StopProofFailure(`launchctl label mismatch: expected ${expectedLabel}, got ${state.label ?? "none"}`);
    if (state.pid !== null && (!Number.isSafeInteger(state.pid) || state.pid <= 0)) throw new StopProofFailure("launchctl PID 无效");
  }

  private async waitForHealth(
    target: DeploymentTargetConfig,
    gate: DeploymentMaintenanceGate,
    expectedPid: number,
    hooks: DeploymentExecutionHooks,
    logger: BoundedDeploymentLog,
    renew = true,
  ): Promise<void> {
    const deadline = this.deps.clock.now() + target.health.timeoutMs;
    let last = "no response";
    const healthUrl = new URL(target.health.url);
    healthUrl.searchParams.set("deployment_job_id", gate.jobId);
    healthUrl.searchParams.set("revision", gate.expectedRevision);
    healthUrl.searchParams.set("target_fingerprint", gate.targetFingerprint);
    while (this.deps.clock.now() <= deadline) {
      if (!(await this.isExactRunningService(target, expectedPid))) throw new DeploymentFailure("health 期间 launchd label/PID identity 漂移");
      try {
        const response = await this.deps.health.get(
          healthUrl.toString(),
          target.health.headers,
          Math.max(1, deadline - this.deps.clock.now()),
        );
        last = `HTTP ${response.status}`;
        if (response.status >= 200 && response.status < 300 && exactHealthBody(response.body, gate)) return;
        if (response.status >= 200 && response.status < 300) last = "2xx but revision/job/fingerprint body mismatch";
      } catch (error) {
        last = message(error);
      }
      if (renew) await hooks.checkpoint(gate.phase === "rolling_back" ? "rolling_back" : "new_started", { newServicePid: expectedPid });
      await this.deps.clock.sleep(target.health.intervalMs);
    }
    logger.record(`health failed: ${last}`);
    throw new DeploymentFailure(`health check timeout (${last})`);
  }

  private assertJob(job: DeploymentJob): void {
    if (!/^[a-f0-9]{40,64}$/i.test(job.revision)) throw new DeploymentFailure("job revision 不是完整 commit id");
    if (!/^[a-f0-9]{64}$/.test(job.targetFingerprint)) throw new DeploymentFailure("job target fingerprint 无效");
  }

  private logger(target: DeploymentTargetConfig): BoundedDeploymentLog {
    return new BoundedDeploymentLog(this.sensitive(target));
  }

  private sensitive(target: DeploymentTargetConfig): string[] {
    return [
      target.repositoryPath,
      target.releasesPath,
      target.currentSymlinkPath,
      target.sqlitePath,
      target.statePath,
      target.launchd.plistPath,
      target.launchd.templatePath,
      target.health.url,
      ...Object.values(target.environment),
      ...Object.values(target.health.headers).flatMap((value) => [value, value.replace(/^Bearer\s+/i, "")]),
    ].filter(Boolean).sort((a, b) => b.length - a.length);
  }

  private failure(logger: BoundedDeploymentLog, reason: string, rollbackComplete: boolean, gate: DeploymentMaintenanceGate | null): DeploymentExecutionResult {
    return {
      status: rollbackComplete ? "failed" : "needs_recovery",
      log: logger.value(),
      error: redact(`${reason}${rollbackComplete ? "" : "; needs recovery"}`, logger.sensitive).slice(0, 4_000),
      rollbackComplete,
      gate,
    };
  }
}

export class BoundedDeploymentLog {
  private valueText = "";
  private truncated = false;

  constructor(readonly sensitive: string[], private readonly limit = 32_000) {}

  record(value: string): void {
    if (!value || this.truncated) return;
    const safe = redact(value, this.sensitive);
    const separator = this.valueText ? "\n" : "";
    const remaining = this.limit - this.valueText.length;
    if (separator.length + safe.length <= remaining) {
      this.valueText += `${separator}${safe}`;
      return;
    }
    const marker = "\n…[truncated]";
    const usable = Math.max(0, remaining - marker.length);
    this.valueText += `${separator}${safe.slice(0, Math.max(0, usable - separator.length))}${marker}`;
    this.valueText = this.valueText.slice(0, this.limit);
    this.truncated = true;
  }

  value(): string {
    return this.valueText;
  }
}

const dummyHooks: DeploymentExecutionHooks = {
  checkpoint: async () => {},
  getMaintenance: async () => null,
  activateMaintenance: async () => { throw new Error("not available"); },
  updateMaintenance: async () => { throw new Error("not available"); },
  restoreMaintenance: async () => { throw new Error("not available"); },
};

async function atomicWrite(fs: DeploymentFileSystem, path: string, content: string, suffix: string): Promise<void> {
  const temp = `${path}.tmp-${suffix}`;
  await fs.writeText(temp, content, 0o600);
  await fs.rename(temp, path);
}

async function atomicSymlink(fs: DeploymentFileSystem, path: string, target: string, suffix: string): Promise<void> {
  const temp = `${path}.tmp-${suffix}`;
  await fs.remove(temp);
  await fs.symlink(target, temp);
  await fs.rename(temp, path);
}

function exactHealthBody(value: unknown, gate: DeploymentMaintenanceGate): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return body.ok === true
    && typeof body.revision === "string" && body.revision.toLowerCase() === gate.expectedRevision
    && body.deploymentJobId === gate.jobId
    && body.targetFingerprint === gate.targetFingerprint
    && body.maintenance === true;
}

function redact(value: string, sensitive: string[]): string {
  let safe = value;
  for (const secret of sensitive) safe = safe.replaceAll(secret, "[redacted]");
  return safe;
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

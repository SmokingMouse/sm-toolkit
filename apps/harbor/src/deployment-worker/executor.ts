import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { type DeploymentServiceConfig, type DeploymentTargetConfig, type SecretReference } from "../config.js";
import type {
  DeploymentFailureKind,
  DeploymentJob,
  DeploymentMaintenanceGate,
  DeploymentMaintenancePhase,
} from "../protocol.js";
import type { DeploymentMaintenanceSentinel } from "./maintenance.js";
import { sameMaintenanceIdentity } from "./maintenance.js";
import { assertNoCredentialMaterial, assertSafeArgv, redactStructured, safeArgvAudit, targetSensitiveValues } from "./redaction.js";
import { exactPlistRootLabel } from "./plist.js";

const RELEASE_MANIFEST = ".harbor-deployment.json";

export interface DeploymentReleaseManifest {
  version: 1;
  targetId: string;
  repositoryId: string;
  revision: string;
  targetFingerprint: string;
  targetManifestHash: string;
  healthFingerprint: string;
  source: { remote: string; remoteUrl: string; allowedRefs: string[] };
  paths: {
    repositoryPath: string;
    releasesPath: string;
    currentSymlinkPath: string;
    sqlitePath: string;
    statePath: string;
  };
  health: {
    url: string;
    timeoutMs: number;
    intervalMs: number;
    headerRefs: Record<string, SecretReference>;
  };
  services: DeploymentServiceConfig[];
}

interface RollbackAnchor {
  version: 1;
  current: string;
  baseline: DeploymentReleaseManifest;
  baselineManifestHash: string;
  oldPlists: Record<string, string>;
}

export interface DeploymentFileSystem {
  mkdir(path: string, mode: number): Promise<void>;
  readText(path: string): Promise<string>;
  writeText(path: string, content: string, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  readLink(path: string): Promise<string | null>;
  symlink(target: string, path: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface DeploymentProcessOptions {
  cwd?: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxCaptureBytes: number;
  redactValues?: string[];
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
  assertFence(boundary: string): Promise<void>;
  assertRestoreFence(gate: DeploymentMaintenanceGate): Promise<void>;
  checkpoint(value: string, metadata?: { newServicePids?: Record<string, number>; databaseBackupCreated?: boolean; log?: string }): Promise<void>;
  getMaintenance(): Promise<DeploymentMaintenanceGate | null>;
  activateMaintenance(input: {
    rollbackAttempt: number;
    baselineRevision: string;
    baselineFingerprint: string;
    baselineManifestHash: string;
    baselineHealthFingerprint: string;
  }): Promise<DeploymentMaintenanceGate>;
  updateMaintenance(
    phase: DeploymentMaintenancePhase,
    expectedRevision: string,
    expectedFingerprint: string,
    metadata?: { checkpoint?: string; newServicePids?: Record<string, number>; log?: string },
  ): Promise<DeploymentMaintenanceGate>;
  restoreMaintenance(
    gate: DeploymentMaintenanceGate,
    phase: DeploymentMaintenancePhase,
    expectedRevision: string,
    expectedFingerprint: string,
  ): Promise<DeploymentMaintenanceGate>;
}

export interface DeploymentExecutionResult {
  status: "succeeded" | "failed" | "needs_recovery";
  log: string;
  error: string | null;
  failureKind: DeploymentFailureKind | null;
  rollbackComplete: boolean;
  gate: DeploymentMaintenanceGate | null;
}

class DeploymentFailure extends Error {}
class StopProofFailure extends DeploymentFailure {}

/** 所有 host 副作用可注入；生产实现与 fake 测试共享相同 fencing/rollback 状态机。 */
export class LocalLaunchdDeploymentExecutor {
  constructor(private readonly deps: DeploymentExecutorDeps) {}

  validateTarget(target: DeploymentTargetConfig): Promise<void> {
    return this.deps.validator.validate(target);
  }

  async execute(job: DeploymentJob, target: DeploymentTargetConfig, hooks: DeploymentExecutionHooks): Promise<DeploymentExecutionResult> {
    const logger = this.logger(target);
    if (job.targetId !== target.id || job.targetFingerprint !== target.fingerprint || job.targetManifestHash !== target.manifestHash) {
      return this.failure(logger, "job target identity 与当前 worker 配置不一致", true, null, "config_drift");
    }
    if (job.checkpoint === "healthy") return this.resumeHealthy(job, target, hooks, logger);
    if (job.rollbackAttempt !== null) return this.recoverOriginalBaseline(job, target, hooks, logger, "worker restart");

    const releasePath = join(target.releasesPath, `${job.id}-g${job.generation}-a${job.attempt}`);
    const statePath = join(target.statePath, job.id, `attempt-${job.attempt}`);
    const databaseBackup = join(statePath, "database.sqlite");
    let gate: DeploymentMaintenanceGate | null = null;
    let backupCreated = false;

    try {
      await this.deps.validator.validate(target);
      this.assertJob(job);
      await this.deps.fs.mkdir(target.releasesPath, 0o700);
      await this.deps.fs.mkdir(join(target.statePath, job.id), 0o700);
      await this.deps.fs.mkdir(statePath, 0o700);
      await hooks.checkpoint("fetching");
      await hooks.assertFence("before-controlled-fetch");
      await this.fetchExactRevision(job, target, releasePath, logger);
      await hooks.assertFence("after-controlled-fetch");
      for (const group of [target.steps.install, target.steps.build, target.steps.test]) {
        for (const argv of group) {
          await hooks.assertFence("build-step");
          await this.command(argv, target, releasePath, logger);
        }
      }

      const current = await this.requireCurrentRelease(target);
      let baseline: DeploymentReleaseManifest;
      try { baseline = await this.readReleaseManifest(current); }
      catch (error) { throw new DeploymentFailure(`trusted baseline manifest unavailable: ${message(error)}`); }
      logger.addSensitive(manifestSensitiveValues(baseline));
      this.validateTrustedBaseline(baseline, target);
      const baselineManifestHash = releaseManifestHash(baseline);
      const oldPlists = Object.fromEntries(await Promise.all(baseline.services.map(async (service) => {
        const plist = await this.deps.fs.readText(service.plistPath);
        assertNoCredentialMaterial(plist, Object.values(target.health.headers));
        if (exactPlistRootLabel(plist) !== service.label) {
          throw new DeploymentFailure(`trusted baseline plist ${service.id} Label 与 manifest 不匹配`);
        }
        return [serviceKey(service), plist] as const;
      })));
      const nextManifest = this.targetManifest(job, target);
      if (releaseManifestHash(nextManifest) !== target.manifestHash) throw new DeploymentFailure("target manifest hash 与 frozen job 不一致");
      const rendered = await this.renderServices(target, releasePath, job);
      const anchor: RollbackAnchor = { version: 1, current, baseline, baselineManifestHash, oldPlists };
      await this.deps.fs.writeText(join(statePath, "rollback-anchor.json"), `${JSON.stringify(anchor)}\n`, 0o600);
      await this.deps.fs.writeText(join(releasePath, RELEASE_MANIFEST), `${JSON.stringify(nextManifest)}\n`, 0o600);
      await hooks.checkpoint("prepared", { log: logger.value() });

      const union = unionServices(baseline.services, target.services);
      const oldPids = await this.captureServicePids(union);
      gate = await this.deps.maintenance.withLock(async () => {
        const activated = await hooks.activateMaintenance({
          rollbackAttempt: job.attempt,
          baselineRevision: baseline.revision,
          baselineFingerprint: baseline.targetFingerprint,
          baselineManifestHash,
          baselineHealthFingerprint: baseline.healthFingerprint,
        });
        await this.writeMaintenanceFenced(hooks, activated, "activate");
        return activated;
      });
      await hooks.assertFence("before-service-bootout");
      await this.stopAndProve(union, oldPids, logger, hooks, "deploy");
      await hooks.assertFence("after-service-bootout-proof");
      await hooks.checkpoint("old_services_stopped", { log: logger.value() });

      await this.deps.maintenance.withLock(async () => {
        await hooks.assertFence("before-db-backup");
        await this.deps.sqlite.backup(target.sqlitePath, databaseBackup);
        backupCreated = true;
        await hooks.assertFence("after-db-backup");
      });
      await hooks.checkpoint("backup_created", { databaseBackupCreated: true, log: logger.value() });

      for (const service of target.services) {
        await this.deps.maintenance.withLock(async () => {
          await hooks.assertFence(`before-plist-${service.id}`);
          await atomicWrite(this.deps.fs, service.plistPath, rendered.get(service.id)!, `${job.id}-${job.attempt}-${service.id}`);
          if (exactPlistRootLabel(await this.deps.fs.readText(service.plistPath)) !== service.label) {
            throw new DeploymentFailure(`written plist ${service.id} Label 复验失败`);
          }
          await hooks.assertFence(`after-plist-${service.id}`);
        });
      }
      for (const service of baseline.services) {
        if (!target.services.some((candidate) => candidate.plistPath === service.plistPath)) {
          await this.deps.maintenance.withLock(async () => {
            await hooks.assertFence(`before-remove-plist-${service.id}`);
            await this.deps.fs.remove(service.plistPath);
            await hooks.assertFence(`after-remove-plist-${service.id}`);
          });
        }
      }
      await this.deps.maintenance.withLock(async () => {
        await hooks.assertFence("before-current-symlink");
        await atomicSymlink(this.deps.fs, target.currentSymlinkPath, releasePath, `${job.id}-${job.attempt}`);
        await hooks.assertFence("after-current-symlink");
      });
      await hooks.checkpoint("switched", { log: logger.value() });

      const server = onlyServer(target.services);
      await this.deps.maintenance.withLock(async () => {
        await hooks.assertFence("before-server-bootstrap");
        await this.deps.launchd.bootstrap(server.domain, server.plistPath);
        await hooks.assertFence("after-server-bootstrap");
      });
      const serverPid = await this.waitForRunningService(server);
      const pids = { [serviceKey(server)]: serverPid };
      gate = await hooks.updateMaintenance("deploying", job.revision, job.targetFingerprint, {
        checkpoint: "server_started", newServicePids: pids, log: logger.value(),
      });
      await this.writeMaintenanceFenced(hooks, gate, "server-started");
      await this.waitForHealth(nextManifest, target, gate, serverPid, logger);
      await hooks.assertFence("health-finalize");
      gate = await hooks.updateMaintenance("healthy", job.revision, job.targetFingerprint, {
        checkpoint: "healthy", newServicePids: pids, log: logger.value(),
      });
      await this.writeMaintenanceFenced(hooks, gate, "healthy");
      logger.record(`deployment exact revision health passed job=${job.id} generation=${job.generation}`);
      return { status: "succeeded", log: logger.value(), error: null, failureKind: null, rollbackComplete: true, gate };
    } catch (error) {
      const reason = redactStructured(message(error), targetSensitiveValues(target));
      logger.record(`deployment failed: ${reason}`);
      if (!gate) return this.failure(logger, reason, true, null, reason.includes("baseline") ? "bootstrap_required" : "deployment_failed");
      if (error instanceof StopProofFailure && !backupCreated) {
        return this.markNeedsRecovery(hooks, gate, logger, `${reason}; service stop proof incomplete`);
      }
      try {
        return await this.rollback(job, target, hooks, gate, backupCreated, logger, reason);
      } catch (rollbackError) {
        return this.markNeedsRecovery(hooks, gate, logger, `${reason}; rollback incomplete: ${message(rollbackError)}`);
      }
    }
  }

  async recoverOriginalBaseline(
    job: DeploymentJob,
    target: DeploymentTargetConfig,
    hooks: DeploymentExecutionHooks,
    logger = this.logger(target),
    reason = "administrator recovery",
  ): Promise<DeploymentExecutionResult> {
    const gate = await hooks.getMaintenance();
    if (!gate || gate.jobId !== job.id || gate.rollbackAttempt !== job.rollbackAttempt
      || gate.fenceEpoch !== job.fenceEpoch || gate.fenceNonce !== job.fenceNonce) {
      return this.failure(logger, "recovery maintenance/fence identity 缺失或不匹配", false, gate, "rollback_incomplete");
    }
    await this.writeMaintenanceFenced(hooks, gate, "recovery-claim");
    try {
      return await this.rollback(job, target, hooks, gate, job.databaseBackupCreated, logger, reason);
    } catch (error) {
      return this.markNeedsRecovery(
        hooks,
        gate,
        logger,
        `recovery incomplete: ${redactStructured(message(error), targetSensitiveValues(target))}`,
      );
    }
  }

  /** 终态 release：先清并确认 host sentinel，再启动 daemon；DB gate 仍保持全局停写。 */
  async releaseHostMaintenance(target: DeploymentTargetConfig, gate: DeploymentMaintenanceGate, hooks: Pick<DeploymentExecutionHooks, "assertFence">): Promise<void> {
    const logger = this.logger(target);
    const current = await this.requireCurrentRelease(target);
    const manifest = await this.readReleaseManifest(current);
    logger.addSensitive(manifestSensitiveValues(manifest));
    this.validateTrustedBaseline(manifest, target);
    if (manifest.revision !== gate.expectedRevision || manifest.targetFingerprint !== gate.expectedFingerprint) {
      throw new Error("release current manifest 与 gate expected identity 不一致");
    }
    const expectedManifestHash = gate.expectedRevision === gate.revision && gate.expectedFingerprint === gate.targetFingerprint
      ? gate.targetManifestHash
      : gate.baselineManifestHash;
    if (releaseManifestHash(manifest) !== expectedManifestHash) {
      throw new Error("release current manifest topology 与 frozen gate 不一致");
    }
    const server = onlyServer(manifest.services);
    for (const service of manifest.services) {
      const installedPlist = await this.deps.fs.readText(service.plistPath);
      assertNoCredentialMaterial(installedPlist, Object.values(target.health.headers));
      if (exactPlistRootLabel(installedPlist) !== service.label) {
        throw new Error(`release plist ${service.id} Label 与 frozen manifest 不匹配`);
      }
    }
    const serverState = await this.deps.launchd.inspect(server.domain, server.label);
    this.assertExactLabel(server, serverState);
    if (!serverState.loaded || serverState.state !== "running" || !serverState.pid || !await this.deps.launchd.isPidAlive(serverState.pid)) {
      throw new Error("release 前无法证明 exact server label/PID running");
    }
    await this.waitForHealth(manifest, target, gate, serverState.pid, logger);

    if (!/^[A-Za-z0-9_-]{1,128}$/.test(gate.jobId) || !Number.isInteger(gate.rollbackAttempt) || gate.rollbackAttempt <= 0) {
      throw new Error("release gate rollback anchor path identity 无效");
    }
    const anchor = parseRollbackAnchor(await this.deps.fs.readText(
      join(target.statePath, gate.jobId, `attempt-${gate.rollbackAttempt}`, "rollback-anchor.json"),
    ));
    logger.addSensitive(manifestSensitiveValues(anchor.baseline));
    this.validateTrustedBaseline(anchor.baseline, target);
    if (anchor.baselineManifestHash !== gate.baselineManifestHash
      || releaseManifestHash(anchor.baseline) !== gate.baselineManifestHash
      || anchor.baseline.revision !== gate.baselineRevision
      || anchor.baseline.targetFingerprint !== gate.baselineFingerprint) {
      throw new Error("release rollback anchor 与 frozen baseline identity 不匹配");
    }
    // success时要复验baseline-only services；rollback时要复验new-only services。
    // 只检查current target会漏掉已经从配置移除但仍被launchd加载的旧label。
    const knownServices = unionServices(target.services, anchor.baseline.services);
    for (const extra of knownServices.filter((candidate) => !manifest.services.some((service) => serviceKey(service) === serviceKey(candidate)))) {
      const state = await this.deps.launchd.inspect(extra.domain, extra.label);
      if (state.loaded || state.pid !== null || state.label !== null) throw new Error(`release 前发现额外 service ${serviceKey(extra)}`);
    }

    await hooks.assertFence("before-sentinel-clear");
    await this.deps.maintenance.clear(gate);
    if (await this.deps.maintenance.read()) throw new Error("host maintenance sentinel clear 未得到证明");
    await hooks.assertFence("after-sentinel-clear");
    for (const daemon of manifest.services.filter((service) => service.role === "daemon")) {
      await hooks.assertFence(`before-daemon-bootstrap-${daemon.id}`);
      const before = await this.deps.launchd.inspect(daemon.domain, daemon.label);
      this.assertExactLabel(daemon, before);
      if (before.loaded) {
        if (before.state !== "running" || !before.pid || !await this.deps.launchd.isPidAlive(before.pid)) {
          throw new Error(`daemon ${serviceKey(daemon)} 已 loaded 但 exact running PID 无法证明`);
        }
      } else {
        await this.deps.launchd.bootstrap(daemon.domain, daemon.plistPath);
        await this.waitForRunningService(daemon);
      }
      await hooks.assertFence(`after-daemon-bootstrap-${daemon.id}`);
    }
  }

  readMaintenance(): Promise<DeploymentMaintenanceGate | null> {
    return this.deps.maintenance.read();
  }

  writeMaintenance(gate: DeploymentMaintenanceGate): Promise<void> {
    return this.deps.maintenance.write(gate);
  }

  withMaintenanceLock<T>(action: () => Promise<T> | T): Promise<T> {
    return this.deps.maintenance.withLock(action);
  }

  private async resumeHealthy(
    job: DeploymentJob,
    target: DeploymentTargetConfig,
    hooks: DeploymentExecutionHooks,
    logger: ReturnType<LocalLaunchdDeploymentExecutor["logger"]>,
  ): Promise<DeploymentExecutionResult> {
    const gate = await hooks.getMaintenance();
    if (!gate || gate.jobId !== job.id || gate.phase !== "healthy" || gate.expectedRevision !== job.revision
      || gate.expectedFingerprint !== job.targetFingerprint || gate.fenceEpoch !== job.fenceEpoch || gate.fenceNonce !== job.fenceNonce) {
      return this.failure(logger, "healthy checkpoint 缺少 exact fenced maintenance proof", false, gate, "rollback_incomplete");
    }
    await this.writeMaintenanceFenced(hooks, gate, "healthy-resume");
    const current = await this.requireCurrentRelease(target);
    const manifest = await this.readReleaseManifest(current);
    logger.addSensitive(manifestSensitiveValues(manifest));
    if (manifest.revision !== job.revision || manifest.targetFingerprint !== job.targetFingerprint
      || releaseManifestHash(manifest) !== job.targetManifestHash) {
      return this.recoverOriginalBaseline(job, target, hooks, logger, "healthy checkpoint current identity mismatch");
    }
    const server = onlyServer(manifest.services);
    const pid = job.newServicePids[serviceKey(server)];
    if (!pid) return this.recoverOriginalBaseline(job, target, hooks, logger, "healthy checkpoint server PID missing");
    try {
      await this.proveRunning(server, pid);
      await this.waitForHealth(manifest, target, gate, pid, logger);
      await hooks.assertFence("healthy-resume-finalize");
      logger.record("worker restart revalidated exact healthy checkpoint");
      return { status: "succeeded", log: logger.value(), error: null, failureKind: null, rollbackComplete: true, gate };
    } catch (error) {
      return this.recoverOriginalBaseline(job, target, hooks, logger, `healthy revalidation failed: ${message(error)}`);
    }
  }

  private async rollback(
    job: DeploymentJob,
    target: DeploymentTargetConfig,
    hooks: DeploymentExecutionHooks,
    originalGate: DeploymentMaintenanceGate,
    restoreDatabase: boolean,
    logger: ReturnType<LocalLaunchdDeploymentExecutor["logger"]>,
    reason: string,
  ): Promise<DeploymentExecutionResult> {
    const attempt = job.rollbackAttempt ?? originalGate.rollbackAttempt;
    const statePath = join(target.statePath, job.id, `attempt-${attempt}`);
    const anchor = parseRollbackAnchor(await this.deps.fs.readText(join(statePath, "rollback-anchor.json")));
    logger.addSensitive(manifestSensitiveValues(anchor.baseline));
    this.validateTrustedBaseline(anchor.baseline, target);
    assertReleasePath(anchor.current, target.releasesPath, "rollback anchor current");
    if (anchor.baseline.revision !== originalGate.baselineRevision
      || anchor.baseline.targetFingerprint !== originalGate.baselineFingerprint
      || anchor.baseline.healthFingerprint !== originalGate.baselineHealthFingerprint
      || anchor.baselineManifestHash !== originalGate.baselineManifestHash
      || releaseManifestHash(anchor.baseline) !== originalGate.baselineManifestHash) {
      throw new DeploymentFailure("rollback anchor/baseline fingerprint 不匹配");
    }
    let gate = await hooks.updateMaintenance(
      "rolling_back", anchor.baseline.revision, anchor.baseline.targetFingerprint,
      { checkpoint: "rolling_back", log: logger.value() },
    );
    await this.writeMaintenanceFenced(hooks, gate, "rollback-start");
    const union = unionServices(target.services, anchor.baseline.services);
    const pids = await this.captureServicePids(union);
    await hooks.assertFence("before-rollback-bootout");
    await this.stopAndProve(union, pids, logger, hooks, "rollback");
    await hooks.assertFence("after-rollback-stop-proof");

    if (restoreDatabase) {
      gate = await this.deps.maintenance.withLock(async () => {
        await hooks.assertFence("before-db-restore");
        const sentinel = await this.deps.maintenance.read();
        if (!sentinel || !sameMaintenanceIdentity(sentinel, gate)) throw new DeploymentFailure("DB restore 前 host sentinel fence 不匹配");
        await hooks.assertRestoreFence(gate);
        await this.deps.sqlite.restore(join(statePath, "database.sqlite"), target.sqlitePath);
        const restored = await hooks.restoreMaintenance(gate, "rolling_back", anchor.baseline.revision, anchor.baseline.targetFingerprint);
        await this.writeMaintenanceFenced(hooks, restored, "db-restore-rehydrate");
        await hooks.assertFence("after-db-restore-rehydrate");
        return restored;
      });
    }

    for (const service of target.services) {
      const baselineService = anchor.baseline.services.find((candidate) => serviceKey(candidate) === serviceKey(service));
      if (!baselineService || baselineService.plistPath !== service.plistPath) {
        await this.deps.maintenance.withLock(async () => {
          await hooks.assertFence(`before-rollback-remove-plist-${service.id}`);
          await this.deps.fs.remove(service.plistPath);
          await hooks.assertFence(`after-rollback-remove-plist-${service.id}`);
        });
      }
    }
    for (const service of anchor.baseline.services) {
      await this.deps.maintenance.withLock(async () => {
        await hooks.assertFence(`before-rollback-plist-${service.id}`);
        const old = anchor.oldPlists[serviceKey(service)];
        if (old === undefined) throw new DeploymentFailure(`rollback anchor 缺少 plist ${serviceKey(service)}`);
        assertNoCredentialMaterial(old, Object.values(target.health.headers));
        if (exactPlistRootLabel(old) !== service.label) throw new DeploymentFailure(`rollback plist ${service.id} Label 与 baseline manifest 不匹配`);
        await atomicWrite(this.deps.fs, service.plistPath, old, `${job.id}-rollback-${service.id}`);
        if (exactPlistRootLabel(await this.deps.fs.readText(service.plistPath)) !== service.label) {
          throw new DeploymentFailure(`written rollback plist ${service.id} Label 复验失败`);
        }
        await hooks.assertFence(`after-rollback-plist-${service.id}`);
      });
    }
    await this.deps.maintenance.withLock(async () => {
      await hooks.assertFence("before-rollback-current-symlink");
      await atomicSymlink(this.deps.fs, target.currentSymlinkPath, anchor.current, `${job.id}-rollback`);
      await hooks.assertFence("after-rollback-current-symlink");
    });
    const server = onlyServer(anchor.baseline.services);
    await this.deps.maintenance.withLock(async () => {
      await hooks.assertFence("before-baseline-server-bootstrap");
      await this.deps.launchd.bootstrap(server.domain, server.plistPath);
      await hooks.assertFence("after-baseline-server-bootstrap");
    });
    const pid = await this.waitForRunningService(server);
    gate = await hooks.updateMaintenance("rolling_back", anchor.baseline.revision, anchor.baseline.targetFingerprint, {
      checkpoint: "baseline_server_started", newServicePids: { [serviceKey(server)]: pid }, log: logger.value(),
    });
    await this.writeMaintenanceFenced(hooks, gate, "baseline-server-started");
    await this.waitForHealth(anchor.baseline, target, gate, pid, logger);
    await hooks.assertFence("rollback-health-finalize");
    logger.record(`rollback verified exact baseline; cause=${reason}`);
    return {
      status: "failed",
      log: logger.value(),
      error: `deployment failed and rolled back: ${reason}`,
      failureKind: "deployment_failed",
      rollbackComplete: true,
      gate,
    };
  }

  private async fetchExactRevision(
    job: DeploymentJob,
    target: DeploymentTargetConfig,
    releasePath: string,
    logger: ReturnType<LocalLaunchdDeploymentExecutor["logger"]>,
  ): Promise<void> {
    const remote = await this.command(["git", "-C", target.repositoryPath, "remote", "get-url", target.source.remote], target, undefined, logger);
    if (remote.stdout.trim() !== target.source.remoteUrl) throw new DeploymentFailure("configured git remote URL drifted");
    const temporaryRefs = target.source.allowedRefs.map((allowedRef, index) =>
      `refs/harbor-deploy/${job.id}/a${job.attempt}/${index}-${sha256(allowedRef).slice(0, 12)}`);
    for (const ref of temporaryRefs) {
      await this.command(["git", "-C", target.repositoryPath, "update-ref", "-d", ref], target, undefined, logger, true);
    }
    try {
      const refspecs = target.source.allowedRefs.map((allowedRef, index) => `+${allowedRef}:${temporaryRefs[index]}`);
      await this.command(["git", "-C", target.repositoryPath, "fetch", "--no-tags", "--prune", target.source.remote, ...refspecs], target, undefined, logger);
      const resolved = await this.command(["git", "-C", target.repositoryPath, "rev-parse", "--verify", `${job.revision}^{commit}`], target, undefined, logger);
      if (resolved.stdout.trim().toLowerCase() !== job.revision.toLowerCase()) throw new DeploymentFailure("fetch 后 object 不是 exact committed revision");
      let reachable = false;
      for (const fetchedRef of temporaryRefs) {
        const result = await this.command(
          ["git", "-C", target.repositoryPath, "merge-base", "--is-ancestor", job.revision, fetchedRef],
          target, undefined, logger, true,
        );
        if (result.exitCode === 0) { reachable = true; break; }
      }
      if (!reachable) throw new DeploymentFailure("exact revision 不可由本次 configured remote fetch refs 到达");
      await this.command(["git", "-C", target.repositoryPath, "worktree", "add", "--detach", releasePath, job.revision], target, undefined, logger);
    } finally {
      for (const ref of temporaryRefs) {
        await this.command(["git", "-C", target.repositoryPath, "update-ref", "-d", ref], target, undefined, logger, true);
      }
    }
  }

  private async renderServices(target: DeploymentTargetConfig, releasePath: string, job: DeploymentJob): Promise<Map<string, string>> {
    const rendered = new Map<string, string>();
    for (const service of target.services) {
      const template = await this.deps.fs.readText(service.templatePath);
      assertNoCredentialMaterial(template, Object.values(target.health.headers));
      if (sha256(template) !== service.templateSha256) throw new DeploymentFailure(`service ${service.id} template 内容 hash 漂移`);
      const label = exactPlistRootLabel(template);
      if (label !== service.label) throw new DeploymentFailure(`service ${service.id} template Label 与配置不匹配`);
      for (const placeholder of ["{{release_path}}", "{{revision}}", "{{target_fingerprint}}"] as const) {
        if (!template.includes(placeholder)) throw new DeploymentFailure(`service ${service.id} template 缺少 ${placeholder}`);
      }
      const finalPlist = template
        .replaceAll("{{release_path}}", xml(releasePath))
        .replaceAll("{{revision}}", xml(job.revision))
        .replaceAll("{{target_fingerprint}}", xml(job.targetFingerprint));
      if (exactPlistRootLabel(finalPlist) !== service.label) throw new DeploymentFailure(`service ${service.id} rendered plist Label 与配置不匹配`);
      rendered.set(service.id, finalPlist);
    }
    return rendered;
  }

  private async captureServicePids(services: DeploymentServiceConfig[]): Promise<Map<string, number | null>> {
    const result = new Map<string, number | null>();
    for (const service of services) {
      const state = await this.deps.launchd.inspect(service.domain, service.label);
      this.assertExactLabel(service, state);
      result.set(serviceKey(service), state.pid);
    }
    return result;
  }

  private async stopAndProve(
    services: DeploymentServiceConfig[],
    priorPids: Map<string, number | null>,
    logger: ReturnType<LocalLaunchdDeploymentExecutor["logger"]>,
    hooks: Pick<DeploymentExecutionHooks, "assertFence">,
    prefix: string,
  ): Promise<void> {
    let ambiguous: string | null = null;
    const proofPids = new Map<string, Set<number>>();
    for (const service of services) {
      const initial = priorPids.get(serviceKey(service));
      proofPids.set(serviceKey(service), new Set(initial ? [initial] : []));
    }
    for (const service of services) {
      await this.deps.maintenance.withLock(async () => {
        await hooks.assertFence(`before-${prefix}-bootout-${service.id}`);
        // This inspect is deliberately adjacent to bootout.  captureServicePids
        // may have observed an earlier incarnation and is not a stop proof.
        const before = await this.deps.launchd.inspect(service.domain, service.label);
        this.assertExactLabel(service, before);
        if (before.pid) proofPids.get(serviceKey(service))!.add(before.pid);
        if (before.loaded) {
          try {
            await this.deps.launchd.bootout(service.domain, service.label);
          } catch (error) {
            ambiguous ??= `${serviceKey(service)} bootout failed: ${message(error)}`;
          }
        }
        await hooks.assertFence(`after-${prefix}-bootout-${service.id}`);
      });
    }
    for (const service of services) {
      await this.deps.maintenance.withLock(async () => {
        await hooks.assertFence(`before-${prefix}-stop-proof-${service.id}`);
        const state = await this.deps.launchd.inspect(service.domain, service.label);
        if (state.loaded || state.pid !== null || state.label !== null) ambiguous ??= `${serviceKey(service)} 仍 loaded/有 PID/label`;
        if (state.pid) proofPids.get(serviceKey(service))!.add(state.pid);
        for (const pid of proofPids.get(serviceKey(service))!) {
          if (await this.deps.launchd.isPidAlive(pid)) ambiguous ??= `${serviceKey(service)} observed PID ${pid} 仍存活`;
        }
        await hooks.assertFence(`after-${prefix}-stop-proof-${service.id}`);
      });
    }
    if (ambiguous) throw new StopProofFailure(`无法证明所有 exact launchd services 已停止：${ambiguous}`);
    logger.record(`proved ${services.length} exact launchd services unloaded and old PIDs dead`);
  }

  private async waitForRunningService(service: DeploymentServiceConfig): Promise<number> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const state = await this.deps.launchd.inspect(service.domain, service.label);
      this.assertExactLabel(service, state);
      if (state.loaded && state.state === "running" && state.pid && await this.deps.launchd.isPidAlive(state.pid)) return state.pid;
      await this.deps.clock.sleep(50);
    }
    throw new DeploymentFailure(`launchd service ${serviceKey(service)} 未进入 exact running PID state`);
  }

  private async proveRunning(service: DeploymentServiceConfig, pid: number): Promise<void> {
    const state = await this.deps.launchd.inspect(service.domain, service.label);
    this.assertExactLabel(service, state);
    if (!state.loaded || state.state !== "running" || state.pid !== pid || !await this.deps.launchd.isPidAlive(pid)) {
      throw new DeploymentFailure(`launchd service ${serviceKey(service)} exact PID proof 失败`);
    }
  }

  private assertExactLabel(service: DeploymentServiceConfig, state: LaunchdServiceState): void {
    if (state.loaded && state.label !== service.label) throw new DeploymentFailure(`launchctl returned wrong label for ${serviceKey(service)}`);
  }

  private async waitForHealth(
    manifest: DeploymentReleaseManifest,
    target: DeploymentTargetConfig,
    gate: DeploymentMaintenanceGate,
    serverPid: number,
    logger: ReturnType<LocalLaunchdDeploymentExecutor["logger"]>,
  ): Promise<void> {
    const server = onlyServer(manifest.services);
    const headers = resolveHealthHeaders(manifest.health.headerRefs, target);
    const deadline = this.deps.clock.now() + manifest.health.timeoutMs;
    while (this.deps.clock.now() <= deadline) {
      await this.proveRunning(server, serverPid);
      const url = new URL(manifest.health.url);
      url.searchParams.set("deployment_job_id", gate.jobId);
      url.searchParams.set("revision", manifest.revision);
      url.searchParams.set("target_fingerprint", manifest.targetFingerprint);
      const response = await this.deps.health.get(url.toString(), headers, Math.min(5_000, manifest.health.timeoutMs));
      const body = response.body as Record<string, unknown> | null;
      if (response.status >= 200 && response.status < 300
        && body?.ok === true && body.revision === manifest.revision
        && body.targetFingerprint === manifest.targetFingerprint
        && body.deploymentJobId === gate.jobId && body.maintenance === true) return;
      if (response.status >= 200 && response.status < 300) logger.record("health 2xx but revision/job/fingerprint body mismatch");
      await this.deps.clock.sleep(manifest.health.intervalMs);
    }
    throw new DeploymentFailure("revision-aware health check timeout");
  }

  private async requireCurrentRelease(target: DeploymentTargetConfig): Promise<string> {
    const current = await this.deps.fs.readLink(target.currentSymlinkPath);
    if (!current) throw new DeploymentFailure("trusted current release manifest 不存在；administrator bootstrap required");
    const releasePath = resolve(dirname(target.currentSymlinkPath), current);
    assertReleasePath(releasePath, target.releasesPath, "trusted current release");
    return releasePath;
  }

  private async readReleaseManifest(releasePath: string): Promise<DeploymentReleaseManifest> {
    return parseReleaseManifest(await this.deps.fs.readText(join(releasePath, RELEASE_MANIFEST)));
  }

  private validateTrustedBaseline(manifest: DeploymentReleaseManifest, target: DeploymentTargetConfig): void {
    if (manifest.targetId !== target.id) throw new DeploymentFailure("trusted baseline target identity 不匹配");
    if (manifest.repositoryId !== target.repositoryId) throw new DeploymentFailure("trusted baseline repository identity 不匹配");
    if (!/^[a-f0-9]{40,64}$/.test(manifest.revision) || !/^[a-f0-9]{64}$/.test(manifest.targetFingerprint)
      || !/^[a-f0-9]{64}$/.test(manifest.targetManifestHash) || !/^[a-f0-9]{64}$/.test(manifest.healthFingerprint)) {
      throw new DeploymentFailure("trusted baseline manifest identity 无效");
    }
    validateManifestServices(manifest.services);
    validateManifestHealth(manifest.health);
    // rollback health contract属于冻结baseline，进入maintenance前就要证明其secret refs
    // 能由当前worker内存解析，不能等新服务失败后才发现旧健康检查已不可执行。
    resolveHealthHeaders(manifest.health.headerRefs, target);
    const allowedDomains = new Set(target.services.map((service) => service.domain));
    if (manifest.services.some((service) => !allowedDomains.has(service.domain))) {
      throw new DeploymentFailure("trusted baseline launchd domain 与当前 worker target 不匹配");
    }
    for (const key of ["repositoryPath", "releasesPath", "currentSymlinkPath", "sqlitePath", "statePath"] as const) {
      if (manifest.paths[key] !== target[key]) throw new DeploymentFailure(`trusted baseline ${key} 与当前 target 不匹配；需要管理员 bootstrap`);
    }
    validateManifestPaths(manifest);
    if (manifest.healthFingerprint !== sha256(JSON.stringify(manifest.health))) {
      throw new DeploymentFailure("trusted baseline health contract fingerprint 不匹配");
    }
    if (manifest.targetManifestHash !== releaseManifestHash(manifest)) {
      throw new DeploymentFailure("trusted baseline manifest hash 不匹配");
    }
  }

  private targetManifest(job: DeploymentJob, target: DeploymentTargetConfig): DeploymentReleaseManifest {
    const health = {
      url: target.health.url,
      timeoutMs: target.health.timeoutMs,
      intervalMs: target.health.intervalMs,
      headerRefs: target.health.headerRefs,
    };
    return {
      version: 1,
      targetId: target.id,
      repositoryId: target.repositoryId,
      revision: job.revision,
      targetFingerprint: target.fingerprint,
      targetManifestHash: target.manifestHash,
      healthFingerprint: sha256(JSON.stringify(health)),
      source: target.source,
      paths: {
        repositoryPath: target.repositoryPath,
        releasesPath: target.releasesPath,
        currentSymlinkPath: target.currentSymlinkPath,
        sqlitePath: target.sqlitePath,
        statePath: target.statePath,
      },
      health,
      services: target.services,
    };
  }

  private async command(
    argv: string[],
    target: DeploymentTargetConfig,
    cwd: string | undefined,
    logger: ReturnType<LocalLaunchdDeploymentExecutor["logger"]>,
    allowFailure = false,
  ): Promise<DeploymentProcessResult> {
    const sensitive = targetSensitiveValues(target);
    assertSafeArgv(argv, Object.values(target.health.headers));
    logger.record(safeArgvAudit(argv));
    const result = await this.deps.process.run(argv, {
      cwd,
      env: target.environment,
      timeoutMs: target.commandTimeoutMs,
      maxCaptureBytes: 16_384,
      redactValues: sensitive,
      // HostProcess 始终流式 drain；audit 等 bounded capture 完整后统一 redaction，避免
      // credential 刚好跨 stdout chunk 边界时被逐 chunk 处理而泄漏。
      onOutput: () => {},
    });
    if (result.stdout) logger.record(`[stdout] ${redactStructured(result.stdout, sensitive)}`);
    if (result.stderr) logger.record(`[stderr] ${redactStructured(result.stderr, sensitive)}`);
    if (result.timedOut) throw new DeploymentFailure("command timeout");
    if (!allowFailure && result.exitCode !== 0) throw new DeploymentFailure(`command failed exit=${result.exitCode}: ${redactStructured(result.stderr || result.stdout, sensitive)}`);
    return result;
  }

  private assertJob(job: DeploymentJob): void {
    if (!/^[a-f0-9]{40,64}$/i.test(job.revision) || !/^[a-f0-9]{64}$/.test(job.targetFingerprint)
      || !/^[a-f0-9]{64}$/.test(job.targetManifestHash) || !/^[A-Za-z0-9_-]{1,128}$/.test(job.id)
      || !Number.isInteger(job.generation) || job.generation <= 0 || !Number.isInteger(job.attempt) || job.attempt <= 0
      || !job.fenceEpoch || !job.fenceNonce || !job.leaseToken) {
      throw new DeploymentFailure("deployment job exact revision/manifest/fence 无效");
    }
  }

  private logger(target: DeploymentTargetConfig) {
    const sensitive = new Set(targetSensitiveValues(target));
    let value = "";
    let truncated = false;
    return {
      record(chunk: string) {
        if (truncated) return;
        const redacted = redactStructured(chunk, [...sensitive]);
        const safe = redacted.length > 8_192 ? `${redacted.slice(0, 8_192)}…[truncated]` : redacted;
        const room = 32_000 - value.length;
        if (safe.length + 1 <= room) value += `${safe}\n`;
        else {
          value += `${safe.slice(0, Math.max(0, room - 15))}…[truncated]\n`;
          truncated = true;
        }
      },
      addSensitive(values: string[]) { for (const value of values) if (value) sensitive.add(value); },
      value: () => value.slice(0, 32_000),
    };
  }

  private failure(
    logger: ReturnType<LocalLaunchdDeploymentExecutor["logger"]>,
    error: string,
    rollbackComplete: boolean,
    gate: DeploymentMaintenanceGate | null,
    failureKind: DeploymentFailureKind,
  ): DeploymentExecutionResult {
    return { status: rollbackComplete ? "failed" : "needs_recovery", log: logger.value(), error, failureKind, rollbackComplete, gate };
  }

  private async markNeedsRecovery(
    hooks: DeploymentExecutionHooks,
    gate: DeploymentMaintenanceGate,
    logger: ReturnType<LocalLaunchdDeploymentExecutor["logger"]>,
    error: string,
  ): Promise<DeploymentExecutionResult> {
    let current = gate;
    try {
      current = await hooks.updateMaintenance("needs_recovery", gate.expectedRevision, gate.expectedFingerprint, {
        checkpoint: "rollback_incomplete", log: logger.value(),
      });
      await this.writeMaintenanceFenced(hooks, current, "needs-recovery");
    } catch (markError) {
      logger.record(`failed to persist needs_recovery: ${message(markError)}`);
    }
    return { status: "needs_recovery", log: logger.value(), error, failureKind: "rollback_incomplete", rollbackComplete: false, gate: current };
  }

  private async writeMaintenanceFenced(
    hooks: Pick<DeploymentExecutionHooks, "assertFence">,
    gate: DeploymentMaintenanceGate,
    boundary: string,
  ): Promise<void> {
    await this.deps.maintenance.withLock(async () => {
      await hooks.assertFence(`before-sentinel-write-${boundary}`);
      await this.deps.maintenance.write(gate);
      await hooks.assertFence(`after-sentinel-write-${boundary}`);
    });
  }
}

export function releaseManifestHash(manifest: DeploymentReleaseManifest): string {
  const identity = {
    version: manifest.version,
    targetId: manifest.targetId,
    repositoryId: manifest.repositoryId,
    source: manifest.source,
    services: manifest.services,
    health: manifest.health,
    paths: manifest.paths,
  };
  return sha256(JSON.stringify(identity));
}

function parseReleaseManifest(value: string): DeploymentReleaseManifest {
  let raw: unknown;
  try { raw = JSON.parse(value); } catch { throw new DeploymentFailure("release manifest JSON 无效"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new DeploymentFailure("release manifest 必须是对象");
  const manifest = raw as DeploymentReleaseManifest;
  if (manifest.version !== 1 || typeof manifest.targetId !== "string" || typeof manifest.repositoryId !== "string"
    || typeof manifest.revision !== "string"
    || typeof manifest.targetFingerprint !== "string" || typeof manifest.targetManifestHash !== "string"
    || typeof manifest.healthFingerprint !== "string" || !Array.isArray(manifest.services)
    || !manifest.health || !manifest.source || !manifest.paths) throw new DeploymentFailure("release manifest fields 无效");
  return manifest;
}

function parseRollbackAnchor(value: string): RollbackAnchor {
  let raw: unknown;
  try { raw = JSON.parse(value); } catch { throw new DeploymentFailure("rollback anchor JSON 无效"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new DeploymentFailure("rollback anchor 无效");
  const anchor = raw as RollbackAnchor;
  if (anchor.version !== 1 || typeof anchor.current !== "string" || typeof anchor.baselineManifestHash !== "string"
    || !anchor.baseline || !anchor.oldPlists) throw new DeploymentFailure("rollback anchor fields 无效");
  return anchor;
}

function unionServices(left: DeploymentServiceConfig[], right: DeploymentServiceConfig[]): DeploymentServiceConfig[] {
  const services = new Map<string, DeploymentServiceConfig>();
  for (const service of [...left, ...right]) services.set(serviceKey(service), service);
  return [...services.values()];
}

function onlyServer(services: DeploymentServiceConfig[]): DeploymentServiceConfig {
  const servers = services.filter((service) => service.role === "server");
  if (servers.length !== 1) throw new DeploymentFailure("service manifest 必须恰有一个 server");
  return servers[0]!;
}

function serviceKey(service: Pick<DeploymentServiceConfig, "domain" | "label">): string {
  return `${service.domain}/${service.label}`;
}

function resolveHealthHeaders(refs: Record<string, SecretReference>, target: DeploymentTargetConfig): Record<string, string> {
  const valuesByEnv = new Map<string, string>();
  for (const [name, reference] of Object.entries(target.health.headerRefs)) valuesByEnv.set(reference.env, target.health.headers[name]!);
  return Object.fromEntries(Object.entries(refs).map(([name, reference]) => {
    const value = valuesByEnv.get(reference.env);
    if (!value) throw new DeploymentFailure(`health secret reference ${reference.env} 无法在 worker 内存解析`);
    return [name, value];
  }));
}

function manifestSensitiveValues(manifest: DeploymentReleaseManifest): string[] {
  return [
    manifest.source.remote,
    manifest.source.remoteUrl,
    manifest.health.url,
    ...Object.values(manifest.paths),
    ...manifest.services.flatMap((service) => [service.label, service.domain, service.plistPath, service.templatePath]),
    ...Object.entries(manifest.health.headerRefs).flatMap(([name, reference]) => [name, reference.env]),
  ];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertReleasePath(path: string, releasesPath: string, label: string): void {
  if (resolve(path) !== path) throw new DeploymentFailure(`${label} 不是 canonical absolute path`);
  const relativePath = path.slice(releasesPath.endsWith("/") ? releasesPath.length : releasesPath.length + 1);
  if (!path.startsWith(`${releasesPath}/`) || !relativePath || relativePath.split("/").includes("..")) {
    throw new DeploymentFailure(`${label} 必须位于 releases_path 内`);
  }
}

function validateManifestServices(services: DeploymentServiceConfig[]): void {
  if (!Array.isArray(services) || services.length < 2) throw new DeploymentFailure("release manifest 缺少 server + daemon services");
  const ids = new Set<string>();
  const labels = new Set<string>();
  const plistPaths = new Set<string>();
  for (const service of services) {
    if (!service || !/^[a-z][a-z0-9_-]{0,31}$/.test(service.id) || ids.has(service.id)) throw new DeploymentFailure("release manifest service id 无效或重复");
    if (service.role !== "server" && service.role !== "daemon") throw new DeploymentFailure("release manifest service role 无效");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(service.label) || !/^gui\/\d+$/.test(service.domain)) {
      throw new DeploymentFailure("release manifest launchd identity 无效");
    }
    const key = serviceKey(service);
    if (labels.has(key) || plistPaths.has(service.plistPath)) throw new DeploymentFailure("release manifest service label/plist 重复");
    for (const path of [service.plistPath, service.templatePath]) {
      if (resolve(path) !== path) throw new DeploymentFailure("release manifest service path 不是 canonical absolute path");
    }
    if (!/^[a-f0-9]{64}$/.test(service.templateSha256)) throw new DeploymentFailure("release manifest template hash 无效");
    ids.add(service.id);
    labels.add(key);
    plistPaths.add(service.plistPath);
  }
  onlyServer(services);
  if (!services.some((service) => service.role === "daemon")) throw new DeploymentFailure("release manifest 缺少 daemon");
}

function validateManifestHealth(health: DeploymentReleaseManifest["health"]): void {
  let url: URL;
  try { url = new URL(health.url); } catch { throw new DeploymentFailure("release manifest health URL 无效"); }
  if (!(["http:", "https:"] as string[]).includes(url.protocol) || url.username || url.password
    || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new DeploymentFailure("release manifest health 必须是无凭证 loopback URL");
  }
  if (!Number.isInteger(health.timeoutMs) || health.timeoutMs <= 0 || !Number.isInteger(health.intervalMs) || health.intervalMs <= 0
    || !health.headerRefs || typeof health.headerRefs !== "object") throw new DeploymentFailure("release manifest health contract 无效");
  for (const [name, reference] of Object.entries(health.headerRefs)) {
    if (!/^[A-Za-z0-9-]{1,128}$/.test(name) || !reference || !/^[A-Z_][A-Z0-9_]*$/.test(reference.env)) {
      throw new DeploymentFailure("release manifest health secret reference 无效");
    }
  }
}

function validateManifestPaths(manifest: DeploymentReleaseManifest): void {
  const paths = [
    manifest.paths.repositoryPath,
    manifest.paths.releasesPath,
    manifest.paths.currentSymlinkPath,
    manifest.paths.sqlitePath,
    manifest.paths.statePath,
    ...manifest.services.flatMap((service) => [service.plistPath, service.templatePath]),
  ];
  if (paths.some((path) => typeof path !== "string" || resolve(path) !== path || path === "/")) {
    throw new DeploymentFailure("release manifest host path 不是 canonical non-root absolute path");
  }
  for (let left = 0; left < paths.length; left++) {
    for (let right = left + 1; right < paths.length; right++) {
      const a = paths[left]!;
      const b = paths[right]!;
      if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) {
        throw new DeploymentFailure("release manifest host paths 冲突或互相包含");
      }
    }
  }
  if (!manifest.source || typeof manifest.source.remote !== "string" || typeof manifest.source.remoteUrl !== "string"
    || !Array.isArray(manifest.source.allowedRefs) || manifest.source.allowedRefs.some((ref) => typeof ref !== "string")) {
    throw new DeploymentFailure("release manifest fixed source identity 无效");
  }
}

async function atomicWrite(fs: DeploymentFileSystem, path: string, value: string, suffix: string): Promise<void> {
  const temp = `${path}.tmp-${suffix}`;
  await fs.writeText(temp, value, 0o600);
  await fs.rename(temp, path);
}

async function atomicSymlink(fs: DeploymentFileSystem, path: string, target: string, suffix: string): Promise<void> {
  const temp = `${path}.tmp-${suffix}`;
  if (await fs.exists(temp)) await fs.remove(temp);
  await fs.symlink(target, temp);
  await fs.rename(temp, path);
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

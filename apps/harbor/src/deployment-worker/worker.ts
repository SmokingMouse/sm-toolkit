import type { DeploymentTargetConfig } from "../config.js";
import type {
  DeploymentFence,
  DeploymentJob,
  DeploymentMaintenanceGate,
  DeploymentMaintenancePhase,
} from "../protocol.js";
import {
  LocalLaunchdDeploymentExecutor,
  type DeploymentClock,
  type DeploymentExecutionHooks,
  type DeploymentExecutionResult,
} from "./executor.js";
import { sameMaintenanceIdentity } from "./maintenance.js";
import { redactStructured, targetSensitiveValues } from "./redaction.js";

export interface DeploymentWorkerResult {
  worked: boolean;
  job: DeploymentJob | null;
  databaseGate: DeploymentMaintenanceGate | null;
  sentinel: DeploymentMaintenanceGate | null;
}

export class DeploymentWorker {
  private readonly targets: Map<string, DeploymentTargetConfig>;

  constructor(
    private readonly store: DeploymentJobStore,
    targets: DeploymentTargetConfig[],
    private readonly executor: LocalLaunchdDeploymentExecutor,
    private readonly clock: DeploymentClock,
    private readonly leaseMs = 5 * 60_000,
  ) {
    this.targets = new Map(targets.map((target) => [target.id, target]));
  }

  async runOnce(): Promise<DeploymentWorkerResult> {
    const validTargets = new Map<string, DeploymentTargetConfig>();
    const invalid: { target: DeploymentTargetConfig; error: unknown }[] = [];
    for (const target of this.targets.values()) {
      try {
        await this.executor.validateTarget(target);
        validTargets.set(target.id, target);
      } catch (error) {
        invalid.push({ target, error });
      }
    }
    const identities = this.targetIdentities(validTargets.values());
    this.store.failDeploymentConfigDrift(identities, this.clock.now());

    const gate = this.store.getDeploymentMaintenance();
    const sentinel = await this.executor.readMaintenance();
    if (gate?.phase === "releasing") {
      const job = this.store.getDeploymentJob(gate.jobId);
      if (!job) throw new Error("terminal maintenance job missing");
      if (sentinel && !sameMaintenanceIdentity(sentinel, gate)) throw new Error("DB/host release fence disagreement");
      const target = validTargets.get(gate.targetId);
      if (!target) {
        const configured = this.targets.get(gate.targetId);
        const reason = configured
          ? `terminal target runtime validation failed: ${safeTargetError(invalid.find((entry) => entry.target.id === gate.targetId)?.error, configured)}`
          : "terminal target config was removed before host maintenance release";
        return this.snapshot(true, this.store.failDeploymentRelease(gate, reason, this.clock.now()));
      }
      return this.releaseTerminal(target, gate);
    }
    if (sentinel && !gate) throw new Error("host sentinel exists without DB global gate; administrator recovery required");

    const job = this.store.claimDeploymentJob(identities, this.clock.now(), this.leaseMs);
    if (!job) {
      if (invalid.length > 0) throw new Error(`deployment target runtime validation failed: ${safeTargetError(invalid[0]!.error, invalid[0]!.target)}`);
      return this.snapshot(false, null);
    }
    const target = validTargets.get(job.targetId);
    if (!target) throw new Error(`deployment target "${job.targetId}" 未配置`);
    return this.executeClaimed(job, target, false);
  }

  /** 唯一普通 recovery 入口；legacy/无 anchor job 必须走 explicit ack/bootstrap。 */
  async recover(jobId: string, targetId: string): Promise<DeploymentWorkerResult> {
    const target = this.targets.get(targetId);
    if (!target) throw new Error(`deployment target "${targetId}" 未配置`);
    await this.executor.validateTarget(target);
    const job = this.store.claimDeploymentRecovery(
      jobId, target.id, target.fingerprint, target.manifestHash, this.clock.now(), this.leaseMs,
    );
    const gate = this.store.getDeploymentMaintenance();
    if (!gate || gate.jobId !== job.id) throw new Error("recovery global maintenance gate missing");
    // claim 已旋转 epoch；先把新 fence durable 到 host sentinel，旧 worker 此后不能清闸。
    const fence = jobFence(job);
    if (!this.store.renewDeploymentJob(job.id, fence, this.clock.now(), this.leaseMs)) {
      throw new Error("recovery fence 在写 host sentinel 前已失效");
    }
    await this.executor.writeMaintenance(gate);
    if (!this.store.renewDeploymentJob(job.id, fence, this.clock.now(), this.leaseMs)) {
      throw new Error("recovery fence 在写 host sentinel 后已失效");
    }
    return this.executeClaimed(job, target, true);
  }

  private async executeClaimed(job: DeploymentJob, target: DeploymentTargetConfig, recovery: boolean): Promise<DeploymentWorkerResult> {
    const fence = jobFence(job);
    let leaseAlive = true;
    const renewTimer = setInterval(() => {
      try { leaseAlive = this.store.renewDeploymentJob(job.id, fence, this.clock.now(), this.leaseMs); }
      catch { leaseAlive = false; }
    }, Math.max(1_000, Math.floor(this.leaseMs / 3)));
    const hooks = this.hooks(job, fence, () => leaseAlive, () => { leaseAlive = false; });
    let result: DeploymentExecutionResult;
    try {
      result = recovery
        ? await this.executor.recoverOriginalBaseline(job, target, hooks)
        : await this.executor.execute(job, target, hooks);
    } finally {
      clearInterval(renewTimer);
    }
    const now = this.clock.now();
    if (!this.store.renewDeploymentJob(job.id, fence, now, this.leaseMs)) {
      throw new Error("deployment fence 在提交 result 前已失效");
    }
    const persisted = result.gate && result.status !== "succeeded"
      ? this.store.completeRecoveredDeploymentJob(result.gate, fence, {
          status: result.status === "needs_recovery" ? "needs_recovery" : "failed",
          log: result.log, error: result.error, failureKind: result.failureKind,
          rollbackComplete: result.rollbackComplete,
        }, now).job
      : this.store.completeDeploymentJob(job.id, fence, result, now).job;
    const terminalGate = this.store.getDeploymentMaintenance();
    if (terminalGate?.phase === "releasing") return this.releaseTerminal(target, terminalGate);
    return this.snapshot(true, persisted);
  }

  private async releaseTerminal(target: DeploymentTargetConfig, gate: DeploymentMaintenanceGate): Promise<DeploymentWorkerResult> {
    try {
      await this.executor.releaseHostMaintenance(target, gate, {
        assertFence: async () => {
          if (!this.store.assertDeploymentReleaseFence(gate)) throw new Error("terminal release fence 已失效");
        },
      });
      if (await this.executor.readMaintenance()) throw new Error("host sentinel 仍存在，拒绝 release DB gate");
      const released = this.store.releaseDeploymentMaintenance(gate, this.clock.now());
      return this.snapshot(true, released.job);
    } catch (error) {
      const current = this.store.getDeploymentMaintenance();
      const job = current && sameMaintenanceIdentity(current, gate)
        ? this.store.failDeploymentRelease(gate, `maintenance release incomplete: ${safeTargetError(error, target)}`, this.clock.now())
        : this.store.getDeploymentJob(gate.jobId);
      return this.snapshot(true, job);
    }
  }

  private hooks(
    job: DeploymentJob,
    fence: DeploymentFence,
    leaseAlive: () => boolean,
    loseLease: () => void,
  ): DeploymentExecutionHooks {
    const renew = () => {
      if (!leaseAlive()) throw new Error("deployment fence 已失效");
      const now = this.clock.now();
      if (!this.store.renewDeploymentJob(job.id, fence, now, this.leaseMs)) {
        loseLease();
        throw new Error("deployment fence 已失效");
      }
      return now;
    };
    return {
      assertFence: async () => { renew(); },
      checkpoint: async (checkpoint, metadata) => {
        const now = renew();
        if (!this.store.updateDeploymentCheckpoint(job.id, fence, checkpoint, now, metadata)) {
          throw new Error("deployment checkpoint 被陈旧 worker fence 拒绝");
        }
      },
      getMaintenance: async () => this.store.getDeploymentMaintenance(),
      activateMaintenance: async (input) => {
        // build可以与另一target并行，但host cutover只有一个singleton lock。占用期间
        // 保持当前lease并等待，不把一个已完成build的job误报成deployment failed。
        while (true) {
          try {
            return this.store.activateDeploymentMaintenance(job.id, fence, input, renew());
          } catch (error) {
            if (!message(error).includes("另一个 target/job maintenance gate 占用")) throw error;
            await this.clock.sleep(Math.max(100, Math.min(1_000, Math.floor(this.leaseMs / 6))));
            renew();
          }
        }
      },
      updateMaintenance: async (phase, expectedRevision, expectedFingerprint, metadata) => this.store.updateDeploymentMaintenance(
        job.id, fence, phase, expectedRevision, expectedFingerprint, renew(), metadata,
      ),
      restoreMaintenance: async (gate, phase, expectedRevision, expectedFingerprint) => this.store.restoreDeploymentMaintenance(
        gate, fence, phase, expectedRevision, expectedFingerprint, this.clock.now(),
      ),
    };
  }

  private targetIdentities(targets: Iterable<DeploymentTargetConfig> = this.targets.values()) {
    return [...targets].map(({ id, fingerprint, manifestHash }) => ({ id, fingerprint, manifestHash }));
  }

  private async snapshot(worked: boolean, job: DeploymentJob | null): Promise<DeploymentWorkerResult> {
    return {
      worked,
      job: job ? this.store.getDeploymentJob(job.id) : null,
      databaseGate: this.store.getDeploymentMaintenance(),
      sentinel: await this.executor.readMaintenance(),
    };
  }
}

export interface DeploymentJobStore {
  claimDeploymentJob(targets: { id: string; fingerprint: string; manifestHash: string }[], now: number, leaseMs: number): DeploymentJob | null;
  failDeploymentConfigDrift(targets: { id: string; fingerprint: string; manifestHash: string }[], now: number): number;
  claimDeploymentRecovery(id: string, targetId: string, targetFingerprint: string, targetManifestHash: string, now: number, leaseMs: number): DeploymentJob;
  getDeploymentJob(id: string): DeploymentJob | null;
  getDeploymentMaintenance(targetId?: string): DeploymentMaintenanceGate | null;
  assertDeploymentReleaseFence(gate: DeploymentMaintenanceGate): boolean;
  renewDeploymentJob(id: string, fence: DeploymentFence, now: number, leaseMs: number): boolean;
  updateDeploymentCheckpoint(id: string, fence: DeploymentFence, checkpoint: string, now: number, metadata?: { newServicePids?: Record<string, number>; databaseBackupCreated?: boolean; log?: string }): boolean;
  activateDeploymentMaintenance(
    id: string,
    fence: DeploymentFence,
    input: { rollbackAttempt: number; baselineRevision: string; baselineFingerprint: string; baselineManifestHash: string; baselineHealthFingerprint: string },
    now: number,
  ): DeploymentMaintenanceGate;
  updateDeploymentMaintenance(
    id: string,
    fence: DeploymentFence,
    phase: DeploymentMaintenancePhase,
    expectedRevision: string,
    expectedFingerprint: string,
    now: number,
    metadata?: { checkpoint?: string; newServicePids?: Record<string, number>; log?: string },
  ): DeploymentMaintenanceGate;
  restoreDeploymentMaintenance(
    gate: DeploymentMaintenanceGate,
    fence: DeploymentFence,
    phase: DeploymentMaintenancePhase,
    expectedRevision: string,
    expectedFingerprint: string,
    now: number,
  ): DeploymentMaintenanceGate;
  completeDeploymentJob(
    id: string,
    fence: DeploymentFence,
    result: DeploymentExecutionResult,
    now: number,
  ): { job: DeploymentJob; applied: boolean; duplicate: boolean };
  completeRecoveredDeploymentJob(
    gate: DeploymentMaintenanceGate,
    fence: DeploymentFence,
    result: { status: "failed" | "needs_recovery"; log: string; error?: string | null; failureKind?: DeploymentExecutionResult["failureKind"]; rollbackComplete: boolean },
    now: number,
  ): { job: DeploymentJob; applied: boolean; duplicate: boolean };
  releaseDeploymentMaintenance(gate: DeploymentMaintenanceGate, now: number): { job: DeploymentJob; applied: boolean };
  failDeploymentRelease(gate: DeploymentMaintenanceGate, error: string, now: number): DeploymentJob;
}

function jobFence(job: DeploymentJob): DeploymentFence {
  if (!job.leaseToken || !job.fenceEpoch || !job.fenceNonce) throw new Error("deployment job fence missing");
  return { leaseToken: job.leaseToken, fenceEpoch: job.fenceEpoch, fenceNonce: job.fenceNonce };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeTargetError(error: unknown, target: DeploymentTargetConfig): string {
  let sensitive: string[] = [];
  try { sensitive = targetSensitiveValues(target); } catch { /* defensive for injected/test registrations */ }
  return redactStructured(message(error), sensitive).slice(0, 4_000);
}

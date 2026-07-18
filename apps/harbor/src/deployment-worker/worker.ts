import type { DeploymentTargetConfig } from "../config.js";
import type {
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

  async runOnce(): Promise<boolean> {
    for (const target of this.targets.values()) {
      await this.executor.validateTarget(target);
      const sentinel = await this.executor.readMaintenance(target);
      const databaseGate = this.store.getDeploymentMaintenance(target.id);
      if (sentinel && !databaseGate) {
        const terminal = this.store.getDeploymentJob(sentinel.jobId);
        if (terminal && (terminal.status === "succeeded" || (terminal.status === "failed" && terminal.rollbackComplete === true))) {
          await this.executor.releaseTerminalMaintenance(terminal, target, sentinel);
          return true;
        }
      }
    }
    const job = this.store.claimDeploymentJob(
      [...this.targets.values()].map(({ id, fingerprint }) => ({ id, fingerprint })),
      this.clock.now(),
      this.leaseMs,
    );
    if (!job) return false;
    const target = this.targets.get(job.targetId);
    if (!target || !job.leaseToken) throw new Error(`deployment target "${job.targetId}" 未配置或 job lease 缺失`);
    return this.executeClaimed(job, target, false);
  }

  /** 唯一允许把 needs_recovery 变回 failed/retryable 的入口；先实际恢复并验证旧 baseline。 */
  async recover(jobId: string, targetId: string): Promise<boolean> {
    const target = this.targets.get(targetId);
    if (!target) throw new Error(`deployment target "${targetId}" 未配置`);
    await this.executor.validateTarget(target);
    const job = this.store.claimDeploymentRecovery(jobId, target.id, target.fingerprint, this.clock.now(), this.leaseMs);
    if (!job.leaseToken) throw new Error("recovery lease 缺失");
    return this.executeClaimed(job, target, true);
  }

  private async executeClaimed(job: DeploymentJob, target: DeploymentTargetConfig, recovery: boolean): Promise<boolean> {
    const leaseToken = job.leaseToken!;
    let leaseAlive = true;
    const renewTimer = setInterval(() => {
      try {
        leaseAlive = this.store.renewDeploymentJob(job.id, leaseToken, this.clock.now(), this.leaseMs);
      } catch {
        leaseAlive = false;
      }
    }, Math.max(1_000, Math.floor(this.leaseMs / 3)));
    const hooks = this.hooks(job, leaseToken, () => leaseAlive, () => { leaseAlive = false; });
    let result: DeploymentExecutionResult;
    try {
      result = recovery
        ? await this.executor.recoverOriginalBaseline(job, target, hooks)
        : await this.executor.execute(job, target, hooks);
    } finally {
      clearInterval(renewTimer);
    }
    const now = this.clock.now();
    let persisted: DeploymentJob;
    if (result.gate && result.status !== "succeeded") {
      persisted = this.store.completeRecoveredDeploymentJob(result.gate, {
        status: result.status === "needs_recovery" ? "needs_recovery" : "failed",
        log: result.log,
        error: result.error,
        rollbackComplete: result.rollbackComplete,
      }, now).job;
    } else {
      if (!this.store.renewDeploymentJob(job.id, leaseToken, now, this.leaseMs)) {
        throw new Error("deployment lease 在提交 result 前已失效");
      }
      persisted = this.store.completeDeploymentJob(job.id, leaseToken, result, now).job;
    }
    if (result.gate && persisted.status !== "needs_recovery") {
      await this.executor.releaseMaintenance(target, result.gate);
    }
    return true;
  }

  private hooks(
    job: DeploymentJob,
    leaseToken: string,
    leaseAlive: () => boolean,
    loseLease: () => void,
  ): DeploymentExecutionHooks {
    const renew = () => {
      if (!leaseAlive()) throw new Error("deployment lease 已失效");
      const now = this.clock.now();
      if (!this.store.renewDeploymentJob(job.id, leaseToken, now, this.leaseMs)) {
        loseLease();
        throw new Error("deployment lease 已失效");
      }
      return now;
    };
    return {
      checkpoint: async (checkpoint, metadata) => {
        const now = renew();
        if (!this.store.updateDeploymentCheckpoint(job.id, leaseToken, checkpoint, now, metadata)) {
          throw new Error("deployment checkpoint 被陈旧 worker 拒绝");
        }
      },
      getMaintenance: async () => this.store.getDeploymentMaintenance(job.targetId),
      activateMaintenance: async (input) => this.store.activateDeploymentMaintenance(job.id, leaseToken, input, renew()),
      updateMaintenance: async (phase, expectedRevision, metadata) => this.store.updateDeploymentMaintenance(
        job.id,
        leaseToken,
        phase,
        expectedRevision,
        renew(),
        metadata,
      ),
      restoreMaintenance: async (gate, phase, expectedRevision) => this.store.restoreDeploymentMaintenance(
        gate,
        phase,
        expectedRevision,
        this.clock.now(),
      ),
    };
  }
}

export interface DeploymentJobStore {
  claimDeploymentJob(targets: { id: string; fingerprint: string }[], now: number, leaseMs: number): DeploymentJob | null;
  claimDeploymentRecovery(id: string, targetId: string, targetFingerprint: string, now: number, leaseMs: number): DeploymentJob;
  getDeploymentJob(id: string): DeploymentJob | null;
  getDeploymentMaintenance(targetId?: string): DeploymentMaintenanceGate | null;
  renewDeploymentJob(id: string, leaseToken: string, now: number, leaseMs: number): boolean;
  updateDeploymentCheckpoint(id: string, leaseToken: string, checkpoint: string, now: number, metadata?: { newServicePid?: number | null }): boolean;
  activateDeploymentMaintenance(
    id: string,
    leaseToken: string,
    input: { rollbackAttempt: number; baselineRevision: string },
    now: number,
  ): DeploymentMaintenanceGate;
  updateDeploymentMaintenance(
    id: string,
    leaseToken: string,
    phase: DeploymentMaintenancePhase,
    expectedRevision: string,
    now: number,
    metadata?: { checkpoint?: string; newServicePid?: number | null },
  ): DeploymentMaintenanceGate;
  restoreDeploymentMaintenance(
    gate: DeploymentMaintenanceGate,
    phase: DeploymentMaintenancePhase,
    expectedRevision: string,
    now: number,
  ): DeploymentMaintenanceGate;
  completeDeploymentJob(
    id: string,
    leaseToken: string,
    result: { status: "succeeded" | "failed" | "needs_recovery"; log: string; error?: string | null; rollbackComplete: boolean },
    now: number,
  ): { job: DeploymentJob; applied: boolean; duplicate: boolean };
  completeRecoveredDeploymentJob(
    gate: DeploymentMaintenanceGate,
    result: { status: "failed" | "needs_recovery"; log: string; error?: string | null; rollbackComplete: boolean },
    now: number,
  ): { job: DeploymentJob; applied: boolean; duplicate: boolean };
}

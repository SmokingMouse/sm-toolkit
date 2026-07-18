import type { DeploymentTargetConfig } from "../config.js";
import type { DeploymentJob } from "../protocol.js";
import { LocalLaunchdDeploymentExecutor, type DeploymentClock } from "./executor.js";

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
    const job = this.store.claimDeploymentJob([...this.targets.keys()], this.clock.now(), this.leaseMs);
    if (!job) return false;
    const target = this.targets.get(job.targetId);
    if (!target || !job.leaseToken) throw new Error(`deployment target "${job.targetId}" 未配置或 job lease 缺失`);
    const leaseToken = job.leaseToken;
    let leaseAlive = true;
    const renewTimer = setInterval(() => {
      try {
        leaseAlive = this.store.renewDeploymentJob(job.id, leaseToken, this.clock.now(), this.leaseMs);
      } catch {
        leaseAlive = false;
      }
    }, Math.max(1_000, Math.floor(this.leaseMs / 3)));
    let result;
    try {
      result = await this.executor.execute(job, target, {
        checkpoint: async (checkpoint) => {
          if (!leaseAlive) throw new Error("deployment lease 已失效");
          const now = this.clock.now();
          if (!this.store.renewDeploymentJob(job.id, leaseToken, now, this.leaseMs)) {
            leaseAlive = false;
            throw new Error("deployment lease 已失效");
          }
          if (!this.store.updateDeploymentCheckpoint(job.id, leaseToken, checkpoint, now)) {
            throw new Error("deployment checkpoint 被陈旧 worker 拒绝");
          }
        },
      });
    } finally {
      clearInterval(renewTimer);
    }
    const now = this.clock.now();
    this.store.renewDeploymentJob(job.id, leaseToken, now, this.leaseMs);
    this.store.completeDeploymentJob(job.id, leaseToken, result, now);
    return true;
  }
}

export interface DeploymentJobStore {
  claimDeploymentJob(targetIds: string[], now: number, leaseMs: number): DeploymentJob | null;
  renewDeploymentJob(id: string, leaseToken: string, now: number, leaseMs: number): boolean;
  updateDeploymentCheckpoint(id: string, leaseToken: string, checkpoint: string, now: number): boolean;
  completeDeploymentJob(
    id: string,
    leaseToken: string,
    result: { status: "succeeded" | "failed"; log: string; error?: string | null; rollbackComplete: boolean },
    now: number,
  ): { job: DeploymentJob; applied: boolean; duplicate: boolean };
}

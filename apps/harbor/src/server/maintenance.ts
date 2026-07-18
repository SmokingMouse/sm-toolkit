import type { DeploymentTargetConfig } from "../config.js";
import type { DeploymentMaintenanceGate } from "../protocol.js";
import type { DeploymentMaintenanceSentinel } from "../deployment-worker/maintenance.js";
import { sameMaintenanceIdentity } from "../deployment-worker/maintenance.js";
import type { HarborStore } from "./store.js";

export interface MaintenanceSnapshot {
  active: boolean;
  exact: boolean;
  gate: DeploymentMaintenanceGate | null;
  reason: string | null;
  runtimeRevision: string | null;
  runtimeFingerprint: string | null;
}

export interface MaintenanceGuard {
  current(): Promise<MaintenanceSnapshot>;
}

/** DB gate + host 0600 sentinel 任一存在就 fail-closed；只有 identity 一致才开放 revision-aware health。 */
export class DeploymentMaintenanceGuard implements MaintenanceGuard {
  constructor(
    private readonly store: HarborStore,
    private readonly targets: DeploymentTargetConfig[],
    private readonly sentinel: DeploymentMaintenanceSentinel,
    private readonly runtime: { revision: string | null; fingerprint: string | null } = {
      revision: process.env.HARBOR_RELEASE_REVISION?.toLowerCase() ?? null,
      fingerprint: process.env.HARBOR_TARGET_FINGERPRINT ?? null,
    },
  ) {}

  async current(): Promise<MaintenanceSnapshot> {
    const databaseGates = this.store.listDeploymentMaintenance();
    const fileGates: DeploymentMaintenanceGate[] = [];
    for (const target of this.targets) {
      const gate = await this.sentinel.read(target);
      if (gate) fileGates.push(gate);
    }
    if (databaseGates.length === 0 && fileGates.length === 0) return this.snapshot(false, false, null, null);
    if (databaseGates.length > 1 || fileGates.length > 1) {
      return this.snapshot(true, false, databaseGates[0] ?? fileGates[0] ?? null, "multiple maintenance gates");
    }
    const dbGate = databaseGates[0] ?? null;
    const fileGate = fileGates[0] ?? null;
    if (dbGate && fileGate) {
      if (!sameMaintenanceIdentity(dbGate, fileGate)
        || dbGate.phase !== fileGate.phase || dbGate.expectedRevision !== fileGate.expectedRevision) {
        return this.snapshot(true, false, dbGate, "DB/file maintenance identity 或 phase 不一致");
      }
      return this.runtimeSnapshot(dbGate);
    }
    if (dbGate) return this.snapshot(true, false, dbGate, "host maintenance sentinel 缺失");

    // DB finalize 成功、sentinel clear 前崩溃：terminal job + frozen identity 可继续 exact health，只保持写闸。
    const job = this.store.getDeploymentJob(fileGate!.jobId);
    if (job && (job.status === "succeeded" || (job.status === "failed" && job.rollbackComplete === true))
      && job.targetId === fileGate!.targetId && job.generation === fileGate!.generation
      && job.revision === fileGate!.revision && job.targetFingerprint === fileGate!.targetFingerprint) {
      return this.runtimeSnapshot(fileGate!);
    }
    return this.snapshot(true, false, fileGate, "DB maintenance gate 缺失且 job 未 terminal");
  }

  private runtimeSnapshot(gate: DeploymentMaintenanceGate): MaintenanceSnapshot {
    if (this.runtime.revision !== gate.expectedRevision || this.runtime.fingerprint !== gate.targetFingerprint) {
      return this.snapshot(true, false, gate, "runtime revision/fingerprint 与 maintenance expected identity 不一致");
    }
    return this.snapshot(true, true, gate, null);
  }

  private snapshot(active: boolean, exact: boolean, gate: DeploymentMaintenanceGate | null, reason: string | null): MaintenanceSnapshot {
    return {
      active,
      exact,
      gate,
      reason,
      runtimeRevision: this.runtime.revision,
      runtimeFingerprint: this.runtime.fingerprint,
    };
  }
}

export function matchesRevisionAwareHealth(url: URL, snapshot: MaintenanceSnapshot): boolean {
  const gate = snapshot.gate;
  return snapshot.active && snapshot.exact && !!gate
    && url.searchParams.get("deployment_job_id") === gate.jobId
    && url.searchParams.get("revision")?.toLowerCase() === gate.expectedRevision
    && url.searchParams.get("target_fingerprint") === gate.targetFingerprint;
}

export const inactiveMaintenanceGuard: MaintenanceGuard = {
  current: async () => ({
    active: false,
    exact: false,
    gate: null,
    reason: null,
    runtimeRevision: process.env.HARBOR_RELEASE_REVISION?.toLowerCase() ?? null,
    runtimeFingerprint: process.env.HARBOR_TARGET_FINGERPRINT ?? null,
  }),
};

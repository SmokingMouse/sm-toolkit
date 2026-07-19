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
    private readonly sentinel: DeploymentMaintenanceSentinel,
    private readonly runtime: { revision: string | null; fingerprint: string | null } = {
      revision: process.env.HARBOR_RELEASE_REVISION?.toLowerCase() ?? null,
      fingerprint: process.env.HARBOR_TARGET_FINGERPRINT ?? null,
    },
  ) {}

  async current(): Promise<MaintenanceSnapshot> {
    const databaseGates = [
      ...this.store.listLegacyDeploymentMaintenance(),
      ...this.store.listDeploymentMaintenance(),
    ];
    const fileGate = await this.sentinel.read();
    const fileGates = fileGate ? [fileGate] : [];
    if (databaseGates.length === 0 && fileGates.length === 0) return this.snapshot(false, false, null, null);
    if (databaseGates.length > 1 || fileGates.length > 1) {
      return this.snapshot(true, false, databaseGates[0] ?? fileGates[0] ?? null, "multiple maintenance gates");
    }
    const dbGate = databaseGates[0] ?? null;
    const hostGate = fileGates[0] ?? null;
    if (dbGate && hostGate) {
      if (!sameMaintenanceIdentity(dbGate, hostGate)
        || dbGate.phase !== hostGate.phase || dbGate.expectedRevision !== hostGate.expectedRevision
        || dbGate.expectedFingerprint !== hostGate.expectedFingerprint) {
        return this.snapshot(true, false, dbGate, "DB/file maintenance identity 或 phase 不一致");
      }
      return this.runtimeSnapshot(dbGate);
    }
    if (dbGate) return this.snapshot(true, false, dbGate, "host maintenance sentinel 缺失");

    return this.snapshot(true, false, hostGate, "DB maintenance gate 缺失");
  }

  private runtimeSnapshot(gate: DeploymentMaintenanceGate): MaintenanceSnapshot {
    if (this.runtime.revision !== gate.expectedRevision || this.runtime.fingerprint !== gate.expectedFingerprint) {
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
    && url.searchParams.get("target_fingerprint") === gate.expectedFingerprint;
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

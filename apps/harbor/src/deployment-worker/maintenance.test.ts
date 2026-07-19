import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeploymentMaintenanceGate } from "../protocol.js";
import { HostMaintenanceSentinel, sameMaintenanceIdentity } from "./maintenance.js";

const REVISION = "a".repeat(40);
const BASELINE = "b".repeat(40);

function gate(epoch: number, nonce: string, phase: DeploymentMaintenanceGate["phase"] = "deploying"): DeploymentMaintenanceGate {
  return {
    version: 2,
    fenceEpoch: epoch,
    fenceNonce: nonce,
    targetId: "local",
    jobId: "depjob_1",
    deliveryId: "delivery_1",
    generation: 1,
    revision: REVISION,
    targetFingerprint: "c".repeat(64),
    targetManifestHash: "d".repeat(64),
    rollbackAttempt: 1,
    baselineRevision: BASELINE,
    baselineFingerprint: "e".repeat(64),
    baselineManifestHash: "f".repeat(64),
    baselineHealthFingerprint: "1".repeat(64),
    expectedRevision: phase === "rolling_back" ? BASELINE : REVISION,
    expectedFingerprint: phase === "rolling_back" ? "e".repeat(64) : "c".repeat(64),
    phase,
    createdAt: 1,
    updatedAt: epoch,
  };
}

test("immutable per-fence journal prevents stale write/clear and old-fence resurrection", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harbor-fence-journal-")));
  try {
    const path = join(root, "maintenance.json");
    const workerA = new HostMaintenanceSentinel(path);
    const workerB = new HostMaintenanceSentinel(path);
    const a = gate(1, "nonce-a");
    const b = gate(2, "nonce-b", "rolling_back");

    await workerA.write(a);
    const staleRead = await workerA.read();
    expect(staleRead && sameMaintenanceIdentity(staleRead, a)).toBeTrue();
    await workerB.write(b);
    expect((await workerB.read())?.fenceEpoch).toBe(2);

    await expect(workerA.write({ ...a, phase: "healthy", updatedAt: 3 })).rejects.toThrow(/更新|另一个/);
    await expect(workerA.clear(a)).rejects.toThrow("陈旧 epoch");
    expect((await workerB.read())?.fenceNonce).toBe("nonce-b");

    await workerB.clear(b);
    expect(await workerB.read()).toBeNull();
    await expect(workerA.write({ ...a, updatedAt: 4 })).rejects.toThrow("release high-water");
    expect(await workerA.read()).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore boundary rechecks the highest fence while holding the host lock", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harbor-fence-restore-")));
  try {
    const sentinel = new HostMaintenanceSentinel(join(root, "maintenance.json"));
    const epoch2 = gate(2, "nonce-2", "rolling_back");
    const epoch3 = gate(3, "nonce-3", "rolling_back");
    await sentinel.write(epoch2);
    const staleObservation = await sentinel.read(); // B read epoch2 before C reclaims.
    await sentinel.write(epoch3); // C publishes epoch3 under the same cross-process lock.

    let restored = false;
    await expect(sentinel.withLock(async () => {
      const current = await sentinel.read();
      if (!current || !staleObservation || !sameMaintenanceIdentity(current, staleObservation)) {
        throw new Error("restore fence changed before irreversible DB replacement");
      }
      restored = true;
    })).rejects.toThrow("restore fence changed");
    expect(restored).toBeFalse();
    expect((await sentinel.read())?.fenceEpoch).toBe(3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

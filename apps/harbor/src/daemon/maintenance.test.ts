import { expect, test } from "bun:test";
import type { DeploymentMaintenanceGate } from "../protocol.js";
import type { DeploymentMaintenanceSentinel } from "../deployment-worker/maintenance.js";
import { DaemonMaintenanceLatch } from "./maintenance.js";

class FakeSentinel implements DeploymentMaintenanceSentinel {
  readonly path = "/stable/global/maintenance.json";
  gate: DeploymentMaintenanceGate | null = null;
  error: Error | null = null;
  async read() { if (this.error) throw this.error; return this.gate; }
  async write(gate: DeploymentMaintenanceGate) { this.gate = gate; }
  async clear() { this.gate = null; }
}

test("daemon refuses connect/Run while stable host sentinel exists or is unreadable", async () => {
  const sentinel = new FakeSentinel();
  const latch = new DaemonMaintenanceLatch(sentinel);
  expect(latch.isBlocked()).toBeTrue();
  sentinel.gate = { fenceEpoch: 7 } as DeploymentMaintenanceGate;
  expect(await latch.refresh()).toBeTrue();
  expect(latch.blockedReason()).toContain("epoch=7");
  sentinel.gate = null;
  expect(await latch.refresh()).toBeFalse();
  sentinel.error = Object.assign(new Error("EACCES"), { code: "EACCES" });
  expect(await latch.refresh()).toBeTrue();
  expect(latch.blockedReason()).toContain("unreadable");
});

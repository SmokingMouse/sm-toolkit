import type { DeploymentMaintenanceSentinel } from "../deployment-worker/maintenance.js";

/** daemon fail-closed latch：sentinel 存在或不可判定时，不连接、不 hello、不接受 Run。 */
export class DaemonMaintenanceLatch {
  private blocked = true;
  private reason = "maintenance state not checked";

  constructor(private readonly sentinel: DeploymentMaintenanceSentinel) {}

  async refresh(): Promise<boolean> {
    try {
      const gate = await this.sentinel.read();
      this.blocked = gate !== null;
      this.reason = gate ? `deployment maintenance epoch=${gate.fenceEpoch}` : "";
    } catch (error) {
      this.blocked = true;
      this.reason = `maintenance sentinel unreadable: ${error instanceof Error ? error.message : String(error)}`;
    }
    return this.blocked;
  }

  isBlocked(): boolean { return this.blocked; }
  blockedReason(): string { return this.reason; }
}

import { ErrorCode, ProtocolError, type ClientIdentity, type Lease } from "../protocol/index.js";

export class LeaseManager {
  private leases = new Map<string, Lease>();
  constructor(private readonly now: () => number = Date.now) {}
  read(threadId: string): Lease | undefined {
    const lease = this.leases.get(threadId);
    if (lease && lease.expiresAtMs <= this.now()) { this.leases.delete(threadId); return; }
    return lease ? structuredClone(lease) : undefined;
  }
  assertInput(threadId: string, clientId: string): void {
    const lease = this.read(threadId);
    if (lease && lease.holder.clientId !== clientId) throw new ProtocolError(ErrorCode.lease_held, "input lease held", { threadId, holder: lease.holder });
  }
  assertHeld(threadId: string, clientId: string): void {
    this.assertInput(threadId, clientId);
    if (!this.read(threadId)) throw new ProtocolError(ErrorCode.unauthorized, "an active thread lease is required for permission escalation", { threadId, reason: "lease_required" });
  }
  acquire(threadId: string, holder: ClientIdentity, ttlMs = 5 * 60_000): Lease {
    this.assertInput(threadId, holder.clientId);
    const lease = { threadId, holder: structuredClone(holder), expiresAtMs: this.now() + ttlMs };
    this.leases.set(threadId, lease); return structuredClone(lease);
  }
  release(threadId: string, clientId: string): void { this.assertInput(threadId, clientId); this.leases.delete(threadId); }
  disconnect(clientId: string): void { for (const [id, lease] of this.leases) if (lease.holder.clientId === clientId) this.leases.delete(id); }
  clear(threadId: string): void { this.leases.delete(threadId); }
}

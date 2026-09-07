import type { AgentClient } from "@smokingmouse/agent-server/client";
import type { TuiModel } from "./model.js";

/** Serialize lease mutations, not user actions: overlapping actions share one renewed lease. */
export class InputLease {
  private queue: Promise<unknown> = Promise.resolve();
  private active = 0;
  private manual = false;
  private generation = 0;
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly unsubscribe: () => void;
  constructor(private readonly client: AgentClient, private readonly model: TuiModel, readonly ttlMs = 30_000) {
    this.unsubscribe = client.onStateChange(state => {
      if (state !== "connected") { this.generation++; this.active = 0; this.manual = false; this.clearTimer(); this.model.lease = { state: "none" }; this.model.changed(); }
    });
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action); this.queue = result.catch(() => {}); return result;
  }
  private clearTimer(): void { clearTimeout(this.timer); this.timer = undefined; }
  private async acquire(threadId: string): Promise<void> {
    if (this.disposed) throw new Error("租约控制器已关闭");
    try {
      const { lease } = await this.client.request("thread/lease/acquire", { threadId, ttlMs: this.ttlMs });
      this.model.lease = { state: "self", expiresAtMs: lease.expiresAtMs, threadId };
      this.model.leaseWarning = "";
      this.model.changed();
    } catch (error) { this.model.recordError(error); throw error; }
  }
  private renew(threadId: string): void {
    this.clearTimer();
    if ((!this.active && !this.manual) || this.model.lease.state !== "self") return;
    this.timer = setTimeout(() => {
      void this.serialize(async () => {
        if ((!this.active && !this.manual) || this.client.state !== "connected") return;
        try { await this.acquire(threadId); this.renew(threadId); }
        catch { this.manual = false; this.clearTimer(); if (this.model.lease.state === "self") this.model.lease = { state: "none" }; this.model.changed(); }
      });
    }, Math.max(1, Math.min(this.ttlMs / 2, (this.model.lease.expiresAtMs - Date.now()) / 2)));
    this.timer.unref();
  }
  private async release(threadId: string): Promise<void> {
    this.clearTimer();
    if (this.model.lease.state !== "self") return;
    try { await this.client.request("thread/lease/release", { threadId }); this.model.lease = { state: "none" }; this.model.leaseWarning = ""; this.model.changed(); }
    catch (error) { this.model.recordLeaseReleaseError(error); throw error; }
  }
  async run<T>(threadId: string, action: () => Promise<T> | T): Promise<T> {
    const generation = await this.serialize(async () => {
      if (this.client.state !== "connected") throw new Error("连接尚未恢复，输入已保留");
      if (this.model.lease.state !== "self" || this.model.lease.expiresAtMs <= Date.now() || !this.active && !this.manual) await this.acquire(threadId);
      this.active++; this.renew(threadId); return this.generation;
    });
    try { return await action(); }
    finally {
      await this.serialize(async () => {
        if (generation !== this.generation) return;
        this.active--;
        if (!this.active && !this.manual) await this.release(threadId).catch(() => {});
      });
    }
  }
  takeover(threadId: string): Promise<void> {
    return this.serialize(async () => { await this.acquire(threadId); this.manual = true; this.renew(threadId); });
  }
  relinquish(threadId: string): Promise<void> {
    return this.serialize(async () => { this.manual = false; if (!this.active) await this.release(threadId); });
  }
  dispose(): void { this.disposed = true; this.generation++; this.active = 0; this.manual = false; this.clearTimer(); this.unsubscribe(); }
}

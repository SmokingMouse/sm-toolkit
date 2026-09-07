import type { AgentClient } from "@smokingmouse/agent-server/client";
import type { TuiModel } from "./model.js";

interface ThreadLease {
  queue: Promise<unknown>;
  active: number;
  manual: boolean;
  lastActivity: number;
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
}
/** Per-thread mutations are serialized; overlapping actions share a renewed lease. */
export class InputLease {
  private entries = new Map<string, ThreadLease>();
  private selected?: string;
  private disposed = false;
  private readonly unsubscribe: () => void;
  private readonly unobserve: () => void;
  constructor(private readonly client: AgentClient, private readonly model: TuiModel, readonly ttlMs = 30_000) {
    this.selected = model.thread?.id;
    this.unsubscribe = client.onStateChange(state => {
      if (state !== "connected") { this.clear(); this.publishNone(); }
    });
    this.unobserve = model.onChange(() => {
      const next = model.thread?.id;
      if (next === this.selected) return;
      this.selected = next;
      // Invalidate in-flight acquires too; old grants expire without further renewal.
      this.clear(); this.publishNone();
    });
  }
  private clear(): void {
    for (const entry of this.entries.values()) clearTimeout(entry.timer);
    this.entries.clear();
  }
  private publishNone(): void {
    this.model.lease = { state: "none" }; this.model.leaseExpiresAt = 0;
    this.model.leaseWarning = ""; this.model.changed();
  }
  private current(threadId: string, entry: ThreadLease): boolean {
    return !this.disposed && this.entries.get(threadId) === entry;
  }
  private entry(threadId: string): ThreadLease {
    if (this.disposed) throw new Error("租约控制器已关闭");
    if (this.selected && threadId !== this.selected) throw new Error("会话已切换，租约操作取消");
    let entry = this.entries.get(threadId);
    if (!entry) {
      entry = { queue: Promise.resolve(), active: 0, manual: false, lastActivity: Date.now(), expiresAt: 0 };
      this.entries.set(threadId, entry);
    }
    return entry;
  }
  private serialize<T>(entry: ThreadLease, action: () => Promise<T>): Promise<T> {
    const result = entry.queue.then(action); entry.queue = result.catch(() => {}); return result;
  }
  touch(threadId?: string): void {
    if (!threadId) return;
    const entry = this.entries.get(threadId);
    if (entry?.manual && entry.expiresAt > Date.now()) entry.lastActivity = Date.now();
  }
  private async acquire(threadId: string, entry: ThreadLease): Promise<void> {
    if (!this.current(threadId, entry)) throw new Error("会话已切换，租约操作取消");
    try {
      const { lease } = await this.client.request("thread/lease/acquire", { threadId, ttlMs: this.ttlMs });
      if (!this.current(threadId, entry)) throw new Error("会话已切换，租约操作取消");
      entry.expiresAt = lease.expiresAtMs;
      this.model.lease = { state: "self", expiresAtMs: lease.expiresAtMs, threadId };
      this.model.leaseExpiresAt = lease.expiresAtMs; this.model.leaseWarning = "";
      this.model.changed();
    } catch (error) { if (this.current(threadId, entry)) this.model.recordError(error); throw error; }
  }
  private renew(threadId: string, entry: ThreadLease): void {
    clearTimeout(entry.timer);
    if (!this.current(threadId, entry) || (!entry.active && !entry.manual)) return;
    const now = Date.now();
    const active = entry.active > 0 || entry.manual && now - entry.lastActivity < this.ttlMs;
    const delay = active ? Math.min(this.ttlMs / 2, entry.expiresAt - now) : entry.expiresAt - now;
    entry.timer = setTimeout(() => {
      void this.serialize(entry, async () => {
        if (!this.current(threadId, entry) || this.client.state !== "connected") return;
        if (!entry.active && (!entry.manual || Date.now() - entry.lastActivity >= this.ttlMs)) {
          if (entry.expiresAt <= Date.now()) { entry.manual = false; entry.expiresAt = 0; this.publishNone(); }
          else this.renew(threadId, entry);
          return;
        }
        try { await this.acquire(threadId, entry); this.renew(threadId, entry); }
        catch {
          entry.manual = false; clearTimeout(entry.timer);
          if (this.current(threadId, entry)) {
            if (this.model.lease.state === "self") this.model.lease = { state: "none" };
            this.model.changed();
          }
        }
      });
    }, Math.max(1, delay));
    entry.timer.unref();
  }
  private async release(threadId: string, entry: ThreadLease): Promise<void> {
    clearTimeout(entry.timer);
    if (!this.current(threadId, entry) || !entry.expiresAt) return;
    try {
      await this.client.request("thread/lease/release", { threadId });
      entry.expiresAt = 0;
      if (this.current(threadId, entry)) this.publishNone();
    } catch (error) { if (this.current(threadId, entry)) this.model.recordLeaseReleaseError(error); throw error; }
  }
  async run<T>(threadId: string, action: () => Promise<T> | T): Promise<T> {
    const entry = this.entry(threadId);
    await this.serialize(entry, async () => {
      if (this.client.state !== "connected") throw new Error("连接尚未恢复，输入已保留");
      if (!this.current(threadId, entry)) throw new Error("会话已切换，租约操作取消");
      entry.lastActivity = Date.now();
      if (entry.expiresAt <= Date.now() || !entry.active && !entry.manual) await this.acquire(threadId, entry);
      entry.active++; this.renew(threadId, entry);
    });
    try { return await action(); }
    finally {
      await this.serialize(entry, async () => {
        if (!this.current(threadId, entry)) return;
        entry.active--;
        if (!entry.active && !entry.manual) await this.release(threadId, entry).catch(() => {});
        else this.renew(threadId, entry);
      });
    }
  }
  takeover(threadId: string): Promise<void> {
    const entry = this.entry(threadId);
    return this.serialize(entry, async () => { await this.acquire(threadId, entry); entry.manual = true; entry.lastActivity = Date.now(); this.renew(threadId, entry); });
  }
  relinquish(threadId: string): Promise<void> {
    const entry = this.entry(threadId);
    return this.serialize(entry, async () => { entry.manual = false; if (!entry.active) await this.release(threadId, entry); });
  }
  dispose(): void { this.disposed = true; this.clear(); this.unsubscribe(); this.unobserve(); }
}

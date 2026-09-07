import { expect, test } from "bun:test";
import type { AgentClient, ClientState } from "@smokingmouse/agent-server/client";
import { InputLease } from "./lease.js";
import { TuiModel } from "./model.js";
import { errorMessage } from "./errors.js";

const wait = async (predicate: () => boolean) => { const until = Date.now() + 2000; while (!predicate()) { if (Date.now() > until) throw new Error("lease condition timed out"); await Bun.sleep(2); } };
function fixture(ttl?: number) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [], listeners = new Set<(state: ClientState) => void>();
  let failure: Error | undefined;
  const client = {
    state: "connected" as ClientState, clientId: "self",
    onStateChange(fn: (state: ClientState) => void) { listeners.add(fn); return () => listeners.delete(fn); },
    async request(method: string, params: Record<string, unknown>) {
      calls.push({ method, params });
      if (method === "thread/lease/acquire") {
        if (failure) throw failure;
        return { lease: { threadId: "th", holder: { clientId: "self", label: "tui" }, expiresAtMs: Date.now() + Number(params.ttlMs) } };
      }
      return {};
    },
  };
  const model = new TuiModel(), lease = new InputLease(client as unknown as AgentClient, model, ttl);
  return { model, lease, calls, fail(error: Error) { failure = error; }, disconnect() { client.state = "disconnected"; for (const fn of listeners) fn(client.state); } };
}
test("P1-3: short transactions explicitly use 30s TTL and release even on action failure", async () => {
  const f = fixture();
  try {
    await expect(f.lease.run("th", async () => { throw new Error("failed action"); })).rejects.toThrow("failed action");
    expect(f.calls.map(c => c.method)).toEqual(["thread/lease/acquire", "thread/lease/release"]);
    expect(f.calls[0].params.ttlMs).toBe(30_000); expect(f.model.leaseLabel).toBe("未持有");
  } finally { f.lease.dispose(); }
});
test("fix2 P2-1: cleanup failure cannot replace either an action value or its error", async () => {
  const model = new TuiModel();
  const client = { state: "connected", onStateChange: () => () => {}, async request(method: string) {
    if (method.endsWith("release")) throw new Error("cleanup failed");
    return { lease: { expiresAtMs: Date.now() + 30_000 } };
  } } as unknown as AgentClient;
  const lease = new InputLease(client, model);
  try {
    expect(await lease.run("th", () => "delivered")).toBe("delivered");
    await expect(lease.run("th", () => { throw new Error("action failed"); })).rejects.toThrow("action failed");
    expect(model.leaseWarning).toContain("cleanup failed"); expect(model.leaseLabel).toBe("释放未确认（未续期）");
  } finally { lease.dispose(); }
});
test("P1-3: overlapping long actions share renewals and release only after the last action", async () => {
  const f = fixture(80); let entered = 0, finishA!: () => void, finishB!: () => void;
  try {
    const a = f.lease.run("th", () => { entered++; return new Promise<void>(resolve => { finishA = resolve; }); });
    const b = f.lease.run("th", () => { entered++; return new Promise<void>(resolve => { finishB = resolve; }); });
    await wait(() => entered === 2); expect(f.calls).toHaveLength(1); expect(f.model.leaseLabel).toContain("持有");
    finishA(); await a; expect(f.calls.some(c => c.method.endsWith("release"))).toBe(false);
    await wait(() => f.calls.filter(c => c.method.endsWith("acquire")).length >= 4);
    expect(f.model.lease.state).toBe("self");
    finishB(); await b;
    expect(f.calls.filter(c => c.method.endsWith("release"))).toHaveLength(1); expect(f.model.leaseLabel).toBe("未持有");
  } finally { finishA?.(); finishB?.(); f.lease.dispose(); }
});
test("P1-3: manual takeover renews, release defers for active work, disconnect cancels renewal", async () => {
  const f = fixture(80); let finish!: () => void;
  try {
    await f.lease.takeover("th"); await wait(() => f.calls.length >= 2);
    const work = f.lease.run("th", () => new Promise<void>(resolve => { finish = resolve; }));
    await wait(() => !!finish); await f.lease.relinquish("th");
    expect(f.calls.some(c => c.method.endsWith("release"))).toBe(false);
    finish(); await work; expect(f.model.leaseLabel).toBe("未持有");
    await f.lease.takeover("th"); f.disconnect();
    const count = f.calls.length; await Bun.sleep(100); expect(f.calls).toHaveLength(count); expect(f.model.leaseLabel).toBe("未持有");
  } finally { finish?.(); f.lease.dispose(); }
});
test("P1-3/P2-1: renewal refusal shows other holder and stops; resolved is never a lease error", async () => {
  const f = fixture(80);
  try {
    await f.lease.takeover("th");
    f.fail(Object.assign(new Error("input lease held"), { code: -32012, data: { holder: { clientId: "phone", label: "Phone" } } }));
    await wait(() => f.model.lease.state === "other"); expect(f.model.leaseLabel).toContain("Phone");
    const count = f.calls.length; await Bun.sleep(100); expect(f.calls).toHaveLength(count);
    expect(errorMessage(Object.assign(new Error("already resolved"), { code: -32014 }))).toBe("该请求已由其他客户端处理");
    expect(errorMessage(Object.assign(new Error("owned lease required"), { code: -32005 }))).toBe("未获授权：owned lease required");
  } finally { f.lease.dispose(); }
});

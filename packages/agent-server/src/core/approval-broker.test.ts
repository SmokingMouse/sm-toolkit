import { afterEach, describe, expect, test } from "bun:test";
import { ApprovalBroker, ItemLog, LeaseManager, type ApprovalClient } from "./index.js";
import type { PendingServerRequest, ServerNotification, ServerRequestResult } from "../protocol/index.js";
import { expectCode } from "../test-helpers.test.js";

const disposals: Array<() => void> = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });
function fixture(options: { orphanTimeoutMs?: number; timeoutMs?: number } = {}) {
  let now = 100;
  const log = new ItemLog();
  log.insertThread({ id: "th", backend: "claude", cwd: "/tmp", engineThreadId: "sid", status: { type: "running" }, createdAtMs: 1 }, {});
  log.insertTurn({ id: "tn", threadId: "th", ordinal: 1, status: "inProgress", enqueuedAtMs: 1 }, {}, ""); log.dequeue("tn");
  log.startItem("th", "tn", { id: "it", type: "commandExecution", payload: { command: "pwd", cwd: "/tmp" } });
  const clients: ApprovalClient[] = [], requests: Array<{ clientId: string; request: PendingServerRequest }> = [], decisions: ServerRequestResult[] = [], notifications: ServerNotification[] = [];
  const leases = new LeaseManager(() => now);
  const broker = new ApprovalBroker(log, () => clients, leases, { ...options, now: () => now });
  log.subscribe("th", notification => notifications.push(notification));
  const request: PendingServerRequest = { method: "item/commandExecution/requestApproval", params: { threadId: "th", turnId: "tn", itemId: "it", requestId: "ar", startedAtMs: now, command: "pwd", cwd: "/tmp" } };
  const addClient = (id: string, capable = true, attached = true) => { const client: ApprovalClient = { clientId: id, label: id, attached: new Set(attached ? ["th"] : []), serverRequests: new Set(capable ? [request.method, "item/tool/requestUserInput", "item/permissions/requestApproval"] : []), sendRequest: request => requests.push({ clientId: id, request }) }; clients.push(client); return client; };
  const start = (r = request) => broker.create(r, result => { decisions.push(result); });
  disposals.push(() => { broker.close(); log.close(); });
  return { log, broker, leases, clients, requests, decisions, notifications, request, addClient, start, advance: (ms: number) => { now += ms; broker.sweep(); } };
}
describe("ApprovalBroker", () => {
  test("one row, capable attached audience, first answer wins and others withdraw", () => {
    const f = fixture(); f.addClient("web"); f.addClient("phone"); f.addClient("display", false); f.addClient("detached", true, false); f.start();
    expect(f.requests.map(r => r.clientId)).toEqual(["web", "phone"]); expect(f.log.pendingRequests("th")).toHaveLength(1);
    f.broker.answer("ar", "phone", { decision: "accept" });
    expect(f.decisions).toEqual([{ decision: "accept" }]); expect(f.log.approval("ar")?.status).toBe("decided"); expect(f.log.pendingRequests("th")).toEqual([]);
    expect(f.notifications.at(-1)).toMatchObject({ method: "serverRequest/resolved", params: { decidedBy: { clientId: "phone", label: "phone" }, outcome: "accept" } });
    expectCode(() => f.broker.answer("ar", "web", { decision: "reject" }), -32014); expectCode(() => f.broker.answer("ar", "phone", { decision: "accept" }), -32014); expect(f.decisions).toHaveLength(1);
  });
  test("invalid answer, detached client and lease loser cannot consume a request", () => {
    const f = fixture(); f.addClient("a"); f.addClient("b"); f.addClient("detached", true, false); f.start();
    expect(() => f.broker.answer("ar", "a", { decision: "invalid" })).toThrow();
    expectCode(() => f.broker.answer("ar", "detached", { decision: "accept" }), -32005);
    f.leases.acquire("th", { clientId: "b", label: "b" }); expectCode(() => f.broker.answer("ar", "a", { decision: "accept" }), -32012);
    expect(f.log.approval("ar")?.status).toBe("pending"); f.broker.answer("ar", "b", { decision: "reject" }); expect(f.decisions).toHaveLength(1);
  });
  test("K2: non-blocking default timeout rejects after 120 seconds", () => {
    const f = fixture(); f.addClient("a"); f.start(); f.advance(119_999); expect(f.decisions).toHaveLength(0); f.advance(1);
    expect(f.decisions).toEqual([{ decision: "reject" }]); expect(f.notifications.at(-1)).toMatchObject({ method: "serverRequest/expired", params: { reason: "timeout" } });
  });
  test("orphan default waits 30 minutes, then rejects", () => {
    const f = fixture(); f.start(); f.advance(120_001); expect(f.decisions).toHaveLength(0); f.advance(30 * 60_000 - 120_002); expect(f.decisions).toHaveLength(0); f.advance(1);
    expect(f.decisions).toEqual([{ decision: "reject" }]); expect(f.notifications.at(-1)).toMatchObject({ params: { reason: "orphan_timeout" } });
  });
  test("reattach receives pending card and switches orphan timer to normal timeout", () => {
    const f = fixture({ orphanTimeoutMs: 1000, timeoutMs: 20 }); f.start(); f.advance(900); const a = f.addClient("a"); f.broker.clientAttached(a, "th");
    expect(f.requests).toHaveLength(1); expect(f.log.snapshot("th").pendingRequests).toHaveLength(1); f.advance(19); expect(f.decisions).toHaveLength(0); f.advance(1); expect(f.decisions).toHaveLength(1);
  });
  test("K3: ten minutes offline preserves the card; reattach resets the normal 120s deadline", () => {
    const f = fixture(); f.start(); f.advance(10 * 60_000);
    expect(f.decisions).toEqual([]); expect(f.log.snapshot("th").pendingRequests.map(r => r.params.requestId)).toEqual(["ar"]);
    const c = f.addClient("phone"); f.broker.clientAttached(c, "th");
    expect(f.requests).toHaveLength(1);
    f.advance(119_999); expect(f.decisions).toEqual([]);
    f.advance(1); expect(f.decisions).toEqual([{ decision: "reject" }]);
    expect(f.log.snapshot("th").pendingRequests).toEqual([]);
  });
  test("disconnect starts orphan timeout instead of rejecting immediately", () => {
    const f = fixture({ orphanTimeoutMs: 1000, timeoutMs: 20 }); f.addClient("a"); f.start(); f.advance(10); f.clients.splice(0); f.broker.audienceChanged();
    f.advance(999); expect(f.decisions).toHaveLength(0); f.advance(1); expect(f.decisions).toHaveLength(1);
  });
  test("blocking question has no present-client timeout, orphan returns empty answers", () => {
    const f = fixture({ orphanTimeoutMs: 100 }); f.addClient("a"); f.start({ method: "item/tool/requestUserInput", params: { requestId: "ar", threadId: "th", turnId: "tn", itemId: "it", questions: [{ id: "q", question: "Which?" }], isBlocking: true } });
    f.advance(1_000_000); expect(f.decisions).toHaveLength(0); f.clients.splice(0); f.broker.audienceChanged(); f.advance(100); expect(f.decisions).toEqual([{ answers: {} }]);
  });
  test("question IDs are validated before arbitration", () => {
    const f = fixture(); f.addClient("a"); f.start({ method: "item/tool/requestUserInput", params: { requestId: "ar", threadId: "th", turnId: "tn", itemId: "it", questions: [{ id: "q", question: "Which?" }], isBlocking: true } });
    expectCode(() => f.broker.answer("ar", "a", { answers: { unknown: { answers: ["x"] } } }), -32602); expect(f.log.approval("ar")?.status).toBe("pending");
  });
  test("permissions default grants nothing and engine death expires pending rows", () => {
    const f = fixture(); f.start({ method: "item/permissions/requestApproval", params: { requestId: "ar", threadId: "th", turnId: "tn", itemId: "it", cwd: "/tmp", permissions: { tool: "Read" }, startedAtMs: 1 } });
    f.broker.expireThread("th", "engine_gone"); expect(f.decisions).toEqual([{ permissions: {}, scope: "turn" }]); expect(f.log.approval("ar")?.status).toBe("expired");
  });
  test("new broker expires pending rows left by the old process", () => {
    const f = fixture(); f.start(); const second = new ApprovalBroker(f.log, () => []); expect(f.log.approval("ar")?.status).toBe("expired"); second.close();
  });
});

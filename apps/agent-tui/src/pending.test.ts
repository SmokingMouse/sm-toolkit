import { expect, test } from "bun:test";
import { TuiModel } from "./model.js";
import { render, renderCard } from "./render.js";
import { pendingRequestState, type PendingServerRequest } from "@smokingmouse/agent-server/protocol";

const request: PendingServerRequest = { method: "item/commandExecution/requestApproval", params: { threadId: "thread", turnId: "turn", itemId: "item", requestId: "request", command: "pwd", cwd: "/tmp", startedAtMs: 1 } };
test("P2-1 requests without local cards neither count nor replace the current status on termination", () => {
  for (const status of ["resolved", "expired"] as const) {
    const model = new TuiModel(); model.connection = "connected";
    model.message = "已排队 #1";
    const state = pendingRequestState(request, 1);
    model.notification({ jsonrpc: "2.0", method: "thread/pendingRequests", params: state });
    expect(model.cards.size).toBe(0); expect(model.pendingCount).toBe(0);
    expect(render(model, 160, 24)).toContain("待处理 0");
    model.notification({ jsonrpc: "2.0", method: "thread/pendingRequests", params: { ...state, status, decidedBy: { clientId: "phone", label: "手机" }, reason: "timeout" } });
    expect(model.message).toBe("已排队 #1"); expect(model.pendingCount).toBe(0);
    model.request(request);
    expect(model.pendingCount).toBe(1);
  }
});
test("pending notification resolves card and count without legacy notifications, label falls back to clientId", () => {
  for (const label of ["phone", ""]) {
    const model = new TuiModel(); model.request(request);
    const state = pendingRequestState(request, 1);
    model.notification({ jsonrpc: "2.0", method: "thread/pendingRequests", params: state });
    expect(model.pendingCount).toBe(1);
    model.notification({ jsonrpc: "2.0", method: "thread/pendingRequests", params: { ...state, status: "resolved", decidedBy: { clientId: "client-phone", label } } });
    expect(model.pendingCount).toBe(0); expect(model.activeCard).toBeUndefined();
    expect(renderCard(model.cards.get("request")!).join("\n")).toBe(`[request] 已由 ${label || "client-phone"} 处理`);
  }
});
test("pending timeout and withdrawal have notices; reconnect snapshot rebuilds pending count", () => {
  const model = new TuiModel();
  for (const reason of ["timeout", "turn_interrupted"]) {
    model.request(request);
    model.notification({ jsonrpc: "2.0", method: "thread/pendingRequests", params: { ...pendingRequestState(request, 1), status: "expired", reason } });
    expect(model.pendingCount).toBe(0); expect(model.activeCard).toBeUndefined();
    expect(model.message).toContain(reason === "timeout" ? "请求超时" : "请求已撤回");
  }
  const snapshot = { thread: { id: "thread", backend: "claude" as const, cwd: "/tmp", engineThreadId: null, createdAtMs: 1, status: { type: "idle" as const } }, items: [], queue: [], pendingRequests: [{ ...request, state: pendingRequestState(request, 1) }], nextSeq: 1 };
  model.snapshot(snapshot); expect(model.pendingCount).toBe(1); expect(model.activeCard).toBeDefined();
  model.snapshot({ ...snapshot, pendingRequests: [] }); expect(model.pendingCount).toBe(0); expect(model.activeCard).toBeUndefined();
});

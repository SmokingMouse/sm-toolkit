import { describe, expect, test } from "bun:test";
import { openDb } from "./db.js";
import { HarborStore } from "./store.js";
import { RunBus } from "./bus.js";
import { buildRest } from "./rest.js";
import type { DeviceHub } from "./ws.js";
import type { RunCoordinator } from "./scheduler.js";
import type { ApprovalService } from "./approvals.js";
import type { AutomationService } from "./automation.js";

function harness() {
  const store = new HarborStore(openDb(":memory:"));
  const online = new Set<string>();
  const hub = {
    onlineIds: () => online,
    isOnline: (id: string) => online.has(id),
  } as unknown as DeviceHub;
  const app = buildRest(
    store,
    new RunBus(),
    hub,
    {} as RunCoordinator,
    {} as ApprovalService,
    {} as AutomationService,
    "test-token",
  );
  const request = (path: string, init?: RequestInit) =>
    app.request(path, {
      ...init,
      headers: {
        Authorization: "Bearer test-token",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  return { store, request };
}

describe("provider capability validation", () => {
  test("rejects missing provider and infers the only installed provider", async () => {
    const { store, request } = harness();
    store.upsertDevice("codex-box", "hash", { clis: { codex: "1.2.3" }, endpoints: [] }, 1);

    const rejected = await request("/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "bad", device: "codex-box", backend: "claude", workdir: "/repo" }),
    });
    expect(rejected.status).toBe(400);
    expect(((await rejected.json()) as { error: string }).error).toContain("可用 provider：codex");

    const created = await request("/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "good", device: "codex-box", model: "gpt-custom", workdir: "/repo" }),
    });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { backend: string; model: string }).backend).toBe("codex");
  });

  test("rejects dynamic approval for codex", async () => {
    const { store, request } = harness();
    store.upsertDevice("codex-box", "hash", { clis: { codex: "1.2.3" }, endpoints: [] }, 1);
    const res = await request("/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "needs-approval",
        device: "codex-box",
        backend: "codex",
        permission: "default",
        workdir: "/repo",
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("不支持 Harbor 动态审批");
  });
});

describe("prompt wrapper settings API", () => {
  test("reads defaults, validates updates, and resets", async () => {
    const { request } = harness();
    const initial = await request("/api/settings/prompt-wrappers");
    const initialBody = (await initial.json()) as { wrappers: { source: string; isDefault: boolean }[] };
    expect(initialBody.wrappers).toHaveLength(3);
    expect(initialBody.wrappers.every((w) => w.isDefault)).toBe(true);

    const invalid = await request("/api/settings/prompt-wrappers", {
      method: "PATCH",
      body: JSON.stringify({ source: "chat", enabled: true, template: "{{unknown}} {{prompt}}" }),
    });
    expect(invalid.status).toBe(400);

    const saved = await request("/api/settings/prompt-wrappers", {
      method: "PATCH",
      body: JSON.stringify({ source: "chat", enabled: false, template: "Request: {{prompt}}" }),
    });
    const savedBody = (await saved.json()) as { enabled: boolean; isDefault: boolean };
    expect(savedBody).toEqual(expect.objectContaining({ enabled: false, isDefault: false }));

    const reset = await request("/api/settings/prompt-wrappers/chat", { method: "DELETE" });
    expect(((await reset.json()) as { isDefault: boolean }).isDefault).toBe(true);
  });
});

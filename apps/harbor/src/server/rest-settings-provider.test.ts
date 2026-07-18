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

  test("accepts only ready sm-toolkit model routes", async () => {
    const { store, request } = harness();
    store.upsertDevice("claude-box", "hash", {
      clis: { claude: "2.1.0" },
      endpoints: ["k3", "kimi:k3", "proxy:missing-key"],
      modelRoutes: [
        { id: "kimi:k3", provider: "kimi", model: "k3", runtime: "claude", kind: "anthropic", ready: true },
        { id: "proxy:missing-key", provider: "proxy", model: "missing-key", runtime: "claude", kind: "anthropic", ready: false },
      ],
    }, 1);

    const rejected = await request("/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "bad-route", device: "claude-box", backend: "claude", model: "proxy:missing-key", workdir: "/repo" }),
    });
    expect(rejected.status).toBe(400);
    expect(((await rejected.json()) as { error: string }).error).toContain("kimi:k3");

    const created = await request("/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "good-route", device: "claude-box", backend: "claude", model: "kimi:k3", workdir: "/repo" }),
    });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { model: string }).model).toBe("kimi:k3");
  });
});

describe("prompt block settings API", () => {
  test("reads defaults, validates updates, and resets", async () => {
    const { request } = harness();
    const initial = await request("/api/settings/prompt-blocks");
    const initialBody = (await initial.json()) as { blocks: { key: string; isDefault: boolean }[] };
    expect(initialBody.blocks).toHaveLength(9);
    expect(initialBody.blocks.every((block) => block.isDefault)).toBe(true);

    const invalid = await request("/api/settings/prompt-blocks", {
      method: "PATCH",
      body: JSON.stringify({ key: "event.chat.message_created", enabled: true, template: "{{unknown}} {{prompt}}" }),
    });
    expect(invalid.status).toBe(400);

    const saved = await request("/api/settings/prompt-blocks", {
      method: "PATCH",
      body: JSON.stringify({ key: "event.chat.message_created", enabled: false, template: "Request: {{prompt}}" }),
    });
    const savedBody = (await saved.json()) as { enabled: boolean; isDefault: boolean };
    expect(savedBody).toEqual(expect.objectContaining({ enabled: false, isDefault: false }));

    const reset = await request("/api/settings/prompt-blocks/event.chat.message_created", { method: "DELETE" });
    expect(((await reset.json()) as { isDefault: boolean }).isDefault).toBe(true);
  });
});

describe("workspace skills API", () => {
  test("creates and imports skills, binds them to agents, and unbinds archived skills", async () => {
    const { store, request } = harness();
    const device = store.upsertDevice("worker", "hash", {
      clis: { claude: "2.1.0" },
      endpoints: [],
      installedSkills: [{
        name: "local-review",
        description: "Review from the local runtime",
        path: "/skills/local-review",
        runtimes: ["claude"],
        instruction: "Always inspect the diff and tests.",
      }],
    }, 1);

    const manualRes = await request("/api/skills", {
      method: "POST",
      body: JSON.stringify({ name: "release-notes", description: "Write concise release notes", instruction: "Summarize user-visible changes." }),
    });
    expect(manualRes.status).toBe(201);
    const manual = (await manualRes.json()) as { id: string };

    const importRes = await request("/api/skills/import", {
      method: "POST",
      body: JSON.stringify({ device: device.id, paths: ["/skills/local-review"] }),
    });
    expect(importRes.status).toBe(200);
    const imported = (await importRes.json()) as { imported: { id: string; source: string }[] };
    expect(imported.imported[0]?.source).toBe("runtime");

    const agentRes = await request("/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "builder",
        device: device.id,
        backend: "claude",
        workdir: "/repo",
        skills: [manual.id, imported.imported[0]!.id],
      }),
    });
    expect(agentRes.status).toBe(201);
    const agent = (await agentRes.json()) as { id: string; skillIds: string[] };
    expect(agent.skillIds).toEqual([manual.id, imported.imported[0]!.id]);

    const other = store.upsertDevice("other", "hash", { clis: { claude: "2.1.0" }, endpoints: [] }, 2);
    const incompatible = await request("/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "other-builder", device: other.id, backend: "claude", workdir: "/repo", skills: [imported.imported[0]!.id] }),
    });
    expect(incompatible.status).toBe(400);
    expect(((await incompatible.json()) as { error: string }).error).toContain("来源设备");

    const archived = await request(`/api/skills/${manual.id}`, {
      method: "PATCH",
      body: JSON.stringify({ archived: true }),
    });
    expect(archived.status).toBe(200);
    expect(store.getAgent(agent.id)?.skillIds).toEqual([imported.imported[0]!.id]);
  });
});

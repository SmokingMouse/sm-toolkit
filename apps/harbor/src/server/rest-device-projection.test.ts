import { describe, expect, test } from "bun:test";
import type { ApprovalService } from "./approvals.js";
import type { AutomationService } from "./automation.js";
import { RunBus } from "./bus.js";
import { openDb } from "./db.js";
import { buildRest } from "./rest.js";
import type { RunCoordinator } from "./scheduler.js";
import { HarborStore } from "./store.js";
import type { DeviceHub } from "./ws.js";

function harness() {
  const db = openDb(":memory:");
  const store = new HarborStore(db);
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
  const request = (path: string, init?: RequestInit) => app.request(path, {
    ...init,
    headers: {
      Authorization: "Bearer test-token",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  return { db, store, request };
}

describe("Device REST projection", () => {
  test("keeps full runtime Skill bundles server-side but omits all text bodies from device lists", async () => {
    const { store, request } = harness();
    const body = "private runtime Skill body ".repeat(8_000);
    const device = store.upsertDevice("worker", "hash", {
      clis: { claude: "2.1.0" },
      endpoints: ["claude-sonnet-4-5"],
      installedSkills: [{
        name: "runtime-review",
        description: "Review a change",
        path: "/skills/runtime-review",
        runtimes: ["claude"],
        instruction: body,
        files: [{ path: "references/policy.md", content: body }],
        dependencies: [{ name: "git", spec: null, required: true }],
      }],
    }, 1);

    const response = await request("/api/devices");
    expect(response.status).toBe(200);
    const raw = await response.text();
    const listed = JSON.parse(raw) as Array<{
      capabilities: { installedSkills?: Array<Record<string, unknown>> };
    }>;
    const skill = listed[0]?.capabilities.installedSkills?.[0];

    expect(skill).toEqual({
      name: "runtime-review",
      description: "Review a change",
      path: "/skills/runtime-review",
      runtimes: ["claude"],
      dependencies: [{ name: "git", spec: null, required: true }],
      fileCount: 1,
    });
    expect(raw).not.toContain("private runtime Skill body");
    expect(raw.length).toBeLessThan(2_000);
    expect(store.getDevice(device.id, true)?.capabilities.installedSkills?.[0]?.files?.[0]?.content).toBe(body);
  });

  test("repository views resolve Device names without hydrating capability bundles", async () => {
    const { store, request } = harness();
    const device = store.upsertDevice("worker", "hash", {
      clis: { claude: "2.1.0" },
      endpoints: [],
      installedSkills: [{
        name: "large",
        description: "Large bundle",
        path: "/skills/large",
        runtimes: ["claude"],
        instruction: "body".repeat(50_000),
        files: [{ path: "body.md", content: "body".repeat(50_000) }],
      }],
    }, 1);
    const repository = store.createRepository({ workspaceId: "ws_personal", name: "app" }, 2);
    store.setRepositoryMount(repository.id, device.id, "/code/app", 3);
    store.getDevice = () => {
      throw new Error("repository list hydrated full Device capabilities");
    };

    const response = await request("/api/repositories");
    expect(response.status).toBe(200);
    const repositories = await response.json() as Array<{ mounts: Array<{ deviceName: string }> }>;
    expect(repositories[0]?.mounts[0]?.deviceName).toBe("worker");
  });

  test("serves the persisted list projection without parsing the full capability snapshot", async () => {
    const { db, store, request } = harness();
    const device = store.upsertDevice("worker", "hash", {
      clis: { claude: "2.1.0" },
      endpoints: [],
      installedSkills: [{
        name: "runtime-review",
        description: "Review a change",
        path: "/skills/runtime-review",
        runtimes: ["claude"],
        instruction: "large body".repeat(50_000),
      }],
    }, 1);
    // Summary 是独立持久化读模型；list path 不应接触完整 snapshot blob。
    db.run("UPDATE devices SET capabilities = 'invalid-full-snapshot' WHERE id = ?", [device.id]);

    const response = await request("/api/devices");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      expect.objectContaining({
        id: device.id,
        capabilities: expect.objectContaining({
          installedSkills: [expect.objectContaining({ name: "runtime-review", fileCount: 1 })],
        }),
      }),
    ]);
  });
});

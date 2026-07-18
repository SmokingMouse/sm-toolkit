import { describe, expect, test } from "bun:test";
import { DEFAULT_WORKSPACE_ID } from "../protocol.js";
import { RunBus } from "./bus.js";
import {
  ensureBuiltinHarborSkill,
  ensureBuiltinSkills,
  HARBOR_BUILTIN_SKILL_NAME,
} from "./builtin-skills.js";
import { openDb } from "./db.js";
import { buildRest } from "./rest.js";
import { HarborStore } from "./store.js";
import type { ApprovalService } from "./approvals.js";
import type { AutomationService } from "./automation.js";
import type { RunCoordinator } from "./scheduler.js";
import type { DeviceHub } from "./ws.js";

function harness() {
  const store = new HarborStore(openDb(":memory:"));
  const hub = {
    onlineIds: () => new Set<string>(),
    isOnline: () => false,
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
      },
    });
  return { store, request };
}

describe("built-in Harbor Skill", () => {
  test("materializes one versioned Device-independent bundle per Workspace", () => {
    const store = new HarborStore(openDb(":memory:"));
    const device = store.upsertDevice(
      "worker",
      "hash",
      { clis: { codex: "1.0" }, endpoints: [] },
      1,
    );
    const agent = store.createAgent(
      {
        name: "builder",
        deviceId: device.id,
        backend: "codex",
        workdir: "/repo",
      },
      2,
    );

    ensureBuiltinSkills(store, 100);
    const skill = store.getSkillByName(
      HARBOR_BUILTIN_SKILL_NAME,
      DEFAULT_WORKSPACE_ID,
    );

    expect(skill).toEqual(
      expect.objectContaining({
        name: "harbor",
        source: "builtin",
        deviceId: null,
        runtimes: ["claude", "codex"],
        createdAt: 100,
        updatedAt: 100,
      }),
    );
    expect(skill?.files.map((file) => file.path)).toEqual(["SKILL.md"]);
    expect(skill?.instruction).toContain("HARBOR_AGENT_ISSUE_URL");
    expect(skill?.instruction).toContain("HARBOR_AGENT_DELIVERY_URL");
    expect(skill?.instruction).toContain("HARBOR_AGENT_REVIEW_URL");
    expect(skill?.instruction).toContain("Never mutate the current Issue status");
    expect(store.getAgent(agent.id)?.skillIds).toEqual([skill!.id]);

    ensureBuiltinSkills(store, 200);
    expect(store.getSkillByName("harbor", DEFAULT_WORKSPACE_ID)).toEqual(
      expect.objectContaining({ id: skill?.id, updatedAt: 100 }),
    );
  });

  test("fails loudly instead of overwriting a user Skill with the reserved name", () => {
    const store = new HarborStore(openDb(":memory:"));
    store.createSkill(
      {
        name: "harbor",
        source: "manual",
        instruction: "User-owned instruction",
      },
      1,
    );

    expect(() => ensureBuiltinHarborSkill(store, DEFAULT_WORKSPACE_ID, 2)).toThrow(
      "该名称由 Harbor 保留",
    );
    expect(store.getSkillByName("harbor")?.instruction).toBe(
      "User-owned instruction",
    );
  });

  test("seeds future Workspaces and rejects API mutation of the managed bundle", async () => {
    const { store, request } = harness();
    ensureBuiltinSkills(store, 1);
    const builtin = store.getSkillByName("harbor", DEFAULT_WORKSPACE_ID)!;
    const device = store.upsertDevice(
      "worker",
      "hash",
      { clis: { codex: "1.0" }, endpoints: [] },
      2,
    );

    const agentResponse = await request("/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "developer",
        device: device.id,
        backend: "codex",
        workdir: "/repo",
        skills: [],
      }),
    });
    expect(agentResponse.status).toBe(201);
    expect(
      ((await agentResponse.json()) as { skillIds: string[] }).skillIds,
    ).toEqual([builtin.id]);

    const mutation = await request(`/api/skills/${builtin.id}`, {
      method: "PATCH",
      body: JSON.stringify({ instruction: "Replace control plane" }),
    });
    expect(mutation.status).toBe(400);
    expect(((await mutation.json()) as { error: string }).error).toContain(
      "由 Harbor 版本管理",
    );

    const created = await request("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "Builders", slug: "builders" }),
    });
    expect(created.status).toBe(201);
    const workspace = (await created.json()) as { id: string };
    expect(store.getSkillByName("harbor", workspace.id)).toEqual(
      expect.objectContaining({ source: "builtin", workspaceId: workspace.id }),
    );
  });
});

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LATEST_SCHEMA_VERSION,
  openDb,
  openV27MigrationFixtureDb,
} from "./db.js";
import { HarborStore } from "./store.js";

test("v28 adds fail-closed Agent sandbox network capability without changing existing Agents", () => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-agent-network-v28-"));
  const path = join(dir, "fixture.db");
  try {
    const legacyDb = openV27MigrationFixtureDb(path);
    const legacyStore = new HarborStore(legacyDb);
    const device = legacyStore.upsertDevice(
      "codex-box",
      "hash",
      { clis: { codex: "0.144.5" }, endpoints: [] },
      1,
    );
    const repository = legacyStore.createRepository({
      workspaceId: legacyStore.defaultWorkspace().id,
      name: "repo",
    }, 2);
    legacyStore.setRepositoryMount(repository.id, device.id, "/repo", 3);
    const legacyAgent = legacyStore.createAgent({
      name: "legacy-builder",
      deviceId: device.id,
      backend: "codex",
      repositoryId: repository.id,
      permission: "auto-edit",
      isolation: "worktree",
    }, 4);
    expect(legacyAgent.sandboxNetworkAccess).toBe(false);
    expect(legacyDb.query<{ name: string }, []>("PRAGMA table_info(agents)").all()
      .some((column) => column.name === "sandbox_network_access")).toBe(false);
    legacyDb.close();

    const migrated = openDb(path);
    try {
      expect(LATEST_SCHEMA_VERSION).toBe(32);
      expect(migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(32);
      const store = new HarborStore(migrated);
      expect(store.getAgent(legacyAgent.id)?.sandboxNetworkAccess).toBe(false);
      store.updateAgentConfig(legacyAgent.id, { sandboxNetworkAccess: true });
      expect(store.getAgent(legacyAgent.id)?.sandboxNetworkAccess).toBe(true);
      expect(() => migrated.run(
        "UPDATE agents SET sandbox_network_access = 2 WHERE id = ?",
        [legacyAgent.id],
      )).toThrow();
      expect(migrated.query<unknown, []>("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

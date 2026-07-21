import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, openV29MigrationFixtureDb } from "./db.js";
import { inspectGitHubPrincipalMigration } from "./github-principal-migration.js";
import { HarborStore } from "./store.js";

const roots: string[] = [];

function fixturePath(): string {
  const root = mkdtempSync(join(tmpdir(), "harbor-github-principal-v30-"));
  roots.push(root);
  return join(root, "fixture.db");
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("schema v30 GitHub principal migration", () => {
  test("dry-run is read-only and names every intentionally non-inferred authorization", () => {
    const db = openV29MigrationFixtureDb(":memory:");
    try {
      const store = new HarborStore(db);
      store.createAuthIdentity({
        accountId: "acc_bootstrap",
        provider: "github",
        subject: "42",
        verifiedAt: 1,
      }, 1);
      const before = db.query<{ changes: number }, []>("SELECT total_changes() AS changes").get()!.changes;
      const report = inspectGitHubPrincipalMigration(db);
      const after = db.query<{ changes: number }, []>("SELECT total_changes() AS changes").get()!.changes;
      expect(report.migratable).toBe(true);
      expect(report.counts.githubAuthIdentities).toBe(1);
      expect(report.counts.existingAuthorizations).toBe(0);
      expect(report.issues).toContainEqual(expect.objectContaining({
        code: "GITHUB_IDENTITIES_REQUIRE_REAUTHORIZATION",
      }));
      expect(after).toBe(before);
    } finally {
      db.close();
    }
  });

  test("dry-run rejects a non-v29 source before reading v29 tables", () => {
    const db = openDb(":memory:");
    try {
      expect(inspectGitHubPrincipalMigration(db)).toEqual(expect.objectContaining({
        sourceSchemaVersion: 30,
        expectedSourceSchemaVersion: 29,
        migratable: false,
        issues: [expect.objectContaining({ code: "UNSUPPORTED_SCHEMA_VERSION" })],
      }));
    } finally {
      db.close();
    }
  });

  test("migration preserves identity, backfills historical Runs honestly, and gives each Automation a service principal", () => {
    const path = fixturePath();
    const legacy = openV29MigrationFixtureDb(path);
    const store = new HarborStore(legacy);
    store.createAuthIdentity({
      accountId: "acc_bootstrap",
      provider: "github",
      subject: "42",
      verifiedAt: 1,
    }, 1);
    const device = store.upsertDevice("worker", "hash", { clis: { claude: "2" }, endpoints: [] }, 2);
    const agent = store.createAgent({
      name: "builder",
      deviceId: device.id,
      backend: "claude",
      workdir: "/repo",
      isolation: "none",
    }, 3);
    const conversation = store.createConversation({
      kind: "issue",
      title: "Historical work",
      description: "fixture",
      agentId: agent.id,
      repositoryId: agent.repositoryId,
    }, 4);
    legacy.run(
      `INSERT INTO automations
       (id, workspace_id, name, agent_id, prompt, output_mode, enabled, last_fired_at, created_at, updated_at)
       VALUES ('auto_fixture', ?, 'fixture', ?, 'run it', 'run', 1, NULL, 5, 5)`,
      [agent.workspaceId, agent.id],
    );
    legacy.run(
      `INSERT INTO automation_triggers
       (id, automation_id, type, cron, timezone, repository_id, codebase_event, last_fired_at, created_at, updated_at)
       VALUES ('trigger_fixture', 'auto_fixture', 'schedule', '0 9 * * *', 'Asia/Shanghai', NULL, NULL, NULL, 5, 5)`,
    );
    legacy.run(
      `INSERT INTO runs
       (id, workspace_id, source_type, source_id, conversation_id, agent_id, device_id,
        repository_id, repository_mount_id, execution_root, prompt, purpose, prompt_event,
        trigger_context, root_run_id, dispatch_depth, status, queued_at)
       VALUES ('run_historical', ?, 'issue', ?, ?, ?, ?, ?, NULL, '/repo', 'work',
               'implementation', 'event.issue.assigned', '{}', 'run_historical', 0, 'succeeded', 6)`,
      [agent.workspaceId, conversation.id, conversation.id, agent.id, device.id, agent.repositoryId],
    );
    legacy.close();

    const migrated = openDb(path);
    try {
      expect(migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(30);
      expect(migrated.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM github_account_authorizations",
      ).get()!.count).toBe(0);
      expect(migrated.query<{ principal_type: string; principal_id: string | null }, []>(
        "SELECT principal_type, principal_id FROM runs WHERE id = 'run_historical'",
      ).get()).toEqual({ principal_type: "system", principal_id: null });
      expect(migrated.query<{ service_principal_id: string }, []>(
        "SELECT service_principal_id FROM automations WHERE id = 'auto_fixture'",
      ).get()).toEqual({ service_principal_id: "sp_automation_auto_fixture" });
      expect(migrated.query<{ owner_id: string; status: string }, []>(
        "SELECT owner_id, status FROM service_principals WHERE id = 'sp_automation_auto_fixture'",
      ).get()).toEqual({ owner_id: "auto_fixture", status: "active" });
      expect(migrated.query<Record<string, unknown>, []>("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      migrated.close();
    }
  });
});

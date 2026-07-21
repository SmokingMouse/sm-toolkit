import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, openV28MigrationFixtureDb } from "./db.js";
import { inspectGitHubAppMigration } from "./github-app-migration.js";
import { HarborStore } from "./store.js";

const roots: string[] = [];

function fixturePath(name: string): string {
  const root = mkdtempSync(join(tmpdir(), "harbor-github-app-v29-"));
  roots.push(root);
  return join(root, `${name}.db`);
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("schema v29 GitHub App migration", () => {
  test("dry-run projects GitHub remotes without guessing installation mappings", () => {
    const db = openV28MigrationFixtureDb(":memory:");
    try {
      const store = new HarborStore(db);
      const workspace = store.defaultWorkspace();
      const repository = store.createRepository({
        workspaceId: workspace.id,
        name: "sm-toolkit",
        remoteUrl: "git@github.com:SmokingMouse/sm-toolkit.git",
      }, 100);
      store.createAuthIdentity({
        accountId: "acc_bootstrap",
        provider: "github",
        subject: "123456789",
        email: "owner@example.test",
        verifiedAt: 101,
      }, 101);

      const before = db.query<{ changes: number }, []>("SELECT total_changes() AS changes").get()!.changes;
      const report = inspectGitHubAppMigration(db);
      const after = db.query<{ changes: number }, []>("SELECT total_changes() AS changes").get()!.changes;

      expect(report.migratable).toBe(true);
      expect(report.counts).toEqual(expect.objectContaining({
        githubAuthIdentities: 1,
        githubRemoteRepositories: 1,
        githubRemoteAliasGroups: 0,
      }));
      expect(report.githubRepositoryCandidates).toEqual([{
        workspaceId: workspace.id,
        repositoryId: repository.id,
        canonicalName: "smokingmouse/sm-toolkit",
      }]);
      expect(after).toBe(before);
    } finally {
      db.close();
    }
  });

  test("migration preserves v28 data and creates empty credential-free integration tables", () => {
    const path = fixturePath("healthy");
    const legacy = openV28MigrationFixtureDb(path);
    const store = new HarborStore(legacy);
    const repository = store.createRepository({
      workspaceId: store.defaultWorkspace().id,
      name: "sm-toolkit",
      remoteUrl: "https://github.com/SmokingMouse/sm-toolkit.git",
    }, 200);
    legacy.close();

    const migrated = openDb(path);
    try {
      expect(migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(31);
      expect(migrated.query<{ id: string }, [string]>("SELECT id FROM repositories WHERE id = ?").get(repository.id)).toEqual({ id: repository.id });
      for (const table of [
        "github_oauth_states",
        "github_installations",
        "github_workspace_installations",
        "github_repository_connections",
      ]) {
        expect(migrated.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count).toBe(0);
      }
      expect(() => migrated.run(
        `INSERT INTO github_installations
         (installation_id, app_id, target_id, target_type, target_login, repository_selection, permissions, status, created_at, updated_at)
         VALUES ('mutable-login', '12345', '42', 'User', 'owner', 'selected', '{}', 'active', 1, 1)`,
      )).toThrow();
      expect(migrated.query<Record<string, unknown>, []>("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      migrated.close();
    }
  });

  test("dry-run reports intentional repository aliases and blocks mutable GitHub identity subjects", () => {
    const warningDb = openV28MigrationFixtureDb(":memory:");
    try {
      const store = new HarborStore(warningDb);
      const workspaceId = store.defaultWorkspace().id;
      store.createRepository({ workspaceId, name: "one", remoteUrl: "https://github.com/Owner/Repo" }, 1);
      store.createRepository({ workspaceId, name: "two", remoteUrl: "git@github.com:owner/repo.git" }, 2);
      const report = inspectGitHubAppMigration(warningDb);
      expect(report.migratable).toBe(true);
      expect(report.issues).toContainEqual(expect.objectContaining({
        severity: "warning",
        code: "GITHUB_REMOTE_ALIASES",
      }));
    } finally {
      warningDb.close();
    }

    const path = fixturePath("invalid-identity");
    const invalid = openV28MigrationFixtureDb(path);
    invalid.run(
      `INSERT INTO auth_identities
       (id, account_id, provider, subject, email, verified_at, created_at)
       VALUES ('auth_bad_github', 'acc_bootstrap', 'github', 'mutable-login', NULL, 1, 1)`,
    );
    invalid.close();
    expect(() => openDb(path)).toThrow("INVALID_GITHUB_IDENTITY_SUBJECT");
    const untouched = openV28MigrationFixtureDb(path);
    expect(untouched.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(28);
    untouched.close();
  });
});

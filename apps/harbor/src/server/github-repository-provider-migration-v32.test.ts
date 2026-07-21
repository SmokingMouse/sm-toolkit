import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, openV31MigrationFixtureDb } from "./db.js";
import { HarborStore } from "./store.js";

test("v32 promotes active GitHub mappings to a first-class provider and follows connection lifecycle", () => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-v32-provider-"));
  const path = join(dir, "harbor.db");
  try {
    const legacy = openV31MigrationFixtureDb(path);
    const store = new HarborStore(legacy);
    const repository = store.createRepository({
      workspaceId: "ws_personal",
      name: "github-app",
      remoteUrl: "https://github.com/acme/app.git",
    }, 1);
    store.upsertGitHubInstallation({
      installationId: "77",
      appId: "123",
      targetId: "42",
      targetType: "User",
      targetLogin: "acme",
      repositorySelection: "selected",
      permissions: { contents: "write", pull_requests: "write" },
    }, 2);
    store.connectGitHubInstallation({
      workspaceId: "ws_personal",
      installationId: "77",
      connectedByAccountId: "acc_bootstrap",
    }, 2);
    store.upsertGitHubRepositoryConnection({
      workspaceId: "ws_personal",
      repositoryId: repository.id,
      installationId: "77",
      githubRepositoryId: "99",
      fullName: "acme/app",
      defaultBranch: "main",
      private: false,
    }, 2);
    store.updateRepository(repository.id, {
      scmProvider: "codebase",
      scmRepository: "acme/app",
      scmAgentId: null,
      scmAutoDispatch: false,
    }, 2);
    expect(store.getRepository(repository.id)?.scmProvider).toBe("codebase");
    legacy.close();

    const migrated = openDb(path);
    const current = new HarborStore(migrated);
    expect(migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(32);
    expect(current.getRepository(repository.id)).toEqual(expect.objectContaining({
      scmProvider: "github",
      scmRepository: null,
      scmAgentId: null,
      scmAutoDispatch: false,
    }));
    expect(migrated.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM pragma_foreign_key_check",
    ).get()?.count).toBe(0);

    expect(() => current.updateRepository(repository.id, { scmProvider: "codebase" }, 3)).toThrow(
      "active github connection blocks provider change",
    );
    expect(current.disconnectGitHubInstallation("ws_personal", "77", 4)).toBe(true);
    expect(current.getRepository(repository.id)?.scmProvider).toBe("local");

    current.connectGitHubInstallation({
      workspaceId: "ws_personal",
      installationId: "77",
      connectedByAccountId: "acc_bootstrap",
    }, 5);
    current.upsertGitHubRepositoryConnection({
      workspaceId: "ws_personal",
      repositoryId: repository.id,
      installationId: "77",
      githubRepositoryId: "99",
      fullName: "acme/app",
      defaultBranch: "main",
      private: false,
    }, 5);
    expect(current.getRepository(repository.id)?.scmProvider).toBe("github");
    expect(current.markMissingGitHubRepositoriesRemoved("ws_personal", "77", [], 6)).toBeGreaterThan(0);
    expect(current.getRepository(repository.id)?.scmProvider).toBe("local");
    migrated.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

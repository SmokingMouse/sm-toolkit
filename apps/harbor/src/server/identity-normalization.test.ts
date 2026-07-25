import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createV22IdentityFixture } from "./fixtures/v22-identity.js";
import { inspectIdentityNormalization } from "./identity-normalization.js";
import { openDb, openV23MigrationFixtureDb } from "./db.js";

test("v22 identity report projects bootstrap/external/local accounts without merging duplicate email", () => {
  const fixture = createV22IdentityFixture();
  try {
    const report = inspectIdentityNormalization(fixture.db);
    expect(report.sourceSchemaVersion).toBe(22);
    expect(report.migratable).toBe(true);
    expect(report.counts).toEqual({
      workspaces: 3,
      legacyMembers: 9,
      activeMembers: 7,
      disabledMembers: 1,
      invitedRows: 1,
      syntheticMembers: 3,
      externalIdentityMembers: 2,
      localMembers: 3,
      workspaceApiTokens: 2,
      projectedAccounts: 5,
      projectedAuthIdentities: 1,
      projectedMemberships: 8,
      projectedInvitations: 1,
    });
    expect(report.referenceCounts).toEqual({
      "agents.created_by_member_id": 1,
      "conversation_messages.author_id": 1,
      "conversations.creator_member_id": 1,
      "conversations.owner_member_id": 1,
      "workspace_api_tokens.member_id": 2,
    });

    const bootstrap = report.accounts.find((account) => account.kind === "bootstrap")!;
    expect(bootstrap.accountId).toBe("acc_bootstrap");
    expect(bootstrap.sourceMemberIds).toEqual([
      fixture.ids.personalSystemMember,
      fixture.ids.teamSystemMember,
      fixture.ids.secondTeamSystemMember,
    ].sort());
    const external = report.accounts.find((account) => account.kind === "external")!;
    expect(external.sourceMemberIds).toEqual([
      fixture.ids.feishuFirstMember,
      fixture.ids.feishuSecondMember,
    ]);
    expect(external.workspaceIds).toEqual([
      fixture.ids.teamWorkspace,
      fixture.ids.secondTeamWorkspace,
    ].sort());
    expect(external.primaryEmailState).toBe("unique");
    expect(report.duplicateEmails).toHaveLength(1);
    expect(report.duplicateEmails[0]!.sourceMemberIds).toEqual([
      fixture.ids.duplicateEmailFirstMember,
      fixture.ids.duplicateEmailSecondMember,
    ]);
    expect(report.duplicateEmails[0]!.projectedAccountIds).toHaveLength(2);
    expect(report.invitations).toEqual([
      expect.objectContaining({
        invitationId: fixture.ids.invitedMember,
        invitedByAccountId: "acc_bootstrap",
        referenceCount: 0,
      }),
    ]);
    expect(report.issues.map((entry) => entry.code)).toEqual([
      "DISABLED_MEMBER_TOKEN_WILL_REVOKE",
      "DUPLICATE_EMAIL_NOT_MERGED",
    ]);

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("fixture-token");
    expect(serialized).not.toContain("ou_fixture");
    expect(serialized).not.toContain("same@example.com");
    expect(serialized).not.toContain("Feishu user");
  } finally {
    fixture.db.close();
  }
});

test("v22 identity report fails before migration when an invited row is referenced", () => {
  const fixture = createV22IdentityFixture();
  try {
    fixture.db.run("UPDATE agents SET created_by_member_id = ? WHERE id = ?", [fixture.ids.invitedMember, fixture.ids.agent]);
    const report = inspectIdentityNormalization(fixture.db);
    expect(report.migratable).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({
      severity: "error",
      code: "INVITED_MEMBER_REFERENCED",
      refs: expect.arrayContaining([fixture.ids.agent, fixture.ids.invitedMember]),
    }));
    expect(report.invitations[0]?.referenceCount).toBe(1);
  } finally {
    fixture.db.close();
  }
});

test("v22 identity report catches soft orphans and cross-workspace member references", () => {
  const fixture = createV22IdentityFixture();
  try {
    fixture.db.run(
      `INSERT INTO conversation_messages
       (id, conversation_id, author_type, author_id, author_name, body, external_id, created_at)
       VALUES ('msg_orphan', ?, 'member', 'mem_missing', 'Missing', 'orphan', NULL, 200)`,
      [fixture.ids.conversation],
    );
    fixture.db.run("UPDATE conversations SET owner_member_id = ? WHERE id = ?", [
      fixture.ids.duplicateEmailSecondMember,
      fixture.ids.conversation,
    ]);
    const report = inspectIdentityNormalization(fixture.db);
    expect(report.migratable).toBe(false);
    expect(report.issues.map((entry) => entry.code)).toContain("ORPHAN_MEMBER_REFERENCE");
    expect(report.issues.map((entry) => entry.code)).toContain("CROSS_WORKSPACE_MEMBER_REFERENCE");
  } finally {
    fixture.db.close();
  }
});

test("identity report rejects non-v22 input without trying to read missing identity tables", () => {
  const db = new Database(":memory:");
  try {
    db.exec("PRAGMA user_version = 21");
    const report = inspectIdentityNormalization(db);
    expect(report.migratable).toBe(false);
    expect(report.counts.legacyMembers).toBe(0);
    expect(report.issues).toEqual([
      expect.objectContaining({ code: "UNSUPPORTED_SCHEMA_VERSION", severity: "error" }),
    ]);
  } finally {
    db.close();
  }
});

test("v23 migration consumes the same report and preserves membership/reference ids", () => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-identity-v23-"));
  const path = join(dir, "fixture.db");
  const fixture = createV22IdentityFixture(path);
  const ids = fixture.ids;
  fixture.db.close();
  try {
    const migrated = openV23MigrationFixtureDb(path);
    try {
      expect(migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(23);
      expect(migrated.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM accounts").get()?.count).toBe(5);
      expect(migrated.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM auth_identities").get()?.count).toBe(1);
      expect(migrated.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM workspace_members").get()?.count).toBe(8);
      expect(migrated.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM workspace_invitations").get()?.count).toBe(1);
      expect(migrated.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM personal_access_tokens").get()?.count).toBe(2);

      expect(migrated.query<{ account_id: string }, [string]>("SELECT account_id FROM workspace_members WHERE id = ?").get(ids.personalSystemMember)).toEqual({ account_id: "acc_bootstrap" });
      expect(migrated.query<{ account_id: string }, [string]>("SELECT account_id FROM workspace_members WHERE id = ?").get(ids.secondTeamSystemMember)).toEqual({ account_id: "acc_bootstrap" });
      const externalAccounts = migrated.query<{ account_id: string }, [string, string]>(
        "SELECT account_id FROM workspace_members WHERE id IN (?, ?) ORDER BY id",
      ).all(ids.feishuFirstMember, ids.feishuSecondMember);
      expect(new Set(externalAccounts.map((row) => row.account_id)).size).toBe(1);
      const duplicateEmailAccounts = migrated.query<{ account_id: string }, [string, string]>(
        "SELECT account_id FROM workspace_members WHERE id IN (?, ?) ORDER BY id",
      ).all(ids.duplicateEmailFirstMember, ids.duplicateEmailSecondMember);
      expect(new Set(duplicateEmailAccounts.map((row) => row.account_id)).size).toBe(2);
      expect(migrated.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM accounts WHERE primary_email_normalized IS NULL AND lower(trim(primary_email)) = 'same@example.com'",
      ).get()?.count).toBe(2);

      expect(migrated.query<{ status: string; expires_at: number; token_length: number; invited_by_account_id: string }, [string]>(
        "SELECT status, expires_at, length(token_hash) AS token_length, invited_by_account_id FROM workspace_invitations WHERE id = ?",
      ).get(ids.invitedMember)).toEqual({
        status: "expired",
        expires_at: 109,
        token_length: 64,
        invited_by_account_id: "acc_bootstrap",
      });
      expect(migrated.query<{ id: string }, [string]>("SELECT id FROM workspace_members WHERE id = ?").get(ids.invitedMember)).toBeNull();
      expect(migrated.query<{ revoked_at: number | null }, [string]>("SELECT revoked_at FROM personal_access_tokens WHERE id = ?").get(ids.externalToken)).toEqual({ revoked_at: null });
      expect(migrated.query<{ revoked_at: number | null }, [string]>("SELECT revoked_at FROM personal_access_tokens WHERE id = ?").get(ids.disabledToken)).toEqual({ revoked_at: 111 });

      expect(migrated.query<{ kind: string; created_by_account_id: string }, [string]>(
        "SELECT kind, created_by_account_id FROM workspaces WHERE id = ?",
      ).get(ids.personalWorkspace)).toEqual({ kind: "personal", created_by_account_id: "acc_bootstrap" });
      expect(migrated.query<{ kind: string; created_by_account_id: string }, [string]>(
        "SELECT kind, created_by_account_id FROM workspaces WHERE id = ?",
      ).get(ids.teamWorkspace)).toEqual({ kind: "team", created_by_account_id: "acc_bootstrap" });

      expect(migrated.query<{ created_by_member_id: string }, [string]>("SELECT created_by_member_id FROM agents WHERE id = ?").get(ids.agent)).toEqual({ created_by_member_id: ids.feishuFirstMember });
      expect(migrated.query<{ creator_member_id: string; owner_member_id: string }, [string]>(
        "SELECT creator_member_id, owner_member_id FROM conversations WHERE id = ?",
      ).get(ids.conversation)).toEqual({ creator_member_id: ids.duplicateEmailFirstMember, owner_member_id: ids.feishuFirstMember });
      expect(migrated.query<{ author_id: string }, [string]>("SELECT author_id FROM conversation_messages WHERE id = ?").get(ids.message)).toEqual({ author_id: ids.feishuFirstMember });
      expect(migrated.query<unknown, []>("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("v23 migration fails closed and leaves v22 untouched when dry-run has blockers", () => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-identity-v23-blocked-"));
  const path = join(dir, "fixture.db");
  const fixture = createV22IdentityFixture(path);
  fixture.db.run("UPDATE agents SET created_by_member_id = ? WHERE id = ?", [fixture.ids.invitedMember, fixture.ids.agent]);
  fixture.db.close();
  try {
    expect(() => openDb(path)).toThrow("INVITED_MEMBER_REFERENCED");
    const verify = new Database(path, { readonly: true });
    try {
      expect(verify.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(22);
      expect(verify.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'accounts'",
      ).get()?.count).toBe(0);
    } finally {
      verify.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

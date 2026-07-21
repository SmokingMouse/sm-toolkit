import type { Database } from "bun:sqlite";

export const GITHUB_PRINCIPAL_MIGRATION_REPORT_VERSION = 1 as const;
export const GITHUB_PRINCIPAL_MIGRATION_SOURCE_SCHEMA = 29 as const;

export interface GitHubPrincipalMigrationIssue {
  severity: "warning" | "error";
  code: string;
  message: string;
  refs: string[];
}

export interface GitHubPrincipalMigrationReport {
  reportVersion: typeof GITHUB_PRINCIPAL_MIGRATION_REPORT_VERSION;
  sourceSchemaVersion: number;
  expectedSourceSchemaVersion: typeof GITHUB_PRINCIPAL_MIGRATION_SOURCE_SCHEMA;
  migratable: boolean;
  counts: {
    githubAuthIdentities: number;
    existingAuthorizations: number;
    historicalRuns: number;
    automations: number;
  };
  issues: GitHubPrincipalMigrationIssue[];
}

function ids(db: Database, sql: string): string[] {
  return db.query<{ id: string }, []>(sql).all().map((row) => row.id);
}

/** v29 → v30 只读 dry-run；绝不读取或猜测 credential。 */
export function inspectGitHubPrincipalMigration(db: Database): GitHubPrincipalMigrationReport {
  const sourceSchemaVersion = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
  const emptyCounts = {
    githubAuthIdentities: 0,
    existingAuthorizations: 0,
    historicalRuns: 0,
    automations: 0,
  };
  if (sourceSchemaVersion !== GITHUB_PRINCIPAL_MIGRATION_SOURCE_SCHEMA) {
    return {
      reportVersion: GITHUB_PRINCIPAL_MIGRATION_REPORT_VERSION,
      sourceSchemaVersion,
      expectedSourceSchemaVersion: GITHUB_PRINCIPAL_MIGRATION_SOURCE_SCHEMA,
      migratable: false,
      counts: emptyCounts,
      issues: [{
        severity: "error",
        code: "UNSUPPORTED_SCHEMA_VERSION",
        message: `GitHub principal migration 只接受 schema v${GITHUB_PRINCIPAL_MIGRATION_SOURCE_SCHEMA}，当前为 v${sourceSchemaVersion}`,
        refs: [`schema:v${sourceSchemaVersion}`],
      }],
    };
  }
  const githubIdentities = ids(db, "SELECT id FROM auth_identities WHERE provider = 'github' ORDER BY id");
  const runs = ids(db, "SELECT id FROM runs ORDER BY queued_at, id");
  const automations = ids(db, "SELECT id FROM automations ORDER BY id");
  const hasAuthorizationTable = !!db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'github_account_authorizations'",
  ).get();
  const existingAuthorizations = hasAuthorizationTable
    ? db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM github_account_authorizations").get()?.count ?? 0
    : 0;
  const issues: GitHubPrincipalMigrationIssue[] = [];
  if (githubIdentities.length) issues.push({
    severity: "warning",
    code: "GITHUB_IDENTITIES_REQUIRE_REAUTHORIZATION",
    message: "AuthIdentity 只保留账号绑定；v30 不会从旧数据猜测或复制 GitHub user credential。",
    refs: githubIdentities,
  });
  if (runs.length) issues.push({
    severity: "warning",
    code: "HISTORICAL_RUNS_BACKFILL_SYSTEM",
    message: "v30 之前没有可信 initiator snapshot；历史 Run 诚实回填为 system。",
    refs: runs,
  });
  if (automations.length) issues.push({
    severity: "warning",
    code: "AUTOMATIONS_GAIN_SERVICE_PRINCIPALS",
    message: "每个 Automation 将获得独立 ServicePrincipal，后续 unattended GitHub action 使用 installation token。",
    refs: automations,
  });
  return {
    reportVersion: GITHUB_PRINCIPAL_MIGRATION_REPORT_VERSION,
    sourceSchemaVersion,
    expectedSourceSchemaVersion: GITHUB_PRINCIPAL_MIGRATION_SOURCE_SCHEMA,
    migratable: true,
    counts: {
      githubAuthIdentities: githubIdentities.length,
      existingAuthorizations,
      historicalRuns: runs.length,
      automations: automations.length,
    },
    issues,
  };
}

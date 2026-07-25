import { Database } from "bun:sqlite";

export const GITHUB_APP_MIGRATION_REPORT_VERSION = 1 as const;
export const GITHUB_APP_MIGRATION_SOURCE_SCHEMA = 28 as const;

export interface GitHubAppMigrationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  refs: string[];
}

export interface GitHubAppMigrationReport {
  reportVersion: typeof GITHUB_APP_MIGRATION_REPORT_VERSION;
  sourceSchemaVersion: number;
  expectedSourceSchemaVersion: typeof GITHUB_APP_MIGRATION_SOURCE_SCHEMA;
  migratable: boolean;
  counts: {
    accounts: number;
    workspaces: number;
    githubAuthIdentities: number;
    repositories: number;
    githubRemoteRepositories: number;
    githubDeliveries: number;
    githubRemoteAliasGroups: number;
  };
  githubRepositoryCandidates: {
    workspaceId: string;
    repositoryId: string;
    canonicalName: string;
  }[];
  githubRepositoryAliasGroups: {
    workspaceId: string;
    canonicalName: string;
    repositoryIds: string[];
  }[];
  issues: GitHubAppMigrationIssue[];
}

function count(db: Database, sql: string): number {
  return db.query<{ count: number }, []>(sql).get()?.count ?? 0;
}

function canonicalGitHubRemote(value: string | null): string | null {
  if (!value) return null;
  let path: string;
  const scp = value.match(/^(?:[^@]+@)?github\.com:([^?#]+)$/i);
  if (scp) path = scp[1]!;
  else {
    try {
      const url = new URL(value);
      if (url.hostname.toLowerCase() !== "github.com") return null;
      path = url.pathname;
    } catch {
      return null;
    }
  }
  const normalized = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  return /^[^/]+\/[^/]+$/.test(normalized) ? normalized.toLowerCase() : null;
}

/**
 * 只读检查 v28。不会读取 YAML/env credential，也不会猜测 installation；
 * v29 只建空 integration 表，真实映射必须由 GitHub OAuth + App installation 证明。
 */
export function inspectGitHubAppMigration(db: Database): GitHubAppMigrationReport {
  const sourceSchemaVersion = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
  const issues: GitHubAppMigrationIssue[] = [];
  const emptyCounts = {
    accounts: 0,
    workspaces: 0,
    githubAuthIdentities: 0,
    repositories: 0,
    githubRemoteRepositories: 0,
    githubDeliveries: 0,
    githubRemoteAliasGroups: 0,
  };
  if (sourceSchemaVersion !== GITHUB_APP_MIGRATION_SOURCE_SCHEMA) {
    issues.push({
      severity: "error",
      code: "UNSUPPORTED_SCHEMA_VERSION",
      message: `GitHub App migration 只接受 schema v${GITHUB_APP_MIGRATION_SOURCE_SCHEMA}，当前为 v${sourceSchemaVersion}`,
      refs: [`schema:v${sourceSchemaVersion}`],
    });
    return {
      reportVersion: GITHUB_APP_MIGRATION_REPORT_VERSION,
      sourceSchemaVersion,
      expectedSourceSchemaVersion: GITHUB_APP_MIGRATION_SOURCE_SCHEMA,
      migratable: false,
      counts: emptyCounts,
      githubRepositoryCandidates: [],
      githubRepositoryAliasGroups: [],
      issues,
    };
  }

  const invalidIdentities = db.query<{ id: string; subject: string }, []>(
    "SELECT id, subject FROM auth_identities WHERE provider = 'github' AND (subject = '' OR subject GLOB '*[^0-9]*' OR subject GLOB '0*')",
  ).all();
  for (const identity of invalidIdentities) {
    issues.push({
      severity: "error",
      code: "INVALID_GITHUB_IDENTITY_SUBJECT",
      message: "GitHub AuthIdentity subject 必须是不可变的数字 user id，不能使用 login/email",
      refs: [identity.id],
    });
  }

  const repositories = db.query<{ id: string; workspace_id: string; remote_url: string | null }, []>(
    "SELECT id, workspace_id, remote_url FROM repositories ORDER BY workspace_id, id",
  ).all();
  const candidates = repositories.flatMap((repository) => {
    const canonicalName = canonicalGitHubRemote(repository.remote_url);
    return canonicalName ? [{
      workspaceId: repository.workspace_id,
      repositoryId: repository.id,
      canonicalName,
    }] : [];
  });
  const grouped = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const key = `${candidate.workspaceId}\0${candidate.canonicalName}`;
    grouped.set(key, [...(grouped.get(key) ?? []), candidate]);
  }
  const githubRepositoryAliasGroups = [...grouped.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      workspaceId: group[0]!.workspaceId,
      canonicalName: group[0]!.canonicalName,
      repositoryIds: group.map((entry) => entry.repositoryId).sort(),
    }))
    .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId) || a.canonicalName.localeCompare(b.canonicalName));
  for (const group of githubRepositoryAliasGroups) {
    issues.push({
      severity: "warning",
      code: "GITHUB_REMOTE_ALIASES",
      message: "同一 Workspace 有多个 Harbor Repository 指向同一 GitHub remote；installation sync 会把 GitHub repository identity 显式映射到全部 alias",
      refs: [group.workspaceId, ...group.repositoryIds],
    });
  }

  const foreignKeyFailures = db.query<{
    table: string; rowid: number | null; parent: string; fkid: number;
  }, []>("PRAGMA foreign_key_check").all();
  for (const failure of foreignKeyFailures) {
    issues.push({
      severity: "error",
      code: "FOREIGN_KEY_FAILURE",
      message: "v28 数据库已有 foreign_key_check 失败，必须先修复再迁移",
      refs: [failure.table, `rowid:${failure.rowid ?? "null"}`, failure.parent, `fkid:${failure.fkid}`],
    });
  }

  const counts = {
    accounts: count(db, "SELECT COUNT(*) AS count FROM accounts"),
    workspaces: count(db, "SELECT COUNT(*) AS count FROM workspaces"),
    githubAuthIdentities: count(db, "SELECT COUNT(*) AS count FROM auth_identities WHERE provider = 'github'"),
    repositories: repositories.length,
    githubRemoteRepositories: candidates.length,
    githubDeliveries: count(db, "SELECT COUNT(*) AS count FROM deliveries WHERE provider = 'github'"),
    githubRemoteAliasGroups: githubRepositoryAliasGroups.length,
  };
  return {
    reportVersion: GITHUB_APP_MIGRATION_REPORT_VERSION,
    sourceSchemaVersion,
    expectedSourceSchemaVersion: GITHUB_APP_MIGRATION_SOURCE_SCHEMA,
    migratable: !issues.some((entry) => entry.severity === "error"),
    counts,
    githubRepositoryCandidates: candidates,
    githubRepositoryAliasGroups,
    issues,
  };
}

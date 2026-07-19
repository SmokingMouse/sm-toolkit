import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

export const IDENTITY_NORMALIZATION_REPORT_VERSION = 1 as const;
export const IDENTITY_NORMALIZATION_SOURCE_SCHEMA = 22 as const;

type LegacyMemberStatus = "active" | "invited" | "disabled";
type LegacyMemberRole = "owner" | "admin" | "member";
type LegacyExternalProvider = "local" | "feishu" | "codebase";

interface LegacyMemberRow {
  id: string;
  workspace_id: string;
  name: string;
  email: string | null;
  external_provider: LegacyExternalProvider;
  external_id: string | null;
  role: LegacyMemberRole;
  status: LegacyMemberStatus;
  created_at: number;
}

interface Candidate {
  key: string;
  accountId: string;
  kind: "bootstrap" | "external" | "local";
  members: LegacyMemberRow[];
  externalProvider: Exclude<LegacyExternalProvider, "local"> | null;
  externalSubject: string | null;
}

export interface IdentityNormalizationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  refs: string[];
}

export interface IdentityAccountProjection {
  accountId: string;
  kind: Candidate["kind"];
  sourceMemberIds: string[];
  workspaceIds: string[];
  externalProvider: Candidate["externalProvider"];
  externalSubjectFingerprint: string | null;
  primaryEmailState: "none" | "unique" | "ambiguous";
  primaryEmailFingerprint: string | null;
  displayNameSourceMemberId: string;
}

export interface IdentityInvitationProjection {
  invitationId: string;
  sourceMemberId: string;
  workspaceId: string;
  role: LegacyMemberRole;
  emailFingerprint: string | null;
  invitedByAccountId: string | null;
  referenceCount: number;
}

export interface IdentityNormalizationReport {
  reportVersion: typeof IDENTITY_NORMALIZATION_REPORT_VERSION;
  sourceSchemaVersion: number;
  expectedSourceSchemaVersion: typeof IDENTITY_NORMALIZATION_SOURCE_SCHEMA;
  migratable: boolean;
  counts: {
    workspaces: number;
    legacyMembers: number;
    activeMembers: number;
    disabledMembers: number;
    invitedRows: number;
    syntheticMembers: number;
    externalIdentityMembers: number;
    localMembers: number;
    workspaceApiTokens: number;
    projectedAccounts: number;
    projectedAuthIdentities: number;
    projectedMemberships: number;
    projectedInvitations: number;
  };
  referenceCounts: Record<string, number>;
  accounts: IdentityAccountProjection[];
  invitations: IdentityInvitationProjection[];
  duplicateEmails: {
    emailFingerprint: string;
    sourceMemberIds: string[];
    projectedAccountIds: string[];
  }[];
  issues: IdentityNormalizationIssue[];
}

const emptyCounts = () => ({
  workspaces: 0,
  legacyMembers: 0,
  activeMembers: 0,
  disabledMembers: 0,
  invitedRows: 0,
  syntheticMembers: 0,
  externalIdentityMembers: 0,
  localMembers: 0,
  workspaceApiTokens: 0,
  projectedAccounts: 0,
  projectedAuthIdentities: 0,
  projectedMemberships: 0,
  projectedInvitations: 0,
});

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function normalizedEmail(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized || null;
}

function stableMemberOrder(a: LegacyMemberRow, b: LegacyMemberRow): number {
  return a.created_at - b.created_at || a.id.localeCompare(b.id);
}

function issue(
  issues: IdentityNormalizationIssue[],
  severity: IdentityNormalizationIssue["severity"],
  code: string,
  message: string,
  refs: string[],
): void {
  issues.push({ severity, code, message, refs: [...new Set(refs)].sort() });
}

function trustedExternal(member: LegacyMemberRow): member is LegacyMemberRow & {
  external_provider: Exclude<LegacyExternalProvider, "local">;
  external_id: string;
} {
  return member.external_provider !== "local" && !!member.external_id?.trim();
}

function syntheticMember(member: LegacyMemberRow): boolean {
  return member.id.startsWith("member_system_");
}

function buildCandidates(members: LegacyMemberRow[]): Candidate[] {
  const groups = new Map<string, LegacyMemberRow[]>();
  for (const member of members.filter((entry) => entry.status !== "invited")) {
    const key = syntheticMember(member)
      ? "bootstrap"
      : trustedExternal(member)
        ? `external\0${member.external_provider}\0${member.external_id}`
        : `local\0${member.id}`;
    const rows = groups.get(key) ?? [];
    rows.push(member);
    groups.set(key, rows);
  }
  return [...groups.entries()].map(([key, rows]) => {
    const ordered = rows.sort(stableMemberOrder);
    const first = ordered[0]!;
    const external = key.startsWith("external\0");
    return {
      key,
      accountId: key === "bootstrap" ? "acc_bootstrap" : `acc_${first.id}`,
      kind: key === "bootstrap" ? "bootstrap" : external ? "external" : "local",
      members: ordered,
      externalProvider: external
        ? first.external_provider as Exclude<LegacyExternalProvider, "local">
        : null,
      externalSubject: external ? first.external_id : null,
    } satisfies Candidate;
  }).sort((a, b) => a.accountId.localeCompare(b.accountId));
}

interface MemberReference {
  source: string;
  sourceId: string;
  memberId: string;
  workspaceId: string;
}

function memberReferences(db: Database): MemberReference[] {
  const refs: MemberReference[] = [];
  refs.push(...db.query<{
    id: string; workspace_id: string; member_id: string;
  }, []>(
    "SELECT id, workspace_id, created_by_member_id AS member_id FROM agents WHERE created_by_member_id IS NOT NULL",
  ).all().map((row) => ({ source: "agents.created_by_member_id", sourceId: row.id, memberId: row.member_id, workspaceId: row.workspace_id })));
  refs.push(...db.query<{
    id: string; workspace_id: string; member_id: string;
  }, []>(
    "SELECT id, workspace_id, creator_member_id AS member_id FROM conversations WHERE creator_member_id IS NOT NULL",
  ).all().map((row) => ({ source: "conversations.creator_member_id", sourceId: row.id, memberId: row.member_id, workspaceId: row.workspace_id })));
  refs.push(...db.query<{
    id: string; workspace_id: string; member_id: string;
  }, []>(
    "SELECT id, workspace_id, owner_member_id AS member_id FROM conversations WHERE owner_member_id IS NOT NULL",
  ).all().map((row) => ({ source: "conversations.owner_member_id", sourceId: row.id, memberId: row.member_id, workspaceId: row.workspace_id })));
  refs.push(...db.query<{
    id: string; workspace_id: string; member_id: string;
  }, []>(
    "SELECT id, workspace_id, member_id FROM workspace_api_tokens",
  ).all().map((row) => ({ source: "workspace_api_tokens.member_id", sourceId: row.id, memberId: row.member_id, workspaceId: row.workspace_id })));
  refs.push(...db.query<{
    id: string; workspace_id: string; member_id: string;
  }, []>(
    `SELECT m.id, c.workspace_id, m.author_id AS member_id
     FROM conversation_messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE m.author_type = 'member' AND m.author_id IS NOT NULL`,
  ).all().map((row) => ({ source: "conversation_messages.author_id", sourceId: row.id, memberId: row.member_id, workspaceId: row.workspace_id })));
  return refs.sort((a, b) => a.source.localeCompare(b.source) || a.sourceId.localeCompare(b.sourceId));
}

/**
 * 只读检查 schema v22；不会创建表、写 last_used_at 或运行 migration。
 * 报告刻意不包含 token hash、原始 external subject、姓名或原始邮箱，可安全附在部署记录里。
 */
export function inspectIdentityNormalization(db: Database): IdentityNormalizationReport {
  const sourceSchemaVersion = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
  const issues: IdentityNormalizationIssue[] = [];
  if (sourceSchemaVersion !== IDENTITY_NORMALIZATION_SOURCE_SCHEMA) {
    issue(
      issues,
      "error",
      "UNSUPPORTED_SCHEMA_VERSION",
      `identity normalization 只接受 schema v${IDENTITY_NORMALIZATION_SOURCE_SCHEMA}，当前为 v${sourceSchemaVersion}`,
      [`schema:v${sourceSchemaVersion}`],
    );
    return {
      reportVersion: IDENTITY_NORMALIZATION_REPORT_VERSION,
      sourceSchemaVersion,
      expectedSourceSchemaVersion: IDENTITY_NORMALIZATION_SOURCE_SCHEMA,
      migratable: false,
      counts: emptyCounts(),
      referenceCounts: {},
      accounts: [],
      invitations: [],
      duplicateEmails: [],
      issues,
    };
  }

  const members = db.query<LegacyMemberRow, []>(
    `SELECT id, workspace_id, name, email, external_provider, external_id, role, status, created_at
     FROM workspace_members ORDER BY created_at, id`,
  ).all();
  const memberById = new Map(members.map((member) => [member.id, member]));
  const candidates = buildCandidates(members);
  const candidateByMemberId = new Map<string, Candidate>();
  for (const candidate of candidates) {
    for (const member of candidate.members) candidateByMemberId.set(member.id, candidate);
  }
  const accountIdGroups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const group = accountIdGroups.get(candidate.accountId) ?? [];
    group.push(candidate);
    accountIdGroups.set(candidate.accountId, group);
  }
  for (const [accountId, group] of accountIdGroups) {
    if (group.length > 1) {
      issue(issues, "error", "PROJECTED_ACCOUNT_ID_COLLISION", "确定性 Account ID 发生碰撞，拒绝自动迁移", [accountId, ...group.flatMap((candidate) => candidate.members.map((member) => member.id))]);
    }
  }
  const membershipPairs = new Map<string, string[]>();
  for (const candidate of candidates) {
    for (const member of candidate.members) {
      const key = `${member.workspace_id}\0${candidate.accountId}`;
      const group = membershipPairs.get(key) ?? [];
      group.push(member.id);
      membershipPairs.set(key, group);
    }
  }
  for (const [key, memberIds] of membershipPairs) {
    if (memberIds.length > 1) {
      issue(issues, "error", "DUPLICATE_PROJECTED_MEMBERSHIP", "多个 legacy member 会归一化为同一 Workspace/Account Membership", [key.replace("\0", ":"), ...memberIds]);
    }
  }

  for (const member of members.filter(syntheticMember)) {
    const wellFormed =
      member.id === `member_system_${member.workspace_id}` &&
      member.external_provider === "local" &&
      member.external_id === null &&
      member.role === "owner" &&
      member.status === "active";
    if (!wellFormed) {
      issue(
        issues,
        "error",
        "MALFORMED_SYNTHETIC_MEMBER",
        "member_system_* 不符合 v13 bootstrap owner 形状，拒绝自动并入 bootstrap Account",
        [member.id, member.workspace_id],
      );
    }
  }

  for (const member of members) {
    if (member.external_provider !== "local" && !member.external_id?.trim()) {
      issue(
        issues,
        "warning",
        "EXTERNAL_PROVIDER_WITHOUT_SUBJECT",
        "legacy member 声明 external provider 但没有 subject；将作为独立 local Account 保留，不能自动登录",
        [member.id, member.workspace_id],
      );
    }
    if (member.external_provider === "local" && member.external_id !== null) {
      issue(
        issues,
        "warning",
        "UNTRUSTED_LOCAL_EXTERNAL_ID",
        "local external_id 不构成可信 identity key；不会据此合并 Account",
        [member.id, member.workspace_id],
      );
    }
  }

  const references = memberReferences(db);
  const referenceCounts: Record<string, number> = {};
  for (const ref of references) {
    referenceCounts[ref.source] = (referenceCounts[ref.source] ?? 0) + 1;
    const member = memberById.get(ref.memberId);
    if (!member) {
      issue(issues, "error", "ORPHAN_MEMBER_REFERENCE", "成员软引用指向不存在的 legacy member", [ref.source, ref.sourceId, ref.memberId]);
      continue;
    }
    if (member.status === "invited") {
      issue(issues, "error", "INVITED_MEMBER_REFERENCED", "invited row 已被领域数据引用，不能安全改写为 Invitation", [ref.source, ref.sourceId, ref.memberId]);
    }
    if (member.workspace_id !== ref.workspaceId) {
      issue(issues, "error", "CROSS_WORKSPACE_MEMBER_REFERENCE", "成员引用跨越 Workspace 边界", [ref.source, ref.sourceId, ref.memberId, ref.workspaceId, member.workspace_id]);
    }
  }

  const foreignKeyFailures = db.query<{
    table: string; rowid: number | null; parent: string; fkid: number;
  }, []>("PRAGMA foreign_key_check").all();
  for (const failure of foreignKeyFailures) {
    issue(
      issues,
      "error",
      "FOREIGN_KEY_FAILURE",
      "v22 数据库已有 foreign_key_check 失败，必须先修复再迁移",
      [failure.table, `rowid:${failure.rowid ?? "null"}`, failure.parent, `fkid:${failure.fkid}`],
    );
  }

  const workspaceRows = db.query<{ id: string }, []>("SELECT id FROM workspaces ORDER BY id").all();
  for (const workspace of workspaceRows) {
    const activeOwners = members.filter((member) =>
      member.workspace_id === workspace.id && member.status === "active" && member.role === "owner");
    if (activeOwners.length === 0) {
      issue(issues, "error", "WORKSPACE_WITHOUT_ACTIVE_OWNER", "Workspace 没有 active owner，无法确定 Invitation inviter 和所有权", [workspace.id]);
    }
  }

  const accountIdsByEmail = new Map<string, Set<string>>();
  const memberIdsByEmail = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    for (const member of candidate.members) {
      const email = normalizedEmail(member.email);
      if (!email) continue;
      const accountIds = accountIdsByEmail.get(email) ?? new Set<string>();
      accountIds.add(candidate.accountId);
      accountIdsByEmail.set(email, accountIds);
      const memberIds = memberIdsByEmail.get(email) ?? new Set<string>();
      memberIds.add(member.id);
      memberIdsByEmail.set(email, memberIds);
    }
  }
  const duplicateEmails = [...accountIdsByEmail.entries()]
    .filter(([, accountIds]) => accountIds.size > 1)
    .map(([email, accountIds]) => ({
      emailFingerprint: fingerprint(email),
      sourceMemberIds: [...(memberIdsByEmail.get(email) ?? [])].sort(),
      projectedAccountIds: [...accountIds].sort(),
    }))
    .sort((a, b) => a.emailFingerprint.localeCompare(b.emailFingerprint));
  for (const duplicate of duplicateEmails) {
    issue(
      issues,
      "warning",
      "DUPLICATE_EMAIL_NOT_MERGED",
      "相同 normalized email 属于多个 Account candidate；只报告，不自动合并，primary_email_normalized 留空",
      [...duplicate.sourceMemberIds, ...duplicate.projectedAccountIds],
    );
  }

  const accounts: IdentityAccountProjection[] = candidates.map((candidate) => {
    const emails = [...new Set(candidate.members.map((member) => normalizedEmail(member.email)).filter((email): email is string => !!email))];
    const unique = emails.length === 1 && accountIdsByEmail.get(emails[0]!)?.size === 1;
    if (emails.length > 1) {
      issue(
        issues,
        "warning",
        "EXTERNAL_IDENTITY_EMAIL_CONFLICT",
        "同一 Account candidate 的 legacy memberships 带有不同 email；不会选择可登录 normalized email",
        candidate.members.map((member) => member.id),
      );
    }
    return {
      accountId: candidate.accountId,
      kind: candidate.kind,
      sourceMemberIds: candidate.members.map((member) => member.id).sort(),
      workspaceIds: [...new Set(candidate.members.map((member) => member.workspace_id))].sort(),
      externalProvider: candidate.externalProvider,
      externalSubjectFingerprint: candidate.externalSubject ? fingerprint(candidate.externalSubject) : null,
      primaryEmailState: emails.length === 0 ? "none" : unique ? "unique" : "ambiguous",
      primaryEmailFingerprint: unique ? fingerprint(emails[0]!) : null,
      displayNameSourceMemberId: candidate.members[0]!.id,
    };
  });

  const invitedMembers = members.filter((member) => member.status === "invited");
  const invitations: IdentityInvitationProjection[] = invitedMembers.map((member) => {
    const owner = members
      .filter((candidate) => candidate.workspace_id === member.workspace_id && candidate.status === "active" && candidate.role === "owner")
      .sort(stableMemberOrder)[0];
    const refCount = references.filter((ref) => ref.memberId === member.id).length;
    if (!member.email?.trim()) {
      issue(issues, "warning", "INVITATION_WITHOUT_EMAIL", "legacy invited row 没有 email；迁移后只能由 owner 撤销或重新邀请", [member.id, member.workspace_id]);
    }
    return {
      invitationId: member.id,
      sourceMemberId: member.id,
      workspaceId: member.workspace_id,
      role: member.role,
      emailFingerprint: normalizedEmail(member.email) ? fingerprint(normalizedEmail(member.email)!) : null,
      invitedByAccountId: owner ? candidateByMemberId.get(owner.id)?.accountId ?? null : null,
      referenceCount: refCount,
    };
  }).sort((a, b) => a.invitationId.localeCompare(b.invitationId));

  const workspaceApiTokens = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM workspace_api_tokens").get()?.count ?? 0;
  const disabledTokenRows = db.query<{ token_id: string; member_id: string }, []>(
    `SELECT t.id AS token_id, t.member_id
     FROM workspace_api_tokens t JOIN workspace_members m ON m.id = t.member_id
     WHERE m.status = 'disabled' AND t.revoked_at IS NULL`,
  ).all();
  for (const row of disabledTokenRows) {
    issue(issues, "warning", "DISABLED_MEMBER_TOKEN_WILL_REVOKE", "disabled member 的 legacy token 会迁为已撤销 PAT", [row.token_id, row.member_id]);
  }

  issues.sort((a, b) =>
    a.severity.localeCompare(b.severity) || a.code.localeCompare(b.code) || a.refs.join("\0").localeCompare(b.refs.join("\0")));
  const counts = {
    workspaces: workspaceRows.length,
    legacyMembers: members.length,
    activeMembers: members.filter((member) => member.status === "active").length,
    disabledMembers: members.filter((member) => member.status === "disabled").length,
    invitedRows: invitedMembers.length,
    syntheticMembers: members.filter(syntheticMember).length,
    externalIdentityMembers: members.filter(trustedExternal).length,
    localMembers: members.filter((member) => !syntheticMember(member) && !trustedExternal(member) && member.status !== "invited").length,
    workspaceApiTokens,
    projectedAccounts: candidates.length,
    projectedAuthIdentities: candidates.filter((candidate) => candidate.kind === "external").length,
    projectedMemberships: members.length - invitedMembers.length,
    projectedInvitations: invitedMembers.length,
  };
  return {
    reportVersion: IDENTITY_NORMALIZATION_REPORT_VERSION,
    sourceSchemaVersion,
    expectedSourceSchemaVersion: IDENTITY_NORMALIZATION_SOURCE_SCHEMA,
    migratable: !issues.some((entry) => entry.severity === "error"),
    counts,
    referenceCounts,
    accounts,
    invitations,
    duplicateEmails,
    issues,
  };
}

interface LegacyTokenRow {
  id: string;
  workspace_id: string;
  member_id: string;
  label: string;
  token_hash: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

/**
 * v23 migration transaction 内调用。DDL 必须已经创建 v23 tables/columns，user_version 仍为 22。
 * 这里消费同一份 dry-run report；若 report 不可迁移则绝不写入。
 */
export function applyIdentityNormalization(db: Database, report: IdentityNormalizationReport): void {
  if (report.sourceSchemaVersion !== IDENTITY_NORMALIZATION_SOURCE_SCHEMA || !report.migratable) {
    throw new Error("identity normalization report 未通过，拒绝 backfill");
  }
  const members = db.query<LegacyMemberRow, []>(
    `SELECT id, workspace_id, name, email, external_provider, external_id, role, status, created_at
     FROM workspace_members ORDER BY created_at, id`,
  ).all();
  const candidates = buildCandidates(members);
  const projectionByAccountId = new Map(report.accounts.map((account) => [account.accountId, account]));
  const candidateByMemberId = new Map<string, Candidate>();
  for (const candidate of candidates) {
    for (const member of candidate.members) candidateByMemberId.set(member.id, candidate);
  }

  const insertAccount = db.prepare(
    `INSERT INTO accounts
     (id, display_name, primary_email, primary_email_normalized, status, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  );
  const insertIdentity = db.prepare(
    `INSERT INTO auth_identities
     (id, account_id, provider, subject, email, verified_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const candidate of candidates) {
    const projection = projectionByAccountId.get(candidate.accountId);
    if (!projection) throw new Error(`identity projection 缺少 ${candidate.accountId}`);
    const first = candidate.members[0]!;
    const emailMember = candidate.members.find((member) => normalizedEmail(member.email));
    const primaryEmail = emailMember?.email?.trim() || null;
    const primaryEmailNormalized = projection.primaryEmailState === "unique"
      ? normalizedEmail(primaryEmail)
      : null;
    const status = candidate.members.some((member) => member.status === "active") ? "active" : "suspended";
    const createdAt = Math.min(...candidate.members.map((member) => member.created_at));
    const updatedAt = Math.max(...candidate.members.map((member) => member.created_at));
    insertAccount.run(
      candidate.accountId,
      first.name,
      primaryEmail,
      primaryEmailNormalized,
      status,
      createdAt,
      updatedAt,
    );
    if (candidate.kind === "external" && candidate.externalProvider && candidate.externalSubject) {
      const identityHash = createHash("sha256")
        .update(`${candidate.externalProvider}\0${candidate.externalSubject}`)
        .digest("hex");
      insertIdentity.run(
        `auth_${identityHash}`,
        candidate.accountId,
        candidate.externalProvider,
        candidate.externalSubject,
        primaryEmail,
        createdAt,
        createdAt,
      );
    }
  }

  const setMembershipAccount = db.prepare("UPDATE workspace_members SET account_id = ? WHERE id = ?");
  for (const candidate of candidates) {
    for (const member of candidate.members) setMembershipAccount.run(candidate.accountId, member.id);
  }

  const invitationById = new Map(report.invitations.map((invitation) => [invitation.sourceMemberId, invitation]));
  const insertInvitation = db.prepare(
    `INSERT INTO workspace_invitations
     (id, workspace_id, email, role, token_hash, status, invited_by_account_id, expires_at, created_at, accepted_at)
     VALUES (?, ?, ?, ?, ?, 'expired', ?, ?, ?, NULL)`,
  );
  for (const member of members.filter((entry) => entry.status === "invited")) {
    const projection = invitationById.get(member.id);
    if (!projection?.invitedByAccountId) throw new Error(`Invitation ${member.id} 缺少 active owner inviter`);
    const unusableLegacyTokenHash = createHash("sha256")
      .update(`harbor:v23:expired-legacy-invitation:${member.id}`)
      .digest("hex");
    insertInvitation.run(
      member.id,
      member.workspace_id,
      member.email?.trim() || null,
      member.role,
      unusableLegacyTokenHash,
      projection.invitedByAccountId,
      member.created_at,
      member.created_at,
    );
  }

  const tokens = db.query<LegacyTokenRow, []>(
    `SELECT id, workspace_id, member_id, label, token_hash, created_at, last_used_at, revoked_at
     FROM workspace_api_tokens ORDER BY created_at, id`,
  ).all();
  const insertPat = db.prepare(
    `INSERT INTO personal_access_tokens
     (id, account_id, workspace_id, label, prefix, token_hash, scopes, created_at, expires_at, last_used_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  );
  const legacyScopes = JSON.stringify([
    "workspace:read",
    "workspace:write",
    "agent:run",
    "agent:manage",
    "device:manage",
  ]);
  for (const token of tokens) {
    const member = members.find((entry) => entry.id === token.member_id);
    const candidate = candidateByMemberId.get(token.member_id);
    if (!member || !candidate) throw new Error(`legacy token ${token.id} 的 member 无法归一化`);
    insertPat.run(
      token.id,
      candidate.accountId,
      token.workspace_id,
      token.label,
      "harbor_legacy",
      token.token_hash,
      legacyScopes,
      token.created_at,
      token.last_used_at,
      token.revoked_at ?? (member.status === "disabled" ? token.created_at : null),
    );
  }

  const updateWorkspace = db.prepare(
    "UPDATE workspaces SET kind = ?, created_by_account_id = ? WHERE id = ?",
  );
  const workspaces = db.query<{ id: string }, []>("SELECT id FROM workspaces ORDER BY created_at, id").all();
  for (const workspace of workspaces) {
    const owner = members
      .filter((member) => member.workspace_id === workspace.id && member.status === "active" && member.role === "owner")
      .sort(stableMemberOrder)[0];
    const accountId = owner ? candidateByMemberId.get(owner.id)?.accountId : null;
    if (!accountId) throw new Error(`Workspace ${workspace.id} 缺少可归一化 active owner`);
    updateWorkspace.run(workspace.id === "ws_personal" ? "personal" : "team", accountId, workspace.id);
  }

  // invited row 已完整投影为 expired Invitation，且 dry-run 证明不存在任何硬/软引用。
  db.run("DELETE FROM workspace_members WHERE status = 'invited'");
}

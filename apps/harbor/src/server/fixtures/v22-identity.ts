import { Database } from "bun:sqlite";
import { openV22MigrationFixtureDb } from "../db.js";
import { HarborStore } from "../store.js";

export const V22_IDENTITY_FIXTURE_IDS = {
  personalWorkspace: "ws_personal",
  teamWorkspace: "ws_fixture_team",
  secondTeamWorkspace: "ws_fixture_team_two",
  personalSystemMember: "member_system_ws_personal",
  teamSystemMember: "member_system_ws_fixture_team",
  secondTeamSystemMember: "member_system_ws_fixture_team_two",
  duplicateEmailFirstMember: "mem_duplicate_first",
  duplicateEmailSecondMember: "mem_duplicate_second",
  feishuFirstMember: "mem_feishu_first",
  feishuSecondMember: "mem_feishu_second",
  disabledMember: "mem_disabled",
  invitedMember: "mem_invited",
  externalToken: "tok_external",
  disabledToken: "tok_disabled",
} as const;

export interface V22IdentityFixture {
  db: Database;
  store: HarborStore;
  ids: typeof V22_IDENTITY_FIXTURE_IDS & {
    agent: string;
    conversation: string;
    message: string;
  };
}

/**
 * P6.1 的 canonical v22 input：
 * - 两个 synthetic owner 应合并到 bootstrap Account；
 * - 同一 Feishu subject 跨 Workspace 应合并；
 * - 相同 email 的两个 local member 不应合并；
 * - disabled member 保留 Membership、active token 应撤销；
 * - invited row 应迁成 Invitation；
 * - Agent / Conversation / Message / token 覆盖全部 legacy member reference 面。
 */
export function createV22IdentityFixture(path = ":memory:"): V22IdentityFixture {
  const db = openV22MigrationFixtureDb(path);
  const store = new HarborStore(db);
  const ids = V22_IDENTITY_FIXTURE_IDS;
  const insertWorkspace = db.prepare(
    `INSERT INTO workspaces (id, name, slug, description, created_at, archived_at)
     VALUES (?, ?, ?, NULL, ?, NULL)`,
  );
  insertWorkspace.run(ids.teamWorkspace, "Fixture team", "fixture-team", 100);
  insertWorkspace.run(ids.secondTeamWorkspace, "Fixture team two", "fixture-team-two", 101);
  const insertMember = db.prepare(
    `INSERT INTO workspace_members
     (id, workspace_id, name, email, external_provider, external_id, role, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertMember.run(ids.teamSystemMember, ids.teamWorkspace, "Local owner", null, "local", null, "owner", "active", 102);
  insertMember.run(ids.secondTeamSystemMember, ids.secondTeamWorkspace, "Local owner", null, "local", null, "owner", "active", 103);
  insertMember.run(ids.duplicateEmailFirstMember, ids.teamWorkspace, "Local A", "Same@Example.com", "local", null, "member", "active", 104);
  insertMember.run(ids.duplicateEmailSecondMember, ids.secondTeamWorkspace, "Local B", " same@example.com ", "local", null, "member", "active", 105);
  insertMember.run(ids.feishuFirstMember, ids.teamWorkspace, "Feishu user", "feishu@example.com", "feishu", "ou_fixture", "admin", "active", 106);
  insertMember.run(ids.feishuSecondMember, ids.secondTeamWorkspace, "Feishu user", "FEISHU@example.com", "feishu", "ou_fixture", "member", "active", 107);
  insertMember.run(ids.disabledMember, ids.teamWorkspace, "Former member", "former@example.com", "local", null, "member", "disabled", 108);
  insertMember.run(ids.invitedMember, ids.secondTeamWorkspace, "Invitee", "invitee@example.com", "local", null, "member", "invited", 109);

  db.run(
    `INSERT INTO workspace_api_tokens
     (id, workspace_id, member_id, label, token_hash, created_at, last_used_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
    [ids.externalToken, ids.teamWorkspace, ids.feishuFirstMember, "External CLI", "fixture-token-external", 110],
  );
  db.run(
    `INSERT INTO workspace_api_tokens
     (id, workspace_id, member_id, label, token_hash, created_at, last_used_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
    [ids.disabledToken, ids.teamWorkspace, ids.disabledMember, "Former CLI", "fixture-token-disabled", 111],
  );

  const device = store.upsertDevice("fixture-device", "fixture-device-token", { clis: { claude: "fixture" }, endpoints: [] }, 112);
  const repository = store.createRepository({ workspaceId: ids.teamWorkspace, name: "fixture-repository" }, 113);
  store.setRepositoryMount(repository.id, device.id, "/fixture/repository", 114);
  const agent = store.createAgent({
    workspaceId: ids.teamWorkspace,
    name: "fixture-agent",
    deviceId: device.id,
    backend: "claude",
    repositoryId: repository.id,
    createdByMemberId: ids.feishuFirstMember,
  }, 115);
  const conversation = store.createConversation({
    workspaceId: ids.teamWorkspace,
    kind: "issue",
    title: "Fixture issue",
    agentId: agent.id,
    creatorMemberId: ids.duplicateEmailFirstMember,
    ownerMemberId: ids.feishuFirstMember,
  }, 116);
  const message = store.appendConversationMessage(conversation.id, {
    authorType: "member",
    authorId: ids.feishuFirstMember,
    authorName: "Feishu user",
    body: "Fixture message",
    externalId: null,
  }, 117);

  return {
    db,
    store,
    ids: { ...ids, agent: agent.id, conversation: conversation.id, message: message.id },
  };
}

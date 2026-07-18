import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.js";
import { renderRunPrompt } from "./prompt-wrapper.js";
import { HarborStore } from "./store.js";

test("legacy database migrates through latest schema without losing conversations, runs, or prompts", () => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-v4-"));
  const path = join(dir, "legacy.db");
  try {
    const legacy = new Database(path, { create: true });
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE devices (
        id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, token_hash TEXT NOT NULL,
        capabilities TEXT NOT NULL DEFAULT '{}', last_seen_at INTEGER, created_at INTEGER NOT NULL
      );
      CREATE TABLE agents (
        id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT,
        device_id TEXT NOT NULL REFERENCES devices(id), backend TEXT NOT NULL,
        model TEXT, permission TEXT NOT NULL DEFAULT 'auto-edit', workdir TEXT NOT NULL,
        isolation TEXT NOT NULL DEFAULT 'none', instruction TEXT, created_at INTEGER NOT NULL, archived_at INTEGER
      );
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT,
        agent_id TEXT NOT NULL REFERENCES agents(id), status TEXT NOT NULL DEFAULT 'backlog',
        worktree_path TEXT, claude_session_id TEXT, origin TEXT NOT NULL DEFAULT 'cli',
        origin_ref TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
        agent_id TEXT NOT NULL, device_id TEXT NOT NULL, prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued', claude_session_id TEXT, error TEXT,
        cost_usd REAL, input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER,
        queued_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER
      );
      CREATE INDEX idx_runs_device_status ON runs(device_id, status);
      CREATE INDEX idx_runs_conversation ON runs(conversation_id);
      CREATE INDEX idx_conversations_origin ON conversations(origin, origin_ref);
      CREATE TABLE status_log (
        conversation_id TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL,
        actor TEXT NOT NULL, ts INTEGER NOT NULL
      );
      CREATE TABLE automations (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, agent_id TEXT NOT NULL REFERENCES agents(id),
        cron TEXT NOT NULL, prompt TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'new_issue',
        target_conversation_id TEXT, notify_chat_id TEXT, enabled INTEGER NOT NULL DEFAULT 1,
        last_fired_at INTEGER
      );
      CREATE TABLE automation_log (
        automation_id TEXT NOT NULL, kind TEXT NOT NULL, ts INTEGER NOT NULL, run_id TEXT, note TEXT
      );
      CREATE TABLE prompt_templates (
        source TEXT PRIMARY KEY CHECK (source IN ('issue','chat','automation')),
        enabled INTEGER NOT NULL DEFAULT 1,
        template TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO devices VALUES ('device_1', 'worker', 'hash', '{}', NULL, 1);
      INSERT INTO agents VALUES ('agent_1', 'builder', NULL, 'device_1', 'claude', NULL, 'auto-edit', '/repo', 'none', NULL, 2, NULL);
      INSERT INTO conversations VALUES ('conversation_1', 'issue', 'Legacy issue', 'agent_1', 'doing', '/repo/wt', 'session_1', 'cli', NULL, 3, 4);
      INSERT INTO runs VALUES ('run_1', 'conversation_1', 'agent_1', 'device_1', 'legacy prompt', 'succeeded', 'session_1', NULL, 0.1, 10, 20, 5, 5, 6, 7);
      INSERT INTO prompt_templates VALUES ('issue', 1, 'Legacy={{conversation.id}} Request={{prompt}}', 8);
      PRAGMA user_version = 3;
    `);
    legacy.close();

    const migrated = openDb(path);
    expect(migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(14);
    expect(
      migrated.query<{ agent_id: string | null; description: string | null; priority: string; status: string }, []>(
        "SELECT agent_id, description, priority, status FROM conversations WHERE id = 'conversation_1'",
      ).get(),
    ).toEqual({ agent_id: "agent_1", description: null, priority: "medium", status: "review" });
    expect(
      migrated.query<{ source_type: string; source_id: string; purpose: string; prompt: string; prompt_event: string; trigger_ref: string | null }, []>(
        "SELECT source_type, source_id, purpose, prompt, prompt_event, trigger_ref FROM runs WHERE id = 'run_1'",
      ).get(),
    ).toEqual({
      source_type: "issue",
      source_id: "conversation_1",
      purpose: "implementation",
      prompt: "legacy prompt",
      prompt_event: "event.issue.message_created",
      trigger_ref: null,
    });
    expect(
      migrated.query<{ workspace_id: string; repository_name: string; path: string }, []>(
        `SELECT a.workspace_id, r.name AS repository_name, m.path
         FROM agents a
         JOIN repositories r ON r.id = a.repository_id
         JOIN repository_mounts m ON m.repository_id = r.id AND m.device_id = a.device_id
         WHERE a.id = 'agent_1'`,
      ).get(),
    ).toEqual({ workspace_id: "ws_personal", repository_name: "repo", path: "/repo" });
    expect(
      migrated.query<{ workspace_id: string; repository_id: string; worktree_mount_id: string }, []>(
        "SELECT workspace_id, repository_id, worktree_mount_id FROM conversations WHERE id = 'conversation_1'",
      ).get(),
    ).toEqual(expect.objectContaining({ workspace_id: "ws_personal" }));
    expect(
      migrated.query<{ workspace_id: string; execution_root: string }, []>(
        "SELECT workspace_id, execution_root FROM runs WHERE id = 'run_1'",
      ).get(),
    ).toEqual({ workspace_id: "ws_personal", execution_root: "/repo/wt" });
    expect(
      migrated.query<{ enabled: number; template: string }, []>(
        "SELECT enabled, template FROM workspace_prompt_blocks WHERE workspace_id = 'ws_personal' AND block_key = 'session.issue.context'",
      ).get(),
    ).toEqual({ enabled: 1, template: "Legacy={{conversation.id}} Request={{prompt}}" });
    const migratedStore = new HarborStore(migrated);
    expect(
      renderRunPrompt(migratedStore, {
        run: migratedStore.getRun("run_1")!,
        conversation: migratedStore.getConversation("conversation_1")!,
        agent: migratedStore.getAgent("agent_1")!,
      }),
    ).toBe("Legacy=conversation_1 Request=legacy prompt");
    expect(migrated.query<unknown, []>("PRAGMA foreign_key_check").all()).toEqual([]);

    migrated.run(
      `INSERT INTO conversations
       (id, kind, title, agent_id, description, priority, status, origin, created_at, updated_at)
       VALUES ('conversation_2', 'issue', 'Unassigned', NULL, 'new', 'low', 'backlog', 'web', 8, 8)`,
    );
    expect(migrated.query<{ agent_id: null }, []>("SELECT agent_id FROM conversations WHERE id = 'conversation_2'").get()).toEqual({ agent_id: null });
    migrated.run(
      `INSERT INTO conversations
       (id, kind, title, agent_id, description, priority, status, origin, origin_ref, created_at, updated_at)
       VALUES ('draft_1', 'issue_draft', NULL, 'agent_1', 'triage me', 'medium', 'open', 'web', 'ai-draft', 9, 9)`,
    );
    migrated.run(
      `INSERT INTO runs
       (id, workspace_id, source_type, source_id, conversation_id, agent_id, device_id,
        prompt, purpose, prompt_event, status, queued_at)
       VALUES ('triage_1', 'ws_personal', 'issue', 'draft_1', 'draft_1', 'agent_1', 'device_1',
        'triage me', 'triage', 'event.issue.message_created', 'queued', 10)`,
    );
    expect(migrated.query<{ kind: string }, []>("SELECT kind FROM conversations WHERE id = 'draft_1'").get()).toEqual({ kind: "issue_draft" });
    expect(migrated.query<{ purpose: string }, []>("SELECT purpose FROM runs WHERE id = 'triage_1'").get()).toEqual({ purpose: "triage" });
    expect(
      migrated.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'deliveries'").get(),
    ).toEqual({ name: "deliveries" });
    migrated.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("latest schema upgrades an already-running v9 database and preserves unbound Agents", () => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-v9-"));
  const path = join(dir, "v9.db");
  try {
    const v9 = new Database(path, { create: true });
    v9.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, slug TEXT UNIQUE NOT NULL,
        description TEXT, created_at INTEGER NOT NULL, archived_at INTEGER
      );
      CREATE TABLE devices (
        id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, token_hash TEXT NOT NULL,
        capabilities TEXT NOT NULL DEFAULT '{}', last_seen_at INTEGER, created_at INTEGER NOT NULL
      );
      CREATE TABLE repositories (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL,
        remote_url TEXT, default_branch TEXT NOT NULL DEFAULT 'main', created_at INTEGER NOT NULL,
        archived_at INTEGER, UNIQUE (workspace_id, name)
      );
      CREATE TABLE agents (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL,
        description TEXT, device_id TEXT NOT NULL REFERENCES devices(id), backend TEXT NOT NULL,
        model TEXT, permission TEXT NOT NULL DEFAULT 'auto-edit',
        default_repository_id TEXT REFERENCES repositories(id), isolation TEXT NOT NULL DEFAULT 'none',
        instruction TEXT, created_at INTEGER NOT NULL, archived_at INTEGER, UNIQUE (workspace_id, name)
      );
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY, workspace_id TEXT REFERENCES workspaces(id), kind TEXT NOT NULL, title TEXT,
        agent_id TEXT REFERENCES agents(id), description TEXT, priority TEXT NOT NULL DEFAULT 'medium',
        status TEXT NOT NULL DEFAULT 'backlog', repository_id TEXT REFERENCES repositories(id),
        worktree_path TEXT, worktree_mount_id TEXT, claude_session_id TEXT, origin TEXT NOT NULL DEFAULT 'web',
        origin_ref TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE automations (
        id TEXT PRIMARY KEY, workspace_id TEXT REFERENCES workspaces(id), name TEXT NOT NULL,
        agent_id TEXT NOT NULL REFERENCES agents(id), repository_id TEXT REFERENCES repositories(id),
        cron TEXT NOT NULL, prompt TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'new_issue',
        target_conversation_id TEXT, notify_chat_id TEXT, enabled INTEGER NOT NULL DEFAULT 1,
        last_fired_at INTEGER
      );
      CREATE TABLE automation_log (
        automation_id TEXT NOT NULL, kind TEXT NOT NULL, ts INTEGER NOT NULL, run_id TEXT, note TEXT
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, workspace_id TEXT REFERENCES workspaces(id), conversation_id TEXT NOT NULL,
        agent_id TEXT NOT NULL, device_id TEXT NOT NULL, repository_id TEXT REFERENCES repositories(id),
        repository_mount_id TEXT, execution_root TEXT, prompt TEXT NOT NULL,
        purpose TEXT NOT NULL DEFAULT 'implementation', status TEXT NOT NULL DEFAULT 'queued',
        claude_session_id TEXT, error TEXT, cost_usd REAL, input_tokens INTEGER, output_tokens INTEGER,
        cached_tokens INTEGER, queued_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER
      );
      CREATE TABLE prompt_templates (
        source TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1,
        template TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE workspace_prompt_templates (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        source TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        template TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, source)
      );
      INSERT INTO workspaces VALUES ('ws_personal', 'Personal', 'personal', NULL, 1, NULL);
      INSERT INTO devices VALUES ('device_1', 'worker', 'hash', '{}', NULL, 1);
      INSERT INTO agents VALUES ('agent_1', 'ws_personal', 'unbound', NULL, 'device_1', 'claude', NULL, 'auto-edit', NULL, 'none', NULL, 2, NULL);
      INSERT INTO conversations VALUES ('conversation_1', 'ws_personal', 'issue', 'Keep me', 'agent_1', NULL, 'medium', 'backlog', NULL, NULL, NULL, NULL, 'web', NULL, 3, 3);
      INSERT INTO automations VALUES ('automation_1', 'ws_personal', 'nightly', 'agent_1', NULL, '0 0 * * *', 'Run', 'new_issue', NULL, NULL, 1, NULL);
      INSERT INTO workspace_prompt_templates VALUES ('ws_personal', 'issue', 1, 'Legacy={{prompt}}', 4);
      PRAGMA user_version = 9;
    `);
    v9.close();

    const migrated = openDb(path);
    expect(migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(14);
    const agent = migrated.query<{ repository_id: string }, []>("SELECT repository_id FROM agents WHERE id = 'agent_1'").get();
    expect(agent?.repository_id).toStartWith("repo_unconfigured_");
    expect(migrated.query<{ repository_id: string }, []>("SELECT repository_id FROM conversations WHERE id = 'conversation_1'").get()).toEqual(agent);
    expect(migrated.query<{ repository_id: string }, []>("SELECT repository_id FROM automations WHERE id = 'automation_1'").get()).toEqual(agent);
    expect(
      migrated.query<{ name: string }, []>("PRAGMA table_info(agents)").all().map((column) => column.name),
    ).toContain("repository_id");
    expect(
      migrated.query<{ template: string }, []>(
        "SELECT template FROM workspace_prompt_blocks WHERE workspace_id = 'ws_personal' AND block_key = 'session.issue.context'",
      ).get(),
    ).toEqual({ template: "Legacy={{prompt}}" });
    expect(migrated.query<unknown, []>("PRAGMA foreign_key_check").all()).toEqual([]);
    migrated.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

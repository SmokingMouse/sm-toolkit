import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.js";

test("v4 migration preserves legacy conversations and runs while adding workflow fields", () => {
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
      INSERT INTO devices VALUES ('device_1', 'worker', 'hash', '{}', NULL, 1);
      INSERT INTO agents VALUES ('agent_1', 'builder', NULL, 'device_1', 'claude', NULL, 'auto-edit', '/repo', 'none', NULL, 2, NULL);
      INSERT INTO conversations VALUES ('conversation_1', 'issue', 'Legacy issue', 'agent_1', 'doing', '/repo/wt', 'session_1', 'cli', NULL, 3, 4);
      INSERT INTO runs VALUES ('run_1', 'conversation_1', 'agent_1', 'device_1', 'legacy prompt', 'succeeded', 'session_1', NULL, 0.1, 10, 20, 5, 5, 6, 7);
      PRAGMA user_version = 3;
    `);
    legacy.close();

    const migrated = openDb(path);
    expect(migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(8);
    expect(
      migrated.query<{ agent_id: string | null; description: string | null; priority: string; status: string }, []>(
        "SELECT agent_id, description, priority, status FROM conversations WHERE id = 'conversation_1'",
      ).get(),
    ).toEqual({ agent_id: "agent_1", description: null, priority: "medium", status: "review" });
    expect(
      migrated.query<{ purpose: string; prompt: string }, []>(
        "SELECT purpose, prompt FROM runs WHERE id = 'run_1'",
      ).get(),
    ).toEqual({ purpose: "implementation", prompt: "legacy prompt" });

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
       (id, conversation_id, agent_id, device_id, prompt, purpose, status, queued_at)
       VALUES ('triage_1', 'draft_1', 'agent_1', 'device_1', 'triage me', 'triage', 'queued', 10)`,
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

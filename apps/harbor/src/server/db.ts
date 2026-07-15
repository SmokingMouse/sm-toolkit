/**
 * SQLite 打开 + 幂等迁移（PRAGMA user_version 版本化）。
 * schema 单一真相源 = progress/harbor.md §4；automations/approvals 表 P1 一并建好
 * （schema 一次到位），API/逻辑分别在 P3/P2 接入。
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const MIGRATIONS: string[] = [
  // v1 —— 全部领域表
  `
  CREATE TABLE devices (
    id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, token_hash TEXT NOT NULL,
    capabilities TEXT NOT NULL DEFAULT '{}',
    last_seen_at INTEGER, created_at INTEGER NOT NULL
  );
  CREATE TABLE agents (
    id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT,
    device_id TEXT NOT NULL REFERENCES devices(id),
    backend TEXT NOT NULL CHECK (backend IN ('claude','codex')),
    model TEXT,
    permission TEXT NOT NULL DEFAULT 'auto-edit',
    workdir TEXT NOT NULL,
    isolation TEXT NOT NULL DEFAULT 'none' CHECK (isolation IN ('none','worktree')),
    instruction TEXT,
    created_at INTEGER NOT NULL, archived_at INTEGER
  );
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('chat','issue')),
    title TEXT, agent_id TEXT NOT NULL REFERENCES agents(id),
    status TEXT NOT NULL DEFAULT 'backlog',
    worktree_path TEXT,
    claude_session_id TEXT,
    origin TEXT NOT NULL DEFAULT 'cli',
    origin_ref TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE runs (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
    agent_id TEXT NOT NULL, device_id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    claude_session_id TEXT, error TEXT,
    cost_usd REAL, input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER,
    queued_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER
  );
  CREATE INDEX idx_runs_device_status ON runs(device_id, status);
  CREATE INDEX idx_runs_conversation ON runs(conversation_id);
  CREATE TABLE run_events (
    run_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL,
    data TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (run_id, seq)
  );
  CREATE TABLE automations (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, agent_id TEXT NOT NULL REFERENCES agents(id),
    cron TEXT NOT NULL, prompt TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'new_issue' CHECK (mode IN ('new_issue','append')),
    target_conversation_id TEXT,
    enabled INTEGER NOT NULL DEFAULT 1, last_fired_at INTEGER
  );
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, request_id TEXT NOT NULL,
    tool_name TEXT NOT NULL, input TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','allowed','denied','expired')),
    decided_at INTEGER, created_at INTEGER NOT NULL
  );
  CREATE TABLE status_log (
    conversation_id TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL,
    actor TEXT NOT NULL, ts INTEGER NOT NULL
  );
  `,
];

export function openDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  let version = row?.user_version ?? 0;
  while (version < MIGRATIONS.length) {
    const sql = MIGRATIONS[version]!;
    db.transaction(() => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    })();
    version++;
  }
  return db;
}

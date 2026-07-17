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
  // v2 —— P2/P3 增量：审批路由/飞书绑定/automation 日志/查询索引
  `
  ALTER TABLE approvals ADD COLUMN decided_by TEXT;             -- cli|feishu|sweep|system
  ALTER TABLE approvals ADD COLUMN feishu_message_id TEXT;      -- 审批卡片 id（过期/决议后改卡）
  ALTER TABLE automations ADD COLUMN notify_chat_id TEXT;       -- 完成播报群（白名单闸在 server 配置）
  CREATE TABLE chat_bindings (                                  -- 飞书群 → 默认 agent
    chat_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id),
    created_at INTEGER NOT NULL
  );
  CREATE TABLE automation_log (                                 -- fired/missed 留档（跳过不补跑）
    automation_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('fired','missed')),
    ts INTEGER NOT NULL, run_id TEXT, note TEXT
  );
  CREATE INDEX idx_conversations_origin ON conversations(origin, origin_ref);
  CREATE INDEX idx_approvals_status ON approvals(status);
  CREATE INDEX idx_approvals_run ON approvals(run_id);
  CREATE INDEX idx_run_events_ts ON run_events(ts);
  CREATE INDEX idx_automation_log ON automation_log(automation_id, ts);
  `,
  // v3 —— P4.6：按来源可配置的 server 级 Prompt wrapper
  `
  CREATE TABLE prompt_templates (
    source TEXT PRIMARY KEY CHECK (source IN ('issue','chat','automation')),
    enabled INTEGER NOT NULL DEFAULT 1,
    template TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // v4 —— P4.10：Mew 式 Issue 工作流（可空 Assignee / Ready / 描述优先级 / Run purpose）
  `
  CREATE TABLE conversations_v4 (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('chat','issue')),
    title TEXT, agent_id TEXT REFERENCES agents(id),
    description TEXT,
    priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('none','low','medium','high','urgent')),
    status TEXT NOT NULL DEFAULT 'backlog',
    worktree_path TEXT,
    claude_session_id TEXT,
    origin TEXT NOT NULL DEFAULT 'cli',
    origin_ref TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  INSERT INTO conversations_v4
    (id, kind, title, agent_id, description, priority, status, worktree_path, claude_session_id, origin, origin_ref, created_at, updated_at)
    SELECT id, kind, title, agent_id, NULL, 'medium', status, worktree_path, claude_session_id, origin, origin_ref, created_at, updated_at
    FROM conversations;

  CREATE TABLE runs_v4 (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations_v4(id),
    agent_id TEXT NOT NULL, device_id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT 'implementation' CHECK (purpose IN ('implementation','review','verification')),
    status TEXT NOT NULL DEFAULT 'queued',
    claude_session_id TEXT, error TEXT,
    cost_usd REAL, input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER,
    queued_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER
  );
  INSERT INTO runs_v4
    (id, conversation_id, agent_id, device_id, prompt, purpose, status, claude_session_id, error,
     cost_usd, input_tokens, output_tokens, cached_tokens, queued_at, started_at, finished_at)
    SELECT id, conversation_id, agent_id, device_id, prompt, 'implementation', status, claude_session_id, error,
           cost_usd, input_tokens, output_tokens, cached_tokens, queued_at, started_at, finished_at
    FROM runs;

  DROP TABLE runs;
  DROP TABLE conversations;
  ALTER TABLE conversations_v4 RENAME TO conversations;
  ALTER TABLE runs_v4 RENAME TO runs;
  CREATE INDEX idx_runs_device_status ON runs(device_id, status);
  CREATE INDEX idx_runs_conversation ON runs(conversation_id);
  CREATE INDEX idx_conversations_origin ON conversations(origin, origin_ref);
  `,
  // v5 —— v4 前可能遗留「Run 已终态但 Issue 仍 doing」；按最后一次 implementation Run 修复阶段
  `
  INSERT INTO status_log (conversation_id, from_status, to_status, actor, ts)
    SELECT c.id, 'doing',
      CASE
        WHEN (SELECT r.status FROM runs r WHERE r.conversation_id = c.id AND r.purpose = 'implementation' ORDER BY r.queued_at DESC LIMIT 1) = 'succeeded'
          THEN 'review'
        ELSE 'todo'
      END,
      'system', CAST(strftime('%s','now') AS INTEGER) * 1000
    FROM conversations c
    WHERE c.kind = 'issue' AND c.status = 'doing'
      AND NOT EXISTS (
        SELECT 1 FROM runs active
        WHERE active.conversation_id = c.id AND active.status IN ('queued','running')
      );

  UPDATE conversations
    SET status = CASE
      WHEN (SELECT r.status FROM runs r WHERE r.conversation_id = conversations.id AND r.purpose = 'implementation' ORDER BY r.queued_at DESC LIMIT 1) = 'succeeded'
        THEN 'review'
      ELSE 'todo'
    END,
    updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
    WHERE kind = 'issue' AND status = 'doing'
      AND NOT EXISTS (
        SELECT 1 FROM runs active
        WHERE active.conversation_id = conversations.id AND active.status IN ('queued','running')
      );
  `,
  // v6 —— P4.11：Mew 式 AI issue draft（隐藏草稿 + 只读 triage Run）
  `
  CREATE TABLE conversations_v6 (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('chat','issue','issue_draft')),
    title TEXT, agent_id TEXT REFERENCES agents(id),
    description TEXT,
    priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('none','low','medium','high','urgent')),
    status TEXT NOT NULL DEFAULT 'backlog',
    worktree_path TEXT,
    claude_session_id TEXT,
    origin TEXT NOT NULL DEFAULT 'cli',
    origin_ref TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  INSERT INTO conversations_v6
    (id, kind, title, agent_id, description, priority, status, worktree_path, claude_session_id, origin, origin_ref, created_at, updated_at)
    SELECT id, kind, title, agent_id, description, priority, status, worktree_path, claude_session_id, origin, origin_ref, created_at, updated_at
    FROM conversations;

  CREATE TABLE runs_v6 (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations_v6(id),
    agent_id TEXT NOT NULL, device_id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT 'implementation' CHECK (purpose IN ('implementation','triage','review','verification')),
    status TEXT NOT NULL DEFAULT 'queued',
    claude_session_id TEXT, error TEXT,
    cost_usd REAL, input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER,
    queued_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER
  );
  INSERT INTO runs_v6
    (id, conversation_id, agent_id, device_id, prompt, purpose, status, claude_session_id, error,
     cost_usd, input_tokens, output_tokens, cached_tokens, queued_at, started_at, finished_at)
    SELECT id, conversation_id, agent_id, device_id, prompt, purpose, status, claude_session_id, error,
           cost_usd, input_tokens, output_tokens, cached_tokens, queued_at, started_at, finished_at
    FROM runs;

  DROP TABLE runs;
  DROP TABLE conversations;
  ALTER TABLE conversations_v6 RENAME TO conversations;
  ALTER TABLE runs_v6 RENAME TO runs;
  CREATE INDEX idx_runs_device_status ON runs(device_id, status);
  CREATE INDEX idx_runs_conversation ON runs(conversation_id);
  CREATE INDEX idx_conversations_origin ON conversations(origin, origin_ref);
  `,
  // v7 —— P4.12：Workspace Skill 配置 + Agent 多对多绑定
  `
  CREATE TABLE skills (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL CHECK (source IN ('manual','runtime')),
    instruction TEXT NOT NULL,
    device_id TEXT REFERENCES devices(id),
    source_path TEXT,
    runtimes TEXT NOT NULL DEFAULT '["claude","codex"]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER,
    CHECK (
      (source = 'manual' AND device_id IS NULL AND source_path IS NULL) OR
      (source = 'runtime' AND device_id IS NOT NULL AND source_path IS NOT NULL)
    )
  );
  CREATE UNIQUE INDEX idx_skills_runtime_source ON skills(device_id, source_path)
    WHERE source = 'runtime';
  CREATE TABLE agent_skills (
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (agent_id, skill_id)
  );
  CREATE INDEX idx_agent_skills_skill ON agent_skills(skill_id, agent_id);
  `,
  // v8 —— P4.13：代码交付控制面（MR/CI/合并/部署正交事实 + 审计事件）
  `
  CREATE TABLE deliveries (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id),
    provider TEXT NOT NULL,
    change_url TEXT,
    external_id TEXT,
    head_branch TEXT,
    base_branch TEXT,
    review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','approved')),
    check_status TEXT NOT NULL DEFAULT 'unknown' CHECK (check_status IN ('unknown','pending','passed','failed')),
    merge_status TEXT NOT NULL DEFAULT 'open' CHECK (merge_status IN ('open','merged')),
    deployment_status TEXT NOT NULL DEFAULT 'not_required' CHECK (deployment_status IN ('not_required','pending','running','succeeded','failed')),
    review_approved_at INTEGER,
    merged_at INTEGER,
    deployed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX idx_deliveries_conversation ON deliveries(conversation_id);
  CREATE TABLE delivery_events (
    delivery_id TEXT NOT NULL REFERENCES deliveries(id),
    kind TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    actor TEXT NOT NULL CHECK (actor IN ('human','system','provider')),
    ts INTEGER NOT NULL
  );
  CREATE INDEX idx_delivery_events ON delivery_events(delivery_id, ts);
  `,
  // v9 —— Mew 式 Prompt pipeline：session context + event trigger；Run 持久化触发原因
  `
  ALTER TABLE runs ADD COLUMN prompt_event TEXT NOT NULL DEFAULT 'event.issue.message_created'
    CHECK (prompt_event IN (
      'event.issue.assigned','event.issue.mentioned','event.issue.message_created',
      'event.chat.message_created','event.automation.schedule','event.automation.manual'
    ));
  ALTER TABLE runs ADD COLUMN trigger_ref TEXT;
  UPDATE runs
    SET prompt_event = CASE
      WHEN EXISTS (
        SELECT 1 FROM conversations c
        WHERE c.id = runs.conversation_id AND c.origin = 'automation'
      ) THEN 'event.automation.schedule'
      WHEN EXISTS (
        SELECT 1 FROM conversations c
        WHERE c.id = runs.conversation_id AND c.kind = 'chat'
      ) THEN 'event.chat.message_created'
      ELSE 'event.issue.message_created'
    END;
  UPDATE runs
    SET trigger_ref = (
      SELECT c.origin_ref FROM conversations c WHERE c.id = runs.conversation_id
    )
    WHERE prompt_event IN ('event.automation.schedule','event.automation.manual','event.issue.mentioned');

  CREATE TABLE prompt_blocks (
    block_key TEXT PRIMARY KEY CHECK (block_key IN (
      'session.issue.context','event.issue.assigned','event.issue.mentioned','event.issue.message_created',
      'session.chat.context','event.chat.message_created',
      'event.automation.schedule','event.automation.manual'
    )),
    enabled INTEGER NOT NULL DEFAULT 1,
    template TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- 旧 issue/chat wrapper 是 context + request 的合并模板。迁到 context 后，renderer
  -- 识别其中的 request 变量并继续单独渲染，重置该 block 后才切到两段式 pipeline。
  INSERT INTO prompt_blocks (block_key, enabled, template, updated_at)
    SELECT CASE source
      WHEN 'issue' THEN 'session.issue.context'
      WHEN 'chat' THEN 'session.chat.context'
      ELSE 'event.automation.schedule'
    END, enabled, template, updated_at
    FROM prompt_templates;
  INSERT INTO prompt_blocks (block_key, enabled, template, updated_at)
    SELECT 'event.automation.manual', enabled, template, updated_at
    FROM prompt_templates WHERE source = 'automation';

  -- 旧 source 被整体禁用时，event 也要透传原始请求，避免迁移后重新启用包装。
  INSERT INTO prompt_blocks (block_key, enabled, template, updated_at)
    SELECT event_key, 0, '', updated_at
    FROM prompt_templates
    JOIN (
      SELECT 'issue' AS source_key, 'event.issue.assigned' AS event_key
      UNION ALL SELECT 'issue', 'event.issue.mentioned'
      UNION ALL SELECT 'issue', 'event.issue.message_created'
      UNION ALL SELECT 'chat', 'event.chat.message_created'
    ) legacy_events ON legacy_events.source_key = prompt_templates.source
    WHERE prompt_templates.enabled = 0;

  DROP TABLE prompt_templates;
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

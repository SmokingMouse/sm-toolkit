/**
 * SQLite 打开 + 幂等迁移（PRAGMA user_version 版本化）。
 * schema 单一真相源 = progress/harbor.md §4；automations/approvals 表 P1 一并建好
 * （schema 一次到位），API/逻辑分别在 P3/P2 接入。
 */

import { Database } from "bun:sqlite";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { applyIdentityNormalization, inspectIdentityNormalization } from "./identity-normalization.js";
import { summarizeDeviceCapabilities } from "../device-summary.js";
import type { DeviceCapabilities } from "../protocol.js";

const APPLICATION_MUTATION_TABLES = [
  "devices",
  "agents",
  "conversations",
  "runs",
  "run_events",
  "automations",
  "approvals",
  "status_log",
  "prompt_templates",
  "chat_bindings",
  "automation_log",
  "workspaces",
  "repositories",
  "repository_mounts",
  "skills",
  "agent_skills",
  "workspace_prompt_templates",
  "workspace_prompt_blocks",
  "deliveries",
  "delivery_events",
  "automation_triggers",
  "automation_trigger_deliveries",
  "automation_legacy_archive_v25",
  "scm_events",
  "scm_external_objects",
  "workspace_members",
  "agent_repositories",
  "skill_groups",
  "skill_files",
  "skill_dependencies",
  "lark_workspace_bindings",
  "conversation_messages",
  "conversation_labels",
  "issue_labels",
  "run_attachments",
  "run_action_tokens",
  "domain_events",
  "workspace_api_tokens",
  "lark_message_links",
  "accounts",
  "auth_identities",
  "passkey_credentials",
  "account_recovery_codes",
  "account_sessions",
  "webauthn_challenges",
  "personal_access_tokens",
  "workspace_invitations",
] as const;

function maintenanceLinearizationSql(tables: readonly string[], includeSelfDeploy = false): string {
  const activeGate = includeSelfDeploy
    ? "EXISTS (SELECT 1 FROM deployment_maintenance WHERE lock_id = 1) OR EXISTS (SELECT 1 FROM self_deploy_maintenance WHERE lock_id = 1)"
    : "EXISTS (SELECT 1 FROM deployment_maintenance WHERE lock_id = 1)";
  return tables.flatMap((table) => (["INSERT", "UPDATE", "DELETE"] as const).map((operation) => `
    CREATE TRIGGER IF NOT EXISTS maintenance_block_${operation.toLowerCase()}_${table}
    BEFORE ${operation} ON ${table}
    WHEN ${activeGate}
    BEGIN SELECT RAISE(ABORT, 'deployment maintenance'); END;
  `)).join("\n");
}

function dropMaintenanceLinearization(db: Database, tables: readonly string[]): void {
  db.exec(tables.flatMap((table) => (['insert', 'update', 'delete'] as const)
    .map((operation) => `DROP TRIGGER IF EXISTS maintenance_block_${operation}_${table};`)).join("\n"));
}

/** Exported for migration-lineage regression fixtures; application code should use openDb. */
export const MIGRATIONS: string[] = [
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
  // v9 —— Workspace 一级作用域 + Repository / Device mount；Agent 不再持有代码目录
  `
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    description TEXT,
    created_at INTEGER NOT NULL,
    archived_at INTEGER
  );
  INSERT INTO workspaces (id, name, slug, description, created_at)
    VALUES ('ws_personal', 'Personal', 'personal', 'Migrated Harbor workspace', CAST(strftime('%s','now') AS INTEGER) * 1000);

  CREATE TABLE repositories (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    remote_url TEXT,
    default_branch TEXT NOT NULL DEFAULT 'main',
    created_at INTEGER NOT NULL,
    archived_at INTEGER,
    UNIQUE (workspace_id, name)
  );
  CREATE INDEX idx_repositories_workspace ON repositories(workspace_id, archived_at, name);

  CREATE TABLE repository_mounts (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL REFERENCES devices(id),
    path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (repository_id, device_id),
    UNIQUE (device_id, path)
  );
  CREATE INDEX idx_repository_mounts_device ON repository_mounts(device_id, repository_id);

  -- 旧 Agent.workdir 按路径折叠成默认 Workspace 下的 Repository，再按 Device 建 mount。
  INSERT INTO repositories (id, workspace_id, name, default_branch, created_at)
    SELECT 'repo_legacy_' || lower(substr(hex(randomblob(8)), 1, 10)), 'ws_personal', workdir, 'main',
           CAST(strftime('%s','now') AS INTEGER) * 1000
    FROM agents WHERE trim(workdir) <> '' GROUP BY workdir;
  INSERT INTO repository_mounts (id, repository_id, device_id, path, created_at)
    SELECT 'mount_legacy_' || lower(substr(hex(randomblob(8)), 1, 10)), r.id, a.device_id, a.workdir,
           CAST(strftime('%s','now') AS INTEGER) * 1000
    FROM agents a JOIN repositories r ON r.workspace_id = 'ws_personal' AND r.name = a.workdir
    WHERE trim(a.workdir) <> '' GROUP BY r.id, a.device_id, a.workdir;

  CREATE TABLE agents_v9 (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    description TEXT,
    device_id TEXT NOT NULL REFERENCES devices(id),
    backend TEXT NOT NULL CHECK (backend IN ('claude','codex')),
    model TEXT,
    permission TEXT NOT NULL DEFAULT 'auto-edit',
    default_repository_id TEXT REFERENCES repositories(id),
    isolation TEXT NOT NULL DEFAULT 'none' CHECK (isolation IN ('none','worktree')),
    instruction TEXT,
    created_at INTEGER NOT NULL,
    archived_at INTEGER,
    UNIQUE (workspace_id, name)
  );
  INSERT INTO agents_v9
    (id, workspace_id, name, description, device_id, backend, model, permission, default_repository_id,
     isolation, instruction, created_at, archived_at)
    SELECT a.id, 'ws_personal', a.name, a.description, a.device_id, a.backend, a.model, a.permission,
           (SELECT r.id FROM repositories r WHERE r.workspace_id = 'ws_personal' AND r.name = a.workdir LIMIT 1),
           a.isolation, a.instruction, a.created_at, a.archived_at
    FROM agents a;
  DROP TABLE agents;
  ALTER TABLE agents_v9 RENAME TO agents;
  CREATE INDEX idx_agents_workspace ON agents(workspace_id, archived_at, created_at);

  CREATE TABLE skills_v9 (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL CHECK (source IN ('manual','runtime')),
    instruction TEXT NOT NULL,
    device_id TEXT REFERENCES devices(id),
    source_path TEXT,
    runtimes TEXT NOT NULL DEFAULT '["claude","codex"]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER,
    UNIQUE (workspace_id, name),
    CHECK (
      (source = 'manual' AND device_id IS NULL AND source_path IS NULL) OR
      (source = 'runtime' AND device_id IS NOT NULL AND source_path IS NOT NULL)
    )
  );
  INSERT INTO skills_v9
    (id, workspace_id, name, description, source, instruction, device_id, source_path, runtimes,
     created_at, updated_at, archived_at)
    SELECT id, 'ws_personal', name, description, source, instruction, device_id, source_path, runtimes,
           created_at, updated_at, archived_at
    FROM skills;
  DROP TABLE skills;
  ALTER TABLE skills_v9 RENAME TO skills;
  CREATE UNIQUE INDEX idx_skills_runtime_source ON skills(workspace_id, device_id, source_path)
    WHERE source = 'runtime';
  CREATE INDEX idx_skills_workspace ON skills(workspace_id, archived_at, updated_at);

  ALTER TABLE conversations ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
  ALTER TABLE conversations ADD COLUMN repository_id TEXT REFERENCES repositories(id);
  ALTER TABLE conversations ADD COLUMN worktree_mount_id TEXT REFERENCES repository_mounts(id);
  UPDATE conversations
    SET workspace_id = COALESCE((SELECT a.workspace_id FROM agents a WHERE a.id = conversations.agent_id), 'ws_personal'),
        repository_id = (SELECT a.default_repository_id FROM agents a WHERE a.id = conversations.agent_id);
  UPDATE conversations
    SET worktree_mount_id = (
      SELECT m.id FROM repository_mounts m JOIN agents a ON a.device_id = m.device_id
      WHERE a.id = conversations.agent_id AND m.repository_id = conversations.repository_id LIMIT 1
    )
    WHERE worktree_path IS NOT NULL;
  CREATE INDEX idx_conversations_workspace ON conversations(workspace_id, kind, updated_at);

  ALTER TABLE runs ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
  ALTER TABLE runs ADD COLUMN repository_id TEXT REFERENCES repositories(id);
  ALTER TABLE runs ADD COLUMN repository_mount_id TEXT REFERENCES repository_mounts(id);
  ALTER TABLE runs ADD COLUMN execution_root TEXT;
  UPDATE runs
    SET workspace_id = COALESCE((SELECT c.workspace_id FROM conversations c WHERE c.id = runs.conversation_id), 'ws_personal'),
        repository_id = (SELECT c.repository_id FROM conversations c WHERE c.id = runs.conversation_id),
        repository_mount_id = (
          SELECT m.id FROM repository_mounts m
          WHERE m.repository_id = (SELECT c.repository_id FROM conversations c WHERE c.id = runs.conversation_id)
            AND m.device_id = runs.device_id LIMIT 1
        ),
        execution_root = COALESCE(
          (SELECT c.worktree_path FROM conversations c WHERE c.id = runs.conversation_id),
          (SELECT m.path FROM repository_mounts m
           WHERE m.repository_id = (SELECT c.repository_id FROM conversations c WHERE c.id = runs.conversation_id)
             AND m.device_id = runs.device_id LIMIT 1)
        );
  CREATE INDEX idx_runs_workspace ON runs(workspace_id, queued_at);

  ALTER TABLE automations ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
  ALTER TABLE automations ADD COLUMN repository_id TEXT REFERENCES repositories(id);
  UPDATE automations
    SET workspace_id = COALESCE((SELECT a.workspace_id FROM agents a WHERE a.id = automations.agent_id), 'ws_personal'),
        repository_id = (SELECT a.default_repository_id FROM agents a WHERE a.id = automations.agent_id);
  CREATE INDEX idx_automations_workspace ON automations(workspace_id, name);

  CREATE TABLE workspace_prompt_templates (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK (source IN ('issue','chat','automation')),
    enabled INTEGER NOT NULL DEFAULT 1,
    template TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, source)
  );
  INSERT INTO workspace_prompt_templates (workspace_id, source, enabled, template, updated_at)
    SELECT 'ws_personal', source, enabled, replace(template, '{{agent.workdir}}', '{{repository.root}}'), updated_at
    FROM prompt_templates;
  `,
  // v10 —— Repository 配置收敛到 Agent；兼容已运行过 v9 的数据库
  `
  -- v9 允许无默认 Repository。保留这些 Agent，并给每个 Workspace 建一个显式待配置占位；
  -- 占位没有 mount，因此在用户从 Agent 详情补完 checkout 前不会误执行。
  CREATE TABLE agent_repository_backfill_v10 (
    workspace_id TEXT PRIMARY KEY,
    repository_id TEXT UNIQUE NOT NULL
  );
  INSERT INTO agent_repository_backfill_v10 (workspace_id, repository_id)
    SELECT workspace_id, 'repo_unconfigured_' || lower(substr(hex(randomblob(8)), 1, 12))
    FROM agents WHERE default_repository_id IS NULL GROUP BY workspace_id;
  INSERT INTO repositories (id, workspace_id, name, default_branch, created_at)
    SELECT repository_id, workspace_id, 'Unconfigured (' || substr(repository_id, -8) || ')', 'main',
           CAST(strftime('%s','now') AS INTEGER) * 1000
    FROM agent_repository_backfill_v10;
  UPDATE agents
    SET default_repository_id = (
      SELECT repository_id FROM agent_repository_backfill_v10 b WHERE b.workspace_id = agents.workspace_id
    )
    WHERE default_repository_id IS NULL;

  CREATE TABLE agents_v10 (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    description TEXT,
    device_id TEXT NOT NULL REFERENCES devices(id),
    backend TEXT NOT NULL CHECK (backend IN ('claude','codex')),
    model TEXT,
    permission TEXT NOT NULL DEFAULT 'auto-edit',
    repository_id TEXT NOT NULL REFERENCES repositories(id),
    isolation TEXT NOT NULL DEFAULT 'none' CHECK (isolation IN ('none','worktree')),
    instruction TEXT,
    created_at INTEGER NOT NULL,
    archived_at INTEGER,
    UNIQUE (workspace_id, name)
  );
  INSERT INTO agents_v10
    (id, workspace_id, name, description, device_id, backend, model, permission, repository_id,
     isolation, instruction, created_at, archived_at)
    SELECT id, workspace_id, name, description, device_id, backend, model, permission, default_repository_id,
           isolation, instruction, created_at, archived_at
    FROM agents;
  DROP TABLE agents;
  ALTER TABLE agents_v10 RENAME TO agents;
  CREATE INDEX idx_agents_workspace ON agents(workspace_id, archived_at, created_at);

  UPDATE conversations
    SET repository_id = (SELECT a.repository_id FROM agents a WHERE a.id = conversations.agent_id)
    WHERE agent_id IS NOT NULL AND repository_id IS NULL;
  UPDATE automations
    SET repository_id = (SELECT a.repository_id FROM agents a WHERE a.id = automations.agent_id)
    WHERE repository_id IS NULL;
  DROP TABLE agent_repository_backfill_v10;
  `,
  // v11 —— Workspace 级 Mew Prompt pipeline：session context + event trigger
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

  CREATE TABLE workspace_prompt_blocks (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    block_key TEXT NOT NULL CHECK (block_key IN (
      'session.issue.context','event.issue.assigned','event.issue.mentioned','event.issue.message_created',
      'session.chat.context','event.chat.message_created',
      'event.automation.schedule','event.automation.manual'
    )),
    enabled INTEGER NOT NULL DEFAULT 1,
    template TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, block_key)
  );

  -- 旧 issue/chat wrapper 是 context + request 的合并模板。迁到 context 后，renderer
  -- 识别其中的 request 变量并继续单独渲染，重置该 block 后才切到两段式 pipeline。
  INSERT INTO workspace_prompt_blocks (workspace_id, block_key, enabled, template, updated_at)
    SELECT workspace_id, CASE source
      WHEN 'issue' THEN 'session.issue.context'
      WHEN 'chat' THEN 'session.chat.context'
      ELSE 'event.automation.schedule'
    END, enabled, template, updated_at
    FROM workspace_prompt_templates;
  INSERT INTO workspace_prompt_blocks (workspace_id, block_key, enabled, template, updated_at)
    SELECT workspace_id, 'event.automation.manual', enabled, template, updated_at
    FROM workspace_prompt_templates WHERE source = 'automation';

  -- 旧 source 被整体禁用时，event 也要透传原始请求，避免迁移后重新启用包装。
  INSERT INTO workspace_prompt_blocks (workspace_id, block_key, enabled, template, updated_at)
    SELECT workspace_id, event_key, 0, '', updated_at
    FROM workspace_prompt_templates
    JOIN (
      SELECT 'issue' AS source_key, 'event.issue.assigned' AS event_key
      UNION ALL SELECT 'issue', 'event.issue.mentioned'
      UNION ALL SELECT 'issue', 'event.issue.message_created'
      UNION ALL SELECT 'chat', 'event.chat.message_created'
    ) legacy_events ON legacy_events.source_key = workspace_prompt_templates.source
    WHERE workspace_prompt_templates.enabled = 0;

  DROP TABLE workspace_prompt_templates;
  DROP TABLE prompt_templates;
  `,
  // v12 —— Mew parity P0：Run Source 一等化 + Automation Trigger/Output/Overlap
  `
  CREATE TABLE runs_v12 (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    source_type TEXT NOT NULL CHECK (source_type IN ('issue','chat','automation')),
    source_id TEXT NOT NULL,
    conversation_id TEXT REFERENCES conversations(id),
    agent_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    repository_id TEXT REFERENCES repositories(id),
    repository_mount_id TEXT REFERENCES repository_mounts(id),
    execution_root TEXT,
    prompt TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT 'implementation' CHECK (purpose IN ('implementation','triage','review','verification')),
    prompt_event TEXT NOT NULL CHECK (prompt_event IN (
      'event.issue.assigned','event.issue.mentioned','event.issue.message_created',
      'event.chat.message_created','event.automation.schedule','event.automation.manual','event.automation.webhook'
    )),
    trigger_ref TEXT,
    trigger_context TEXT NOT NULL DEFAULT '{}',
    concurrency_key TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    claude_session_id TEXT,
    error TEXT,
    cost_usd REAL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cached_tokens INTEGER,
    queued_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    CHECK (
      (source_type = 'automation' AND conversation_id IS NULL) OR
      (source_type IN ('issue','chat') AND conversation_id IS NOT NULL AND source_id = conversation_id)
    )
  );
  INSERT INTO runs_v12
    (id, workspace_id, source_type, source_id, conversation_id, agent_id, device_id,
     repository_id, repository_mount_id, execution_root, prompt, purpose, prompt_event, trigger_ref,
     trigger_context, concurrency_key, status, claude_session_id, error, cost_usd, input_tokens,
     output_tokens, cached_tokens, queued_at, started_at, finished_at)
    SELECT r.id, r.workspace_id,
      CASE WHEN c.kind = 'chat' THEN 'chat' ELSE 'issue' END,
      r.conversation_id, r.conversation_id, r.agent_id, r.device_id,
      r.repository_id, r.repository_mount_id, r.execution_root, r.prompt, r.purpose, r.prompt_event,
      r.trigger_ref, '{}', NULL, r.status, r.claude_session_id, r.error, r.cost_usd, r.input_tokens,
      r.output_tokens, r.cached_tokens, r.queued_at, r.started_at, r.finished_at
    FROM runs r JOIN conversations c ON c.id = r.conversation_id;
  DROP TABLE runs;
  ALTER TABLE runs_v12 RENAME TO runs;
  CREATE INDEX idx_runs_device_status ON runs(device_id, status);
  CREATE INDEX idx_runs_conversation ON runs(conversation_id);
  CREATE INDEX idx_runs_workspace ON runs(workspace_id, queued_at);
  CREATE INDEX idx_runs_source ON runs(source_type, source_id, queued_at);
  CREATE INDEX idx_runs_trigger_ref ON runs(trigger_ref, status, queued_at);
  CREATE INDEX idx_runs_concurrency ON runs(concurrency_key, status, queued_at);

  CREATE TABLE automation_legacy_crons_v12 (
    automation_id TEXT PRIMARY KEY, cron TEXT NOT NULL, last_fired_at INTEGER
  );
  INSERT INTO automation_legacy_crons_v12 SELECT id, cron, last_fired_at FROM automations;

  CREATE TABLE automations_v12 (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    repository_id TEXT REFERENCES repositories(id),
    prompt TEXT NOT NULL,
    output_mode TEXT NOT NULL DEFAULT 'run' CHECK (output_mode IN ('run','chat','issue','append')),
    overlap_mode TEXT NOT NULL DEFAULT 'skip' CHECK (overlap_mode IN ('skip','queue')),
    target_conversation_id TEXT REFERENCES conversations(id),
    notify_chat_id TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_fired_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (workspace_id, name),
    CHECK ((output_mode = 'append' AND target_conversation_id IS NOT NULL) OR output_mode <> 'append')
  );
  INSERT INTO automations_v12
    (id, workspace_id, name, agent_id, repository_id, prompt, output_mode, overlap_mode,
     target_conversation_id, notify_chat_id, enabled, last_fired_at, created_at, updated_at)
    SELECT id, workspace_id, name, agent_id, repository_id, prompt,
      CASE mode WHEN 'new_issue' THEN 'issue' ELSE 'append' END,
      'skip', target_conversation_id, notify_chat_id, enabled, last_fired_at,
      COALESCE(last_fired_at, CAST(strftime('%s','now') AS INTEGER) * 1000),
      COALESCE(last_fired_at, CAST(strftime('%s','now') AS INTEGER) * 1000)
    FROM automations;
  DROP TABLE automations;
  ALTER TABLE automations_v12 RENAME TO automations;
  CREATE INDEX idx_automations_workspace ON automations(workspace_id, name);

  CREATE TABLE automation_triggers (
    id TEXT PRIMARY KEY,
    automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('schedule','webhook')),
    enabled INTEGER NOT NULL DEFAULT 1,
    cron TEXT,
    provider TEXT,
    events TEXT NOT NULL DEFAULT '[]',
    filters TEXT NOT NULL DEFAULT '[]',
    secret_hash TEXT,
    last_fired_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (
      (type = 'schedule' AND cron IS NOT NULL AND secret_hash IS NULL) OR
      (type = 'webhook' AND cron IS NULL AND secret_hash IS NOT NULL)
    )
  );
  INSERT INTO automation_triggers
    (id, automation_id, type, enabled, cron, events, filters, last_fired_at, created_at, updated_at)
    SELECT 'trigger_' || automation_id, automation_id, 'schedule', 1, cron, '[]', '[]', last_fired_at,
      COALESCE(last_fired_at, CAST(strftime('%s','now') AS INTEGER) * 1000),
      COALESCE(last_fired_at, CAST(strftime('%s','now') AS INTEGER) * 1000)
    FROM automation_legacy_crons_v12;
  DROP TABLE automation_legacy_crons_v12;
  CREATE INDEX idx_automation_triggers_automation ON automation_triggers(automation_id, type);

  CREATE TABLE automation_webhook_deliveries (
    trigger_id TEXT NOT NULL REFERENCES automation_triggers(id) ON DELETE CASCADE,
    delivery_id TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    PRIMARY KEY (trigger_id, delivery_id)
  );
  CREATE INDEX idx_automation_webhook_deliveries_ts ON automation_webhook_deliveries(received_at);

  CREATE TABLE automation_log_v12 (
    automation_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('fired','missed','skipped','rejected')),
    ts INTEGER NOT NULL,
    run_id TEXT,
    trigger_id TEXT,
    event_id TEXT,
    note TEXT
  );
  INSERT INTO automation_log_v12 (automation_id, kind, ts, run_id, note)
    SELECT automation_id, kind, ts, run_id, note FROM automation_log;
  DROP TABLE automation_log;
  ALTER TABLE automation_log_v12 RENAME TO automation_log;
  CREATE INDEX idx_automation_log ON automation_log(automation_id, ts);

  CREATE TABLE workspace_prompt_blocks_v12 (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    block_key TEXT NOT NULL CHECK (block_key IN (
      'session.issue.context','event.issue.assigned','event.issue.mentioned','event.issue.message_created',
      'session.chat.context','event.chat.message_created',
      'event.automation.schedule','event.automation.manual','event.automation.webhook'
    )),
    enabled INTEGER NOT NULL DEFAULT 1,
    template TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, block_key)
  );
  INSERT INTO workspace_prompt_blocks_v12 SELECT * FROM workspace_prompt_blocks;
  DROP TABLE workspace_prompt_blocks;
  ALTER TABLE workspace_prompt_blocks_v12 RENAME TO workspace_prompt_blocks;
  `,
  // v13 —— Mew parity：SCM 事件事实、成员/RBAC、Agent 多仓库与执行配置、Skill bundle、Lark workspace binding
  `
  ALTER TABLE repositories ADD COLUMN scm_provider TEXT NOT NULL DEFAULT 'local'
    CHECK (scm_provider IN ('local','codebase'));
  ALTER TABLE repositories ADD COLUMN scm_repository TEXT;
  ALTER TABLE repositories ADD COLUMN scm_agent_id TEXT REFERENCES agents(id);
  ALTER TABLE repositories ADD COLUMN scm_auto_dispatch INTEGER NOT NULL DEFAULT 0;
  CREATE UNIQUE INDEX idx_repositories_scm
    ON repositories(scm_provider, scm_repository)
    WHERE scm_provider <> 'local' AND scm_repository IS NOT NULL;

  CREATE TABLE workspace_members (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT,
    external_provider TEXT NOT NULL DEFAULT 'local'
      CHECK (external_provider IN ('local','feishu','codebase')),
    external_id TEXT,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','invited','disabled')),
    created_at INTEGER NOT NULL,
    UNIQUE (workspace_id, email)
  );
  CREATE UNIQUE INDEX idx_workspace_members_external
    ON workspace_members(workspace_id, external_provider, external_id)
    WHERE external_id IS NOT NULL;
  INSERT INTO workspace_members
    (id, workspace_id, name, external_provider, role, status, created_at)
    SELECT 'member_system_' || id, id, 'Local owner', 'local', 'owner', 'active', created_at
    FROM workspaces;

  CREATE TABLE workspace_api_tokens (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    member_id TEXT NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
  );
  CREATE INDEX idx_workspace_api_tokens_member ON workspace_api_tokens(member_id, revoked_at);

  ALTER TABLE agents ADD COLUMN concurrency INTEGER NOT NULL DEFAULT 1 CHECK (concurrency BETWEEN 1 AND 64);
  ALTER TABLE agents ADD COLUMN visibility TEXT NOT NULL DEFAULT 'workspace'
    CHECK (visibility IN ('workspace','private'));
  ALTER TABLE agents ADD COLUMN environment TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE agents ADD COLUMN setup_script TEXT;
  ALTER TABLE agents ADD COLUMN reuse_device_cli INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE agents ADD COLUMN created_by_member_id TEXT REFERENCES workspace_members(id);
  CREATE TABLE agent_repositories (
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    is_primary INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (agent_id, repository_id)
  );
  INSERT INTO agent_repositories (agent_id, repository_id, position, is_primary, created_at)
    SELECT id, repository_id, 0, 1, created_at FROM agents;
  CREATE INDEX idx_agent_repositories_repository ON agent_repositories(repository_id, agent_id);

  -- 一些早期开发库错误地提前写入 user_version、但漏建 v7 表；补齐后再做 bundle rebuild。
  CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL CHECK (source IN ('manual','runtime')),
    instruction TEXT NOT NULL,
    device_id TEXT REFERENCES devices(id),
    source_path TEXT,
    runtimes TEXT NOT NULL DEFAULT '["claude","codex"]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER,
    UNIQUE (workspace_id, name)
  );
  CREATE TABLE IF NOT EXISTS agent_skills (
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (agent_id, skill_id)
  );
  CREATE TABLE skill_groups (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE (workspace_id, name)
  );
  CREATE TABLE skills_v13 (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL CHECK (source IN ('manual','runtime','codebase','github','upload')),
    instruction TEXT NOT NULL,
    device_id TEXT REFERENCES devices(id),
    source_path TEXT,
    runtimes TEXT NOT NULL DEFAULT '["claude","codex"]',
    group_id TEXT REFERENCES skill_groups(id) ON DELETE SET NULL,
    origin_url TEXT,
    source_ref TEXT,
    entry_hash TEXT NOT NULL DEFAULT '',
    bundle_hash TEXT NOT NULL DEFAULT '',
    auto_sync INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER,
    UNIQUE (workspace_id, name),
    CHECK (
      (source = 'runtime' AND device_id IS NOT NULL AND source_path IS NOT NULL) OR
      (source <> 'runtime' AND device_id IS NULL)
    )
  );
  INSERT INTO skills_v13
    (id, workspace_id, name, description, source, instruction, device_id, source_path, runtimes,
     created_at, updated_at, archived_at)
    SELECT id, workspace_id, name, description, source, instruction, device_id, source_path, runtimes,
           created_at, updated_at, archived_at
    FROM skills;
  DROP TABLE skills;
  ALTER TABLE skills_v13 RENAME TO skills;
  CREATE UNIQUE INDEX idx_skills_runtime_source ON skills(workspace_id, device_id, source_path)
    WHERE source = 'runtime';
  CREATE INDEX idx_skills_workspace ON skills(workspace_id, archived_at, updated_at);
  CREATE INDEX idx_skills_group ON skills(group_id, updated_at);
  CREATE TABLE skill_files (
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    content TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (skill_id, path)
  );
  INSERT INTO skill_files (skill_id, path, content, sha256, position)
    SELECT id, 'SKILL.md', instruction, entry_hash, 0 FROM skills;
  CREATE TABLE skill_dependencies (
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    spec TEXT,
    required INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (skill_id, name)
  );

  ALTER TABLE conversations ADD COLUMN creator_member_id TEXT REFERENCES workspace_members(id);
  ALTER TABLE conversations ADD COLUMN owner_member_id TEXT REFERENCES workspace_members(id);
  CREATE TABLE issue_labels (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#75817b',
    UNIQUE (workspace_id, name)
  );
  CREATE TABLE conversation_labels (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    label_id TEXT NOT NULL REFERENCES issue_labels(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, label_id)
  );
  CREATE TABLE conversation_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    author_type TEXT NOT NULL CHECK (author_type IN ('member','agent','external','system')),
    author_id TEXT,
    author_name TEXT,
    body TEXT NOT NULL,
    external_id TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (conversation_id, external_id)
  );
  CREATE INDEX idx_conversation_messages ON conversation_messages(conversation_id, created_at);

  CREATE TABLE scm_external_objects (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('codebase')),
    kind TEXT NOT NULL CHECK (kind IN ('issue','change')),
    external_id TEXT NOT NULL,
    url TEXT,
    title TEXT NOT NULL,
    description TEXT,
    author_id TEXT,
    author_name TEXT,
    state TEXT NOT NULL,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
    delivery_id TEXT REFERENCES deliveries(id) ON DELETE SET NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (provider, repository_id, kind, external_id)
  );
  CREATE INDEX idx_scm_external_conversation ON scm_external_objects(conversation_id, kind);
  CREATE TABLE scm_events (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('codebase')),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    repository_id TEXT REFERENCES repositories(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    action TEXT,
    object_kind TEXT CHECK (object_kind IN ('issue','change')),
    external_id TEXT,
    payload TEXT NOT NULL,
    outcome TEXT NOT NULL DEFAULT 'received' CHECK (outcome IN ('received','applied','ignored','failed')),
    error TEXT,
    received_at INTEGER NOT NULL,
    processed_at INTEGER
  );
  CREATE INDEX idx_scm_events_workspace ON scm_events(workspace_id, received_at);

  CREATE TABLE lark_workspace_bindings (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    chat_id TEXT NOT NULL UNIQUE,
    default_agent_id TEXT NOT NULL REFERENCES agents(id),
    response_mode TEXT NOT NULL DEFAULT 'thread' CHECK (response_mode IN ('thread','message')),
    listen_mode TEXT NOT NULL DEFAULT 'mention' CHECK (listen_mode IN ('mention','all')),
    bot_mode TEXT NOT NULL DEFAULT 'global' CHECK (bot_mode IN ('global','custom')),
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_bindings (
    chat_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    created_at INTEGER NOT NULL
  );
  INSERT INTO lark_workspace_bindings
    (id, workspace_id, chat_id, default_agent_id, response_mode, listen_mode, bot_mode, enabled, created_at, updated_at)
    SELECT 'lark_' || lower(substr(hex(randomblob(8)), 1, 16)), a.workspace_id, b.chat_id, b.agent_id,
           'thread', 'mention', 'global', 1, b.created_at, b.created_at
    FROM chat_bindings b JOIN agents a ON a.id = b.agent_id;
  CREATE TABLE lark_message_links (
    message_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_lark_message_links_conversation ON lark_message_links(conversation_id, created_at);
  `,
  // v14 —— 飞书附件随 Run 下发；Agent follow-up Issue 使用短期最小权限 action token
  `
  CREATE TABLE run_attachments (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    data_base64 TEXT NOT NULL,
    PRIMARY KEY (run_id, position)
  );
  CREATE TABLE run_action_tokens (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE INDEX idx_run_action_tokens_run ON run_action_tokens(run_id, expires_at);
  `,
  // v15 —— 合流 GitHub Delivery fork：closed 状态、head-bound approval 与并发 revision
  `
  CREATE TABLE deliveries_v15 (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id),
    provider TEXT NOT NULL,
    change_url TEXT,
    external_id TEXT,
    head_branch TEXT,
    base_branch TEXT,
    review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','approved')),
    check_status TEXT NOT NULL DEFAULT 'unknown' CHECK (check_status IN ('unknown','pending','passed','failed')),
    merge_status TEXT NOT NULL DEFAULT 'open' CHECK (merge_status IN ('open','closed','merged')),
    deployment_status TEXT NOT NULL DEFAULT 'not_required' CHECK (deployment_status IN ('not_required','pending','running','succeeded','failed')),
    review_approved_at INTEGER,
    merged_at INTEGER,
    deployed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    latest_head_sha TEXT,
    approved_head_sha TEXT,
    revision INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO deliveries_v15
    (id, conversation_id, provider, change_url, external_id, head_branch, base_branch,
     review_status, check_status, merge_status, deployment_status, review_approved_at,
     merged_at, deployed_at, created_at, updated_at, latest_head_sha, approved_head_sha, revision)
    SELECT id, conversation_id, provider, change_url, external_id, head_branch, base_branch,
           review_status, check_status, merge_status, deployment_status, review_approved_at,
           merged_at, deployed_at, created_at, updated_at, latest_head_sha, approved_head_sha, revision
    FROM deliveries;
  DROP TABLE deliveries;
  ALTER TABLE deliveries_v15 RENAME TO deliveries;
  CREATE INDEX idx_deliveries_conversation ON deliveries(conversation_id);

  -- 没有 head SHA 归属的旧 GitHub 证据不能安全沿用；下一次 refresh 会重建事实。
  UPDATE deliveries
    SET review_status = 'pending', review_approved_at = NULL, check_status = 'pending'
    WHERE provider = 'github' AND (latest_head_sha IS NULL OR approved_head_sha IS NULL);
  `,
  // v16 —— Agent team：Harbor 内部领域事件、event Automation 与 Run-scoped actions
  `
  CREATE TABLE IF NOT EXISTS automation_webhook_deliveries (
    trigger_id TEXT NOT NULL REFERENCES automation_triggers(id) ON DELETE CASCADE,
    delivery_id TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    PRIMARY KEY (trigger_id, delivery_id)
  );

  CREATE TABLE runs_v16 (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    source_type TEXT NOT NULL CHECK (source_type IN ('issue','chat','automation')),
    source_id TEXT NOT NULL,
    conversation_id TEXT REFERENCES conversations(id),
    agent_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    repository_id TEXT REFERENCES repositories(id),
    repository_mount_id TEXT REFERENCES repository_mounts(id),
    execution_root TEXT,
    prompt TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT 'implementation' CHECK (purpose IN ('implementation','triage','review','verification')),
    prompt_event TEXT NOT NULL CHECK (prompt_event IN (
      'event.issue.assigned','event.issue.mentioned','event.issue.message_created',
      'event.chat.message_created','event.automation.schedule','event.automation.manual',
      'event.automation.webhook','event.automation.event'
    )),
    trigger_ref TEXT,
    trigger_context TEXT NOT NULL DEFAULT '{}',
    concurrency_key TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    claude_session_id TEXT,
    error TEXT,
    cost_usd REAL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cached_tokens INTEGER,
    queued_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    CHECK (
      (source_type = 'automation' AND conversation_id IS NULL) OR
      (source_type IN ('issue','chat') AND conversation_id IS NOT NULL AND source_id = conversation_id)
    )
  );
  INSERT INTO runs_v16
    (id, workspace_id, source_type, source_id, conversation_id, agent_id, device_id,
     repository_id, repository_mount_id, execution_root, prompt, purpose, prompt_event, trigger_ref,
     trigger_context, concurrency_key, status, claude_session_id, error, cost_usd, input_tokens,
     output_tokens, cached_tokens, queued_at, started_at, finished_at)
    SELECT id, workspace_id, source_type, source_id, conversation_id, agent_id, device_id,
           repository_id, repository_mount_id, execution_root, prompt, purpose, prompt_event, trigger_ref,
           trigger_context, concurrency_key, status, claude_session_id, error, cost_usd, input_tokens,
           output_tokens, cached_tokens, queued_at, started_at, finished_at
    FROM runs;
  DROP TABLE runs;
  ALTER TABLE runs_v16 RENAME TO runs;
  CREATE INDEX idx_runs_device_status ON runs(device_id, status);
  CREATE INDEX idx_runs_conversation ON runs(conversation_id);
  CREATE INDEX idx_runs_workspace ON runs(workspace_id, queued_at);
  CREATE INDEX idx_runs_source ON runs(source_type, source_id, queued_at);
  CREATE INDEX idx_runs_trigger_ref ON runs(trigger_ref, status, queued_at);
  CREATE INDEX idx_runs_concurrency ON runs(concurrency_key, status, queued_at);

  CREATE TABLE delivery_events_v16 (
    delivery_id TEXT NOT NULL REFERENCES deliveries(id),
    kind TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    actor TEXT NOT NULL CHECK (actor IN ('human','agent','system','provider')),
    ts INTEGER NOT NULL
  );
  INSERT INTO delivery_events_v16 (delivery_id, kind, data, actor, ts)
    SELECT delivery_id, kind, data, actor, ts FROM delivery_events;
  DROP TABLE delivery_events;
  ALTER TABLE delivery_events_v16 RENAME TO delivery_events;
  CREATE INDEX idx_delivery_events ON delivery_events(delivery_id, ts);

  CREATE TABLE automations_v16 (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    repository_id TEXT REFERENCES repositories(id),
    prompt TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT 'implementation' CHECK (purpose IN ('implementation','triage','review','verification')),
    output_mode TEXT NOT NULL DEFAULT 'run' CHECK (output_mode IN ('run','chat','issue','append','source')),
    overlap_mode TEXT NOT NULL DEFAULT 'skip' CHECK (overlap_mode IN ('skip','queue')),
    target_conversation_id TEXT REFERENCES conversations(id),
    notify_chat_id TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_fired_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (workspace_id, name),
    CHECK (
      (output_mode = 'append' AND target_conversation_id IS NOT NULL) OR
      (output_mode <> 'append' AND target_conversation_id IS NULL)
    )
  );
  INSERT INTO automations_v16
    (id, workspace_id, name, agent_id, repository_id, prompt, purpose, output_mode, overlap_mode,
     target_conversation_id, notify_chat_id, enabled, last_fired_at, created_at, updated_at)
    SELECT id, workspace_id, name, agent_id, repository_id, prompt, 'implementation', output_mode, overlap_mode,
           target_conversation_id, notify_chat_id, enabled, last_fired_at, created_at, updated_at
    FROM automations;

  CREATE TABLE automation_triggers_v16 (
    id TEXT PRIMARY KEY,
    automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('schedule','webhook','event')),
    enabled INTEGER NOT NULL DEFAULT 1,
    cron TEXT,
    provider TEXT,
    events TEXT NOT NULL DEFAULT '[]',
    filters TEXT NOT NULL DEFAULT '[]',
    secret_hash TEXT,
    last_fired_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (
      (type = 'schedule' AND cron IS NOT NULL AND secret_hash IS NULL) OR
      (type = 'webhook' AND cron IS NULL AND secret_hash IS NOT NULL) OR
      (type = 'event' AND cron IS NULL AND secret_hash IS NULL)
    )
  );
  INSERT INTO automation_triggers_v16
    (id, automation_id, type, enabled, cron, provider, events, filters, secret_hash,
     last_fired_at, created_at, updated_at)
    SELECT id, automation_id, type, enabled, cron, provider, events, filters, secret_hash,
           last_fired_at, created_at, updated_at
    FROM automation_triggers;

  CREATE TABLE automation_trigger_deliveries_v16 (
    trigger_id TEXT NOT NULL REFERENCES automation_triggers(id) ON DELETE CASCADE,
    delivery_id TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    PRIMARY KEY (trigger_id, delivery_id)
  );
  INSERT INTO automation_trigger_deliveries_v16 (trigger_id, delivery_id, received_at)
    SELECT trigger_id, delivery_id, received_at FROM automation_webhook_deliveries;

  DROP TABLE automation_webhook_deliveries;
  DROP TABLE automation_triggers;
  DROP TABLE automations;
  ALTER TABLE automations_v16 RENAME TO automations;
  ALTER TABLE automation_triggers_v16 RENAME TO automation_triggers;
  ALTER TABLE automation_trigger_deliveries_v16 RENAME TO automation_trigger_deliveries;
  CREATE INDEX idx_automations_workspace ON automations(workspace_id, name);
  CREATE INDEX idx_automation_triggers_automation ON automation_triggers(automation_id, type);
  CREATE INDEX idx_automation_trigger_deliveries_ts ON automation_trigger_deliveries(received_at);
  `,
  // v17（Provider branch phase 1 / 原 v14）—— SCM 与 Deployment Provider 正交；durable queue
  `
  CREATE TABLE deliveries_v14 (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id),
    provider TEXT NOT NULL,
    change_url TEXT,
    external_id TEXT,
    head_branch TEXT,
    base_branch TEXT,
    latest_head_sha TEXT,
    approved_head_sha TEXT,
    review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','approved')),
    check_status TEXT NOT NULL DEFAULT 'unknown' CHECK (check_status IN ('unknown','pending','passed','failed')),
    merge_status TEXT NOT NULL DEFAULT 'open' CHECK (merge_status IN ('open','closed','merged')),
    deployment_status TEXT NOT NULL DEFAULT 'not_required'
      CHECK (deployment_status IN ('not_required','pending','queued','running','succeeded','failed')),
    deployment_target_id TEXT,
    merged_revision TEXT,
    deployment_revision TEXT,
    deployment_generation INTEGER NOT NULL DEFAULT 0,
    active_deployment_job_id TEXT,
    deployment_error TEXT,
    review_approved_at INTEGER,
    merged_at INTEGER,
    deployed_at INTEGER,
    revision INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  INSERT INTO deliveries_v14
    (id, conversation_id, provider, change_url, external_id, head_branch, base_branch,
     latest_head_sha, approved_head_sha, review_status, check_status, merge_status,
     deployment_status, review_approved_at, merged_at, deployed_at, revision, created_at, updated_at)
    SELECT id, conversation_id, provider, change_url, external_id, head_branch, base_branch,
           latest_head_sha, approved_head_sha, review_status, check_status, merge_status,
           deployment_status, review_approved_at, merged_at, deployed_at, revision, created_at, updated_at
    FROM deliveries;
  DROP TABLE deliveries;
  ALTER TABLE deliveries_v14 RENAME TO deliveries;
  CREATE INDEX idx_deliveries_conversation ON deliveries(conversation_id);
  CREATE INDEX idx_deliveries_deployment_status ON deliveries(deployment_status, updated_at);

  CREATE TABLE deployment_jobs (
    id TEXT PRIMARY KEY,
    delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL,
    target_id TEXT NOT NULL,
    revision TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
    attempt INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    lease_expires_at INTEGER,
    checkpoint TEXT NOT NULL DEFAULT 'queued',
    log TEXT,
    error TEXT,
    rollback_complete INTEGER,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    updated_at INTEGER NOT NULL,
    UNIQUE (delivery_id, generation)
  );
  CREATE INDEX idx_deployment_jobs_claim ON deployment_jobs(status, lease_expires_at, created_at);
  `,
  // v18（Provider branch phase 2 / 原 v15）—— fail-closed recovery；冻结 target 与 rollback anchor
  `
  DROP TABLE IF EXISTS deployment_maintenance;
  CREATE TABLE deliveries_v15 (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id),
    provider TEXT NOT NULL,
    change_url TEXT,
    external_id TEXT,
    head_branch TEXT,
    base_branch TEXT,
    latest_head_sha TEXT,
    approved_head_sha TEXT,
    review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','approved')),
    check_status TEXT NOT NULL DEFAULT 'unknown' CHECK (check_status IN ('unknown','pending','passed','failed')),
    merge_status TEXT NOT NULL DEFAULT 'open' CHECK (merge_status IN ('open','closed','merged')),
    deployment_status TEXT NOT NULL DEFAULT 'not_required'
      CHECK (deployment_status IN ('not_required','pending','queued','running','succeeded','failed','needs_recovery')),
    deployment_target_id TEXT,
    merged_revision TEXT,
    deployment_revision TEXT,
    deployment_generation INTEGER NOT NULL DEFAULT 0,
    active_deployment_job_id TEXT,
    deployment_error TEXT,
    review_approved_at INTEGER,
    merged_at INTEGER,
    deployed_at INTEGER,
    revision INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  INSERT INTO deliveries_v15
    SELECT id, conversation_id, provider, change_url, external_id, head_branch, base_branch,
           latest_head_sha, approved_head_sha, review_status, check_status, merge_status,
           CASE WHEN deployment_status IN ('queued','running') THEN 'needs_recovery' ELSE deployment_status END,
           deployment_target_id, merged_revision, deployment_revision, deployment_generation,
           active_deployment_job_id,
           CASE WHEN deployment_status IN ('queued','running')
                THEN 'v17 active deployment 缺少 target fingerprint/maintenance anchor；需要管理员 recovery'
                ELSE deployment_error END,
           review_approved_at, merged_at, deployed_at, revision, created_at, updated_at
    FROM deliveries;

  CREATE TABLE deployment_jobs_v15 (
    id TEXT PRIMARY KEY,
    delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL,
    target_id TEXT NOT NULL,
    revision TEXT NOT NULL,
    target_fingerprint TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued','running','recovering','succeeded','failed','needs_recovery')),
    attempt INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    lease_expires_at INTEGER,
    checkpoint TEXT NOT NULL DEFAULT 'queued',
    log TEXT,
    error TEXT,
    rollback_complete INTEGER,
    rollback_attempt INTEGER,
    baseline_revision TEXT,
    new_service_pid INTEGER,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    updated_at INTEGER NOT NULL,
    UNIQUE (delivery_id, generation)
  );
  INSERT INTO deployment_jobs_v15
    (id, delivery_id, generation, target_id, revision, target_fingerprint, status, attempt,
     lease_token, lease_expires_at, checkpoint, log, error, rollback_complete,
     rollback_attempt, baseline_revision, new_service_pid, created_at, started_at, finished_at, updated_at)
    SELECT id, delivery_id, generation, target_id, revision, '',
           CASE WHEN status IN ('queued','running') THEN 'needs_recovery' ELSE status END,
           attempt, NULL, NULL,
           CASE WHEN status IN ('queued','running') THEN 'rollback_incomplete' ELSE checkpoint END,
           log,
           CASE WHEN status IN ('queued','running')
                THEN 'v17 active deployment 无可证明 rollback anchor；需要管理员 recovery'
                ELSE error END,
           CASE WHEN status IN ('queued','running') THEN 0 ELSE rollback_complete END,
           NULL, NULL, NULL, created_at, started_at, finished_at, updated_at
    FROM deployment_jobs;

  DROP TABLE deployment_jobs;
  DROP TABLE deliveries;
  ALTER TABLE deliveries_v15 RENAME TO deliveries;
  ALTER TABLE deployment_jobs_v15 RENAME TO deployment_jobs;
  CREATE INDEX idx_deliveries_conversation ON deliveries(conversation_id);
  CREATE INDEX idx_deliveries_deployment_status ON deliveries(deployment_status, updated_at);
  CREATE INDEX idx_deployment_jobs_claim ON deployment_jobs(status, lease_expires_at, created_at);

  CREATE TABLE deployment_maintenance (
    target_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL UNIQUE REFERENCES deployment_jobs(id) ON DELETE CASCADE,
    delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL,
    revision TEXT NOT NULL,
    target_fingerprint TEXT NOT NULL,
    rollback_attempt INTEGER NOT NULL,
    baseline_revision TEXT NOT NULL,
    expected_revision TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('deploying','healthy','rolling_back','needs_recovery')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // v19（Provider branch phase 3 / 原 v16）—— host-global gate + monotonic fence + durable identity
  `
  CREATE TABLE deployment_jobs_v16 (
    id TEXT PRIMARY KEY,
    delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL,
    target_id TEXT NOT NULL,
    revision TEXT NOT NULL,
    target_fingerprint TEXT NOT NULL,
    target_manifest_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued','running','recovering','succeeded','failed','needs_recovery')),
    attempt INTEGER NOT NULL DEFAULT 0,
    fence_epoch INTEGER,
    fence_nonce TEXT,
    lease_token TEXT,
    lease_expires_at INTEGER,
    checkpoint TEXT NOT NULL DEFAULT 'queued',
    log TEXT,
    error TEXT,
    failure_kind TEXT CHECK (failure_kind IS NULL OR failure_kind IN
      ('config_drift','bootstrap_required','deployment_failed','rollback_incomplete','legacy_ack_required')),
    rollback_complete INTEGER,
    rollback_attempt INTEGER,
    baseline_revision TEXT,
    baseline_fingerprint TEXT,
    baseline_manifest_hash TEXT,
    baseline_health_fingerprint TEXT,
    database_backup_created INTEGER NOT NULL DEFAULT 0 CHECK (database_backup_created IN (0,1)),
    new_service_pids TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    updated_at INTEGER NOT NULL,
    UNIQUE (delivery_id, generation)
  );
  INSERT INTO deployment_jobs_v16
    (id, delivery_id, generation, target_id, revision, target_fingerprint, target_manifest_hash,
     status, attempt, lease_token, lease_expires_at, checkpoint, log, error, failure_kind,
     rollback_complete, rollback_attempt, baseline_revision, database_backup_created, new_service_pids,
     created_at, started_at, finished_at, updated_at)
    SELECT id, delivery_id, generation, target_id, revision, target_fingerprint, '',
           status, attempt, NULL, NULL, checkpoint, log, error,
           CASE WHEN target_fingerprint = '' OR rollback_attempt IS NULL AND status = 'needs_recovery'
                THEN 'legacy_ack_required' ELSE NULL END,
           rollback_complete, rollback_attempt, baseline_revision, 0,
           CASE WHEN new_service_pid IS NULL THEN '{}' ELSE printf('{"legacy":%d}', new_service_pid) END,
           created_at, started_at, finished_at, updated_at
    FROM deployment_jobs;

  CREATE TABLE deployment_maintenance_v15_copy AS SELECT * FROM deployment_maintenance;
  DROP TABLE deployment_maintenance;
  DROP TABLE deployment_jobs;
  ALTER TABLE deployment_jobs_v16 RENAME TO deployment_jobs;
  CREATE INDEX idx_deployment_jobs_claim ON deployment_jobs(status, lease_expires_at, created_at);

  DROP TABLE IF EXISTS deployment_host_fence;
  CREATE TABLE deployment_host_fence (
    lock_id INTEGER PRIMARY KEY CHECK (lock_id = 1),
    epoch INTEGER NOT NULL
  );
  INSERT INTO deployment_host_fence(lock_id, epoch) VALUES (1, 0);

  CREATE TABLE deployment_maintenance (
    lock_id INTEGER PRIMARY KEY CHECK (lock_id = 1),
    fence_epoch INTEGER NOT NULL,
    fence_nonce TEXT NOT NULL,
    target_id TEXT NOT NULL,
    job_id TEXT NOT NULL UNIQUE REFERENCES deployment_jobs(id) ON DELETE CASCADE,
    delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL,
    revision TEXT NOT NULL,
    target_fingerprint TEXT NOT NULL,
    target_manifest_hash TEXT NOT NULL,
    rollback_attempt INTEGER NOT NULL,
    baseline_revision TEXT NOT NULL,
    baseline_fingerprint TEXT NOT NULL,
    baseline_manifest_hash TEXT NOT NULL,
    baseline_health_fingerprint TEXT NOT NULL,
    expected_revision TEXT NOT NULL,
    expected_fingerprint TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('deploying','healthy','rolling_back','releasing','needs_recovery')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  INSERT INTO deployment_maintenance
    (lock_id, fence_epoch, fence_nonce, target_id, job_id, delivery_id, generation, revision,
     target_fingerprint, target_manifest_hash, rollback_attempt, baseline_revision,
     baseline_fingerprint, baseline_manifest_hash, baseline_health_fingerprint,
     expected_revision, expected_fingerprint, phase, created_at, updated_at)
    SELECT 1, 1, 'legacy-v18', target_id, job_id, delivery_id, generation, revision,
           target_fingerprint, '', rollback_attempt, baseline_revision,
           '', '', '', expected_revision, target_fingerprint, 'needs_recovery', created_at, updated_at
    FROM deployment_maintenance_v15_copy LIMIT 1;
  UPDATE deployment_host_fence SET epoch = CASE WHEN EXISTS(SELECT 1 FROM deployment_maintenance) THEN 1 ELSE 0 END WHERE lock_id = 1;
  UPDATE deployment_jobs
    SET status = 'needs_recovery', checkpoint = 'rollback_incomplete', failure_kind = 'legacy_ack_required',
        rollback_complete = 0, fence_epoch = 1, fence_nonce = 'legacy-v18', lease_token = NULL, lease_expires_at = NULL,
        error = 'v18 active deployment 必须由管理员验证 host baseline 后 ack/bootstrap'
    WHERE id IN (SELECT job_id FROM deployment_maintenance);
  UPDATE deliveries
    SET deployment_status = 'needs_recovery',
        deployment_error = 'v18 active deployment 必须由管理员验证 host baseline 后 ack/bootstrap'
    WHERE active_deployment_job_id IN (SELECT job_id FROM deployment_maintenance);
  DROP TABLE deployment_maintenance_v15_copy;

  -- v18 误把没有 automatic target/job 的 manual/GitHub running delivery 锁死；恢复原人工语义。
  UPDATE deliveries
    SET deployment_status = 'running', deployment_error = NULL
    WHERE deployment_status = 'needs_recovery'
      AND deployment_target_id IS NULL AND active_deployment_job_id IS NULL
      AND deployment_error LIKE 'v17 active deployment 缺少 target fingerprint/maintenance anchor%';

  -- v17 legacy automatic rows没有可信 fingerprint/anchor，必须显式 ack，不能给永远不可执行的 recover。
  UPDATE deliveries
    SET deployment_error = 'legacy automatic deployment 缺少可信 baseline；请执行管理员 ack 后重新 bootstrap'
    WHERE active_deployment_job_id IN (
      SELECT id FROM deployment_jobs WHERE failure_kind = 'legacy_ack_required'
    );
  `,
  // v20 —— versioned built-in Skills（Harbor control-plane capability）
  `
  CREATE TABLE skills_v20 (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL CHECK (source IN ('builtin','manual','runtime','codebase','github','upload')),
    instruction TEXT NOT NULL,
    device_id TEXT REFERENCES devices(id),
    source_path TEXT,
    runtimes TEXT NOT NULL DEFAULT '["claude","codex"]',
    group_id TEXT REFERENCES skill_groups(id) ON DELETE SET NULL,
    origin_url TEXT,
    source_ref TEXT,
    entry_hash TEXT NOT NULL DEFAULT '',
    bundle_hash TEXT NOT NULL DEFAULT '',
    auto_sync INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER,
    UNIQUE (workspace_id, name),
    CHECK (
      (source = 'runtime' AND device_id IS NOT NULL AND source_path IS NOT NULL) OR
      (source <> 'runtime' AND device_id IS NULL)
    )
  );
  INSERT INTO skills_v20
    (id, workspace_id, name, description, source, instruction, device_id, source_path, runtimes,
     group_id, origin_url, source_ref, entry_hash, bundle_hash, auto_sync,
     created_at, updated_at, archived_at)
    SELECT id, workspace_id, name, description, source, instruction, device_id, source_path, runtimes,
           group_id, origin_url, source_ref, entry_hash, bundle_hash, auto_sync,
           created_at, updated_at, archived_at
    FROM skills;
  DROP TABLE skills;
  ALTER TABLE skills_v20 RENAME TO skills;
  CREATE UNIQUE INDEX idx_skills_runtime_source ON skills(workspace_id, device_id, source_path)
    WHERE source = 'runtime';
  CREATE INDEX idx_skills_workspace ON skills(workspace_id, archived_at, updated_at);
  CREATE INDEX idx_skills_group ON skills(group_id, updated_at);
  `,
  // v21 —— 把全局 maintenance guard 下沉到 application DB mutation 线性化点。
  "",
  // v22 —— 开放编排：中性 coordination Run、Run lineage、exact-revision Review 与持久领域事件。
  `
  CREATE TABLE runs_v22 (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    source_type TEXT NOT NULL CHECK (source_type IN ('issue','chat','automation')),
    source_id TEXT NOT NULL,
    conversation_id TEXT REFERENCES conversations(id),
    agent_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    repository_id TEXT REFERENCES repositories(id),
    repository_mount_id TEXT REFERENCES repository_mounts(id),
    execution_root TEXT,
    prompt TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT 'implementation'
      CHECK (purpose IN ('implementation','triage','review','verification','coordination')),
    prompt_event TEXT NOT NULL CHECK (prompt_event IN (
      'event.issue.assigned','event.issue.mentioned','event.issue.message_created',
      'event.chat.message_created','event.automation.schedule','event.automation.manual',
      'event.automation.webhook','event.automation.event'
    )),
    trigger_ref TEXT,
    trigger_context TEXT NOT NULL DEFAULT '{}',
    concurrency_key TEXT,
    parent_run_id TEXT REFERENCES runs(id),
    root_run_id TEXT NOT NULL,
    dispatch_depth INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_depth >= 0),
    dispatch_key TEXT,
    review_delivery_id TEXT REFERENCES deliveries(id),
    review_revision TEXT,
    review_ref TEXT,
    review_remote_url TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    claude_session_id TEXT,
    error TEXT,
    cost_usd REAL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cached_tokens INTEGER,
    queued_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    CHECK (
      (source_type = 'automation' AND conversation_id IS NULL) OR
      (source_type IN ('issue','chat') AND conversation_id IS NOT NULL AND source_id = conversation_id)
    ),
    CHECK (
      (review_delivery_id IS NULL AND review_revision IS NULL AND review_ref IS NULL AND review_remote_url IS NULL) OR
      (review_delivery_id IS NOT NULL AND review_revision IS NOT NULL AND review_ref IS NOT NULL AND review_remote_url IS NOT NULL)
    )
  );
  INSERT INTO runs_v22
    (id, workspace_id, source_type, source_id, conversation_id, agent_id, device_id,
     repository_id, repository_mount_id, execution_root, prompt, purpose, prompt_event, trigger_ref,
     trigger_context, concurrency_key, parent_run_id, root_run_id, dispatch_depth, dispatch_key,
     review_delivery_id, review_revision, review_ref, review_remote_url,
     status, claude_session_id, error, cost_usd, input_tokens, output_tokens, cached_tokens,
     queued_at, started_at, finished_at)
    SELECT id, workspace_id, source_type, source_id, conversation_id, agent_id, device_id,
           repository_id, repository_mount_id, execution_root, prompt, purpose, prompt_event, trigger_ref,
           trigger_context, concurrency_key, NULL, id, 0, NULL,
           NULL, NULL, NULL, NULL,
           status, claude_session_id, error, cost_usd, input_tokens, output_tokens, cached_tokens,
           queued_at, started_at, finished_at
    FROM runs;
  DROP TABLE runs;
  ALTER TABLE runs_v22 RENAME TO runs;
  CREATE INDEX idx_runs_device_status ON runs(device_id, status);
  CREATE INDEX idx_runs_conversation ON runs(conversation_id);
  CREATE INDEX idx_runs_workspace ON runs(workspace_id, queued_at);
  CREATE INDEX idx_runs_source ON runs(source_type, source_id, queued_at);
  CREATE INDEX idx_runs_trigger_ref ON runs(trigger_ref, status, queued_at);
  CREATE INDEX idx_runs_concurrency ON runs(concurrency_key, status, queued_at);
  CREATE INDEX idx_runs_parent ON runs(parent_run_id, queued_at);
  CREATE UNIQUE INDEX idx_runs_dispatch_key ON runs(root_run_id, dispatch_key) WHERE dispatch_key IS NOT NULL;

  CREATE TABLE automations_v22 (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    repository_id TEXT REFERENCES repositories(id),
    prompt TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT 'implementation'
      CHECK (purpose IN ('implementation','triage','review','verification','coordination')),
    output_mode TEXT NOT NULL DEFAULT 'run' CHECK (output_mode IN ('run','chat','issue','append','source')),
    overlap_mode TEXT NOT NULL DEFAULT 'skip' CHECK (overlap_mode IN ('skip','queue')),
    target_conversation_id TEXT REFERENCES conversations(id),
    notify_chat_id TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_fired_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (workspace_id, name),
    CHECK (
      (output_mode = 'append' AND target_conversation_id IS NOT NULL) OR
      (output_mode <> 'append' AND target_conversation_id IS NULL)
    )
  );
  INSERT INTO automations_v22
    (id, workspace_id, name, agent_id, repository_id, prompt, purpose, output_mode, overlap_mode,
     target_conversation_id, notify_chat_id, enabled, last_fired_at, created_at, updated_at)
    SELECT id, workspace_id, name, agent_id, repository_id, prompt, purpose, output_mode, overlap_mode,
           target_conversation_id, notify_chat_id, enabled, last_fired_at, created_at, updated_at
    FROM automations;
  DROP TABLE automations;
  ALTER TABLE automations_v22 RENAME TO automations;
  CREATE INDEX idx_automations_workspace ON automations(workspace_id, name);

  CREATE TABLE IF NOT EXISTS domain_events (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL CHECK (event_type IN (
      'issue.created','issue.ready','issue.review_ready','delivery.merge_ready','delivery.merged'
    )),
    source_type TEXT NOT NULL CHECK (source_type IN ('issue','delivery')),
    source_id TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_domain_events_workspace ON domain_events(workspace_id, created_at, id);
  `,
  // v23 —— P6.1 identity normalization：全局 Account + Workspace Membership + browser/API auth 基座。
  `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    primary_email TEXT,
    primary_email_normalized TEXT UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('active','suspended','deleted')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE TABLE auth_identities (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    provider TEXT NOT NULL,
    subject TEXT NOT NULL,
    email TEXT,
    verified_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE(provider, subject)
  );
  CREATE INDEX idx_auth_identities_account ON auth_identities(account_id, created_at);
  CREATE TABLE passkey_credentials (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    credential_id TEXT NOT NULL UNIQUE,
    public_key BLOB NOT NULL,
    sign_count INTEGER NOT NULL DEFAULT 0,
    transports TEXT NOT NULL DEFAULT '[]',
    label TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
  );
  CREATE INDEX idx_passkeys_account ON passkey_credentials(account_id, revoked_at);
  CREATE TABLE account_recovery_codes (
    account_id TEXT NOT NULL REFERENCES accounts(id),
    code_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    used_at INTEGER,
    PRIMARY KEY(account_id, code_hash)
  );
  CREATE TABLE account_sessions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    token_hash TEXT NOT NULL UNIQUE,
    csrf_token_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    last_used_at INTEGER,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE INDEX idx_account_sessions_account ON account_sessions(account_id, revoked_at, expires_at);
  CREATE TABLE webauthn_challenges (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    flow TEXT NOT NULL CHECK (flow IN ('bootstrap','register','invite','authenticate')),
    account_id TEXT REFERENCES accounts(id),
    invitation_id TEXT REFERENCES workspace_invitations(id),
    display_name TEXT,
    challenge TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    consumed_at INTEGER
  );
  CREATE INDEX idx_webauthn_challenges_expiry ON webauthn_challenges(expires_at, consumed_at);
  CREATE TABLE personal_access_tokens (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    workspace_id TEXT REFERENCES workspaces(id),
    label TEXT NOT NULL,
    prefix TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    scopes TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    last_used_at INTEGER,
    revoked_at INTEGER
  );
  CREATE INDEX idx_personal_access_tokens_account ON personal_access_tokens(account_id, revoked_at, expires_at);
  CREATE TABLE workspace_invitations (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    email TEXT,
    role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
    token_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('pending','accepted','revoked','expired')),
    invited_by_account_id TEXT NOT NULL REFERENCES accounts(id),
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    accepted_at INTEGER
  );
  CREATE INDEX idx_workspace_invitations_workspace ON workspace_invitations(workspace_id, status, created_at);

  ALTER TABLE workspace_members ADD COLUMN account_id TEXT REFERENCES accounts(id);
  CREATE UNIQUE INDEX idx_workspace_members_account
    ON workspace_members(workspace_id, account_id) WHERE account_id IS NOT NULL;
  ALTER TABLE workspaces ADD COLUMN kind TEXT NOT NULL DEFAULT 'team'
    CHECK (kind IN ('personal','team'));
  ALTER TABLE workspaces ADD COLUMN created_by_account_id TEXT REFERENCES accounts(id);
  `,
  // v24 —— Device 高频列表持久化轻量 projection；完整 capabilities 继续用于 runtime Skill import。
  `
  ALTER TABLE devices ADD COLUMN capabilities_summary TEXT NOT NULL DEFAULT '{}';
  `,
  // v25 —— Mew Automation product model：单一 Output + 单一 Schedule/Codebase Trigger。
  `
  CREATE TABLE automation_legacy_archive_v25 (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    purpose TEXT NOT NULL,
    output_mode TEXT NOT NULL,
    overlap_mode TEXT NOT NULL,
    target_conversation_id TEXT,
    notify_chat_id TEXT,
    enabled INTEGER NOT NULL,
    trigger_snapshot TEXT NOT NULL,
    archived_at INTEGER NOT NULL,
    reason TEXT NOT NULL
  );

  CREATE TABLE automations_v25 (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    prompt TEXT NOT NULL,
    output_mode TEXT NOT NULL CHECK (output_mode IN ('run','chat','issue')),
    enabled INTEGER NOT NULL DEFAULT 1,
    last_fired_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (workspace_id, name)
  );

  INSERT INTO automations_v25
    (id, workspace_id, name, agent_id, prompt, output_mode, enabled,
     last_fired_at, created_at, updated_at)
    SELECT a.id, a.workspace_id, a.name, a.agent_id, a.prompt, a.output_mode,
           CASE WHEN a.enabled != 0 AND EXISTS (
             SELECT 1 FROM automation_triggers only_trigger
             WHERE only_trigger.automation_id = a.id AND only_trigger.enabled != 0
           ) THEN 1 ELSE 0 END,
           a.last_fired_at, a.created_at, a.updated_at
    FROM automations a
    WHERE a.output_mode IN ('run','chat','issue')
      AND (SELECT COUNT(*) FROM automation_triggers t WHERE t.automation_id = a.id) = 1
      AND EXISTS (
        SELECT 1 FROM automation_triggers t
        WHERE t.automation_id = a.id
          AND (
            (t.type = 'schedule' AND t.cron IS NOT NULL) OR
            (t.type = 'webhook' AND t.provider = 'codebase'
              AND a.repository_id IS NOT NULL
              AND json_array_length(t.events) = 1
              AND json_extract(t.events, '$[0]') IN (
                'merge_request_opened','merge_request_updated','merge_request_merged',
                'issue_opened','issue_updated','issue_commented'
              ))
          )
      );

  INSERT INTO automation_legacy_archive_v25
    (id, workspace_id, name, agent_id, prompt, purpose, output_mode, overlap_mode,
     target_conversation_id, notify_chat_id, enabled, trigger_snapshot, archived_at, reason)
    SELECT a.id, a.workspace_id, a.name, a.agent_id, a.prompt, a.purpose,
           a.output_mode, a.overlap_mode, a.target_conversation_id, a.notify_chat_id,
           a.enabled,
           COALESCE((
             SELECT json_group_array(json_object(
               'id', t.id, 'type', t.type, 'enabled', t.enabled, 'cron', t.cron,
               'provider', t.provider, 'events', json(t.events), 'filters', json(t.filters),
               'lastFiredAt', t.last_fired_at, 'createdAt', t.created_at, 'updatedAt', t.updated_at
             )) FROM automation_triggers t WHERE t.automation_id = a.id
           ), '[]'),
           CAST(strftime('%s','now') AS INTEGER) * 1000,
           'Not representable as one Mew Output plus one Schedule/Codebase Trigger'
    FROM automations a
    WHERE NOT EXISTS (SELECT 1 FROM automations_v25 fresh WHERE fresh.id = a.id);

  CREATE TABLE automation_triggers_v25 (
    id TEXT PRIMARY KEY,
    automation_id TEXT NOT NULL UNIQUE REFERENCES automations(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('schedule','codebase')),
    cron TEXT,
    timezone TEXT,
    repository_id TEXT REFERENCES repositories(id),
    codebase_event TEXT CHECK (codebase_event IN (
      'merge_request_opened','merge_request_updated','merge_request_merged',
      'issue_opened','issue_updated','issue_commented'
    )),
    last_fired_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (
      (type = 'schedule' AND cron IS NOT NULL AND timezone IS NOT NULL
        AND repository_id IS NULL AND codebase_event IS NULL) OR
      (type = 'codebase' AND cron IS NULL AND timezone IS NULL
        AND repository_id IS NOT NULL AND codebase_event IS NOT NULL)
    )
  );

  INSERT INTO automation_triggers_v25
    (id, automation_id, type, cron, timezone, repository_id, codebase_event,
     last_fired_at, created_at, updated_at)
    SELECT t.id, t.automation_id,
           CASE WHEN t.type = 'schedule' THEN 'schedule' ELSE 'codebase' END,
           CASE WHEN t.type = 'schedule' THEN t.cron ELSE NULL END,
           CASE WHEN t.type = 'schedule' THEN 'Asia/Shanghai' ELSE NULL END,
           CASE WHEN t.type = 'webhook' THEN a.repository_id ELSE NULL END,
           CASE WHEN t.type = 'webhook' THEN json_extract(t.events, '$[0]') ELSE NULL END,
           t.last_fired_at, t.created_at, t.updated_at
    FROM automation_triggers t
    JOIN automations a ON a.id = t.automation_id
    JOIN automations_v25 fresh ON fresh.id = t.automation_id;

  CREATE TABLE automation_trigger_deliveries_v25 (
    trigger_id TEXT NOT NULL REFERENCES automation_triggers(id) ON DELETE CASCADE,
    delivery_id TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    PRIMARY KEY (trigger_id, delivery_id)
  );
  INSERT INTO automation_trigger_deliveries_v25
    SELECT delivery.trigger_id, delivery.delivery_id, delivery.received_at
    FROM automation_trigger_deliveries delivery
    JOIN automation_triggers_v25 trigger ON trigger.id = delivery.trigger_id;

  DROP TABLE automation_trigger_deliveries;
  DROP TABLE automation_triggers;
  DROP TABLE automations;
  ALTER TABLE automations_v25 RENAME TO automations;
  ALTER TABLE automation_triggers_v25 RENAME TO automation_triggers;
  ALTER TABLE automation_trigger_deliveries_v25 RENAME TO automation_trigger_deliveries;
  CREATE INDEX idx_automations_workspace ON automations(workspace_id, name);
  CREATE INDEX idx_automation_triggers_repository ON automation_triggers(repository_id, codebase_event);
  CREATE INDEX idx_automation_trigger_deliveries_ts ON automation_trigger_deliveries(received_at);
  `,
  // v26 —— Agent-owned Harbor self deployment：独立 durable queue，不再依赖 Delivery 生命周期。
  // legacy deployment_* 表暂留一个 release，供部署本 migration 的旧 worker 完成 cutover。
  `
  CREATE TABLE self_deploy_jobs (
    id TEXT PRIMARY KEY,
    source_run_id TEXT NOT NULL REFERENCES runs(id),
    request_key TEXT NOT NULL,
    repository_id TEXT NOT NULL REFERENCES repositories(id),
    generation INTEGER NOT NULL,
    target_id TEXT NOT NULL,
    revision TEXT NOT NULL,
    target_fingerprint TEXT NOT NULL,
    target_manifest_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued','running','recovering','succeeded','failed','needs_recovery')),
    attempt INTEGER NOT NULL DEFAULT 0,
    fence_epoch INTEGER,
    fence_nonce TEXT,
    lease_token TEXT,
    lease_expires_at INTEGER,
    checkpoint TEXT NOT NULL DEFAULT 'queued',
    log TEXT,
    error TEXT,
    failure_kind TEXT CHECK (failure_kind IS NULL OR failure_kind IN (
      'config_drift','bootstrap_required','deployment_failed','rollback_incomplete'
    )),
    rollback_complete INTEGER,
    rollback_attempt INTEGER,
    baseline_revision TEXT,
    baseline_fingerprint TEXT,
    baseline_manifest_hash TEXT,
    baseline_health_fingerprint TEXT,
    database_backup_created INTEGER NOT NULL DEFAULT 0,
    new_service_pids TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    updated_at INTEGER NOT NULL,
    UNIQUE(source_run_id, request_key),
    UNIQUE(target_id, generation)
  );
  CREATE INDEX idx_self_deploy_jobs_claim
    ON self_deploy_jobs(status, lease_expires_at, created_at);
  CREATE INDEX idx_self_deploy_jobs_source
    ON self_deploy_jobs(source_run_id, created_at);

  CREATE TABLE self_deploy_host_fence (
    lock_id INTEGER PRIMARY KEY CHECK (lock_id = 1),
    epoch INTEGER NOT NULL
  );
  INSERT INTO self_deploy_host_fence(lock_id, epoch)
    VALUES (1, COALESCE((SELECT epoch FROM deployment_host_fence WHERE lock_id = 1), 0));

  CREATE TABLE self_deploy_maintenance (
    lock_id INTEGER PRIMARY KEY CHECK (lock_id = 1),
    fence_epoch INTEGER NOT NULL,
    fence_nonce TEXT NOT NULL,
    target_id TEXT NOT NULL,
    job_id TEXT NOT NULL REFERENCES self_deploy_jobs(id),
    source_run_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    revision TEXT NOT NULL,
    target_fingerprint TEXT NOT NULL,
    target_manifest_hash TEXT NOT NULL,
    rollback_attempt INTEGER NOT NULL,
    baseline_revision TEXT NOT NULL,
    baseline_fingerprint TEXT NOT NULL,
    baseline_manifest_hash TEXT NOT NULL,
    baseline_health_fingerprint TEXT NOT NULL,
    expected_revision TEXT NOT NULL,
    expected_fingerprint TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('deploying','healthy','rolling_back','releasing','needs_recovery')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
];

function backfillDeviceCapabilitySummaries(db: Database): void {
  const rows = db.query<{ id: string; capabilities: string }, []>(
    "SELECT id, capabilities FROM devices",
  ).all();
  const update = db.query<void, [string, string]>(
    "UPDATE devices SET capabilities_summary = ? WHERE id = ?",
  );
  for (const row of rows) {
    const capabilities = JSON.parse(row.capabilities) as DeviceCapabilities;
    update.run(JSON.stringify(summarizeDeviceCapabilities(capabilities)), row.id);
  }
}

function hasTable(db: Database, table: string): boolean {
  return !!db
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(table);
}

function hasColumn(db: Database, table: string, column: string): boolean {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .some((entry) => entry.name === column);
}

function ensureGitHubDeliveryColumns(db: Database): void {
  if (!hasColumn(db, "deliveries", "latest_head_sha")) {
    db.exec("ALTER TABLE deliveries ADD COLUMN latest_head_sha TEXT;");
  }
  if (!hasColumn(db, "deliveries", "approved_head_sha")) {
    db.exec("ALTER TABLE deliveries ADD COLUMN approved_head_sha TEXT;");
  }
  if (!hasColumn(db, "deliveries", "revision")) {
    db.exec("ALTER TABLE deliveries ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;");
  }
}

export const LATEST_SCHEMA_VERSION = MIGRATIONS.length;

function normalizeLegacyRepositoryNames(db: Database): void {
  const rows = db
    .query<{ id: string; workspace_id: string; name: string }, []>(
      "SELECT id, workspace_id, name FROM repositories WHERE name LIKE '/%' OR name LIKE '~%'",
    )
    .all();
  for (const row of rows) {
    const base = basename(row.name.replace(/\/$/, "")) || "repository";
    let candidate = base;
    let n = 2;
    while (
      db
        .query<{ id: string }, [string, string, string]>(
          "SELECT id FROM repositories WHERE workspace_id = ? AND name = ? AND id <> ?",
        )
        .get(row.workspace_id, candidate, row.id)
    ) {
      candidate = `${base} (${n++})`;
    }
    db.run("UPDATE repositories SET name = ? WHERE id = ?", [candidate, row.id]);
  }
}

function openDbAtVersion(path: string, targetVersion: number): Database {
  if (!Number.isInteger(targetVersion) || targetVersion < 1 || targetVersion > MIGRATIONS.length) {
    throw new Error(`无效 SQLite target schema v${targetVersion}`);
  }
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true });
  if (path !== ":memory:") chmodSync(path, 0o600);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  let version = row?.user_version ?? 0;
  if (version > targetVersion) {
    db.close();
    throw new Error(`SQLite schema v${version} 新于目标 v${targetVersion}；拒绝隐式降级`);
  }

  // codex/harbor-self-hosting 曾把 GitHub migrations 占用了 v12/v13。按结构识别该 lineage，
  // 先补跑 canonical Mew parity v12/v13，再从 v14 汇合；不能只信 user_version。
  if (version >= 12 && version <= 13 && !hasTable(db, "automation_triggers")) {
    db.exec("PRAGMA foreign_keys = OFF;");
    try {
      db.transaction(() => {
        db.exec(MIGRATIONS[11]!);
        db.exec(MIGRATIONS[12]!);
        db.exec("PRAGMA user_version = 13");
      })();
    } finally {
      db.exec("PRAGMA foreign_keys = ON;");
    }
    version = 13;
  }

  while (version < targetVersion) {
    // deployment phase 3（当前 MIGRATIONS[18]）收敛 host-global gate 前拒绝多重 legacy gate。
    if (version === 18) {
      const active = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM deployment_maintenance").get()?.count ?? 0;
      if (active > 1) {
        db.close();
        throw new Error("deployment convergence migration 拒绝多个 legacy maintenance gates；请先离线恢复到唯一 baseline");
      }
    }
    const sql = MIGRATIONS[version]!;
    const identityReport = version === 22 ? inspectIdentityNormalization(db) : null;
    if (identityReport && !identityReport.migratable) {
      const blockers = identityReport.issues
        .filter((entry) => entry.severity === "error")
        .map((entry) => `${entry.code}[${entry.refs.join(",")}]`)
        .join("; ");
      db.close();
      throw new Error(`schema v23 identity normalization preflight 失败：${blockers}`);
    }
    const rebuildsReferencedTables =
      version === 8 ||
      version === 9 ||
      version === 11 ||
      version === 12 ||
      version === 14 ||
      version === 15 ||
      version === 16 ||
      version === 17 ||
      version === 18 ||
      version === 19 ||
      version === 21 ||
      version === 24;
    if (rebuildsReferencedTables) db.exec("PRAGMA foreign_keys = OFF;");
    try {
      db.transaction(() => {
        if (version === 14) ensureGitHubDeliveryColumns(db);
        // v21 maintenance triggers 正确阻止应用写；migration 自身在同一 SQLite transaction
        // 内暂时移除待 backfill 表的 trigger，提交前原样重装。其他连接在 commit 前看不到该变化。
        if (version === 22) dropMaintenanceLinearization(db, ["workspace_members", "workspaces"]);
        if (version === 23) dropMaintenanceLinearization(db, ["devices"]);
        if (version === 24) dropMaintenanceLinearization(db, [
          "automations",
          "automation_triggers",
          "automation_trigger_deliveries",
        ]);
        if (version === 25) dropMaintenanceLinearization(db, APPLICATION_MUTATION_TABLES);
        if (sql.trim()) db.exec(sql);
        if (version === 22) {
          applyIdentityNormalization(db, identityReport!);
          installMaintenanceLinearization(db);
        }
        if (version === 23) {
          backfillDeviceCapabilitySummaries(db);
          installMaintenanceLinearization(db);
        }
        if (version === 20) installMaintenanceLinearization(db);
        if (version === 25) installMaintenanceLinearization(db);
        db.exec(`PRAGMA user_version = ${version + 1}`);
      })();
    } finally {
      if (rebuildsReferencedTables) db.exec("PRAGMA foreign_keys = ON;");
    }
    version++;
  }
  if (version >= 21) installMaintenanceLinearization(db);
  normalizeLegacyRepositoryNames(db);
  const foreignKeyFailures = db.query<Record<string, unknown>, []>("PRAGMA foreign_key_check").all();
  if (foreignKeyFailures.length > 0) {
    db.close();
    throw new Error(`SQLite migration foreign_key_check 失败（${foreignKeyFailures.length} rows）`);
  }
  return db;
}

export function openDb(path: string): Database {
  return openDbAtVersion(path, LATEST_SCHEMA_VERSION);
}

/**
 * 只给 migration regression fixture 固定历史输入使用。应用代码必须调用 openDb，
 * 否则会把旧 schema 当成可运行版本。限定 v22，避免这个测试闸演变成通用降级入口。
 */
export function openV22MigrationFixtureDb(path = ":memory:"): Database {
  return openDbAtVersion(path, 22);
}

/** 只给 v24 projection migration regression fixture 使用。 */
export function openV23MigrationFixtureDb(path = ":memory:"): Database {
  return openDbAtVersion(path, 23);
}

/** 只给 v25 Mew Automation migration regression fixture 使用。 */
export function openV24MigrationFixtureDb(path = ":memory:"): Database {
  return openDbAtVersion(path, 24);
}

/** 只给 v26 Agent-owned Harbor self-deploy migration regression fixture 使用。 */
export function openV25MigrationFixtureDb(path = ":memory:"): Database {
  return openDbAtVersion(path, 25);
}

function installMaintenanceLinearization(db: Database): void {
  const present = new Set(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  db.exec(maintenanceLinearizationSql(
    APPLICATION_MUTATION_TABLES.filter((table) => present.has(table)),
    present.has("self_deploy_maintenance"),
  ));
}

/** Harbor self-deployer 只打开已 bootstrap 的 queue；绝不创建 DB、绝不运行应用 migration。 */
export function openDeploymentDb(path: string): Database {
  assertPrivateDeploymentDatabase(path);
  const db = new Database(path, { create: false, readwrite: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  const version = row?.user_version ?? 0;
  if (version < 26) {
    db.close();
    throw new Error(`Harbor self-deployer 拒绝 schema v${version}；需要 server bootstrap 到至少 v26`);
  }
  try { assertDeploymentControlCompatibility(db); }
  catch (error) { db.close(); throw error; }
  return db;
}

function assertDeploymentControlCompatibility(db: Database): void {
  const required: Record<string, string[]> = {
    self_deploy_jobs: ["id", "source_run_id", "request_key", "repository_id", "generation", "target_id", "revision", "target_fingerprint", "target_manifest_hash", "status", "attempt", "fence_epoch", "fence_nonce", "lease_token", "lease_expires_at", "checkpoint", "log", "error", "failure_kind", "rollback_complete", "rollback_attempt", "baseline_revision", "baseline_fingerprint", "baseline_manifest_hash", "baseline_health_fingerprint", "database_backup_created", "new_service_pids", "created_at", "started_at", "finished_at", "updated_at"],
    self_deploy_maintenance: ["lock_id", "fence_epoch", "fence_nonce", "target_id", "job_id", "source_run_id", "generation", "revision", "target_fingerprint", "target_manifest_hash", "rollback_attempt", "baseline_revision", "baseline_fingerprint", "baseline_manifest_hash", "baseline_health_fingerprint", "expected_revision", "expected_fingerprint", "phase", "created_at", "updated_at"],
    self_deploy_host_fence: ["lock_id", "epoch"],
  };
  for (const [table, columns] of Object.entries(required)) {
    const present = new Set(db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((row) => row.name));
    const missing = columns.filter((column) => !present.has(column));
    if (missing.length) throw new Error(`Harbor self-deployer control schema incompatible: ${table} 缺少 ${missing.join(",")}`);
  }
}

function assertPrivateDeploymentDatabase(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error("deployment worker DB 必须是 canonical 绝对路径");
  assertTrustedDeploymentDatabaseComponents(path);
  const metadata = lstatSync(path);
  const uid = process.getuid?.();
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("deployment worker DB 必须是 non-symlink regular file");
  if (uid !== undefined && metadata.uid !== uid) throw new Error("deployment worker DB owner 不是当前 uid");
  if ((metadata.mode & 0o777) !== 0o600) throw new Error("deployment worker DB 权限必须精确为 0600");
  if (realpathSync(path) !== path) throw new Error("deployment worker DB 路径包含 symlink component");
  const parent = dirname(path);
  const parentMetadata = lstatSync(parent);
  if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()
    || (uid !== undefined && parentMetadata.uid !== uid) || (parentMetadata.mode & 0o022) !== 0
    || realpathSync(parent) !== parent) {
    throw new Error("deployment worker DB 父目录必须由当前 uid 拥有、不可写篡改且不能包含 symlink");
  }
}

function assertTrustedDeploymentDatabaseComponents(path: string): void {
  const uid = process.getuid?.();
  const components: string[] = [];
  for (let current = path;; current = dirname(current)) {
    components.push(current);
    if (dirname(current) === current) break;
  }
  components.reverse();
  for (let index = 0; index < components.length; index++) {
    const component = components[index]!;
    const metadata = lstatSync(component);
    const leaf = index === components.length - 1;
    if (metadata.isSymbolicLink() || (!leaf && !metadata.isDirectory())) {
      throw new Error(`deployment worker DB 路径含不可信 component ${component}`);
    }
    if (uid !== undefined && metadata.uid !== uid && metadata.uid !== 0) {
      throw new Error(`deployment worker DB component ${component} owner 不可信`);
    }
    if ((metadata.mode & 0o022) !== 0) {
      const trustedStickySystemParent = !leaf && metadata.uid === 0 && (metadata.mode & 0o1000) !== 0;
      if (!trustedStickySystemParent) throw new Error(`deployment worker DB component ${component} 不能 group/world writable`);
    }
  }
}

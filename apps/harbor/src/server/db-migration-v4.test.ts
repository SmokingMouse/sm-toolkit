import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LATEST_SCHEMA_VERSION, MIGRATIONS, openDb, openDeploymentDb, openV22MigrationFixtureDb, openV25MigrationFixtureDb } from "./db.js";
import { DeliveryService } from "./delivery.js";
import { renderRunPrompt } from "./prompt-wrapper.js";
import { HarborStore } from "./store.js";

test("deployment worker refuses an old schema without creating or migrating it", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "harbor-worker-schema-")));
  const path = join(dir, "legacy.db");
  try {
    const legacy = new Database(path, { create: true });
    legacy.exec("PRAGMA user_version = 13");
    legacy.close();
    chmodSync(path, 0o600);
    expect(() => openDeploymentDb(path)).toThrow("拒绝 schema v13");
    const verify = new Database(path, { readonly: true });
    expect(verify.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(13);
    verify.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
    expect(migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(LATEST_SCHEMA_VERSION);
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
        prompt, purpose, prompt_event, root_run_id, status, queued_at)
       VALUES ('triage_1', 'ws_personal', 'issue', 'draft_1', 'draft_1', 'agent_1', 'device_1',
        'triage me', 'triage', 'event.issue.message_created', 'triage_1', 'queued', 10)`,
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
      CREATE TABLE deliveries (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id),
        provider TEXT NOT NULL, change_url TEXT, external_id TEXT, head_branch TEXT, base_branch TEXT,
        review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','approved')),
        check_status TEXT NOT NULL DEFAULT 'unknown' CHECK (check_status IN ('unknown','pending','passed','failed')),
        merge_status TEXT NOT NULL DEFAULT 'open' CHECK (merge_status IN ('open','merged')),
        deployment_status TEXT NOT NULL DEFAULT 'not_required' CHECK (deployment_status IN ('not_required','pending','running','succeeded','failed')),
        review_approved_at INTEGER, merged_at INTEGER, deployed_at INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_deliveries_conversation ON deliveries(conversation_id);
      CREATE TABLE delivery_events (
        delivery_id TEXT NOT NULL REFERENCES deliveries(id), kind TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}', actor TEXT NOT NULL, ts INTEGER NOT NULL
      );
      CREATE INDEX idx_delivery_events ON delivery_events(delivery_id, ts);
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
      INSERT INTO deliveries
        (id, conversation_id, provider, change_url, external_id, head_branch, base_branch,
         review_status, check_status, merge_status, deployment_status, review_approved_at,
         merged_at, deployed_at, created_at, updated_at)
        VALUES
        ('delivery_v9', 'conversation_1', 'manual', 'https://example.test/mr/9', 'MR-9', 'feature', 'main',
         'approved', 'passed', 'open', 'not_required', 4, NULL, NULL, 4, 4);
      INSERT INTO delivery_events VALUES ('delivery_v9', 'review_approved', '{"source":"v9"}', 'human', 4);
      INSERT INTO workspace_prompt_templates VALUES ('ws_personal', 'issue', 1, 'Legacy={{prompt}}', 4);
      PRAGMA user_version = 9;
    `);
    v9.close();

    const migrated = openDb(path);
    expect(migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(LATEST_SCHEMA_VERSION);
    const agent = migrated.query<{ repository_id: string }, []>("SELECT repository_id FROM agents WHERE id = 'agent_1'").get();
    expect(agent?.repository_id).toStartWith("repo_unconfigured_");
    expect(migrated.query<{ repository_id: string }, []>("SELECT repository_id FROM conversations WHERE id = 'conversation_1'").get()).toEqual(agent);
    expect(migrated.query<{ output_mode: string }, []>("SELECT output_mode FROM automations WHERE id = 'automation_1'").get()).toEqual({ output_mode: "issue" });
    expect(migrated.query<{ type: string; cron: string; timezone: string }, []>(
      "SELECT type, cron, timezone FROM automation_triggers WHERE automation_id = 'automation_1'",
    ).get()).toEqual({ type: "schedule", cron: "0 0 * * *", timezone: "Asia/Shanghai" });
    expect(
      migrated.query<{ name: string }, []>("PRAGMA table_info(agents)").all().map((column) => column.name),
    ).toContain("repository_id");
    expect(
      migrated.query<{ template: string }, []>(
        "SELECT template FROM workspace_prompt_blocks WHERE workspace_id = 'ws_personal' AND block_key = 'session.issue.context'",
      ).get(),
    ).toEqual({ template: "Legacy={{prompt}}" });
    expect(
      migrated.query<{
        provider: string;
        review_status: string;
        check_status: string;
        latest_head_sha: string | null;
        approved_head_sha: string | null;
        revision: number;
      }, []>(
        "SELECT provider, review_status, check_status, latest_head_sha, approved_head_sha, revision FROM deliveries WHERE id = 'delivery_v9'",
      ).get(),
    ).toEqual({
      provider: "manual",
      review_status: "approved",
      check_status: "passed",
      latest_head_sha: null,
      approved_head_sha: null,
      revision: 0,
    });
    expect(migrated.query<{ kind: string }, []>("SELECT kind FROM delivery_events WHERE delivery_id = 'delivery_v9'").all()).toEqual([
      { kind: "review_approved" },
    ]);
    expect(migrated.query<unknown, []>("PRAGMA foreign_key_check").all()).toEqual([]);
    migrated.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("latest schema preserves v11 Delivery rows and audit events while adding deployment recovery fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-v11-delivery-"));
  const path = join(dir, "v11.db");
  try {
    const current = openV22MigrationFixtureDb(path);
    const store = new HarborStore(current);
    const device = store.upsertDevice("worker", "hash", { clis: { claude: "2.1" }, endpoints: [] }, 1);
    const repository = store.createRepository(
      { workspaceId: store.defaultWorkspace().id, name: "repo", remoteUrl: "https://github.com/acme/repo.git" },
      2,
    );
    store.setRepositoryMount(repository.id, device.id, "/repo", 3);
    const agent = store.createAgent(
      { name: "builder", deviceId: device.id, backend: "claude", repositoryId: repository.id },
      4,
    );
    const issue = store.createConversation({ kind: "issue", title: "Keep delivery", agentId: agent.id, origin: "web" }, 5);
    store.setConversationStatus(issue.id, "review", 6);
    const delivery = new DeliveryService(store).create(
      store.getConversation(issue.id)!,
      { changeUrl: "https://github.com/acme/repo/pull/1" },
      7,
    );

    current.exec("PRAGMA foreign_keys = OFF;");
    current.exec(`
      CREATE TABLE deliveries_v11 (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id),
        provider TEXT NOT NULL, change_url TEXT, external_id TEXT, head_branch TEXT, base_branch TEXT,
        review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','approved')),
        check_status TEXT NOT NULL DEFAULT 'unknown' CHECK (check_status IN ('unknown','pending','passed','failed')),
        merge_status TEXT NOT NULL DEFAULT 'open' CHECK (merge_status IN ('open','merged')),
        deployment_status TEXT NOT NULL DEFAULT 'not_required' CHECK (deployment_status IN ('not_required','pending','running','succeeded','failed')),
        review_approved_at INTEGER, merged_at INTEGER, deployed_at INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      DROP TABLE deployment_jobs;
      INSERT INTO deliveries_v11
        (id, conversation_id, provider, change_url, external_id, head_branch, base_branch,
         review_status, check_status, merge_status, deployment_status, review_approved_at,
         merged_at, deployed_at, created_at, updated_at)
        SELECT id, conversation_id, provider, change_url, external_id, head_branch, base_branch,
               review_status, check_status, merge_status, deployment_status, review_approved_at,
               merged_at, deployed_at, created_at, updated_at
        FROM deliveries;
      DROP TABLE deliveries;
      ALTER TABLE deliveries_v11 RENAME TO deliveries;
      CREATE INDEX idx_deliveries_conversation ON deliveries(conversation_id);
      DROP TABLE automation_trigger_deliveries;
      PRAGMA user_version = 14;
    `);
    current.close();

    const migrated = openDb(path);
    expect(migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(LATEST_SCHEMA_VERSION);
    expect(migrated.query<{ provider: string; change_url: string }, [string]>("SELECT provider, change_url FROM deliveries WHERE id = ?").get(delivery.id)).toEqual({
      provider: "manual",
      change_url: "https://github.com/acme/repo/pull/1",
    });
    expect(migrated.query<{ kind: string }, [string]>("SELECT kind FROM delivery_events WHERE delivery_id = ?").all(delivery.id)).toEqual([{ kind: "created" }]);
    expect(
      migrated.query<{ latest_head_sha: string | null; approved_head_sha: string | null; revision: number }, [string]>(
        "SELECT latest_head_sha, approved_head_sha, revision FROM deliveries WHERE id = ?",
      ).get(delivery.id),
    ).toEqual({ latest_head_sha: null, approved_head_sha: null, revision: 0 });
    migrated.run("UPDATE deliveries SET merge_status = 'closed' WHERE id = ?", [delivery.id]);
    expect(migrated.query<{ merge_status: string }, [string]>("SELECT merge_status FROM deliveries WHERE id = ?").get(delivery.id)).toEqual({ merge_status: "closed" });
    expect(migrated.query<unknown, []>("PRAGMA foreign_key_check").all()).toEqual([]);
    migrated.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("latest schema invalidates unbound GitHub evidence from v12 while preserving Delivery and event data", () => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-v12-delivery-"));
  const path = join(dir, "v12.db");
  try {
    const current = openV22MigrationFixtureDb(path);
    const store = new HarborStore(current);
    const device = store.upsertDevice("worker", "hash", { clis: { claude: "2.1" }, endpoints: [] }, 1);
    const repository = store.createRepository(
      { workspaceId: store.defaultWorkspace().id, name: "repo", remoteUrl: "https://github.com/acme/repo.git" },
      2,
    );
    store.setRepositoryMount(repository.id, device.id, "/repo", 3);
    const agent = store.createAgent(
      { name: "builder", deviceId: device.id, backend: "claude", repositoryId: repository.id },
      4,
    );
    const issue = store.createConversation({ kind: "issue", title: "Keep v12 delivery", agentId: agent.id, origin: "web" }, 5);
    store.setConversationStatus(issue.id, "review", 6);
    const delivery = new DeliveryService(store).create(
      store.getConversation(issue.id)!,
      { changeUrl: "https://github.com/acme/repo/pull/12" },
      7,
    );
    current.run(
      `UPDATE deliveries
       SET provider = 'github', review_status = 'approved', check_status = 'passed', review_approved_at = 8
       WHERE id = ?`,
      [delivery.id],
    );

    current.exec("PRAGMA foreign_keys = OFF;");
    current.exec(`
      CREATE TABLE deliveries_v12_fixture (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id),
        provider TEXT NOT NULL, change_url TEXT, external_id TEXT, head_branch TEXT, base_branch TEXT,
        review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','approved')),
        check_status TEXT NOT NULL DEFAULT 'unknown' CHECK (check_status IN ('unknown','pending','passed','failed')),
        merge_status TEXT NOT NULL DEFAULT 'open' CHECK (merge_status IN ('open','closed','merged')),
        deployment_status TEXT NOT NULL DEFAULT 'not_required' CHECK (deployment_status IN ('not_required','pending','running','succeeded','failed')),
        review_approved_at INTEGER, merged_at INTEGER, deployed_at INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      DROP TABLE deployment_jobs;
      INSERT INTO deliveries_v12_fixture
        (id, conversation_id, provider, change_url, external_id, head_branch, base_branch,
         review_status, check_status, merge_status, deployment_status, review_approved_at,
         merged_at, deployed_at, created_at, updated_at)
        SELECT id, conversation_id, provider, change_url, external_id, head_branch, base_branch,
               review_status, check_status, merge_status, deployment_status, review_approved_at,
               merged_at, deployed_at, created_at, updated_at
        FROM deliveries;
      DROP TABLE deliveries;
      ALTER TABLE deliveries_v12_fixture RENAME TO deliveries;
      CREATE INDEX idx_deliveries_conversation ON deliveries(conversation_id);
      DROP TABLE automation_trigger_deliveries;
      PRAGMA user_version = 14;
    `);
    current.close();

    const migrated = openDb(path);
    expect(migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(LATEST_SCHEMA_VERSION);
    expect(
      migrated.query<{
        provider: string;
        review_status: string;
        check_status: string;
        review_approved_at: number | null;
        latest_head_sha: string | null;
        approved_head_sha: string | null;
        revision: number;
      }, [string]>(
        `SELECT provider, review_status, check_status, review_approved_at,
                latest_head_sha, approved_head_sha, revision
         FROM deliveries WHERE id = ?`,
      ).get(delivery.id),
    ).toEqual({
      provider: "github",
      review_status: "pending",
      check_status: "pending",
      review_approved_at: null,
      latest_head_sha: null,
      approved_head_sha: null,
      revision: 0,
    });
    expect(migrated.query<{ kind: string }, [string]>("SELECT kind FROM delivery_events WHERE delivery_id = ?").all(delivery.id)).toEqual([
      { kind: "created" },
    ]);
    expect(migrated.query<unknown, []>("PRAGMA foreign_key_check").all()).toEqual([]);
    migrated.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("latest schema converges the historical self-hosting v13 fork without losing GitHub Delivery data", () => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-fork-v13-"));
  const path = join(dir, "fork-v13.db");
  try {
    const fork = new Database(path, { create: true });
    for (let index = 0; index < 11; index++) {
      const rebuildsReferencedTables = index === 8 || index === 9;
      if (rebuildsReferencedTables) fork.exec("PRAGMA foreign_keys = OFF;");
      fork.exec(MIGRATIONS[index]!);
      fork.exec(`PRAGMA user_version = ${index + 1}`);
      if (rebuildsReferencedTables) fork.exec("PRAGMA foreign_keys = ON;");
      if (index === 0) {
        fork.exec(`
          INSERT INTO devices VALUES ('device_fork', 'fork-worker', 'hash', '{}', NULL, 1);
          INSERT INTO agents
            (id, name, device_id, backend, permission, workdir, isolation, created_at)
            VALUES ('agent_fork', 'fork-builder', 'device_fork', 'codex', 'auto-edit', '/repo', 'none', 2);
          INSERT INTO conversations
            (id, kind, title, agent_id, status, origin, created_at, updated_at)
            VALUES ('conversation_fork', 'issue', 'Fork issue', 'agent_fork', 'doing', 'web', 3, 3);
          INSERT INTO runs
            (id, conversation_id, agent_id, device_id, prompt, status, queued_at)
            VALUES ('run_fork', 'conversation_fork', 'agent_fork', 'device_fork', 'implement', 'succeeded', 4);
        `);
      }
    }

    fork.exec("PRAGMA foreign_keys = OFF;");
    fork.exec(`
      INSERT INTO deliveries
        (id, conversation_id, provider, change_url, external_id, head_branch, base_branch,
         review_status, check_status, merge_status, deployment_status, review_approved_at,
         merged_at, deployed_at, created_at, updated_at)
        VALUES ('delivery_fork', 'conversation_fork', 'github',
                'https://github.com/acme/repo/pull/13', '13', 'feature', 'main',
                'approved', 'passed', 'open', 'not_required', 5, NULL, NULL, 5, 5);
      INSERT INTO delivery_events VALUES ('delivery_fork', 'review_approved', '{}', 'human', 5);

      CREATE TABLE deliveries_v12 (
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
        updated_at INTEGER NOT NULL
      );
      INSERT INTO deliveries_v12 SELECT * FROM deliveries;
      DROP TABLE deliveries;
      ALTER TABLE deliveries_v12 RENAME TO deliveries;
      CREATE INDEX idx_deliveries_conversation ON deliveries(conversation_id);
      ALTER TABLE deliveries ADD COLUMN latest_head_sha TEXT;
      ALTER TABLE deliveries ADD COLUMN approved_head_sha TEXT;
      ALTER TABLE deliveries ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
      UPDATE deliveries
        SET review_status = 'pending', review_approved_at = NULL, check_status = 'pending'
        WHERE provider = 'github';
      PRAGMA user_version = 13;
    `);
    fork.exec("PRAGMA foreign_keys = ON;");
    fork.close();

    const migrated = openDb(path);
    expect(migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(LATEST_SCHEMA_VERSION);
    expect(
      migrated.query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'automation_triggers'",
      ).get(),
    ).toEqual({ name: "automation_triggers" });
    expect(
      migrated.query<{ source_type: string; source_id: string }, []>(
        "SELECT source_type, source_id FROM runs WHERE id = 'run_fork'",
      ).get(),
    ).toEqual({ source_type: "issue", source_id: "conversation_fork" });
    expect(
      migrated.query<{
        provider: string;
        review_status: string;
        check_status: string;
        revision: number;
      }, []>(
        "SELECT provider, review_status, check_status, revision FROM deliveries WHERE id = 'delivery_fork'",
      ).get(),
    ).toEqual({ provider: "github", review_status: "pending", check_status: "pending", revision: 0 });
    expect(
      migrated.query<{ kind: string }, []>(
        "SELECT kind FROM delivery_events WHERE delivery_id = 'delivery_fork'",
      ).all(),
    ).toEqual([{ kind: "review_approved" }]);
    expect(migrated.query<unknown, []>("PRAGMA foreign_key_check").all()).toEqual([]);
    migrated.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("v26 creates an independent Harbor self-deploy queue and preserves the host fence high-water", () => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-v25-self-deploy-"));
  const path = join(dir, "v25.db");
  try {
    const current = openV25MigrationFixtureDb(path);
    current.run("UPDATE deployment_host_fence SET epoch = 17 WHERE lock_id = 1");
    current.close();

    const migrated = openDb(path);
    expect(migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(LATEST_SCHEMA_VERSION);
    expect(migrated.query<{ epoch: number }, []>(
      "SELECT epoch FROM self_deploy_host_fence WHERE lock_id = 1",
    ).get()?.epoch).toBe(17);
    expect(migrated.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('self_deploy_jobs','self_deploy_maintenance','self_deploy_host_fence') ORDER BY name",
    ).all().map((row) => row.name)).toEqual([
      "self_deploy_host_fence",
      "self_deploy_jobs",
      "self_deploy_maintenance",
    ]);
    expect(migrated.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM self_deploy_jobs").get()?.count).toBe(0);
    expect(migrated.query<unknown, []>("PRAGMA foreign_key_check").all()).toEqual([]);
    migrated.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("v20 preserves existing Skill bundles, dependencies, and Agent bindings", () => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-v19-skills-"));
  const path = join(dir, "v19.db");
  try {
    const current = openV22MigrationFixtureDb(path);
    const store = new HarborStore(current);
    const device = store.upsertDevice(
      "skill-worker",
      "hash",
      { clis: { codex: "1.0" }, endpoints: [] },
      1,
    );
    const agent = store.createAgent(
      {
        name: "skill-agent",
        deviceId: device.id,
        backend: "codex",
        workdir: "/repo",
      },
      2,
    );
    const skill = store.createSkill(
      {
        name: "existing-skill",
        source: "manual",
        instruction: "Existing instruction",
        files: [
          { path: "SKILL.md", content: "Existing instruction" },
          { path: "reference.md", content: "Existing reference" },
        ],
        dependencies: [
          { name: "rg", spec: ">=14", required: true },
        ],
      },
      3,
    );
    store.setAgentSkills(agent.id, [skill.id], 4);

    current.exec("PRAGMA foreign_keys = OFF;");
    current.exec(`
      CREATE TABLE skills_v19 (
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
      INSERT INTO skills_v19 SELECT * FROM skills;
      DROP TABLE skills;
      ALTER TABLE skills_v19 RENAME TO skills;
      CREATE UNIQUE INDEX idx_skills_runtime_source ON skills(workspace_id, device_id, source_path)
        WHERE source = 'runtime';
      CREATE INDEX idx_skills_workspace ON skills(workspace_id, archived_at, updated_at);
      CREATE INDEX idx_skills_group ON skills(group_id, updated_at);
      PRAGMA user_version = 19;
    `);
    current.close();

    const migrated = openDb(path);
    const migratedStore = new HarborStore(migrated);
    expect(migratedStore.getSkill(skill.id)).toEqual(
      expect.objectContaining({
        source: "manual",
        files: [
          expect.objectContaining({ path: "SKILL.md", content: "Existing instruction" }),
          expect.objectContaining({ path: "reference.md", content: "Existing reference" }),
        ],
        dependencies: [{ name: "rg", spec: ">=14", required: true }],
      }),
    );
    expect(migratedStore.getAgent(agent.id)?.skillIds).toEqual([skill.id]);
    expect(migrated.query<unknown, []>("PRAGMA foreign_key_check").all()).toEqual([]);
    migrated.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

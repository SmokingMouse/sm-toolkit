import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarborStore } from "./store.js";
import { LATEST_SCHEMA_VERSION, openDb, openV24MigrationFixtureDb } from "./db.js";

test("v25 preserves representable Mew Automations and archives legacy product concepts", () => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-automation-v25-"));
  const path = join(dir, "fixture.db");
  try {
    const legacy = openV24MigrationFixtureDb(path);
    const store = new HarborStore(legacy);
    const device = store.upsertDevice("worker", "hash", { clis: { claude: "2.1" }, endpoints: [] }, 1);
    const codebaseRepository = store.createRepository({
      workspaceId: "ws_personal",
      name: "codebase-app",
      scmProvider: "codebase",
      scmRepository: "team/codebase-app",
    }, 2);
    store.setRepositoryMount(codebaseRepository.id, device.id, "/codebase-app", 2);
    const agent = store.createAgent({
      name: "builder",
      deviceId: device.id,
      backend: "claude",
      repositoryId: codebaseRepository.id,
    }, 3);

    const insertAutomation = legacy.prepare(`
      INSERT INTO automations
      (id, workspace_id, name, agent_id, repository_id, prompt, purpose, output_mode,
       overlap_mode, target_conversation_id, notify_chat_id, enabled, last_fired_at, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    insertAutomation.run(
      "auto_schedule",
      "ws_personal",
      "Daily report",
      agent.id,
      codebaseRepository.id,
      "Report status",
      "implementation",
      "run",
      "queue",
      null,
      "oc_legacy",
      1,
      90,
      10,
      90,
    );
    insertAutomation.run(
      "auto_codebase",
      "ws_personal",
      "New MR chat",
      agent.id,
      codebaseRepository.id,
      "Summarize the merge request",
      "implementation",
      "chat",
      "skip",
      null,
      null,
      1,
      null,
      20,
      20,
    );
    insertAutomation.run(
      "auto_review",
      "ws_personal",
      "Auto review and merge",
      agent.id,
      codebaseRepository.id,
      "Review current Issue",
      "review",
      "source",
      "queue",
      null,
      null,
      1,
      null,
      30,
      30,
    );

    const insertTrigger = legacy.prepare(`
      INSERT INTO automation_triggers
      (id, automation_id, type, enabled, cron, provider, events, filters, secret_hash,
       last_fired_at, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    // The old per-trigger enabled bit collapses into the Automation enabled bit.
    insertTrigger.run("trg_schedule", "auto_schedule", "schedule", 0, "0 9 * * *", null, "[]", "[]", null, 90, 10, 90);
    insertTrigger.run(
      "trg_codebase",
      "auto_codebase",
      "webhook",
      1,
      null,
      "codebase",
      '["merge_request_opened"]',
      "[]",
      "legacy-secret-hash",
      null,
      20,
      20,
    );
    insertTrigger.run(
      "trg_review",
      "auto_review",
      "event",
      1,
      null,
      "harbor",
      '["issue.review_ready"]',
      "[]",
      null,
      null,
      30,
      30,
    );
    legacy.run(
      "INSERT INTO automation_trigger_deliveries (trigger_id, delivery_id, received_at) VALUES (?,?,?)",
      ["trg_codebase", "delivery-1", 40],
    );
    legacy.close();

    const migrated = openDb(path);
    try {
      expect(migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(LATEST_SCHEMA_VERSION);
      expect(LATEST_SCHEMA_VERSION).toBe(26);

      const automations = new HarborStore(migrated).listAutomations("ws_personal");
      expect(automations).toEqual([
        expect.objectContaining({
          id: "auto_schedule",
          output: "run",
          enabled: false,
          trigger: expect.objectContaining({
            id: "trg_schedule",
            type: "schedule",
            cron: "0 9 * * *",
            timezone: "Asia/Shanghai",
          }),
        }),
        expect.objectContaining({
          id: "auto_codebase",
          output: "chat",
          trigger: expect.objectContaining({
            id: "trg_codebase",
            type: "codebase",
            repositoryId: codebaseRepository.id,
            codebaseEvent: "merge_request_opened",
          }),
        }),
      ]);
      expect(migrated.query<{ name: string; purpose: string; output_mode: string }, []>(
        "SELECT name, purpose, output_mode FROM automation_legacy_archive_v25",
      ).all()).toEqual([{
        name: "Auto review and merge",
        purpose: "review",
        output_mode: "source",
      }]);
      expect(migrated.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM automation_trigger_deliveries WHERE trigger_id = 'trg_codebase'",
      ).get()?.count).toBe(1);

      const automationColumns = migrated.query<{ name: string }, []>("PRAGMA table_info(automations)").all().map((row) => row.name);
      expect(automationColumns).toEqual([
        "id",
        "workspace_id",
        "name",
        "agent_id",
        "prompt",
        "output_mode",
        "enabled",
        "last_fired_at",
        "created_at",
        "updated_at",
      ]);
      expect(migrated.query<unknown, []>("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

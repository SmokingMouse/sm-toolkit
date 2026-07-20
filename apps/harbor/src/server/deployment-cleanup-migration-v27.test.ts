import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LATEST_SCHEMA_VERSION, openDb, openV26MigrationFixtureDb } from "./db.js";
import { HarborStore } from "./store.js";

const REVISION = "a".repeat(40);
const BASELINE = "b".repeat(40);
const FINGERPRINT = "c".repeat(64);
const MANIFEST = "d".repeat(64);
const BASELINE_FINGERPRINT = "e".repeat(64);
const BASELINE_MANIFEST = "f".repeat(64);
const BASELINE_HEALTH = "1".repeat(64);

function seedV26(path: string, legacyStatus: "queued" | "succeeded") {
  const db = openV26MigrationFixtureDb(path);
  const store = new HarborStore(db);
  const device = store.upsertDevice(
    "migration-worker",
    "hash",
    { clis: { claude: "2.1" }, endpoints: [] },
    1,
  );
  const repository = store.createRepository({
    workspaceId: store.defaultWorkspace().id,
    name: "harbor",
    remoteUrl: "https://github.com/SmokingMouse/sm-toolkit.git",
  }, 2);
  const mount = store.setRepositoryMount(repository.id, device.id, "/repo", 3);
  const agent = store.createAgent({
    name: "release-builder",
    deviceId: device.id,
    backend: "claude",
    repositoryId: repository.id,
  }, 4);
  const conversation = store.createConversation({
    kind: "issue",
    title: "Legacy release",
    agentId: agent.id,
    repositoryId: repository.id,
    origin: "web",
  }, 5);
  const delivery = store.createDelivery({
    conversationId: conversation.id,
    provider: "github",
    changeUrl: "https://github.com/SmokingMouse/sm-toolkit/pull/1",
    latestHeadSha: REVISION,
    checkStatus: "passed",
  }, 6);
  const legacyJobId = "legacy_job_1";
  db.run(
    `INSERT INTO deployment_jobs
     (id, delivery_id, generation, target_id, revision, target_fingerprint, target_manifest_hash,
      status, attempt, fence_epoch, fence_nonce, lease_token, lease_expires_at, checkpoint, log, error,
      failure_kind, rollback_complete, rollback_attempt, baseline_revision, baseline_fingerprint,
      baseline_manifest_hash, baseline_health_fingerprint, database_backup_created, new_service_pids,
      created_at, started_at, finished_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [legacyJobId, delivery.id, 1, "local-harbor", REVISION, FINGERPRINT, MANIFEST,
      legacyStatus, legacyStatus === "succeeded" ? 1 : 0, legacyStatus === "succeeded" ? 7 : null,
      legacyStatus === "succeeded" ? "legacy-fence" : null, null, null,
      legacyStatus === "succeeded" ? "released" : "queued", "redacted audit log", null, null,
      legacyStatus === "succeeded" ? 1 : null, legacyStatus === "succeeded" ? 1 : null,
      legacyStatus === "succeeded" ? BASELINE : null,
      legacyStatus === "succeeded" ? BASELINE_FINGERPRINT : null,
      legacyStatus === "succeeded" ? BASELINE_MANIFEST : null,
      legacyStatus === "succeeded" ? BASELINE_HEALTH : null,
      legacyStatus === "succeeded" ? 1 : 0,
      legacyStatus === "succeeded" ? '{"server":123,"daemon":456}' : "{}",
      7, legacyStatus === "succeeded" ? 8 : null, legacyStatus === "succeeded" ? 9 : null, 10],
  );
  db.run(
    `UPDATE deliveries SET review_status = 'approved', check_status = 'passed', merge_status = 'merged',
       deployment_status = ?, deployment_target_id = 'local-harbor', merged_revision = ?, deployment_revision = ?,
       deployment_generation = 1, active_deployment_job_id = ?, deployment_error = ?,
       review_approved_at = 7, merged_at = 8, deployed_at = ?, revision = 4, updated_at = 10
     WHERE id = ?`,
    [legacyStatus === "succeeded" ? "succeeded" : "queued", REVISION, REVISION, legacyJobId,
      legacyStatus === "succeeded" ? null : "pending", legacyStatus === "succeeded" ? 9 : null, delivery.id],
  );
  return { db, store, device, repository, mount, agent, delivery, legacyJobId };
}

test("v27 archives complete legacy deployment audit, drops legacy runtime schema, and preserves an active self-deploy gate", () => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-deployment-v27-"));
  const path = join(dir, "fixture.db");
  try {
    const fixture = seedV26(path, "succeeded");
    const run = fixture.store.createRun({
      sourceType: "automation",
      sourceId: "auto_release",
      workspaceId: fixture.repository.workspaceId,
      agentId: fixture.agent.id,
      deviceId: fixture.device.id,
      repositoryId: fixture.repository.id,
      repositoryMountId: fixture.mount.id,
      executionRoot: fixture.mount.path,
      prompt: "Deploy",
      purpose: "coordination",
      promptEvent: "event.automation.webhook",
      triggerContext: { eventType: "merge_request_merged", revision: REVISION },
    }, 11);
    const selfJob = fixture.store.enqueueDeploymentJob(
      run.id,
      "delivery-1",
      fixture.repository.id,
      "local-harbor",
      REVISION,
      FINGERPRINT,
      MANIFEST,
      12,
    ).job;
    fixture.db.run(
      `UPDATE self_deploy_jobs SET status = 'running', attempt = 1, fence_epoch = 8,
       fence_nonce = 'self-fence', lease_token = 'lease', lease_expires_at = 9999999999999,
       checkpoint = 'maintenance', rollback_attempt = 1, baseline_revision = ?, baseline_fingerprint = ?,
       baseline_manifest_hash = ?, baseline_health_fingerprint = ?, started_at = 13, updated_at = 13
       WHERE id = ?`,
      [BASELINE, BASELINE_FINGERPRINT, BASELINE_MANIFEST, BASELINE_HEALTH, selfJob.id],
    );
    fixture.db.run(
      `INSERT INTO self_deploy_maintenance
       (lock_id, fence_epoch, fence_nonce, target_id, job_id, source_run_id, generation, revision,
        target_fingerprint, target_manifest_hash, rollback_attempt, baseline_revision, baseline_fingerprint,
        baseline_manifest_hash, baseline_health_fingerprint, expected_revision, expected_fingerprint,
        phase, created_at, updated_at)
       VALUES (1,8,'self-fence','local-harbor',?,?,?,?,?,?,?,?,?,?,?,?,?,'deploying',13,13)`,
      [selfJob.id, run.id, selfJob.generation, REVISION, FINGERPRINT, MANIFEST, 1, BASELINE,
        BASELINE_FINGERPRINT, BASELINE_MANIFEST, BASELINE_HEALTH, REVISION, FINGERPRINT],
    );
    fixture.db.close();

    const migrated = openDb(path);
    try {
      expect(LATEST_SCHEMA_VERSION).toBe(28);
      expect(migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(28);
      const tableNames = new Set(migrated.query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      ).all().map((row) => row.name));
      expect(tableNames.has("deployment_jobs")).toBe(false);
      expect(tableNames.has("deployment_maintenance")).toBe(false);
      expect(tableNames.has("deployment_host_fence")).toBe(false);
      expect(tableNames.has("self_deploy_jobs")).toBe(true);
      expect(tableNames.has("self_deploy_maintenance")).toBe(true);

      const deliveryColumns = migrated.query<{ name: string }, []>("PRAGMA table_info(deliveries)").all().map((row) => row.name);
      expect(deliveryColumns).toEqual([
        "id", "conversation_id", "provider", "change_url", "external_id", "head_branch", "base_branch",
        "latest_head_sha", "approved_head_sha", "review_status", "check_status", "merge_status",
        "merged_revision", "review_approved_at", "merged_at", "revision", "created_at", "updated_at",
      ]);
      const archive = migrated.query<{ snapshot: string; jobs: string }, [string]>(
        "SELECT snapshot, jobs FROM delivery_deployment_archive_v27 WHERE delivery_id = ?",
      ).get(fixture.delivery.id)!;
      expect(JSON.parse(archive.snapshot)).toEqual({
        deploymentStatus: "succeeded",
        targetId: "local-harbor",
        deploymentRevision: REVISION,
        generation: 1,
        activeJobId: fixture.legacyJobId,
        error: null,
        deployedAt: 9,
      });
      expect(JSON.parse(archive.jobs)).toEqual([expect.objectContaining({
        id: fixture.legacyJobId,
        status: "succeeded",
        targetFingerprint: FINGERPRINT,
        targetManifestHash: MANIFEST,
        baselineRevision: BASELINE,
        newServicePids: { server: 123, daemon: 456 },
        log: "redacted audit log",
      })]);
      expect(migrated.query<{ phase: string; job_id: string }, []>(
        "SELECT phase, job_id FROM self_deploy_maintenance WHERE lock_id = 1",
      ).get()).toEqual({ phase: "deploying", job_id: selfJob.id });
      expect(migrated.query<{ status: string }, [string]>(
        "SELECT status FROM self_deploy_jobs WHERE id = ?",
      ).get(selfJob.id)).toEqual({ status: "running" });
      expect(new HarborStore(migrated).getDelivery(fixture.delivery.id)).toEqual(expect.objectContaining({
        status: "succeeded",
        mergedRevision: REVISION,
      }));
      expect(() => migrated.run(
        "UPDATE delivery_deployment_archive_v27 SET archived_at = archived_at + 1 WHERE delivery_id = ?",
        [fixture.delivery.id],
      )).toThrow("deployment maintenance");
      migrated.run("DELETE FROM self_deploy_maintenance WHERE lock_id = 1");
      expect(() => migrated.run(
        "UPDATE delivery_deployment_archive_v27 SET archived_at = archived_at + 1 WHERE delivery_id = ?",
        [fixture.delivery.id],
      )).toThrow("immutable deployment archive");
      expect(migrated.query<unknown, []>("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("v27 refuses active legacy deployment jobs without mutating the v26 database", () => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-deployment-v27-blocked-"));
  const path = join(dir, "fixture.db");
  try {
    const fixture = seedV26(path, "queued");
    fixture.db.close();
    expect(() => openDb(path)).toThrow("拒绝 active legacy deployment");
    const unchanged = openV26MigrationFixtureDb(path);
    try {
      expect(unchanged.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(26);
      expect(unchanged.query<{ status: string }, [string]>(
        "SELECT status FROM deployment_jobs WHERE id = ?",
      ).get(fixture.legacyJobId)).toEqual({ status: "queued" });
      expect(unchanged.query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'delivery_deployment_archive_v27'",
      ).get()).toBeNull();
    } finally {
      unchanged.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

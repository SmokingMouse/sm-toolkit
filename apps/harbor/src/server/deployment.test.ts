import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeploymentFence, DeploymentJob } from "../protocol.js";
import { openDb, openDeploymentDb } from "./db.js";
import { HarborStore } from "./store.js";

const REVISION = "a".repeat(40);
const OTHER_REVISION = "9".repeat(40);
const BASELINE = "b".repeat(40);
const FINGERPRINT = "c".repeat(64);
const MANIFEST_HASH = "d".repeat(64);
const BASELINE_FINGERPRINT = "e".repeat(64);
const BASELINE_MANIFEST_HASH = "f".repeat(64);
const BASELINE_HEALTH_FINGERPRINT = "1".repeat(64);

function harness(path = ":memory:") {
  const db = openDb(path);
  const store = new HarborStore(db);
  const device = store.upsertDevice("release-runner", "hash", { clis: { codex: "1" }, endpoints: [] }, 1);
  const repository = store.createRepository({
    workspaceId: store.defaultWorkspace().id,
    name: "harbor",
    remoteUrl: "https://github.com/acme/harbor.git",
    defaultBranch: "main",
  }, 2);
  const mount = store.setRepositoryMount(repository.id, device.id, "/repo", 3);
  const agent = store.createAgent({
    name: "Harbor Release",
    deviceId: device.id,
    backend: "codex",
    repositoryId: repository.id,
  }, 4);
  const run = store.createRun({
    workspaceId: store.defaultWorkspace().id,
    sourceType: "automation",
    sourceId: "automation_release",
    agentId: agent.id,
    deviceId: device.id,
    repositoryId: repository.id,
    repositoryMountId: mount.id,
    executionRoot: mount.path,
    prompt: "Deploy the exact merged revision",
    purpose: "coordination",
    promptEvent: "event.automation.webhook",
    triggerContext: {
      eventType: "merge_request_merged",
      repositoryId: repository.id,
      revision: REVISION,
    },
  }, 5);
  const target = {
    id: "local-harbor",
    repositoryId: repository.id,
    fingerprint: FINGERPRINT,
    manifestHash: MANIFEST_HASH,
  };
  return { db, store, run, repository, target };
}

function enqueue(h: ReturnType<typeof harness>, requestKey = "merge-event-1", revision = REVISION, now = 6) {
  return h.store.enqueueDeploymentJob(
    h.run.id,
    requestKey,
    h.repository.id,
    h.target.id,
    revision,
    h.target.fingerprint,
    h.target.manifestHash,
    now,
  );
}

function targetClaim(target: ReturnType<typeof harness>["target"]) {
  return [{ id: target.id, fingerprint: target.fingerprint, manifestHash: target.manifestHash }];
}

function succeedSourceRun(h: ReturnType<typeof harness>, now = 8) {
  h.store.markRunRunning(h.run.id, now - 1);
  h.store.finishRun(h.run.id, "succeeded", {
    claudeSessionId: null,
    cost: null,
    error: null,
  }, now);
}

function fenceOf(job: DeploymentJob): DeploymentFence {
  if (!job.leaseToken || !job.fenceEpoch || !job.fenceNonce) throw new Error("claim missing fence");
  return { leaseToken: job.leaseToken, fenceEpoch: job.fenceEpoch, fenceNonce: job.fenceNonce };
}

function baselineInput(job: DeploymentJob) {
  return {
    rollbackAttempt: job.attempt,
    baselineRevision: BASELINE,
    baselineFingerprint: BASELINE_FINGERPRINT,
    baselineManifestHash: BASELINE_MANIFEST_HASH,
    baselineHealthFingerprint: BASELINE_HEALTH_FINGERPRINT,
  };
}

describe("Harbor self deployment queue", () => {
  test("is owned by an Automation Run and idempotently freezes the server-managed target", () => {
    const h = harness();
    const first = enqueue(h);
    const duplicate = enqueue(h, "merge-event-1", REVISION, 7);

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.job.id).toBe(first.job.id);
    expect(first.job).toEqual(expect.objectContaining({
      sourceRunId: h.run.id,
      requestKey: "merge-event-1",
      repositoryId: h.repository.id,
      targetId: h.target.id,
      revision: REVISION,
      status: "queued",
    }));
    expect(h.store.listDeploymentJobs(h.run.id)).toHaveLength(1);
    expect(() => enqueue(h, "merge-event-1", OTHER_REVISION, 8)).toThrow("idempotencyKey");
    expect(h.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM deliveries").get()?.count).toBe(0);
  });

  test("persists independently across a server close and worker reopen", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "harbor-self-deploy-")));
    const path = join(dir, "harbor.db");
    try {
      const h = harness(path);
      const queued = enqueue(h).job;
      h.db.close();

      const workerDb = openDeploymentDb(path);
      const workerStore = new HarborStore(workerDb);
      expect(workerStore.getDeploymentJob(queued.id)).toEqual(expect.objectContaining({
        sourceRunId: h.run.id,
        repositoryId: h.repository.id,
        status: "queued",
      }));
      workerDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reclaims an expired lease and fences every callback from the old worker", () => {
    const h = harness();
    enqueue(h);
    succeedSourceRun(h);
    const first = h.store.claimDeploymentJob(targetClaim(h.target), 10, 10)!;
    const reclaimed = h.store.claimDeploymentJob(targetClaim(h.target), 21, 10)!;

    expect(reclaimed.id).toBe(first.id);
    expect(reclaimed.attempt).toBe(2);
    expect(reclaimed.fenceEpoch).toBeGreaterThan(first.fenceEpoch!);
    expect(h.store.renewDeploymentJob(first.id, fenceOf(first), 22, 10)).toBe(false);
    expect(() => h.store.completeDeploymentJob(first.id, fenceOf(first), {
      status: "failed",
      log: "stale",
      rollbackComplete: true,
    }, 23)).toThrow("fence");
  });

  test("requires exact healthy proof, keeps the gate through restart, then releases it", () => {
    const h = harness();
    enqueue(h);
    succeedSourceRun(h);
    const claimed = h.store.claimDeploymentJob(targetClaim(h.target), 10, 100)!;
    const fence = fenceOf(claimed);
    const gate = h.store.activateDeploymentMaintenance(claimed.id, fence, baselineInput(claimed), 11);
    expect(gate).toEqual(expect.objectContaining({
      version: 3,
      sourceRunId: h.run.id,
      expectedRevision: REVISION,
      phase: "deploying",
    }));
    expect(() => h.store.completeDeploymentJob(claimed.id, fence, {
      status: "succeeded",
      log: "not healthy yet",
      rollbackComplete: true,
    }, 12)).toThrow("exact revision healthy");

    h.store.updateDeploymentMaintenance(
      claimed.id,
      fence,
      "healthy",
      REVISION,
      FINGERPRINT,
      13,
      { checkpoint: "healthy" },
    );
    const completed = h.store.completeDeploymentJob(claimed.id, fence, {
      status: "succeeded",
      log: "exact health passed",
      rollbackComplete: true,
    }, 14);
    expect(completed.job.status).toBe("succeeded");
    const releasing = h.store.getDeploymentMaintenance()!;
    expect(releasing.phase).toBe("releasing");
    expect(h.store.releaseDeploymentMaintenance(releasing, 15)).toEqual(expect.objectContaining({ applied: true }));
    expect(h.store.getDeploymentMaintenance()).toBeNull();
  });

  test("turns removed or drifted config into an explicit terminal result", () => {
    const h = harness();
    const queued = enqueue(h).job;
    expect(h.store.failDeploymentConfigDrift([], 10)).toBe(1);
    expect(h.store.getDeploymentJob(queued.id)).toEqual(expect.objectContaining({
      status: "failed",
      failureKind: "config_drift",
      rollbackComplete: true,
    }));
    expect(h.store.claimDeploymentJob(targetClaim(h.target), 11, 100)).toBeNull();
  });

  test("waits for the Release Agent Run and abandons requests from failed source Runs", () => {
    const h = harness();
    const queued = enqueue(h).job;
    h.store.markRunRunning(h.run.id, 7);
    expect(h.store.claimDeploymentJob(targetClaim(h.target), 8, 100)).toBeNull();
    h.store.finishRun(h.run.id, "succeeded", {
      claudeSessionId: null, cost: null, error: null,
    }, 9);
    expect(h.store.claimDeploymentJob(targetClaim(h.target), 10, 100)).toEqual(expect.objectContaining({
      id: queued.id,
      status: "running",
    }));

    const failed = harness();
    const abandoned = enqueue(failed).job;
    failed.store.markRunRunning(failed.run.id, 7);
    failed.store.finishRun(failed.run.id, "failed", {
      claudeSessionId: null, cost: null, error: "agent failed",
    }, 8);
    expect(failed.store.claimDeploymentJob(targetClaim(failed.target), 9, 100)).toBeNull();
    expect(failed.store.getDeploymentJob(abandoned.id)).toEqual(expect.objectContaining({
      status: "failed",
      failureKind: "deployment_failed",
      checkpoint: "source_run_failed",
      rollbackComplete: true,
    }));
  });

  test("serializes host cutovers even when separate Runs request the same target", () => {
    const h = harness();
    enqueue(h);
    const secondRun = h.store.createRun({
      workspaceId: h.store.defaultWorkspace().id,
      sourceType: "automation",
      sourceId: "automation_release",
      agentId: h.run.agentId,
      deviceId: h.run.deviceId,
      repositoryId: h.repository.id,
      repositoryMountId: h.run.repositoryMountId,
      executionRoot: h.run.executionRoot,
      prompt: "Deploy next merge",
      purpose: "coordination",
      promptEvent: "event.automation.webhook",
      triggerContext: { eventType: "merge_request_merged", repositoryId: h.repository.id, revision: OTHER_REVISION },
    }, 7);
    expect(() => h.store.enqueueDeploymentJob(
      secondRun.id,
      "merge-event-2",
      h.repository.id,
      h.target.id,
      OTHER_REVISION,
      h.target.fingerprint,
      h.target.manifestHash,
      8,
    )).toThrow("已有未完成 job");
  });
});

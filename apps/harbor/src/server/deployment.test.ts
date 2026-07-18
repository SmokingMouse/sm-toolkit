import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.js";
import { HarborStore } from "./store.js";
import { reconcileCompletedDeployments } from "./deployment-reconciler.js";
import {
  DeliveryService,
  type DeliveryChangeInput,
  type DeliveryProvider,
  type DeliveryProviderAction,
  type DeliveryProviderContext,
} from "./delivery.js";
import type { DeploymentFence, DeploymentJob } from "../protocol.js";
import type { DeploymentTargetConfig } from "../config.js";
import type { DeploymentExecutionHooks, LocalLaunchdDeploymentExecutor } from "../deployment-worker/executor.js";
import { DeploymentWorker } from "../deployment-worker/worker.js";
import { assertSafeRecoveryTruth } from "../deployment-worker/recovery.js";

const REVISION = "a".repeat(40);
const BASELINE = "b".repeat(40);
const FINGERPRINT = "c".repeat(64);
const MANIFEST_HASH = "d".repeat(64);
const BASELINE_FINGERPRINT = "e".repeat(64);
const BASELINE_MANIFEST_HASH = "f".repeat(64);
const BASELINE_HEALTH_FINGERPRINT = "1".repeat(64);

class FakeScmProvider implements DeliveryProvider {
  readonly kind = "github" as const;
  readonly mode = "automatic" as const;
  prepareChange(_context: DeliveryProviderContext, input: DeliveryChangeInput): DeliveryChangeInput {
    return { ...input, checkStatus: "pending" };
  }
  async merge(_delivery: never, _input: DeliveryProviderAction, _context: DeliveryProviderContext) {
    return { message: "merged by fake SCM", mergedRevision: REVISION };
  }
}

function harness(path = ":memory:") {
  const db = openDb(path);
  const store = new HarborStore(db);
  const device = store.upsertDevice("worker", "hash", { clis: { claude: "2.1" }, endpoints: [] }, 1);
  const repository = store.createRepository(
    { workspaceId: store.defaultWorkspace().id, name: "harbor", remoteUrl: "https://github.com/acme/harbor.git" },
    2,
  );
  store.setRepositoryMount(repository.id, device.id, "/repo", 3);
  const agent = store.createAgent({ name: "builder", deviceId: device.id, backend: "claude", repositoryId: repository.id }, 4);
  const issue = store.createConversation({ kind: "issue", title: "deploy", agentId: agent.id, origin: "web" }, 5);
  store.setConversationStatus(issue.id, "review", 6);
  const target = {
    id: "local-harbor", name: "Local Harbor", provider: "local-launchd" as const,
    repositoryId: repository.id, fingerprint: FINGERPRINT, manifestHash: MANIFEST_HASH,
  };
  const provider = new FakeScmProvider();
  const service = new DeliveryService(store, [provider], [target]);
  return { db, store, issue: store.getConversation(issue.id)!, service, provider, target };
}

function targetClaim(target: { id: string; fingerprint: string; manifestHash: string }) {
  return [{ id: target.id, fingerprint: target.fingerprint, manifestHash: target.manifestHash }];
}

function fenceOf(claimed: DeploymentJob): DeploymentFence {
  if (!claimed.leaseToken || !claimed.fenceEpoch || !claimed.fenceNonce) throw new Error("claim missing fence");
  return { leaseToken: claimed.leaseToken, fenceEpoch: claimed.fenceEpoch, fenceNonce: claimed.fenceNonce };
}

function baselineInput(claimed: DeploymentJob) {
  return {
    rollbackAttempt: claimed.attempt, baselineRevision: BASELINE,
    baselineFingerprint: BASELINE_FINGERPRINT, baselineManifestHash: BASELINE_MANIFEST_HASH,
    baselineHealthFingerprint: BASELINE_HEALTH_FINGERPRINT,
  };
}

function markHealthy(store: HarborStore, claimed: ReturnType<HarborStore["claimDeploymentJob"]>, now: number) {
  if (!claimed) throw new Error("claim missing");
  const fence = fenceOf(claimed);
  store.activateDeploymentMaintenance(claimed.id, fence, baselineInput(claimed), now);
  return store.updateDeploymentMaintenance(claimed.id, fence, "healthy", claimed.revision, claimed.targetFingerprint, now + 1, {
    checkpoint: "healthy", newServicePids: { "gui/1/com.test.server": 42 },
  });
}

function completeAndRelease(store: HarborStore, claimed: DeploymentJob, now: number) {
  const completed = store.completeDeploymentJob(claimed.id, fenceOf(claimed), {
    status: "succeeded", log: "ok", rollbackComplete: true,
  }, now);
  const gate = store.getDeploymentMaintenance()!;
  const released = store.releaseDeploymentMaintenance(gate, now + 1);
  return { completed, released };
}

async function mergedDelivery() {
  const h = harness();
  let delivery = h.service.create(h.issue, {
    provider: "github",
    changeUrl: "https://github.com/acme/harbor/pull/1",
    deploymentRequired: true,
    deploymentTargetId: h.target.id,
  }, 7);
  h.store.updateDeliveryMetadata(delivery.id, { latestHeadSha: REVISION }, 8);
  delivery = h.service.approve(h.store.getDelivery(delivery.id)!, h.issue, 9);
  h.store.updateDeliveryState(delivery.id, { checkStatus: "passed" }, 10);
  delivery = await h.service.merge(h.store.getDelivery(delivery.id)!, h.issue, {}, 11);
  return { ...h, delivery };
}

describe("durable automatic deployment queue", () => {
  test("persists an enqueued job across a real server DB close/reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harbor-deploy-restart-"));
    try {
      const path = join(dir, "harbor.db");
      const h = harness(path);
      let delivery = h.service.create(h.issue, {
        provider: "github", changeUrl: "https://github.com/acme/harbor/pull/1",
        deploymentRequired: true, deploymentTargetId: h.target.id,
      }, 7);
      h.store.updateDeliveryMetadata(delivery.id, { latestHeadSha: REVISION }, 8);
      h.service.approve(h.store.getDelivery(delivery.id)!, h.issue, 9);
      h.store.updateDeliveryState(delivery.id, { checkStatus: "passed" }, 10);
      delivery = await h.service.merge(h.store.getDelivery(delivery.id)!, h.issue, {}, 11);
      expect(delivery.deploymentStatus).toBe("queued");
      h.db.close();

      const reopenedDb = openDb(path);
      const reopenedStore = new HarborStore(reopenedDb);
      const restarted = new DeliveryService(reopenedStore, [h.provider], [h.target]);
      expect(restarted.reconcileAutomaticDeployment(delivery.id, 12).deploymentStatus).toBe("queued");
      expect(reopenedStore.listDeploymentJobs(delivery.id)).toHaveLength(1);
      const claimed = reopenedStore.claimDeploymentJob(targetClaim(h.target), 13, 100)!;
      markHealthy(reopenedStore, claimed, 14);
      completeAndRelease(reopenedStore, claimed, 16);
      reopenedDb.close();

      const finalDb = openDb(path);
      const finalStore = new HarborStore(finalDb);
      const cleanups: string[] = [];
      expect(reconcileCompletedDeployments(finalStore, { requestWorktreeCleanup: (conv) => { cleanups.push(conv.id); } }, 15)).toEqual([delivery.id]);
      expect(finalStore.getConversation(h.issue.id)?.status).toBe("done");
      expect(cleanups).toEqual([h.issue.id]);
      finalDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("auto-enqueues once, survives service restart, fences leases, retries by generation, and deduplicates callbacks", async () => {
    const h = await mergedDelivery();
    expect(h.delivery).toEqual(expect.objectContaining({
      deploymentStatus: "queued",
      deploymentTargetId: h.target.id,
      deploymentGeneration: 1,
      deploymentRevision: REVISION,
    }));
    expect(h.store.listDeploymentJobs(h.delivery.id)).toHaveLength(1);

    const restarted = new DeliveryService(h.store, [h.provider], [h.target]);
    restarted.reconcileAutomaticDeployment(h.delivery.id, 12);
    expect(h.store.listDeploymentJobs(h.delivery.id)).toHaveLength(1);

    const firstLease = h.store.claimDeploymentJob(targetClaim(h.target), 20, 10)!;
    const reclaimed = h.store.claimDeploymentJob(targetClaim(h.target), 31, 10)!;
    expect(reclaimed.id).toBe(firstLease.id);
    expect(reclaimed.attempt).toBe(2);
    expect(() => h.store.completeDeploymentJob(firstLease.id, fenceOf(firstLease), {
      status: "succeeded", log: "late", rollbackComplete: true,
    }, 32)).toThrow("fence 已失效");

    h.store.completeDeploymentJob(reclaimed.id, fenceOf(reclaimed), {
      status: "failed", log: "health failed", error: "health timeout", rollbackComplete: true,
    }, 33);
    expect(h.store.getDelivery(h.delivery.id)).toEqual(expect.objectContaining({ deploymentStatus: "failed", deploymentGeneration: 1 }));

    const retried = await restarted.startDeployment(h.store.getDelivery(h.delivery.id)!, h.issue, {}, 34);
    expect(retried).toEqual(expect.objectContaining({ deploymentStatus: "queued", deploymentGeneration: 2 }));
    expect(h.store.listDeploymentJobs(h.delivery.id)).toHaveLength(2);
    const lateDuplicate = h.store.completeDeploymentJob(reclaimed.id, fenceOf(reclaimed), {
      status: "succeeded", log: "duplicate old generation", rollbackComplete: true,
    }, 35);
    expect(lateDuplicate.duplicate).toBeTrue();
    expect(h.store.getDelivery(h.delivery.id)).toEqual(expect.objectContaining({ deploymentStatus: "queued", deploymentGeneration: 2 }));

    const second = h.store.claimDeploymentJob(targetClaim(h.target), 36, 10)!;
    markHealthy(h.store, second, 37);
    const { completed, released } = completeAndRelease(h.store, second, 39);
    expect(completed.applied).toBeFalse();
    expect(released.applied).toBeTrue();
    expect(h.store.completeDeploymentJob(second.id, fenceOf(second), {
      status: "succeeded", log: "duplicate", rollbackComplete: true,
    }, 38).duplicate).toBeTrue();
    expect(h.store.getDelivery(h.delivery.id)?.deploymentStatus).toBe("succeeded");
    expect(h.store.listDeliveriesReadyToFinalize().map((item) => item.id)).toEqual([h.delivery.id]);
  });

  test("discards a result when active generation/revision changed", async () => {
    const h = await mergedDelivery();
    const claimed = h.store.claimDeploymentJob(targetClaim(h.target), 20, 100)!;
    markHealthy(h.store, claimed, 21);
    h.store.updateDeliveryState(h.delivery.id, {
      deploymentGeneration: 2,
      deploymentRevision: "b".repeat(40),
      activeDeploymentJobId: "depjob_new",
    }, 21);
    const result = h.store.completeDeploymentJob(claimed.id, fenceOf(claimed), {
      status: "succeeded", log: "stale", rollbackComplete: true,
    }, 22);
    expect(result.applied).toBeFalse();
    expect(h.store.getDelivery(h.delivery.id)).toEqual(expect.objectContaining({
      deploymentGeneration: 2,
      deploymentRevision: "b".repeat(40),
      activeDeploymentJobId: "depjob_new",
      deploymentStatus: "running",
    }));
    expect(result.job.status).toBe("needs_recovery");
    const recovery = h.store.claimDeploymentRecovery(claimed.id, h.target.id, h.target.fingerprint, h.target.manifestHash, 23, 100);
    const recoveryGate = h.store.updateDeploymentMaintenance(
      recovery.id, fenceOf(recovery), "rolling_back", BASELINE, BASELINE_FINGERPRINT, 24,
    );
    const recovered = h.store.completeRecoveredDeploymentJob(recoveryGate, fenceOf(recovery), {
      status: "failed", log: "original baseline verified", error: "stale generation rolled back", rollbackComplete: true,
    }, 25);
    expect(recovered).toEqual(expect.objectContaining({ applied: false, job: expect.objectContaining({ status: "failed" }) }));
    h.store.releaseDeploymentMaintenance(h.store.getDeploymentMaintenance()!, 26);
    expect(h.store.getDeploymentMaintenance(h.target.id)).toBeNull();
    expect(h.store.getDelivery(h.delivery.id)).toEqual(expect.objectContaining({
      deploymentGeneration: 2,
      deploymentRevision: "b".repeat(40),
      activeDeploymentJobId: "depjob_new",
      deploymentStatus: "running",
    }));
  });

  test("never claims a queued job after it stops being the active generation", async () => {
    const h = await mergedDelivery();
    h.store.updateDeliveryState(h.delivery.id, {
      deploymentGeneration: 2,
      deploymentRevision: "b".repeat(40),
      activeDeploymentJobId: "depjob_new",
    }, 20);
    expect(h.store.claimDeploymentJob(targetClaim(h.target), 21, 100)).toBeNull();
  });

  test("a claimed worker cannot enter maintenance after its Delivery generation becomes stale", async () => {
    const h = await mergedDelivery();
    const claimed = h.store.claimDeploymentJob(targetClaim(h.target), 20, 100)!;
    h.store.updateDeliveryState(h.delivery.id, {
      deploymentGeneration: 2,
      deploymentRevision: "b".repeat(40),
      activeDeploymentJobId: "depjob_new",
    }, 21);
    expect(() => h.store.activateDeploymentMaintenance(
      claimed.id,
      fenceOf(claimed),
      baselineInput(claimed),
      22,
    )).toThrow("拒绝进入 maintenance/cutover");
    expect(h.store.getDeploymentMaintenance(h.target.id)).toBeNull();
  });

  test("generation drift at an irreversible boundary revokes the lease and preserves the global recovery gate", async () => {
    const h = await mergedDelivery();
    const claimed = h.store.claimDeploymentJob(targetClaim(h.target), 20, 100)!;
    h.store.activateDeploymentMaintenance(claimed.id, fenceOf(claimed), baselineInput(claimed), 21);
    h.store.updateDeliveryState(h.delivery.id, {
      deploymentGeneration: 2,
      deploymentRevision: "b".repeat(40),
      activeDeploymentJobId: "depjob_new",
    }, 22);
    expect(h.store.renewDeploymentJob(claimed.id, fenceOf(claimed), 23, 100)).toBeFalse();
    expect(h.store.getDeploymentJob(claimed.id)).toEqual(expect.objectContaining({
      status: "needs_recovery", rollbackComplete: false, failureKind: "rollback_incomplete",
    }));
    expect(h.store.getDeploymentMaintenance()).toEqual(expect.objectContaining({ phase: "needs_recovery" }));
    expect(h.store.updateDeploymentCheckpoint(claimed.id, fenceOf(claimed), "stale", 24)).toBeFalse();
  });

  test("freezes target fingerprint and rejects a worker with drifted host config", async () => {
    const h = await mergedDelivery();
    expect(h.store.listDeploymentJobs(h.delivery.id)[0]?.targetFingerprint).toBe(FINGERPRINT);
    expect(h.store.claimDeploymentJob([{ id: h.target.id, fingerprint: "2".repeat(64), manifestHash: h.target.manifestHash }], 20, 100)).toBeNull();
    expect(h.store.claimDeploymentJob(targetClaim(h.target), 21, 100)?.targetFingerprint).toBe(FINGERPRINT);
  });

  test("config drift turns queued work into an explicit failed generation instead of starving the queue", async () => {
    const h = await mergedDelivery();
    expect(h.store.failDeploymentConfigDrift([], 20)).toBe(1);
    expect(h.store.listDeploymentJobs(h.delivery.id)[0]).toEqual(expect.objectContaining({
      status: "failed", failureKind: "config_drift", rollbackComplete: true,
    }));
    expect(h.store.getDelivery(h.delivery.id)).toEqual(expect.objectContaining({ deploymentStatus: "failed" }));
    expect(h.store.claimDeploymentJob(targetClaim(h.target), 21, 100)).toBeNull();
  });

  test("a reclaimed fence rejects every callback from the old lease and preserves the newer global gate", async () => {
    const h = await mergedDelivery();
    const first = h.store.claimDeploymentJob(targetClaim(h.target), 20, 10)!;
    markHealthy(h.store, first, 21);
    const second = h.store.claimDeploymentJob(targetClaim(h.target), 31, 10)!;
    expect(second.fenceEpoch).toBeGreaterThan(first.fenceEpoch!);
    expect(h.store.updateDeploymentCheckpoint(first.id, fenceOf(first), "stale", 32)).toBeFalse();
    expect(() => h.store.updateDeploymentMaintenance(
      first.id, fenceOf(first), "healthy", REVISION, FINGERPRINT, 33,
    )).toThrow("fence 已失效");
    expect(h.store.getDeploymentMaintenance()).toEqual(expect.objectContaining({
      fenceEpoch: second.fenceEpoch, fenceNonce: second.fenceNonce, phase: "healthy",
    }));
  });

  test("host-global maintenance lock serializes cutover across targets", async () => {
    const h = await mergedDelivery();
    const first = h.store.claimDeploymentJob(targetClaim(h.target), 20, 100)!;
    h.store.activateDeploymentMaintenance(first.id, fenceOf(first), baselineInput(first), 21);

    const target2 = { ...h.target, id: "local-other", fingerprint: "2".repeat(64), manifestHash: "3".repeat(64) };
    const service = new DeliveryService(h.store, [], [h.target, target2]);
    const issue2 = h.store.createConversation({ kind: "issue", title: "second", agentId: h.issue.agentId, origin: "web" }, 22);
    h.store.setConversationStatus(issue2.id, "review", 23);
    let delivery2 = service.create(h.store.getConversation(issue2.id)!, {
      provider: "manual", changeUrl: "https://example.test/mr/2", deploymentRequired: true, deploymentTargetId: target2.id,
    }, 24);
    delivery2 = service.approve(delivery2, h.store.getConversation(issue2.id)!, 25);
    h.store.updateDeliveryState(delivery2.id, { checkStatus: "passed" }, 26);
    await service.merge(h.store.getDelivery(delivery2.id)!, h.store.getConversation(issue2.id)!, {
      confirmed: true, mergedRevision: REVISION,
    }, 27);
    const second = h.store.claimDeploymentJob(targetClaim(target2), 28, 100)!;
    expect(() => h.store.activateDeploymentMaintenance(second.id, fenceOf(second), baselineInput(second), 29))
      .toThrow("另一个 target/job");
  });

  test("healthy checkpoint keeps the original rollback anchor across lease reclaim", async () => {
    const h = await mergedDelivery();
    const first = h.store.claimDeploymentJob(targetClaim(h.target), 20, 10)!;
    const originalGate = markHealthy(h.store, first, 21);
    const reclaimed = h.store.claimDeploymentJob(targetClaim(h.target), 31, 10)!;
    expect(reclaimed).toEqual(expect.objectContaining({
      attempt: 2,
      checkpoint: "healthy",
      rollbackAttempt: 1,
      baselineRevision: BASELINE,
      newServicePids: { "gui/1/com.test.server": 42 },
    }));
    expect(h.store.getDeploymentMaintenance(h.target.id)).toEqual(expect.objectContaining({
      jobId: originalGate.jobId,
      rollbackAttempt: 1,
      baselineRevision: BASELINE,
      phase: "healthy",
    }));
    completeAndRelease(h.store, reclaimed, 32);
    expect(h.store.getDelivery(h.delivery.id)?.deploymentStatus).toBe("succeeded");
  });

  test("terminal result keeps the DB gate until host sentinel/daemon release is separately proven", async () => {
    const h = await mergedDelivery();
    const claimed = h.store.claimDeploymentJob(targetClaim(h.target), 20, 100)!;
    markHealthy(h.store, claimed, 21);
    const completed = h.store.completeDeploymentJob(claimed.id, fenceOf(claimed), {
      status: "succeeded", log: "healthy", rollbackComplete: true,
    }, 23);
    expect(completed.applied).toBeFalse();
    expect(h.store.getDeploymentMaintenance()).toEqual(expect.objectContaining({ phase: "releasing" }));
    expect(h.store.getDelivery(h.delivery.id)?.deploymentStatus).toBe("running");
    h.store.releaseDeploymentMaintenance(h.store.getDeploymentMaintenance()!, 24);
    expect(h.store.getDeploymentMaintenance()).toBeNull();
    expect(h.store.getDelivery(h.delivery.id)?.deploymentStatus).toBe("succeeded");
  });

  test("rollback incomplete blocks Retry until administrator recovery verifies the frozen baseline", async () => {
    const h = await mergedDelivery();
    const claimed = h.store.claimDeploymentJob(targetClaim(h.target), 20, 100)!;
    const maintenance = h.store.activateDeploymentMaintenance(
      claimed.id,
      fenceOf(claimed),
      baselineInput(claimed),
      21,
    );
    h.store.completeRecoveredDeploymentJob(maintenance, fenceOf(claimed), {
      status: "needs_recovery", log: "ambiguous stop", error: "rollback incomplete", rollbackComplete: false,
    }, 22);
    expect(h.store.getDelivery(h.delivery.id)).toEqual(expect.objectContaining({ deploymentStatus: "needs_recovery" }));
    expect(() => h.service.reconcileAutomaticDeployment(h.delivery.id, 23)).toThrow("needs_recovery");
    expect(h.service.startDeployment(h.store.getDelivery(h.delivery.id)!, h.issue, {}, 24)).rejects.toThrow("needs_recovery");

    const recovery = h.store.claimDeploymentRecovery(claimed.id, h.target.id, h.target.fingerprint, h.target.manifestHash, 25, 100);
    expect(recovery.status).toBe("recovering");
    const rotatedGate = h.store.updateDeploymentMaintenance(
      recovery.id, fenceOf(recovery), "rolling_back", BASELINE, BASELINE_FINGERPRINT, 26,
    );
    h.store.completeRecoveredDeploymentJob(rotatedGate, fenceOf(recovery), {
      status: "failed", log: "old baseline verified", error: "deployment rolled back", rollbackComplete: true,
    }, 27);
    h.store.releaseDeploymentMaintenance(h.store.getDeploymentMaintenance()!, 28);
    expect(h.store.getDelivery(h.delivery.id)?.deploymentStatus).toBe("failed");
    const retried = await h.service.startDeployment(h.store.getDelivery(h.delivery.id)!, h.issue, {}, 29);
    expect(retried).toEqual(expect.objectContaining({ deploymentStatus: "queued", deploymentGeneration: 2 }));
  });

  test("SQLite restore rehydrates the host-sentinel epoch and cannot roll the fence backward", async () => {
    const h = await mergedDelivery();
    const claimed = h.store.claimDeploymentJob(targetClaim(h.target), 20, 100)!;
    const oldGate = h.store.activateDeploymentMaintenance(claimed.id, fenceOf(claimed), baselineInput(claimed), 21);
    h.store.completeRecoveredDeploymentJob(oldGate, fenceOf(claimed), {
      status: "needs_recovery", log: "crash", rollbackComplete: false,
    }, 22);
    const recovery = h.store.claimDeploymentRecovery(
      claimed.id, h.target.id, h.target.fingerprint, h.target.manifestHash, 23, 100,
    );
    const hostGate = h.store.getDeploymentMaintenance()!;
    // 一致性 backup 会真实带回 claim A 的旧 gate；restore 必须用 host sentinel B
    // 旋转整行 fence，而不是要求旧 DB 恰好没有 gate。
    h.db.run("UPDATE deployment_host_fence SET epoch = ? WHERE lock_id = 1", [oldGate.fenceEpoch]);
    h.db.run("UPDATE deployment_maintenance SET fence_epoch = ?, fence_nonce = ? WHERE lock_id = 1", [oldGate.fenceEpoch, oldGate.fenceNonce]);
    const restored = h.store.restoreDeploymentMaintenance(
      hostGate, fenceOf(recovery), "rolling_back", BASELINE, BASELINE_FINGERPRINT, 24,
    );
    expect(restored.fenceEpoch).toBe(recovery.fenceEpoch!);
    expect(h.db.query<{ epoch: number }, []>("SELECT epoch FROM deployment_host_fence WHERE lock_id = 1").get()?.epoch)
      .toBe(recovery.fenceEpoch!);
    expect(() => h.store.restoreDeploymentMaintenance(
      oldGate, fenceOf(claimed), "rolling_back", BASELINE, BASELINE_FINGERPRINT, 25,
    )).toThrow("高于 host sentinel");
  });

  test("manual SCM stays orthogonal by supplying a verified exact revision to the configured target", async () => {
    const h = harness();
    let delivery = h.service.create(h.issue, {
      provider: "manual", changeUrl: "https://example.test/mr/2", deploymentRequired: true,
      deploymentTargetId: h.target.id,
    }, 7);
    delivery = h.service.approve(delivery, h.issue, 8);
    h.store.updateDeliveryState(delivery.id, { checkStatus: "passed" }, 9);
    delivery = await h.service.merge(h.store.getDelivery(delivery.id)!, h.issue, {
      confirmed: true, mergedRevision: REVISION,
    }, 10);
    expect(delivery).toEqual(expect.objectContaining({
      provider: "manual", mergedRevision: REVISION, deploymentStatus: "queued", deploymentGeneration: 1,
    }));
  });

  test("keeps manual deployment fallback and rejects worker-target self-reported results", async () => {
    const manual = harness();
    let delivery = manual.service.create(manual.issue, {
      provider: "manual", changeUrl: "https://example.test/mr/1", deploymentRequired: true,
    }, 7);
    delivery = manual.service.approve(delivery, manual.issue, 8);
    manual.store.updateDeliveryState(delivery.id, { checkStatus: "passed" }, 9);
    delivery = await manual.service.merge(manual.store.getDelivery(delivery.id)!, manual.issue, { confirmed: true }, 10);
    delivery = await manual.service.startDeployment(delivery, manual.issue, { confirmed: true }, 11);
    expect(manual.service.finishDeployment(delivery, "succeeded", 12).deploymentStatus).toBe("succeeded");

    const automatic = await mergedDelivery();
    const claimed = automatic.store.claimDeploymentJob(targetClaim(automatic.target), 20, 100)!;
    expect(() => automatic.service.finishDeployment(automatic.store.getDelivery(automatic.delivery.id)!, "succeeded", 21)).toThrow("只能由独立 host worker");
    automatic.store.completeDeploymentJob(claimed.id, fenceOf(claimed), { status: "failed", log: "x", rollbackComplete: true }, 22);
  });

  test("worker runOnce returns final persisted truth rather than a mere executed boolean", async () => {
    const h = await mergedDelivery();
    const fakeExecutor = {
      validateTarget: async () => {},
      readMaintenance: async () => null,
      execute: async () => ({
        status: "failed" as const, log: "bounded", error: "build failed", failureKind: "deployment_failed" as const,
        rollbackComplete: true, gate: null,
      }),
    } as unknown as LocalLaunchdDeploymentExecutor;
    const clock = { now: () => 20, sleep: async () => {} };
    const worker = new DeploymentWorker(
      h.store,
      [h.target as unknown as DeploymentTargetConfig],
      fakeExecutor,
      clock,
      100,
    );
    const result = await worker.runOnce();
    expect(result).toEqual(expect.objectContaining({
      worked: true,
      job: expect.objectContaining({ status: "failed", rollbackComplete: true, failureKind: "deployment_failed" }),
      databaseGate: null,
      sentinel: null,
    }));
    expect(h.store.getDelivery(h.delivery.id)?.deploymentStatus).toBe("failed");
  });

  test("worker reports needs_recovery when terminal host release cannot be proven", async () => {
    const h = await mergedDelivery();
    const fakeExecutor = {
      validateTarget: async () => {},
      readMaintenance: async () => null,
      execute: async (_job: DeploymentJob, _target: DeploymentTargetConfig, hooks: DeploymentExecutionHooks) => {
        await hooks.activateMaintenance(baselineInput(_job));
        const healthy = await hooks.updateMaintenance("healthy", REVISION, FINGERPRINT, { checkpoint: "healthy" });
        return {
          status: "succeeded" as const, log: "healthy", error: null, failureKind: null,
          rollbackComplete: true, gate: healthy,
        };
      },
      releaseHostMaintenance: async () => { throw new Error("daemon bootstrap ambiguous"); },
    } as unknown as LocalLaunchdDeploymentExecutor;
    const worker = new DeploymentWorker(
      h.store, [h.target as unknown as DeploymentTargetConfig], fakeExecutor,
      { now: () => 20, sleep: async () => {} }, 100,
    );
    const result = await worker.runOnce();
    expect(result.job).toEqual(expect.objectContaining({
      status: "needs_recovery", rollbackComplete: false, failureKind: "rollback_incomplete",
    }));
    expect(result.databaseGate).toEqual(expect.objectContaining({ phase: "needs_recovery" }));
    expect(h.store.getDelivery(h.delivery.id)?.deploymentStatus).toBe("needs_recovery");
  });

  test("target removal or runtime path drift during terminal release stays globally gated", async () => {
    const removed = await mergedDelivery();
    const claimed = removed.store.claimDeploymentJob(targetClaim(removed.target), 20, 100)!;
    markHealthy(removed.store, claimed, 21);
    removed.store.completeDeploymentJob(claimed.id, fenceOf(claimed), {
      status: "succeeded", log: "healthy", rollbackComplete: true,
    }, 22);
    const frozenSentinel = removed.store.getDeploymentMaintenance()!;
    const executor = {
      readMaintenance: async () => frozenSentinel,
    } as unknown as LocalLaunchdDeploymentExecutor;
    const worker = new DeploymentWorker(removed.store, [], executor, { now: () => 23, sleep: async () => {} }, 100);
    const result = await worker.runOnce();
    expect(result.job).toEqual(expect.objectContaining({ status: "needs_recovery", rollbackComplete: false }));
    expect(result.databaseGate).toEqual(expect.objectContaining({ phase: "needs_recovery" }));
    expect(result.sentinel).toEqual(expect.objectContaining({ phase: "releasing" }));
  });

  test("release fence binds expected state and recovery truth rejects any surviving gate", async () => {
    const h = await mergedDelivery();
    const claimed = h.store.claimDeploymentJob(targetClaim(h.target), 20, 100)!;
    markHealthy(h.store, claimed, 21);
    h.store.completeDeploymentJob(claimed.id, fenceOf(claimed), { status: "succeeded", log: "ok", rollbackComplete: true }, 22);
    const gate = h.store.getDeploymentMaintenance()!;
    expect(h.store.assertDeploymentReleaseFence({ ...gate, expectedFingerprint: "9".repeat(64) })).toBeFalse();
    expect(() => h.store.releaseDeploymentMaintenance({ ...gate, expectedFingerprint: "9".repeat(64) }, 23)).toThrow("identity");
    expect(() => assertSafeRecoveryTruth({
      worked: true,
      job: { ...h.store.getDeploymentJob(claimed.id)!, status: "failed", rollbackComplete: true },
      databaseGate: gate,
      sentinel: null,
    })).toThrow("未达到安全终态");
  });

  test("store applies generic credential redaction before Delivery audit persistence", async () => {
    const h = await mergedDelivery();
    const claimed = h.store.claimDeploymentJob(targetClaim(h.target), 20, 100)!;
    const completed = h.store.completeDeploymentJob(claimed.id, fenceOf(claimed), {
      status: "failed", log: "Authorization: Bearer TOPSECRET token=SECONDSECRET", error: "password=hunter2", rollbackComplete: true,
    }, 21);
    expect(JSON.stringify(completed.job)).not.toContain("TOPSECRET");
    expect(JSON.stringify(completed.job)).not.toContain("SECONDSECRET");
    expect(JSON.stringify(h.store.listDeliveryEvents(h.delivery.id))).not.toContain("hunter2");
  });

  test("active job projection persists only bounded redacted checkpoint logs", async () => {
    const h = await mergedDelivery();
    const claimed = h.store.claimDeploymentJob(targetClaim(h.target), 20, 100)!;
    expect(h.store.updateDeploymentCheckpoint(claimed.id, fenceOf(claimed), "prepared", 21, {
      log: `Authorization: Bearer TOPSECRET\n${"x".repeat(40_000)}`,
    })).toBeTrue();
    const view = h.store.getDeploymentJobView(claimed.id)!;
    expect(view.status).toBe("running");
    expect(view.checkpoint).toBe("prepared");
    expect(view.attempt).toBe(1);
    expect(view.fenceEpoch).toBe(claimed.fenceEpoch);
    expect(view.log?.length).toBeLessThanOrEqual(32_000);
    expect(view.log).not.toContain("TOPSECRET");
    expect(view.log).not.toContain(claimed.fenceNonce!);
  });
});

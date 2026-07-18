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

const REVISION = "a".repeat(40);
const BASELINE = "b".repeat(40);
const FINGERPRINT = "c".repeat(64);

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
    repositoryId: repository.id, fingerprint: FINGERPRINT,
  };
  const provider = new FakeScmProvider();
  const service = new DeliveryService(store, [provider], [target]);
  return { db, store, issue: store.getConversation(issue.id)!, service, provider, target };
}

function targetClaim(target: { id: string; fingerprint: string }) {
  return [{ id: target.id, fingerprint: target.fingerprint }];
}

function markHealthy(store: HarborStore, claimed: ReturnType<HarborStore["claimDeploymentJob"]>, now: number) {
  if (!claimed?.leaseToken) throw new Error("claim missing");
  store.activateDeploymentMaintenance(claimed.id, claimed.leaseToken, { rollbackAttempt: claimed.attempt, baselineRevision: BASELINE }, now);
  return store.updateDeploymentMaintenance(claimed.id, claimed.leaseToken, "healthy", claimed.revision, now + 1, {
    checkpoint: "healthy", newServicePid: 42,
  });
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
      reopenedStore.completeDeploymentJob(claimed.id, claimed.leaseToken!, {
        status: "succeeded", log: "result persisted while server is absent", rollbackComplete: true,
      }, 16);
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
    expect(() => h.store.completeDeploymentJob(firstLease.id, firstLease.leaseToken!, {
      status: "succeeded", log: "late", rollbackComplete: true,
    }, 32)).toThrow("lease 已失效");

    h.store.completeDeploymentJob(reclaimed.id, reclaimed.leaseToken!, {
      status: "failed", log: "health failed", error: "health timeout", rollbackComplete: true,
    }, 33);
    expect(h.store.getDelivery(h.delivery.id)).toEqual(expect.objectContaining({ deploymentStatus: "failed", deploymentGeneration: 1 }));

    const retried = await restarted.startDeployment(h.store.getDelivery(h.delivery.id)!, h.issue, {}, 34);
    expect(retried).toEqual(expect.objectContaining({ deploymentStatus: "queued", deploymentGeneration: 2 }));
    expect(h.store.listDeploymentJobs(h.delivery.id)).toHaveLength(2);
    const lateDuplicate = h.store.completeDeploymentJob(reclaimed.id, reclaimed.leaseToken!, {
      status: "succeeded", log: "duplicate old generation", rollbackComplete: true,
    }, 35);
    expect(lateDuplicate.duplicate).toBeTrue();
    expect(h.store.getDelivery(h.delivery.id)).toEqual(expect.objectContaining({ deploymentStatus: "queued", deploymentGeneration: 2 }));

    const second = h.store.claimDeploymentJob(targetClaim(h.target), 36, 10)!;
    markHealthy(h.store, second, 37);
    const completed = h.store.completeDeploymentJob(second.id, second.leaseToken!, {
      status: "succeeded", log: "ok", rollbackComplete: true,
    }, 39);
    expect(completed.applied).toBeTrue();
    expect(h.store.completeDeploymentJob(second.id, second.leaseToken!, {
      status: "succeeded", log: "duplicate", rollbackComplete: true,
    }, 38).duplicate).toBeTrue();
    expect(h.store.getDelivery(h.delivery.id)?.deploymentStatus).toBe("succeeded");
    expect(h.store.listDeliveriesReadyToFinalize().map((item) => item.id)).toEqual([h.delivery.id]);
  });

  test("discards a result when active generation/revision changed", async () => {
    const h = await mergedDelivery();
    const claimed = h.store.claimDeploymentJob(targetClaim(h.target), 20, 100)!;
    const originalGate = markHealthy(h.store, claimed, 21);
    h.store.updateDeliveryState(h.delivery.id, {
      deploymentGeneration: 2,
      deploymentRevision: "b".repeat(40),
      activeDeploymentJobId: "depjob_new",
    }, 21);
    const result = h.store.completeDeploymentJob(claimed.id, claimed.leaseToken!, {
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
    h.store.claimDeploymentRecovery(claimed.id, h.target.id, h.target.fingerprint, 23, 100);
    const recovered = h.store.completeRecoveredDeploymentJob(originalGate, {
      status: "failed", log: "original baseline verified", error: "stale generation rolled back", rollbackComplete: true,
    }, 24);
    expect(recovered).toEqual(expect.objectContaining({ applied: false, job: expect.objectContaining({ status: "failed" }) }));
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
      claimed.leaseToken!,
      { rollbackAttempt: 1, baselineRevision: BASELINE },
      22,
    )).toThrow("拒绝进入 maintenance/cutover");
    expect(h.store.getDeploymentMaintenance(h.target.id)).toBeNull();
  });

  test("freezes target fingerprint and rejects a worker with drifted host config", async () => {
    const h = await mergedDelivery();
    expect(h.store.listDeploymentJobs(h.delivery.id)[0]?.targetFingerprint).toBe(FINGERPRINT);
    expect(h.store.claimDeploymentJob([{ id: h.target.id, fingerprint: "d".repeat(64) }], 20, 100)).toBeNull();
    expect(h.store.claimDeploymentJob(targetClaim(h.target), 21, 100)?.targetFingerprint).toBe(FINGERPRINT);
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
      newServicePid: 42,
    }));
    expect(h.store.getDeploymentMaintenance(h.target.id)).toEqual(expect.objectContaining({
      jobId: originalGate.jobId,
      rollbackAttempt: 1,
      baselineRevision: BASELINE,
      phase: "healthy",
    }));
    h.store.completeDeploymentJob(reclaimed.id, reclaimed.leaseToken!, {
      status: "succeeded", log: "revalidated after crash", rollbackComplete: true,
    }, 32);
    expect(h.store.getDelivery(h.delivery.id)?.deploymentStatus).toBe("succeeded");
  });

  test("rollback incomplete blocks Retry until administrator recovery verifies the frozen baseline", async () => {
    const h = await mergedDelivery();
    const claimed = h.store.claimDeploymentJob(targetClaim(h.target), 20, 100)!;
    const maintenance = h.store.activateDeploymentMaintenance(
      claimed.id,
      claimed.leaseToken!,
      { rollbackAttempt: 1, baselineRevision: BASELINE },
      21,
    );
    h.store.completeRecoveredDeploymentJob(maintenance, {
      status: "needs_recovery", log: "ambiguous stop", error: "rollback incomplete", rollbackComplete: false,
    }, 22);
    expect(h.store.getDelivery(h.delivery.id)).toEqual(expect.objectContaining({ deploymentStatus: "needs_recovery" }));
    expect(() => h.service.reconcileAutomaticDeployment(h.delivery.id, 23)).toThrow("needs_recovery");
    expect(h.service.startDeployment(h.store.getDelivery(h.delivery.id)!, h.issue, {}, 24)).rejects.toThrow("needs_recovery");

    const recovery = h.store.claimDeploymentRecovery(claimed.id, h.target.id, h.target.fingerprint, 25, 100);
    expect(recovery.status).toBe("recovering");
    h.store.completeRecoveredDeploymentJob(maintenance, {
      status: "failed", log: "old baseline verified", error: "deployment rolled back", rollbackComplete: true,
    }, 26);
    expect(h.store.getDelivery(h.delivery.id)?.deploymentStatus).toBe("failed");
    const retried = await h.service.startDeployment(h.store.getDelivery(h.delivery.id)!, h.issue, {}, 27);
    expect(retried).toEqual(expect.objectContaining({ deploymentStatus: "queued", deploymentGeneration: 2 }));
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
    automatic.store.completeDeploymentJob(claimed.id, claimed.leaseToken!, { status: "failed", log: "x", rollbackComplete: true }, 22);
  });
});

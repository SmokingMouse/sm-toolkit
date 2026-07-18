import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import type { DeploymentTargetConfig } from "../config.js";
import type { DeploymentMaintenanceGate } from "../protocol.js";
import type { DeploymentMaintenanceSentinel } from "../deployment-worker/maintenance.js";
import type { ApprovalService } from "./approvals.js";
import { AutomationService } from "./automation.js";
import { RunBus } from "./bus.js";
import { openDb } from "./db.js";
import { DeliveryService } from "./delivery.js";
import { DeploymentMaintenanceGuard } from "./maintenance.js";
import { buildRest } from "./rest.js";
import { RunCoordinator } from "./scheduler.js";
import { HarborStore } from "./store.js";
import { DeviceHub, type WsData } from "./ws.js";

const REVISION = "a".repeat(40);
const BASELINE = "b".repeat(40);
const FINGERPRINT = "c".repeat(64);

class FakeSentinel implements DeploymentMaintenanceSentinel {
  gate: DeploymentMaintenanceGate | null = null;
  async read() { return this.gate; }
  async write(_target: DeploymentTargetConfig, gate: DeploymentMaintenanceGate) { this.gate = gate; }
  async clear() { this.gate = null; }
}

function target(repositoryId: string): DeploymentTargetConfig {
  return {
    id: "local", name: "Local", provider: "local-launchd", repositoryId,
    repositoryPath: "/repo", releasesPath: "/releases", currentSymlinkPath: "/current",
    sqlitePath: "/db", statePath: "/state", steps: { install: [], build: [], test: [] },
    environment: {}, launchd: { label: "com.test", domain: "gui/1", plistPath: "/plist", templatePath: "/template" },
    health: { url: "http://127.0.0.1/health", headers: {}, timeoutMs: 100, intervalMs: 10 },
    commandTimeoutMs: 100, fingerprint: FINGERPRINT,
  };
}

async function activeMaintenanceHarness() {
  const store = new HarborStore(openDb(":memory:"));
  const device = store.upsertDevice("worker", "hash", { clis: { claude: "2.1" }, endpoints: [] }, 1);
  const repository = store.createRepository({ workspaceId: store.defaultWorkspace().id, name: "repo" }, 2);
  store.setRepositoryMount(repository.id, device.id, "/repo", 3);
  const agent = store.createAgent({ name: "builder", deviceId: device.id, backend: "claude", repositoryId: repository.id }, 4);
  const issue = store.createConversation({ kind: "issue", title: "maintenance", agentId: agent.id, origin: "web" }, 5);
  store.setConversationStatus(issue.id, "review", 6);
  const configured = target(repository.id);
  const deliveries = new DeliveryService(store, [], [{
    id: configured.id, name: configured.name, provider: configured.provider,
    repositoryId: configured.repositoryId, fingerprint: configured.fingerprint,
  }]);
  let delivery = deliveries.create(store.getConversation(issue.id)!, {
    changeUrl: "https://example.test/mr/1", deploymentTargetId: configured.id, deploymentRequired: true,
  }, 7);
  delivery = deliveries.approve(delivery, store.getConversation(issue.id)!, 8);
  store.updateDeliveryState(delivery.id, { checkStatus: "passed" }, 9);
  delivery = await deliveries.merge(store.getDelivery(delivery.id)!, store.getConversation(issue.id)!, {
    confirmed: true, mergedRevision: REVISION,
  }, 10);
  const job = store.claimDeploymentJob([{ id: configured.id, fingerprint: configured.fingerprint }], 11, 100)!;
  const gate = store.activateDeploymentMaintenance(job.id, job.leaseToken!, { rollbackAttempt: 1, baselineRevision: BASELINE }, 12);
  const sentinel = new FakeSentinel();
  sentinel.gate = gate;
  const guard = new DeploymentMaintenanceGuard(store, [configured], sentinel, { revision: REVISION, fingerprint: FINGERPRINT });
  return { store, deliveries, configured, gate, guard };
}

test("maintenance sentinel blocks every REST operation and only admits exact revision-aware health", async () => {
  const h = await activeMaintenanceHarness();
  const coordinator = new RunCoordinator(h.store, new RunBus(), { isOnline: () => false, send: () => false }, 1);
  const app = buildRest(
    h.store,
    new RunBus(),
    { onlineIds: () => new Set<string>(), isOnline: () => false } as unknown as DeviceHub,
    coordinator,
    {} as ApprovalService,
    new AutomationService(h.store, coordinator, () => true),
    "token",
    h.deliveries,
    h.guard,
  );
  const before = h.store.listConversations({}).length;
  const mutation = await app.request("/api/conversations", {
    method: "POST", headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "issue", title: "must not be written" }),
  });
  expect(mutation.status).toBe(503);
  expect(h.store.listConversations({})).toHaveLength(before);
  expect((await app.request("/api/workspaces", { headers: { Authorization: "Bearer token" } })).status).toBe(503);
  expect((await app.request("/api/health", { headers: { Authorization: "Bearer token" } })).status).toBe(503);

  const query = new URLSearchParams({
    deployment_job_id: h.gate.jobId,
    revision: REVISION,
    target_fingerprint: FINGERPRINT,
  });
  const health = await app.request(`/api/health?${query}`, { headers: { Authorization: "Bearer token" } });
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({
    ok: true, revision: REVISION, targetFingerprint: FINGERPRINT,
    deploymentJobId: h.gate.jobId, maintenance: true,
  });
  query.set("revision", BASELINE);
  expect((await app.request(`/api/health?${query}`, { headers: { Authorization: "Bearer token" } })).status).toBe(503);
});

test("maintenance rejects automation and closes daemon sockets before hello/write", async () => {
  const h = await activeMaintenanceHarness();
  const coordinator = new RunCoordinator(h.store, new RunBus(), { isOnline: () => false, send: () => false }, 1);
  const automation = new AutomationService(h.store, coordinator, () => true);
  expect(() => automation.runNow("missing")).toThrow("maintenance");

  const hub = new DeviceHub(h.store, "token", () => true);
  const closes: unknown[][] = [];
  hub.handleOpen({ close: (...args: unknown[]) => { closes.push(args); } } as unknown as ServerWebSocket<WsData>);
  expect(closes).toEqual([[1013, "deployment maintenance"]]);
  expect(hub.onlineIds()).toEqual(new Set());
});

test("DB/file gate disagreement remains fail-closed and never accepts a new 2xx as success", async () => {
  const h = await activeMaintenanceHarness();
  const sentinel = new FakeSentinel();
  sentinel.gate = { ...h.gate, expectedRevision: BASELINE };
  const guard = new DeploymentMaintenanceGuard(h.store, [h.configured], sentinel, { revision: BASELINE, fingerprint: FINGERPRINT });
  expect(await guard.current()).toEqual(expect.objectContaining({ active: true, exact: false }));
});

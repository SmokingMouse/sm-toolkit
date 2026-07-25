import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { ApprovalService } from "./approvals.js";
import { AutomationService } from "./automation.js";
import { RunBus } from "./bus.js";
import { openDb } from "./db.js";
import { buildRest } from "./rest.js";
import { RunCoordinator } from "./scheduler.js";
import { HarborStore } from "./store.js";
import type { DeviceHub } from "./ws.js";

const SECRET = "github-webhook-secret";
const REVISION = "a".repeat(40);

function harness() {
  const store = new HarborStore(openDb(":memory:"));
  const device = store.upsertDevice(
    "github-runner",
    "hash",
    { clis: { claude: "2.1" }, endpoints: [] },
    1,
  );
  const repository = store.createRepository({
    workspaceId: store.defaultWorkspace().id,
    name: "harbor",
    remoteUrl: "git@github.com:SmokingMouse/sm-toolkit.git",
  }, 2);
  store.upsertGitHubInstallation({
    installationId: "77",
    appId: "12345",
    targetId: "42",
    targetType: "User",
    targetLogin: "SmokingMouse",
    repositorySelection: "selected",
    permissions: { contents: "write", pull_requests: "write" },
  }, 2);
  store.connectGitHubInstallation({
    workspaceId: repository.workspaceId,
    installationId: "77",
    connectedByAccountId: "acc_bootstrap",
  }, 2);
  store.upsertGitHubRepositoryConnection({
    workspaceId: repository.workspaceId,
    repositoryId: repository.id,
    installationId: "77",
    githubRepositoryId: "99",
    fullName: "SmokingMouse/sm-toolkit",
    defaultBranch: "main",
    private: false,
  }, 2);
  store.setRepositoryMount(repository.id, device.id, "/repo", 3);
  const agent = store.createAgent({
    name: "release-builder",
    deviceId: device.id,
    backend: "claude",
    repositoryId: repository.id,
  }, 4);
  const coordinator = new RunCoordinator(
    store,
    new RunBus(),
    { isOnline: () => false, send: () => false },
    2,
  );
  const automations = new AutomationService(store, coordinator);
  const automation = store.createAutomation({
    name: "deploy-on-merge",
    agentId: agent.id,
    prompt: "Deploy the trusted merged revision",
    output: "run",
    trigger: {
      type: "codebase",
      repositoryId: repository.id,
      codebaseEvent: "merge_request_merged",
    },
  }, 5);
  const app = buildRest(
    store,
    new RunBus(),
    { onlineIds: () => new Set<string>(), isOnline: () => false } as unknown as DeviceHub,
    coordinator,
    {} as ApprovalService,
    automations,
    "system-token",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    SECRET,
  );
  const payload = {
    action: "closed",
    installation: { id: 77, app_id: 12345 },
    repository: { id: 99, full_name: "SmokingMouse/sm-toolkit" },
    pull_request: {
      merged: true,
      merge_commit_sha: REVISION,
      merged_at: "2026-07-20T04:00:00Z",
      head: { sha: "b".repeat(40) },
    },
  };
  const send = (body: unknown, overrides: Record<string, string> = {}) => {
    const raw = JSON.stringify(body);
    const signature = `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;
    return app.request("/hooks/github/app", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "pull_request",
        "X-GitHub-Delivery": "delivery-1",
        "X-Hub-Signature-256": signature,
        ...overrides,
      },
      body: raw,
    });
  };
  return { store, repository, automation, payload, send };
}

describe("GitHub repository event adapter", () => {
  test("starts one Codebase Automation Run with the trusted merged revision and deduplicates delivery", async () => {
    const h = harness();
    const first = await h.send(h.payload);
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual(expect.objectContaining({
      status: "accepted",
      results: [expect.objectContaining({ status: "started", automationId: h.automation.id })],
    }));
    const [run] = h.store.listRunsBySource("automation", h.automation.id);
    expect(run).toEqual(expect.objectContaining({
      repositoryId: h.repository.id,
      promptEvent: "event.automation.webhook",
      triggerContext: expect.objectContaining({
        eventType: "merge_request_merged",
        eventId: "github:delivery-1",
        revision: REVISION,
      }),
    }));

    const duplicate = await h.send(h.payload);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual(expect.objectContaining({
      results: [expect.objectContaining({ status: "duplicate" })],
    }));
    expect(h.store.listRunsBySource("automation", h.automation.id)).toHaveLength(1);
  });

  test("rejects invalid signatures, mismatched repositories, and merged events without an exact revision", async () => {
    const invalidSignature = harness();
    const badSignature = await invalidSignature.send(invalidSignature.payload, {
      "X-Hub-Signature-256": `sha256=${"0".repeat(64)}`,
    });
    expect(badSignature.status).toBe(401);

    const mismatch = harness();
    const wrongRepository = await mismatch.send({
      ...mismatch.payload,
      repository: { id: 99, full_name: "other/project" },
    });
    expect(wrongRepository.status).toBe(400);

    const missing = harness();
    const missingRevision = await missing.send({
      ...missing.payload,
      pull_request: { ...missing.payload.pull_request, merge_commit_sha: null },
    });
    expect(missingRevision.status).toBe(400);
    expect(await missingRevision.json()).toEqual({
      error: expect.stringContaining("merge_commit_sha"),
    });
  });
});

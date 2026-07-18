import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { openDb } from "./db.js";
import { HarborStore } from "./store.js";
import { buildRest } from "./rest.js";
import { RunBus } from "./bus.js";
import { RunCoordinator } from "./scheduler.js";
import type { DeviceHub } from "./ws.js";
import type { ApprovalService } from "./approvals.js";
import type { AutomationService } from "./automation.js";
import { DeliveryService, type DeliveryProvider } from "./delivery.js";

test("Run action token creates a scoped follow-up Issue and can route it to a Workspace Agent", async () => {
  const store = new HarborStore(openDb(":memory:"));
  const device = store.upsertDevice("worker", "hash", { clis: { claude: "2" }, endpoints: [] }, 1);
  const repository = store.createRepository({ workspaceId: "ws_personal", name: "app" }, 2);
  const mount = store.setRepositoryMount(repository.id, device.id, "/repo", 3);
  const agent = store.createAgent({ name: "builder", deviceId: device.id, backend: "claude", repositoryId: repository.id }, 4);
  const parent = store.createConversation({ workspaceId: "ws_personal", kind: "issue", title: "parent", agentId: agent.id }, 5);
  const run = store.createRun({
    conversationId: parent.id,
    agentId: agent.id,
    deviceId: device.id,
    repositoryId: repository.id,
    repositoryMountId: mount.id,
    executionRoot: mount.path,
    prompt: "work",
    promptEvent: "event.issue.assigned",
  }, 6);
  store.markRunRunning(run.id, 7);
  const raw = "harbor_run_test";
  store.createRunActionToken(run.id, createHash("sha256").update(raw).digest("hex"), Date.now() + 60_000, 8);
  const coordinator = new RunCoordinator(store, new RunBus(), { isOnline: () => false, send: () => false }, 2);
  const app = buildRest(
    store,
    new RunBus(),
    { onlineIds: () => new Set<string>(), isOnline: () => false } as unknown as DeviceHub,
    coordinator,
    {} as ApprovalService,
    {} as AutomationService,
    "owner-token",
  );

  const response = await app.request("/hooks/agent-actions/issues", {
    method: "POST",
    headers: { Authorization: `Bearer ${raw}`, "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Add regression test", description: "Cover the edge case", assignee: "self", priority: "high" }),
  });
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual(expect.objectContaining({
    title: "Add regression test",
    origin: "agent",
    originRef: `run:${run.id}`,
    agentId: agent.id,
    repositoryId: repository.id,
    status: "backlog",
  }));
  expect(store.listConversationMessages(parent.id).at(-1)?.body).toContain("Created follow-up Issue");

  const developer = store.createAgent({
    name: "developer",
    deviceId: device.id,
    backend: "claude",
    repositoryId: repository.id,
  }, 9);
  const routedResponse = await app.request("/hooks/agent-actions/issues", {
    method: "POST",
    headers: { Authorization: `Bearer ${raw}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Implement routed work",
      description: "Build the requested change",
      assignee: developer.name,
      dispatch: true,
    }),
  });
  expect(routedResponse.status).toBe(201);
  const routed = await routedResponse.json() as {
    issue: { id: string; agentId: string; repositoryId: string; status: string };
    run: { conversationId: string; agentId: string; purpose: string; status: string };
  };
  expect(routed.issue).toEqual(expect.objectContaining({
    agentId: developer.id,
    repositoryId: repository.id,
    status: "todo",
  }));
  expect(routed.run).toEqual(expect.objectContaining({
    conversationId: routed.issue.id,
    agentId: developer.id,
    purpose: "implementation",
    status: "queued",
  }));

  store.revokeRunActionTokens(run.id, Date.now());
  const denied = await app.request("/hooks/agent-actions/issues", {
    method: "POST",
    headers: { Authorization: `Bearer ${raw}`, "Content-Type": "application/json" },
    body: JSON.stringify({ title: "should fail" }),
  });
  expect(denied.status).toBe(401);
});

test("implementation and review action tokens can open, approve, and policy-merge only the current Issue PR", async () => {
  const store = new HarborStore(openDb(":memory:"));
  const device = store.upsertDevice("worker", "hash", { clis: { codex: "1" }, endpoints: [] }, 1);
  const repository = store.createRepository({
    workspaceId: "ws_personal",
    name: "app",
    remoteUrl: "https://github.com/acme/app.git",
    defaultBranch: "main",
  }, 2);
  const mount = store.setRepositoryMount(repository.id, device.id, "/repo", 3);
  const developer = store.createAgent({
    name: "developer",
    deviceId: device.id,
    backend: "codex",
    repositoryId: repository.id,
    isolation: "worktree",
  }, 4);
  const reviewer = store.createAgent({
    name: "reviewer",
    deviceId: device.id,
    backend: "codex",
    repositoryId: repository.id,
    permission: "readonly",
    isolation: "worktree",
  }, 5);
  const issue = store.createConversation({
    workspaceId: "ws_personal",
    kind: "issue",
    title: "Ship feature",
    description: "Implement and review it",
    agentId: developer.id,
    repositoryId: repository.id,
  }, 6);
  store.setConversationStatus(issue.id, "doing", 7);
  const implementation = store.createRun({
    conversationId: issue.id,
    agentId: developer.id,
    deviceId: device.id,
    repositoryId: repository.id,
    repositoryMountId: mount.id,
    executionRoot: mount.path,
    prompt: "implement",
    purpose: "implementation",
    promptEvent: "event.issue.assigned",
  }, 8);
  store.markRunRunning(implementation.id, 9);

  const fakeGitHub: DeliveryProvider = {
    kind: "github",
    mode: "automatic",
    async createChange(_context, input) {
      return {
        ...input,
        changeUrl: "https://github.com/acme/app/pull/7",
        externalId: "#7",
        checkStatus: "pending",
      };
    },
    prepareChange(_context, input) {
      return { ...input, checkStatus: input.checkStatus ?? "pending" };
    },
    async sync() {
      return {
        message: "synced",
        metadata: {
          changeUrl: "https://github.com/acme/app/pull/7",
          externalId: "#7",
          headBranch: `harbor/${issue.id}`,
          baseBranch: "main",
          latestHeadSha: "abc123",
        },
        checkStatus: "passed",
        mergeStatus: "open",
        mergedAt: null,
        mergedRevision: null,
      };
    },
    async merge() {
      return { message: "merged" };
    },
  };
  const deliveries = new DeliveryService(store, [fakeGitHub]);
  const transitions: { before: string; after: string }[] = [];
  deliveries.onTransition = (before, after) => transitions.push({ before: before.status, after: after.status });
  const coordinator = new RunCoordinator(
    store,
    new RunBus(),
    { isOnline: () => false, send: () => false },
    2,
    deliveries,
  );
  const app = buildRest(
    store,
    new RunBus(),
    { onlineIds: () => new Set<string>(), isOnline: () => false } as unknown as DeviceHub,
    coordinator,
    {} as ApprovalService,
    {} as AutomationService,
    "owner-token",
    deliveries,
  );
  const implementationToken = "implementation-token";
  store.createRunActionToken(
    implementation.id,
    createHash("sha256").update(implementationToken).digest("hex"),
    Date.now() + 60_000,
    10,
  );
  const opened = await app.request("/hooks/agent-actions/deliveries", {
    method: "POST",
    headers: { Authorization: `Bearer ${implementationToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "github",
      headBranch: `harbor/${issue.id}`,
      baseBranch: "main",
      deploymentRequired: true,
    }),
  });
  const openedBody = await opened.json() as Record<string, unknown>;
  expect({ status: opened.status, body: openedBody }).toEqual({
    status: 201,
    body: expect.objectContaining({
    conversationId: issue.id,
    provider: "github",
    changeUrl: "https://github.com/acme/app/pull/7",
    deploymentStatus: "pending",
    }),
  });

  store.finishRun(implementation.id, "succeeded", { claudeSessionId: null, cost: null, error: null }, 11);
  store.setConversationStatus(issue.id, "review", 12);
  const review = store.createRun({
    conversationId: issue.id,
    agentId: reviewer.id,
    deviceId: device.id,
    repositoryId: repository.id,
    repositoryMountId: mount.id,
    executionRoot: mount.path,
    prompt: "review",
    purpose: "review",
    promptEvent: "event.issue.message_created",
  }, 13);
  store.markRunRunning(review.id, 14);
  const reviewToken = "review-token";
  store.createRunActionToken(
    review.id,
    createHash("sha256").update(reviewToken).digest("hex"),
    Date.now() + 60_000,
    15,
  );
  const approved = await app.request("/hooks/agent-actions/reviews", {
    method: "POST",
    headers: { Authorization: `Bearer ${reviewToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "approve", feedback: "No blockers.", merge: true }),
  });
  expect(approved.status).toBe(200);
  expect((await approved.json()) as unknown).toEqual(expect.objectContaining({
    decision: "approve",
    mergeDeferred: null,
    delivery: expect.objectContaining({
      reviewStatus: "approved",
      checkStatus: "passed",
      mergeStatus: "merged",
      approvedHeadSha: "abc123",
    }),
  }));
  expect(store.listDeliveryEvents(store.getDeliveryForConversation(issue.id)!.id).map((event) => event.actor)).toContain("agent");
  expect(transitions).toContainEqual({ before: "merge_ready", after: "merged" });
  expect(store.getDeliveryForConversation(issue.id)).toEqual(expect.objectContaining({
    mergeStatus: "merged",
    deploymentStatus: "pending",
  }));
});

test("request_changes queues the Developer behind the active review Run without conversation overlap", async () => {
  const store = new HarborStore(openDb(":memory:"));
  const device = store.upsertDevice("worker", "hash", { clis: { codex: "1" }, endpoints: [] }, 1);
  const repository = store.createRepository({ workspaceId: "ws_personal", name: "app" }, 2);
  const mount = store.setRepositoryMount(repository.id, device.id, "/repo", 3);
  const developer = store.createAgent({
    name: "developer",
    deviceId: device.id,
    backend: "codex",
    repositoryId: repository.id,
    isolation: "worktree",
  }, 4);
  const reviewer = store.createAgent({
    name: "reviewer",
    deviceId: device.id,
    backend: "codex",
    repositoryId: repository.id,
    permission: "readonly",
    isolation: "worktree",
  }, 5);
  const issue = store.createConversation({
    workspaceId: "ws_personal",
    kind: "issue",
    title: "Needs review",
    agentId: developer.id,
    repositoryId: repository.id,
  }, 6);
  store.setConversationStatus(issue.id, "review", 7);
  const review = store.createRun({
    conversationId: issue.id,
    agentId: reviewer.id,
    deviceId: device.id,
    repositoryId: repository.id,
    repositoryMountId: mount.id,
    executionRoot: mount.path,
    prompt: "review",
    purpose: "review",
    promptEvent: "event.issue.message_created",
  }, 8);
  store.markRunRunning(review.id, 9);
  const sent: unknown[] = [];
  const coordinator = new RunCoordinator(store, new RunBus(), {
    isOnline: () => true,
    send: (_deviceId, message) => {
      sent.push(message);
      return true;
    },
  }, 2);
  const app = buildRest(
    store,
    new RunBus(),
    { onlineIds: () => new Set([device.id]), isOnline: () => true } as unknown as DeviceHub,
    coordinator,
    {} as ApprovalService,
    {} as AutomationService,
    "owner-token",
  );
  const token = "request-changes-token";
  store.createRunActionToken(
    review.id,
    createHash("sha256").update(token).digest("hex"),
    Date.now() + 60_000,
    10,
  );
  const response = await app.request("/hooks/agent-actions/reviews", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      decision: "request_changes",
      feedback: "Please add the missing regression test.",
      developer: developer.name,
    }),
  });
  expect(response.status).toBe(201);
  const body = await response.json() as { run: { id: string; status: string; purpose: string } };
  expect(body.run).toEqual(expect.objectContaining({ status: "queued", purpose: "implementation" }));
  expect(sent).toHaveLength(0);
  expect(store.getConversation(issue.id)?.status).toBe("todo");

  coordinator.onRunDone({ runId: review.id, status: "succeeded", claudeSessionId: null, cost: null });
  expect(store.getRun(body.run.id)?.status).toBe("running");
  expect(sent).toHaveLength(1);
});

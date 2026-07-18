import { expect, test } from "bun:test";
import type { Conversation, Delivery, Run } from "../protocol.js";
import type { ApprovalService } from "./approvals.js";
import type { AutomationService } from "./automation.js";
import { RunBus } from "./bus.js";
import { openDb } from "./db.js";
import { DeliveryService } from "./delivery.js";
import { buildRest } from "./rest.js";
import { RunCoordinator, type DeviceTransport } from "./scheduler.js";
import { HarborStore } from "./store.js";
import type { DeviceHub } from "./ws.js";

test("Issue action API supports Inbox → Assign & Run → Review → AI Review → Approve", async () => {
  const store = new HarborStore(openDb(":memory:"));
  const device = store.upsertDevice("worker", "hash", { clis: { claude: "2.1" }, endpoints: [] }, 1);
  const builder = store.createAgent(
    { name: "builder", deviceId: device.id, backend: "claude", workdir: "/repo" },
    2,
  );
  const reviewer = store.createAgent(
    { name: "reviewer", deviceId: device.id, backend: "claude", workdir: "/repo" },
    3,
  );
  const transport: DeviceTransport = { isOnline: () => false, send: () => false };
  const coordinator = new RunCoordinator(store, new RunBus(), transport, 2);
  const hub = { onlineIds: () => new Set<string>(), isOnline: () => false } as unknown as DeviceHub;
  const app = buildRest(
    store,
    new RunBus(),
    hub,
    coordinator,
    {} as ApprovalService,
    {} as AutomationService,
    "test-token",
  );
  const request = (path: string, body?: unknown) =>
    app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer test-token",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const createdResponse = await request("/api/conversations", {
    kind: "issue",
    title: "Ship from Harbor",
    description: "Implement and test the feature",
    priority: "urgent",
    origin: "web",
  });
  expect(createdResponse.status).toBe(201);
  const issue = (await createdResponse.json()) as Conversation;
  expect(issue).toEqual(expect.objectContaining({ status: "backlog", agentId: null, priority: "urgent" }));

  const prematureApproval = await request(`/api/conversations/${issue.id}/approve`, {});
  expect(prematureApproval.status).toBe(400);

  const dispatchResponse = await request(`/api/conversations/${issue.id}/dispatch`, { agent: builder.id });
  expect(dispatchResponse.status).toBe(201);
  const implementation = (await dispatchResponse.json()) as Run;
  expect(implementation).toEqual(expect.objectContaining({ purpose: "implementation", status: "queued" }));
  expect(store.getConversation(issue.id)).toEqual(expect.objectContaining({ status: "todo", agentId: builder.id }));

  coordinator.onRunDone({
    runId: implementation.id,
    status: "succeeded",
    claudeSessionId: "implementation-session",
    cost: null,
  });
  expect(store.getConversation(issue.id)?.status).toBe("review");

  const reviewResponse = await request(`/api/conversations/${issue.id}/review`, { agent: reviewer.id });
  expect(reviewResponse.status).toBe(201);
  const review = (await reviewResponse.json()) as Run;
  expect(review.purpose).toBe("review");
  expect(store.getConversation(issue.id)?.agentId).toBe(builder.id);

  coordinator.onRunDone({ runId: review.id, status: "succeeded", claudeSessionId: "review-session", cost: null });
  expect(store.getConversation(issue.id)).toEqual(
    expect.objectContaining({ status: "review", agentId: builder.id, claudeSessionId: "implementation-session" }),
  );

  const approvalResponse = await request(`/api/conversations/${issue.id}/approve`, {});
  expect(approvalResponse.status).toBe(200);
  expect((await approvalResponse.json()) as Conversation).toEqual(expect.objectContaining({ status: "done" }));
});

test("AI issue draft triages read-only before publishing a visible Issue", async () => {
  const store = new HarborStore(openDb(":memory:"));
  const device = store.upsertDevice("worker", "hash", { clis: { claude: "2.1" }, endpoints: [] }, 1);
  const agent = store.createAgent(
    { name: "triager", deviceId: device.id, backend: "claude", workdir: "/repo", permission: "full", isolation: "worktree" },
    2,
  );
  const coordinator = new RunCoordinator(
    store,
    new RunBus(),
    { isOnline: () => false, send: () => false },
    2,
  );
  const app = buildRest(
    store,
    new RunBus(),
    { onlineIds: () => new Set<string>(), isOnline: () => false } as unknown as DeviceHub,
    coordinator,
    {} as ApprovalService,
    {} as AutomationService,
    "test-token",
  );
  const post = (path: string, body: unknown) => app.request(path, {
    method: "POST",
    headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const draftResponse = await post("/api/issue-drafts", {
    request: "Find the root cause and turn it into an actionable issue",
    agent: agent.id,
    priority: "high",
  });
  expect(draftResponse.status).toBe(201);
  const draft = (await draftResponse.json()) as { conversation: Conversation; run: Run };
  expect(draft.conversation).toEqual(expect.objectContaining({ kind: "issue_draft", status: "open", agentId: agent.id }));
  expect(draft.run).toEqual(expect.objectContaining({ purpose: "triage", status: "queued" }));
  expect(draft.run.prompt).toContain("Do not edit files");
  expect(store.listConversations({ kind: "issue" })).toHaveLength(0);

  coordinator.onRunDone({ runId: draft.run.id, status: "succeeded", claudeSessionId: "triage-session", cost: null });
  expect(store.getConversation(draft.conversation.id)).toEqual(expect.objectContaining({ kind: "issue_draft", status: "open", claudeSessionId: "triage-session" }));

  const publishResponse = await post(`/api/issue-drafts/${draft.conversation.id}/publish`, {
    title: "Fix the concrete root cause",
    description: "## Acceptance criteria\n- Reproduction passes",
    priority: "high",
    status: "todo",
  });
  expect(publishResponse.status).toBe(200);
  expect((await publishResponse.json()) as Conversation).toEqual(
    expect.objectContaining({ kind: "issue", status: "todo", title: "Fix the concrete root cause", agentId: agent.id }),
  );
  expect(store.listRunsByConversation(draft.conversation.id)[0]?.purpose).toBe("triage");
  expect(store.listConversations({ kind: "issue" })).toHaveLength(1);
});

test("Delivery policy keeps Issue in Review until checks, merge and deployment all complete", async () => {
  const store = new HarborStore(openDb(":memory:"));
  const device = store.upsertDevice("delivery-worker", "hash", { clis: { claude: "2.1" }, endpoints: [] }, 1);
  const agent = store.createAgent(
    { name: "delivery-builder", deviceId: device.id, backend: "claude", workdir: "/repo" },
    2,
  );
  const coordinator = new RunCoordinator(
    store,
    new RunBus(),
    { isOnline: () => false, send: () => false },
    2,
  );
  const app = buildRest(
    store,
    new RunBus(),
    { onlineIds: () => new Set<string>(), isOnline: () => false } as unknown as DeviceHub,
    coordinator,
    {} as ApprovalService,
    {} as AutomationService,
    "test-token",
  );
  const request = (method: string, path: string, body?: unknown) => app.request(path, {
    method,
    headers: {
      Authorization: "Bearer test-token",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const issue = store.createConversation(
    { kind: "issue", title: "Deliver safely", description: "Implement it", agentId: agent.id, origin: "web" },
    3,
  );
  store.setConversationStatus(issue.id, "review", 4);

  const createdResponse = await request("POST", `/api/conversations/${issue.id}/delivery`, {
    changeUrl: "https://github.com/example/repo/pull/42",
    deploymentRequired: true,
  });
  expect(createdResponse.status).toBe(201);
  const created = (await createdResponse.json()) as Delivery;
  expect(created).toEqual(expect.objectContaining({ status: "review_pending", deploymentStatus: "pending" }));

  const approvedResponse = await request("POST", `/api/conversations/${issue.id}/approve`, {});
  expect(approvedResponse.status).toBe(200);
  expect(store.getConversation(issue.id)?.status).toBe("review");
  expect(store.getDelivery(created.id)).toEqual(expect.objectContaining({ reviewStatus: "approved", status: "checks_pending" }));

  const blockedMerge = await request("POST", `/api/deliveries/${created.id}/merge`, { confirmed: true });
  expect(blockedMerge.status).toBe(400);
  expect((await blockedMerge.json()) as { error: string }).toEqual(expect.objectContaining({ error: expect.stringContaining("CI checks") }));

  const checksResponse = await request("PATCH", `/api/deliveries/${created.id}`, { checkStatus: "passed" });
  expect(checksResponse.status).toBe(200);
  expect((await checksResponse.json()) as Delivery).toEqual(expect.objectContaining({ status: "merge_ready" }));

  const changedReference = await request("PATCH", `/api/deliveries/${created.id}`, {
    changeUrl: "https://github.com/example/repo/pull/43",
  });
  expect(changedReference.status).toBe(200);
  expect((await changedReference.json()) as Delivery).toEqual(
    expect.objectContaining({ reviewStatus: "pending", checkStatus: "pending", status: "review_pending" }),
  );
  await request("POST", `/api/conversations/${issue.id}/approve`, {});
  await request("PATCH", `/api/deliveries/${created.id}`, { checkStatus: "passed" });

  const mergedResponse = await request("POST", `/api/deliveries/${created.id}/merge`, { confirmed: true });
  expect(mergedResponse.status).toBe(200);
  expect((await mergedResponse.json()) as Delivery).toEqual(expect.objectContaining({ status: "merged" }));
  expect(store.getConversation(issue.id)?.status).toBe("review");

  const deployResponse = await request("POST", `/api/deliveries/${created.id}/deploy`, { confirmed: true });
  expect(deployResponse.status).toBe(200);
  expect((await deployResponse.json()) as Delivery).toEqual(expect.objectContaining({ status: "deploying" }));

  const completedResponse = await request("POST", `/api/deliveries/${created.id}/deployment-result`, { status: "succeeded" });
  expect(completedResponse.status).toBe(200);
  expect((await completedResponse.json()) as Delivery).toEqual(expect.objectContaining({ status: "succeeded" }));
  expect(store.getConversation(issue.id)?.status).toBe("done");
  expect(store.listDeliveryEvents(created.id).map((event) => event.kind)).toEqual([
    "created",
    "review_approved",
    "checks_updated",
    "change_updated",
    "evidence_invalidated",
    "review_approved",
    "checks_updated",
    "merged",
    "deployment_started",
    "deployment_succeeded",
  ]);
});

test("Deployment targets expose only safe descriptors and REST rejects request-supplied execution config", async () => {
  const store = new HarborStore(openDb(":memory:"));
  const device = store.upsertDevice("target-worker", "hash", { clis: { claude: "2.1" }, endpoints: [] }, 1);
  const repository = store.createRepository({ workspaceId: store.defaultWorkspace().id, name: "target-repo" }, 2);
  store.setRepositoryMount(repository.id, device.id, "/repo", 3);
  const agent = store.createAgent({ name: "target-builder", deviceId: device.id, backend: "claude", repositoryId: repository.id }, 4);
  const issue = store.createConversation({ kind: "issue", title: "Target", agentId: agent.id, origin: "web" }, 5);
  store.setConversationStatus(issue.id, "review", 6);
  const deliveries = new DeliveryService(store, [], [{
    id: "local-target", name: "Local Target", provider: "local-launchd", repositoryId: repository.id,
    fingerprint: "c".repeat(64),
    manifestHash: "d".repeat(64),
  }]);
  const coordinator = new RunCoordinator(store, new RunBus(), { isOnline: () => false, send: () => false }, 2, deliveries);
  const app = buildRest(
    store, new RunBus(), { onlineIds: () => new Set<string>(), isOnline: () => false } as unknown as DeviceHub,
    coordinator, {} as ApprovalService, {} as AutomationService, "test-token", deliveries,
  );
  const request = (method: string, path: string, body?: unknown) => app.request(path, {
    method,
    headers: { Authorization: "Bearer test-token", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const targets = await request("GET", "/api/deployment-targets");
  expect(await targets.json()).toEqual([{ id: "local-target", name: "Local Target", provider: "local-launchd" }]);
  const injection = await request("POST", `/api/conversations/${issue.id}/delivery`, {
    provider: "manual", changeUrl: "https://example.test/mr/1", deploymentRequired: true,
    deploymentTargetId: "local-target", commands: [["sh", "-c", "anything"]],
  });
  expect(injection.status).toBe(400);
  expect(await injection.json()).toEqual(expect.objectContaining({ error: expect.stringContaining("只能来自 server 管理员配置") }));

  const createdResponse = await request("POST", `/api/conversations/${issue.id}/delivery`, {
    provider: "manual", changeUrl: "https://example.test/mr/1", deploymentRequired: true,
    deploymentTargetId: "local-target",
  });
  expect(createdResponse.status).toBe(201);
  const created = (await createdResponse.json()) as Delivery;
  expect(created).toEqual(expect.objectContaining({ deploymentTargetId: "local-target", deploymentStatus: "pending" }));
  const forgedResult = await request("POST", `/api/deliveries/${created.id}/deployment-result`, { status: "succeeded" });
  expect(forgedResult.status).toBe(400);
  expect(await forgedResult.json()).toEqual(expect.objectContaining({ error: expect.stringContaining("独立 host worker") }));
});

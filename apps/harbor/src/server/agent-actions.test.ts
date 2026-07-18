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

test("Run action token can only create a scoped follow-up Issue", async () => {
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

  store.revokeRunActionTokens(run.id, Date.now());
  const denied = await app.request("/hooks/agent-actions/issues", {
    method: "POST",
    headers: { Authorization: `Bearer ${raw}`, "Content-Type": "application/json" },
    body: JSON.stringify({ title: "should fail" }),
  });
  expect(denied.status).toBe(401);
});

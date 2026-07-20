import { expect, test } from "bun:test";
import type { Conversation, Delivery } from "../protocol.js";
import type { ApprovalService } from "./approvals.js";
import type { AutomationService } from "./automation.js";
import { RunBus } from "./bus.js";
import { DeliveryService, type DeliveryProvider } from "./delivery.js";
import { openDb } from "./db.js";
import { GitHubDeliveryProvider, GitHubRestClient } from "./github-delivery.js";
import { buildRest } from "./rest.js";
import { RunCoordinator } from "./scheduler.js";
import { HarborStore } from "./store.js";
import type { DeviceHub } from "./ws.js";

function restHarness(providers: DeliveryProvider[] = []) {
  const store = new HarborStore(openDb(":memory:"));
  const deliveries = new DeliveryService(store, providers);
  const device = store.upsertDevice("rest-github-worker", "hash", { clis: { claude: "2.1" }, endpoints: [] }, 1);
  const repository = store.createRepository(
    { workspaceId: store.defaultWorkspace().id, name: "harbor", remoteUrl: "https://github.com/acme/harbor.git" },
    2,
  );
  store.setRepositoryMount(repository.id, device.id, "/repo", 3);
  const agent = store.createAgent(
    { name: "builder", deviceId: device.id, backend: "claude", repositoryId: repository.id },
    4,
  );
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
    "test-token",
    deliveries,
  );
  const request = (method: string, path: string, body?: unknown) => app.request(path, {
    method,
    headers: {
      Authorization: "Bearer test-token",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const issue = (title: string, now: number): Conversation => {
    const created = store.createConversation({ kind: "issue", title, agentId: agent.id, origin: "web" }, now);
    store.setConversationStatus(created.id, "review", now + 1);
    return store.getConversation(created.id)!;
  };
  return { store, deliveries, request, issue };
}

test("REST fails GitHub configuration loudly while manual Delivery remains usable", async () => {
  const h = restHarness();
  const githubIssue = h.issue("Missing GitHub config", 10);
  const github = await h.request("POST", `/api/conversations/${githubIssue.id}/delivery`, {
    provider: "github",
    changeUrl: "https://github.com/acme/harbor/pull/42",
  });
  expect(github.status).toBe(400);
  expect((await github.json()) as { error: string }).toEqual({
    error: expect.stringContaining("GitHub App installation"),
  });

  const manualIssue = h.issue("Manual fallback", 20);
  const manual = await h.request("POST", `/api/conversations/${manualIssue.id}/delivery`, {
    provider: "manual",
    changeUrl: "https://code.example.com/acme/harbor/merge_requests/42",
  });
  expect(manual.status).toBe(201);
  expect((await manual.json()) as Delivery).toEqual(expect.objectContaining({ provider: "manual", checkStatus: "unknown" }));
});

test("REST syncs GitHub truth, rejects forged checks, and merges only after policy passes", async () => {
  let mergeCalls = 0;
  const fetchImpl = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    if (url.pathname.endsWith("/pulls/42") && (init?.method ?? "GET") === "GET") {
      return json({
        number: 42,
        state: "open",
        merged: false,
        merged_at: null,
        html_url: "https://github.com/acme/harbor/pull/42",
        head: { ref: "feature/github", sha: "abc123" },
        base: { ref: "main" },
      });
    }
    if (url.pathname.endsWith("/check-runs")) {
      return json({ total_count: 1, check_runs: [{ id: 101, name: "build", status: "completed", conclusion: "success", app: { id: 7 } }] });
    }
    if (url.pathname.endsWith("/status")) {
      return json({ state: "pending", sha: "abc123", total_count: 0, statuses: [] });
    }
    if (url.pathname === "/repos/acme/harbor/branches/main") return json({ protected: true });
    if (url.pathname.endsWith("/required_status_checks")) {
      return json({ checks: [{ context: "build", app_id: 7 }] });
    }
    if (url.pathname.endsWith("/rules/branches/main")) return json([]);
    if (url.pathname.endsWith("/pulls/42/merge") && init?.method === "PUT") {
      mergeCalls++;
      return json({ merged: true, sha: "merge456", message: "merged" });
    }
    return json({ message: "unexpected request" }, 500);
  }) as typeof fetch;
  const provider = new GitHubDeliveryProvider(
    new GitHubRestClient("fake-token", { baseUrl: "https://api.github.test/", fetch: fetchImpl }),
  );
  const h = restHarness([provider]);
  const issue = h.issue("REST GitHub", 10);

  const createdResponse = await h.request("POST", `/api/conversations/${issue.id}/delivery`, {
    provider: "github",
    changeUrl: "https://github.com/acme/harbor/pull/42",
  });
  expect(createdResponse.status).toBe(201);
  const created = (await createdResponse.json()) as Delivery;
  expect(created).toEqual(expect.objectContaining({ provider: "github", checkStatus: "pending" }));

  const forged = await h.request("PATCH", `/api/deliveries/${created.id}`, { checkStatus: "passed" });
  expect(forged.status).toBe(400);
  expect((await forged.json()) as { error: string }).toEqual({ error: expect.stringContaining("Sync from GitHub") });

  const syncedResponse = await h.request("POST", `/api/deliveries/${created.id}/sync`, {});
  expect(syncedResponse.status).toBe(200);
  expect((await syncedResponse.json()) as Delivery).toEqual(expect.objectContaining({ checkStatus: "passed", status: "review_pending" }));

  const blocked = await h.request("POST", `/api/deliveries/${created.id}/merge`, {});
  expect(blocked.status).toBe(400);
  expect(mergeCalls).toBe(0);

  const approved = await h.request("POST", `/api/conversations/${issue.id}/approve`, {});
  expect(approved.status).toBe(200);
  const merged = await h.request("POST", `/api/deliveries/${created.id}/merge`, {});
  expect(merged.status).toBe(200);
  expect((await merged.json()) as Delivery).toEqual(expect.objectContaining({ mergeStatus: "merged", status: "succeeded" }));
  expect(mergeCalls).toBe(1);
  expect(h.store.getConversation(issue.id)?.status).toBe("done");
});

test("REST does not finalize an Issue when merge HTTP returns after evidence was invalidated", async () => {
  const mergeEntered = deferred();
  const mergeRelease = deferred();
  let merged = false;
  const fetchImpl = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    const method = init?.method ?? "GET";
    if (url.pathname.endsWith("/pulls/42") && method === "GET") {
      return json({
        number: 42,
        state: merged ? "closed" : "open",
        merged,
        merged_at: merged ? "2026-07-18T12:00:00Z" : null,
        html_url: "https://github.com/acme/harbor/pull/42",
        head: { ref: "feature/github", sha: "abc123" },
        base: { ref: "main" },
      });
    }
    if (url.pathname.endsWith("/check-runs")) {
      return json({ total_count: 1, check_runs: [{ id: 101, name: "build", status: "completed", conclusion: "success" }] });
    }
    if (url.pathname.endsWith("/status")) {
      return json({ state: "pending", sha: "abc123", total_count: 0, statuses: [] });
    }
    if (url.pathname === "/repos/acme/harbor/branches/main") return json({ protected: true });
    if (url.pathname.endsWith("/required_status_checks")) return json({ contexts: ["build"] });
    if (url.pathname.endsWith("/rules/branches/main")) return json([]);
    if (url.pathname.endsWith("/pulls/42/merge") && method === "PUT") {
      mergeEntered.resolve();
      await mergeRelease.promise;
      merged = true;
      return json({ merged: true, sha: "merge456", message: "merged" });
    }
    return json({ message: "unexpected request" }, 500);
  }) as typeof fetch;
  const h = restHarness([
    new GitHubDeliveryProvider(
      new GitHubRestClient("fake-token", { baseUrl: "https://api.github.test/", fetch: fetchImpl }),
    ),
  ]);
  const issue = h.issue("REST merge race", 10);
  const createdResponse = await h.request("POST", `/api/conversations/${issue.id}/delivery`, {
    provider: "github",
    changeUrl: "https://github.com/acme/harbor/pull/42",
  });
  const delivery = (await createdResponse.json()) as Delivery;
  expect((await h.request("POST", `/api/deliveries/${delivery.id}/sync`, {})).status).toBe(200);
  expect((await h.request("POST", `/api/conversations/${issue.id}/approve`, {})).status).toBe(200);

  const mergeResponse = h.request("POST", `/api/deliveries/${delivery.id}/merge`, {});
  await mergeEntered.promise;
  h.deliveries.prepareImplementation(h.store.getConversation(issue.id)!, 30);
  mergeRelease.resolve();
  const raced = await mergeResponse;
  expect(raced.status).toBe(400);
  expect((await raced.json()) as { error: string }).toEqual({ error: expect.stringContaining("证据已变化") });
  expect(h.store.getConversation(issue.id)?.status).toBe("review");
  expect(h.store.getDelivery(delivery.id)).toEqual(expect.objectContaining({
    mergeStatus: "open",
    reviewStatus: "pending",
    checkStatus: "pending",
  }));

  const reconciled = await h.request("POST", `/api/deliveries/${delivery.id}/sync`, {});
  expect(reconciled.status).toBe(200);
  expect((await reconciled.json()) as Delivery).toEqual(expect.objectContaining({
    mergeStatus: "merged",
    reviewStatus: "pending",
    status: "review_pending",
  }));
  expect(h.store.getConversation(issue.id)?.status).toBe("review");
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

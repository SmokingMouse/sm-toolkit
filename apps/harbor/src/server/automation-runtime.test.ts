import { describe, expect, test } from "bun:test";
import type { ServerMsg } from "../protocol.js";
import { AutomationService, hashWebhookSecret } from "./automation.js";
import { RunBus } from "./bus.js";
import { openDb } from "./db.js";
import { renderRunPrompt } from "./prompt-wrapper.js";
import { buildRest } from "./rest.js";
import { RunCoordinator, type DeviceTransport } from "./scheduler.js";
import { HarborStore } from "./store.js";
import type { ApprovalService } from "./approvals.js";
import type { DeviceHub } from "./ws.js";

function setup(online = false) {
  const store = new HarborStore(openDb(":memory:"));
  const device = store.upsertDevice("worker", "hash", { clis: { claude: "2.1" }, endpoints: [] }, 1);
  const agent = store.createAgent({ name: "builder", deviceId: device.id, backend: "claude", workdir: "/repo" }, 2);
  const sent: { deviceId: string; message: ServerMsg }[] = [];
  const transport: DeviceTransport = {
    isOnline: () => online,
    send: (deviceId, message) => {
      sent.push({ deviceId, message });
      return true;
    },
  };
  const coordinator = new RunCoordinator(store, new RunBus(), transport, 2);
  return { store, agent, coordinator, sent, service: new AutomationService(store, coordinator) };
}

describe("Mew-style Automation runtime", () => {
  test("durable issue events dispatch live and do not retroactively trigger newer Automations", () => {
    const { store, agent, service } = setup();
    const historical = store.createConversation({
      workspaceId: "ws_personal",
      kind: "issue",
      title: "Historical",
      agentId: agent.id,
      repositoryId: agent.repositoryId,
    }, 3);
    store.setConversationStatus(historical.id, "todo", 4);
    expect(store.listDomainEvents().map((event) => event.id)).toEqual([
      `issue.created:${historical.id}`,
      `issue.ready:${historical.id}`,
    ]);
    const automation = store.createAutomation({
      name: "ready-router",
      agentId: agent.id,
      prompt: "Apply the user-defined routing policy.",
      purpose: "coordination",
      outputMode: "source",
      triggers: [{ type: "event", events: ["issue.ready"] }],
    }, 5);
    const historicalEvent = store.getDomainEvent(`issue.ready:${historical.id}`)!;
    expect(service.receiveEvent({
      workspaceId: historicalEvent.workspaceId,
      eventType: historicalEvent.type,
      eventId: historicalEvent.id,
      payload: historicalEvent.payload,
      createdAt: historicalEvent.createdAt,
    })).toEqual([]);

    store.setDomainEventListener((event) => {
      service.receiveEvent({
        workspaceId: event.workspaceId,
        eventType: event.type,
        eventId: event.id,
        payload: event.payload,
        createdAt: event.createdAt,
      });
    });
    const live = store.createConversation({
      workspaceId: "ws_personal",
      kind: "issue",
      title: "Live",
      agentId: agent.id,
      repositoryId: agent.repositoryId,
    }, 6);
    store.setConversationStatus(live.id, "todo", 7);
    expect(store.listRunsByConversation(live.id)).toEqual([
      expect.objectContaining({
        purpose: "coordination",
        triggerRef: automation.id,
        sourceId: live.id,
      }),
    ]);
  });

  test("direct output persists Automation as the Run source without creating a Conversation", () => {
    const { store, agent, coordinator, service } = setup();
    const automation = store.createAutomation({
      name: "direct",
      agentId: agent.id,
      prompt: "Inspect the repository",
      outputMode: "run",
      overlapMode: "skip",
      cron: "0 9 * * *",
    }, 3);

    const run = service.runNow(automation.id);

    expect(run).toEqual(expect.objectContaining({
      sourceType: "automation",
      sourceId: automation.id,
      conversationId: null,
      promptEvent: "event.automation.manual",
      triggerRef: automation.id,
      concurrencyKey: `automation:${automation.id}`,
    }));
    expect(store.listConversations({ workspaceId: "ws_personal" })).toHaveLength(0);
    expect(renderRunPrompt(store, { run, conversation: null, agent })).toContain("Manual Automation Run");
    expect(() => coordinator.enqueueAutomationRun(
      { ...automation, outputMode: "run" },
      { ...agent, isolation: "worktree" },
      "unsafe",
      "implementation",
      "event.automation.manual",
      {},
    )).toThrow("isolation=none");
  });

  test("webhook verifies secret, filters events, deduplicates deliveries, and snapshots context", () => {
    const { store, agent, service } = setup();
    const secret = "test-webhook-secret";
    const automation = store.createAutomation({
      name: "codebase-push",
      agentId: agent.id,
      prompt: "Handle the release event",
      outputMode: "run",
      overlapMode: "queue",
      triggers: [{
        type: "webhook",
        provider: "codebase",
        events: ["push"],
        filters: [{ path: "ref", equals: "refs/tags/release/prod" }],
        secretHash: hashWebhookSecret(secret),
      }],
    }, 3);
    const trigger = automation.triggers[0]!;

    expect(() => service.receiveWebhook(trigger.id, {
      secret: "wrong",
      eventType: "push",
      eventId: "delivery-1",
      payload: { ref: "refs/tags/release/prod" },
    })).toThrow("secret");
    expect(service.receiveWebhook(trigger.id, {
      secret,
      eventType: "merge",
      eventId: "delivery-1",
      payload: { ref: "refs/tags/release/prod" },
    }).status).toBe("ignored");
    expect(service.receiveWebhook(trigger.id, {
      secret,
      eventType: "push",
      eventId: "delivery-1",
      payload: { ref: "refs/heads/main" },
    }).status).toBe("ignored");

    const started = service.receiveWebhook(trigger.id, {
      secret,
      eventType: "push",
      eventId: "delivery-1",
      payload: { ref: "refs/tags/release/prod", repository: { path: "codebase/x" } },
    });
    expect(started.status).toBe("started");
    if (started.status !== "started") throw new Error("expected started webhook");
    expect(started.run.promptEvent).toBe("event.automation.webhook");
    expect(started.run.triggerContext).toEqual(expect.objectContaining({
      eventType: "push",
      eventId: "delivery-1",
      provider: "codebase",
      payload: expect.objectContaining({ ref: "refs/tags/release/prod" }),
    }));
    expect(service.receiveWebhook(trigger.id, {
      secret,
      eventType: "push",
      eventId: "delivery-1",
      payload: { ref: "refs/tags/release/prod" },
    }).status).toBe("duplicate");
  });

  test("internal event dispatches a review Run back to the source Issue exactly once", () => {
    const { store, agent, service } = setup();
    const issue = store.createConversation({
      workspaceId: "ws_personal",
      kind: "issue",
      title: "Review me",
      agentId: agent.id,
      repositoryId: agent.repositoryId,
    }, 3);
    store.setConversationStatus(issue.id, "review", 4);
    const mount = store.getRepositoryMountForDevice(agent.repositoryId, agent.deviceId)!;
    store.setConversationWorktreePath(issue.id, "/repo-review", mount.id, 4);
    const automation = store.createAutomation({
      name: "auto-review",
      agentId: agent.id,
      prompt: "Review the implementation and submit a decision.",
      purpose: "review",
      outputMode: "source",
      overlapMode: "skip",
      triggers: [{
        type: "event",
        events: ["issue.review_ready"],
        filters: [{ path: "repositoryId", equals: agent.repositoryId }],
      }],
    }, 5);

    const first = service.receiveEvent({
      workspaceId: "ws_personal",
      eventType: "issue.review_ready",
      eventId: "issue.review_ready:r_1",
      payload: { conversationId: issue.id, repositoryId: agent.repositoryId },
    });
    expect(first).toHaveLength(1);
    expect(first[0]).toEqual(expect.objectContaining({ status: "started", automationId: automation.id }));
    if (first[0]?.status !== "started") throw new Error("expected internal event to start");
    expect(first[0].run).toEqual(expect.objectContaining({
      conversationId: issue.id,
      purpose: "review",
      triggerRef: automation.id,
      promptEvent: "event.automation.event",
      triggerContext: expect.objectContaining({
        provider: "harbor",
        eventType: "issue.review_ready",
      }),
    }));

    expect(service.receiveEvent({
      workspaceId: "ws_personal",
      eventType: "issue.review_ready",
      eventId: "issue.review_ready:r_1",
      payload: { conversationId: issue.id, repositoryId: agent.repositoryId },
    })[0]).toEqual(expect.objectContaining({ status: "duplicate" }));
  });

  test("overlap=skip rejects an active invocation while queue serializes starts", () => {
    const skipped = setup();
    const skipAutomation = skipped.store.createAutomation({
      name: "skip",
      agentId: skipped.agent.id,
      prompt: "Run once",
      outputMode: "run",
      overlapMode: "skip",
      cron: "0 9 * * *",
    }, 3);
    skipped.service.runNow(skipAutomation.id);
    expect(() => skipped.service.runNow(skipAutomation.id)).toThrow("overlap=skip");
    expect(skipped.store.listAutomationLog(skipAutomation.id)[0]).toEqual(expect.objectContaining({ kind: "skipped" }));

    const queued = setup(true);
    const queueAutomation = queued.store.createAutomation({
      name: "queue",
      agentId: queued.agent.id,
      prompt: "Run serially",
      outputMode: "run",
      overlapMode: "queue",
      cron: "0 9 * * *",
    }, 3);
    const first = queued.service.runNow(queueAutomation.id);
    const second = queued.service.runNow(queueAutomation.id);
    expect(queued.store.getRun(first.id)?.status).toBe("running");
    expect(queued.store.getRun(second.id)?.status).toBe("queued");
    expect(queued.sent.filter(({ message }) => message.type === "run_start")).toHaveLength(1);

    queued.coordinator.onRunDone({ runId: first.id, status: "succeeded", claudeSessionId: null, cost: null });
    expect(queued.store.getRun(second.id)?.status).toBe("running");
    expect(queued.sent.filter(({ message }) => message.type === "run_start")).toHaveLength(2);
  });

  test("chat output creates a Chat source while preserving Automation trigger provenance", () => {
    const { store, agent, service } = setup();
    const automation = store.createAutomation({
      name: "daily-chat",
      agentId: agent.id,
      prompt: "Post a report",
      outputMode: "chat",
      overlapMode: "skip",
      cron: "0 9 * * *",
    }, 3);

    const run = service.runNow(automation.id);
    const conversation = run.conversationId ? store.getConversation(run.conversationId) : null;
    expect(run.sourceType).toBe("chat");
    expect(run.conversationId).not.toBeNull();
    expect(run.sourceId).toBe(run.conversationId!);
    expect(conversation).toEqual(expect.objectContaining({ kind: "chat", origin: "automation", originRef: automation.id }));
  });

  test("REST creates a webhook with a one-time secret and the public hook authenticates it", async () => {
    const { store, agent, coordinator, service } = setup();
    const hub = { onlineIds: () => new Set<string>(), isOnline: () => false } as unknown as DeviceHub;
    const app = buildRest(
      store,
      new RunBus(),
      hub,
      coordinator,
      {} as ApprovalService,
      service,
      "harbor-token",
    );
    const createdResponse = await app.request("/api/automations", {
      method: "POST",
      headers: { Authorization: "Bearer harbor-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "incoming",
        agent: agent.name,
        triggerType: "webhook",
        provider: "codebase",
        events: ["push"],
        prompt: "Inspect this event",
        outputMode: "run",
        overlapMode: "queue",
      }),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as {
      id: string;
      webhookSecret: string;
      triggers: { id: string; webhookPath: string }[];
    };
    expect(created.webhookSecret.length).toBeGreaterThan(20);
    expect(created.triggers[0]?.webhookPath).toBe(`/hooks/automations/${created.triggers[0]?.id}`);

    const unauthorized = await app.request(created.triggers[0]!.webhookPath, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Harbor-Event": "push" },
      body: JSON.stringify({ ref: "refs/heads/main" }),
    });
    expect(unauthorized.status).toBe(401);

    const accepted = await app.request(created.triggers[0]!.webhookPath, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Harbor-Webhook-Secret": created.webhookSecret,
        "X-Harbor-Event": "push",
        "X-Harbor-Delivery": "delivery-http-1",
      },
      body: JSON.stringify({ ref: "refs/heads/main" }),
    });
    expect(accepted.status).toBe(202);
    expect((await accepted.json()) as { status: string }).toEqual(expect.objectContaining({ status: "started" }));

    const editedResponse = await app.request(`/api/automations/${created.id}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer harbor-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "incoming-edited",
        prompt: "Route this event using the configured policy",
        purpose: "coordination",
        overlapMode: "skip",
      }),
    });
    expect(editedResponse.status).toBe(200);
    expect(await editedResponse.json()).toEqual(expect.objectContaining({
      name: "incoming-edited",
      prompt: "Route this event using the configured policy",
      purpose: "coordination",
      overlapMode: "skip",
    }));
    const triggerResponse = await app.request(
      `/api/automations/${created.id}/triggers/${created.triggers[0]!.id}`,
      {
        method: "PATCH",
        headers: { Authorization: "Bearer harbor-token", "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "generic", events: ["push", "tag"], enabled: false }),
      },
    );
    expect(triggerResponse.status).toBe(200);
    expect(await triggerResponse.json()).toEqual(expect.objectContaining({
      provider: "generic",
      events: ["push", "tag"],
      enabled: false,
    }));
  });
});

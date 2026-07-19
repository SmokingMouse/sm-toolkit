import { describe, expect, test } from "bun:test";
import type { ServerMsg } from "../protocol.js";
import { AutomationService } from "./automation.js";
import { RunBus } from "./bus.js";
import { openDb } from "./db.js";
import { renderRunPrompt } from "./prompt-wrapper.js";
import { buildRest } from "./rest.js";
import { RunCoordinator, type DeviceTransport } from "./scheduler.js";
import { HarborStore } from "./store.js";
import type { ApprovalService } from "./approvals.js";
import type { DeviceHub } from "./ws.js";

function setup(online = false, isolation: "none" | "worktree" = "none") {
  const store = new HarborStore(openDb(":memory:"));
  const device = store.upsertDevice("worker", "hash", { clis: { claude: "2.1" }, endpoints: [] }, 1);
  const agent = store.createAgent({
    name: "builder",
    deviceId: device.id,
    backend: "claude",
    workdir: "/repo",
    isolation,
  }, 2);
  const sent: { deviceId: string; message: ServerMsg }[] = [];
  const transport: DeviceTransport = {
    isOnline: () => online,
    send: (deviceId, message) => {
      sent.push({ deviceId, message });
      return true;
    },
  };
  const coordinator = new RunCoordinator(store, new RunBus(), transport, 2);
  return { store, agent, device, coordinator, sent, service: new AutomationService(store, coordinator) };
}

function addCodebaseRepository(
  store: HarborStore,
  agentId: string,
  deviceId: string,
  now = 3,
) {
  const agent = store.getAgent(agentId)!;
  const repository = store.createRepository({
    workspaceId: agent.workspaceId,
    name: "codebase-app",
    scmProvider: "codebase",
    scmRepository: "team/codebase-app",
  }, now);
  store.setRepositoryMount(repository.id, deviceId, "/codebase-app", now);
  store.setAgentRepositories(agentId, [agent.repositoryId, repository.id], agent.repositoryId, now);
  return repository;
}

describe("Mew Automation runtime", () => {
  test("Run output records history only and derives a neutral coordination purpose", () => {
    const { store, agent, service } = setup(false, "worktree");
    const automation = store.createAutomation({
      name: "direct",
      agentId: agent.id,
      prompt: "Inspect the repository",
      output: "run",
      trigger: { type: "schedule", cron: "0 9 * * *", timezone: "Asia/Shanghai" },
    }, 3);

    const run = service.runNow(automation.id);

    expect(run).toEqual(expect.objectContaining({
      sourceType: "automation",
      sourceId: automation.id,
      conversationId: null,
      purpose: "coordination",
      promptEvent: "event.automation.manual",
      triggerRef: automation.id,
      concurrencyKey: `automation:${automation.id}`,
    }));
    expect(store.listConversations({ workspaceId: "ws_personal" })).toHaveLength(0);
    expect(renderRunPrompt(store, { run, conversation: null, agent })).toContain("Manual Automation Run");
  });

  test("Chat reports in a Chat while Issue creates actionable implementation work", () => {
    const chatHarness = setup();
    const chatAutomation = chatHarness.store.createAutomation({
      name: "daily-chat",
      agentId: chatHarness.agent.id,
      prompt: "Post a report",
      output: "chat",
      trigger: { type: "schedule", cron: "0 9 * * *", timezone: "Asia/Shanghai" },
    }, 3);
    const chatRun = chatHarness.service.runNow(chatAutomation.id);
    const chat = chatHarness.store.getConversation(chatRun.conversationId!);
    expect(chatRun).toEqual(expect.objectContaining({ sourceType: "chat", purpose: "coordination" }));
    expect(chat).toEqual(expect.objectContaining({ kind: "chat", origin: "automation", originRef: chatAutomation.id }));

    const issueHarness = setup();
    const issueAutomation = issueHarness.store.createAutomation({
      name: "actionable",
      agentId: issueHarness.agent.id,
      prompt: "Fix the failing checks",
      output: "issue",
      trigger: { type: "schedule", cron: "0 10 * * 1-5", timezone: "UTC" },
    }, 3);
    const issueRun = issueHarness.service.runNow(issueAutomation.id);
    const issue = issueHarness.store.getConversation(issueRun.conversationId!);
    expect(issueRun).toEqual(expect.objectContaining({ sourceType: "issue", purpose: "implementation" }));
    expect(issue).toEqual(expect.objectContaining({ kind: "issue", description: "Fix the failing checks" }));
  });

  test("Codebase Trigger binds one Repository/event and deduplicates delivery IDs", () => {
    const { store, agent, device, service } = setup();
    const repository = addCodebaseRepository(store, agent.id, device.id);
    const automation = store.createAutomation({
      name: "review-new-mr",
      agentId: agent.id,
      prompt: "Summarize the merge request",
      output: "run",
      trigger: {
        type: "codebase",
        repositoryId: repository.id,
        codebaseEvent: "merge_request_opened",
      },
    }, 4);

    expect(service.receiveCodebase({
      workspaceId: agent.workspaceId,
      repositoryId: repository.id,
      eventType: "merge_request_updated",
      eventId: "delivery-ignored",
      payload: {},
    })).toEqual([]);

    const first = service.receiveCodebase({
      workspaceId: agent.workspaceId,
      repositoryId: repository.id,
      eventType: "merge_request_opened",
      eventId: "delivery-1",
      payload: { merge_request: { number: 7 } },
    });
    expect(first[0]).toEqual(expect.objectContaining({ status: "started", automationId: automation.id }));
    if (first[0]?.status !== "started") throw new Error("expected Codebase Automation to start");
    expect(first[0].run).toEqual(expect.objectContaining({
      repositoryId: repository.id,
      executionRoot: "/codebase-app",
      promptEvent: "event.automation.webhook",
      purpose: "coordination",
      triggerContext: expect.objectContaining({
        eventType: "merge_request_opened",
        eventId: "delivery-1",
      }),
    }));
    expect(service.receiveCodebase({
      workspaceId: agent.workspaceId,
      repositoryId: repository.id,
      eventType: "merge_request_opened",
      eventId: "delivery-1",
      payload: {},
    })[0]).toEqual(expect.objectContaining({ status: "duplicate" }));
  });

  test("implicit overlap policy skips while an earlier Automation Run is active", () => {
    const { store, agent, service } = setup();
    const automation = store.createAutomation({
      name: "single-flight",
      agentId: agent.id,
      prompt: "Run once",
      output: "run",
      trigger: { type: "schedule", cron: "0 * * * *", timezone: "UTC" },
    }, 3);
    service.runNow(automation.id);
    expect(() => service.runNow(automation.id)).toThrow("已有 queued/running Run");
    expect(store.listAutomationLog(automation.id)[0]).toEqual(expect.objectContaining({ kind: "skipped" }));
  });

  test("Schedule validates IANA timezone", () => {
    expect(() => AutomationService.validateCron("0 9 * * *", "Mars/Olympus")).toThrow("IANA timezone");
    expect(() => AutomationService.validateCron("0 9 * * *", "Asia/Shanghai")).not.toThrow();
  });

  test("REST exposes only Output and a single Schedule/Codebase Trigger", async () => {
    const { store, agent, device, coordinator, service } = setup();
    const repository = addCodebaseRepository(store, agent.id, device.id);
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
        prompt: "Inspect this event",
        output: "chat",
        trigger: {
          type: "codebase",
          repository: repository.id,
          event: "merge_request_opened",
        },
      }),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as { id: string; output: string; trigger: { type: string; repositoryId: string } };
    expect(created).toEqual(expect.objectContaining({
      output: "chat",
      trigger: expect.objectContaining({ type: "codebase", repositoryId: repository.id }),
    }));

    const editedResponse = await app.request(`/api/automations/${created.id}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer harbor-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "incoming-edited",
        output: "issue",
        trigger: { type: "schedule", cron: "30 8 * * 1-5", timezone: "Asia/Shanghai" },
      }),
    });
    expect(editedResponse.status).toBe(200);
    expect(await editedResponse.json()).toEqual(expect.objectContaining({
      name: "incoming-edited",
      output: "issue",
      trigger: expect.objectContaining({ type: "schedule", timezone: "Asia/Shanghai" }),
    }));

    const legacyResponse = await app.request("/api/automations", {
      method: "POST",
      headers: { Authorization: "Bearer harbor-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "legacy",
        agent: agent.name,
        prompt: "legacy",
        purpose: "review",
        outputMode: "source",
        trigger: { type: "schedule", cron: "0 9 * * *" },
      }),
    });
    expect(legacyResponse.status).toBe(400);
    expect(await legacyResponse.json()).toEqual(expect.objectContaining({ error: expect.stringContaining("Purpose") }));
  });
});

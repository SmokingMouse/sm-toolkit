import { describe, expect, test } from "bun:test";
import type { ServerMsg } from "../protocol.js";
import { openDb } from "./db.js";
import { HarborStore } from "./store.js";
import { RunBus } from "./bus.js";
import { RunCoordinator, type DeviceTransport } from "./scheduler.js";
import { DeliveryService } from "./delivery.js";

function workflowHarness() {
  const store = new HarborStore(openDb(":memory:"));
  const device = store.upsertDevice("worker", "hash", { clis: { claude: "2.1" }, endpoints: [] }, 1);
  const builder = store.createAgent(
    { name: "builder", deviceId: device.id, backend: "claude", workdir: "/repo", isolation: "worktree" },
    2,
  );
  const reviewer = store.createAgent(
    { name: "reviewer", deviceId: device.id, backend: "claude", workdir: "/repo", isolation: "worktree" },
    3,
  );
  let online = false;
  const sent: ServerMsg[] = [];
  const transport: DeviceTransport = {
    isOnline: () => online,
    send: (_deviceId, message) => {
      sent.push(message);
      return online;
    },
  };
  const coordinator = new RunCoordinator(store, new RunBus(), transport, 1);
  return {
    store,
    builder,
    reviewer,
    coordinator,
    sent,
    setOnline(value: boolean) {
      online = value;
    },
  };
}

describe("Mew-style Issue workflow", () => {
  test("assign & run drives implementation to Review without conflating reviewer ownership", () => {
    const h = workflowHarness();
    const issue = h.store.createConversation(
      {
        kind: "issue",
        title: "Ship workflow",
        description: "Implement the workflow",
        priority: "high",
        agentId: null,
        origin: "web",
      },
      4,
    );

    const implementation = h.coordinator.enqueueRun(issue, h.builder, issue.description!, "implementation");
    expect(h.store.getConversation(issue.id)).toEqual(
      expect.objectContaining({ agentId: h.builder.id, status: "todo" }),
    );
    expect(implementation).toEqual(expect.objectContaining({ purpose: "implementation", status: "queued" }));

    h.setOnline(true);
    h.coordinator.pump(h.builder.deviceId);
    expect(h.store.getConversation(issue.id)?.status).toBe("doing");
    expect(h.store.getRun(implementation.id)?.status).toBe("running");

    h.coordinator.onWorktreeReady(implementation.id, issue.id, "/repo/.harbor-worktrees/ship-workflow");
    h.coordinator.onRunDone({
      runId: implementation.id,
      status: "succeeded",
      claudeSessionId: "implementation-session",
      cost: null,
    });
    expect(h.store.getConversation(issue.id)).toEqual(
      expect.objectContaining({ status: "review", agentId: h.builder.id, claudeSessionId: "implementation-session" }),
    );

    const reviewIssue = h.store.getConversation(issue.id)!;
    const review = h.coordinator.enqueueRun(reviewIssue, h.reviewer, "Review the diff", "review");
    expect(h.store.getConversation(issue.id)).toEqual(
      expect.objectContaining({ status: "review", agentId: h.builder.id, claudeSessionId: "implementation-session" }),
    );
    expect(review.purpose).toBe("review");

    h.coordinator.onRunDone({
      runId: review.id,
      status: "succeeded",
      claudeSessionId: "review-session",
      cost: null,
    });
    expect(h.store.getConversation(issue.id)).toEqual(
      expect.objectContaining({ status: "review", agentId: h.builder.id, claudeSessionId: "implementation-session" }),
    );

    h.setOnline(false);
    const changes = h.coordinator.enqueueRun(
      h.store.getConversation(issue.id)!,
      h.builder,
      "Address the blocking feedback",
      "implementation",
    );
    expect(changes.purpose).toBe("implementation");
    expect(h.store.getConversation(issue.id)?.status).toBe("todo");
  });

  test("rejects a reviewer that cannot see the implementation worktree", () => {
    const h = workflowHarness();
    const otherDevice = h.store.upsertDevice("other", "hash-2", { clis: { claude: "2.1" }, endpoints: [] }, 5);
    const remoteReviewer = h.store.createAgent(
      { name: "remote-reviewer", deviceId: otherDevice.id, backend: "claude", workdir: "/other-repo" },
      6,
    );
    const issue = h.store.createConversation(
      { kind: "issue", title: "Review safely", agentId: h.builder.id, origin: "web" },
      7,
    );
    h.store.setConversationStatus(issue.id, "review", 8);
    h.store.setConversationWorktreePath(issue.id, "/repo/.harbor-worktrees/review-safely", 9);

    expect(() =>
      h.coordinator.enqueueRun(h.store.getConversation(issue.id)!, remoteReviewer, "Review", "review"),
    ).toThrow("没有挂载到 Agent 设备");
  });

  test("AI draft triage is read-only and never creates a worktree or advances Issue status", () => {
    const h = workflowHarness();
    const draft = h.store.createConversation(
      { kind: "issue_draft", description: "Turn this vague request into an issue", agentId: h.builder.id, origin: "web" },
      10,
    );
    h.setOnline(true);
    const run = h.coordinator.enqueueRun(draft, h.builder, "Triage only", "triage");
    const start = h.sent.find((message) => message.type === "run_start");
    expect(start).toEqual(expect.objectContaining({
      type: "run_start",
      runId: run.id,
      spec: expect.objectContaining({ permission: "readonly", isolation: "none", worktreePath: null }),
    }));
    expect(h.store.getConversation(draft.id)).toEqual(expect.objectContaining({ kind: "issue_draft", status: "open" }));

    h.coordinator.onRunDone({ runId: run.id, status: "succeeded", claudeSessionId: "triage-session", cost: null });
    expect(h.store.getConversation(draft.id)).toEqual(
      expect.objectContaining({ kind: "issue_draft", status: "open", claudeSessionId: "triage-session" }),
    );
  });

  test("a new implementation invalidates unmerged review and CI evidence", () => {
    const h = workflowHarness();
    const issue = h.store.createConversation(
      { kind: "issue", title: "Invalidate stale evidence", agentId: h.builder.id, origin: "web" },
      11,
    );
    h.store.setConversationStatus(issue.id, "review", 12);
    const deliveries = new DeliveryService(h.store);
    let delivery = deliveries.create(
      h.store.getConversation(issue.id)!,
      { changeUrl: "https://github.com/example/repo/pull/7", deploymentRequired: false },
      13,
    );
    delivery = deliveries.approve(delivery, h.store.getConversation(issue.id)!, 14);
    delivery = deliveries.update(delivery, { checkStatus: "passed" }, 15);
    expect(delivery.status).toBe("merge_ready");

    h.coordinator.enqueueRun(h.store.getConversation(issue.id)!, h.builder, "Address review feedback", "implementation");
    expect(h.store.getDelivery(delivery.id)).toEqual(
      expect.objectContaining({ reviewStatus: "pending", checkStatus: "pending", status: "review_pending" }),
    );
    expect(h.store.listDeliveryEvents(delivery.id).at(-1)?.kind).toBe("evidence_invalidated");
  });
});

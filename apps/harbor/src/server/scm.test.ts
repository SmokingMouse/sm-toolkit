import { describe, expect, test } from "bun:test";
import { openDb } from "./db.js";
import { HarborStore } from "./store.js";
import { DeliveryService, ManualDeliveryProvider } from "./delivery.js";
import { CodebaseDeliveryProvider, type CodebaseCommandRunner } from "./codebase.js";
import { RunBus } from "./bus.js";
import { RunCoordinator } from "./scheduler.js";
import { ScmService, normalizeCodebaseEvent } from "./scm.js";

const runner: CodebaseCommandRunner = {
  async run() { return { stdout: "{}", stderr: "", exitCode: 0 }; },
};

describe("SCM event projection", () => {
  test("an opened MR creates one Review Issue and one Codebase Delivery; replay is idempotent", () => {
    const store = new HarborStore(openDb(":memory:"));
    const repository = store.createRepository({
      workspaceId: "ws_personal",
      name: "harbor",
      scmProvider: "codebase",
      scmRepository: "team/harbor",
    }, 1);
    const deliveries = new DeliveryService(store, [new ManualDeliveryProvider(), new CodebaseDeliveryProvider(store, runner)]);
    const coordinator = new RunCoordinator(store, new RunBus(), { isOnline: () => false, send: () => false }, 2, deliveries);
    const scm = new ScmService(store, coordinator, deliveries, runner);
    const payload = {
      action: "open",
      object_kind: "merge_request",
      merge_request: {
        number: 18,
        title: "Fix stale projection",
        description: "Make webhook replay safe",
        status: "open",
        source_branch: "fix/projection",
        target_branch: "main",
        url: "https://code.byted.org/team/harbor/merge_requests/18",
      },
      user: { id: "u1", username: "alice" },
    };
    const first = scm.receiveCodebase(repository.id, { eventId: "evt-18", eventType: "merge_request", payload }, 2);
    const replay = scm.receiveCodebase(repository.id, { eventId: "evt-18", eventType: "merge_request", payload }, 3);

    expect(first.status).toBe("applied");
    expect(replay.status).toBe("duplicate");
    expect(store.listConversations({ workspaceId: "ws_personal", kind: "issue" })).toHaveLength(1);
    const conversation = store.getConversation(first.conversationId!)!;
    expect(conversation).toEqual(expect.objectContaining({ status: "review", origin: "codebase", repositoryId: repository.id }));
    expect(store.getDeliveryForConversation(conversation.id)).toEqual(expect.objectContaining({
      provider: "codebase",
      externalId: "18",
      headBranch: "fix/projection",
      baseBranch: "main",
    }));
    expect(store.getScmEvent("evt-18")?.outcome).toBe("applied");
  });

  test("an Issue comment mention dispatches only when repository auto-dispatch is explicitly enabled", () => {
    const store = new HarborStore(openDb(":memory:"));
    const device = store.upsertDevice("worker", "hash", { clis: { claude: "2" }, endpoints: [] }, 1);
    const repository = store.createRepository({
      workspaceId: "ws_personal",
      name: "harbor",
      scmProvider: "codebase",
      scmRepository: "team/harbor",
    }, 2);
    store.setRepositoryMount(repository.id, device.id, "/repo", 3);
    const agent = store.createAgent({
      name: "triager",
      deviceId: device.id,
      backend: "claude",
      repositoryId: repository.id,
    }, 4);
    store.updateRepository(repository.id, { scmAgentId: agent.id, scmAutoDispatch: true }, 5);
    const deliveries = new DeliveryService(store);
    const coordinator = new RunCoordinator(store, new RunBus(), { isOnline: () => false, send: () => false }, 2, deliveries);
    const scm = new ScmService(store, coordinator, deliveries, runner);
    const payload = {
      action: "commented",
      issue: { number: 9, title: "Why does this fail?", description: "Investigate", status: "open" },
      comment: { id: "comment-1", body: "@harbor please diagnose this" },
      user: { id: "u2", username: "bob" },
    };
    const result = scm.receiveCodebase(repository.id, { eventId: "evt-comment", eventType: "issue_comment", payload }, 6);
    expect(result.status).toBe("applied");
    expect(store.listConversationMessages(result.conversationId!)).toEqual([
      expect.objectContaining({ body: "@harbor please diagnose this", authorName: "bob" }),
    ]);
    expect(store.listRunsByConversation(result.conversationId!)).toEqual([
      expect.objectContaining({ status: "queued", prompt: "@harbor please diagnose this" }),
    ]);
  });

  test("normalizer recognizes review and CI facts without assuming one webhook casing", () => {
    expect(normalizeCodebaseEvent("review", {
      action: "approved",
      MergeRequest: { Number: 3, Title: "Review me", Status: "open" },
    })).toEqual(expect.objectContaining({ kind: "change", externalId: "3", reviewStatus: "approved" }));
    expect(normalizeCodebaseEvent("pipeline", {
      action: "completed",
      merge_request: { number: 3, title: "Review me", status: "open" },
      pipeline: { status: "failed" },
    })).toEqual(expect.objectContaining({ kind: "change", externalId: "3", checkStatus: "failed" }));
  });
});

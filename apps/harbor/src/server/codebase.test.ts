import { describe, expect, test } from "bun:test";
import { openDb } from "./db.js";
import { HarborStore } from "./store.js";
import { CodebaseDeliveryProvider, codebaseCheckStatus, type CodebaseCommandRunner } from "./codebase.js";
import { DeliveryService, ManualDeliveryProvider } from "./delivery.js";

class FakeRunner implements CodebaseCommandRunner {
  calls: string[][] = [];
  constructor(private readonly outputs: unknown[]) {}
  async run(args: string[]) {
    this.calls.push(args);
    return { stdout: JSON.stringify(this.outputs.shift() ?? {}), stderr: "", exitCode: 0 };
  }
}

describe("Codebase delivery provider", () => {
  test("refreshes review, CI and merge facts through explicit -N/-R arguments", async () => {
    const store = new HarborStore(openDb(":memory:"));
    const repository = store.createRepository({
      workspaceId: "ws_personal",
      name: "harbor",
      scmProvider: "codebase",
      scmRepository: "team/harbor",
    }, 1);
    const conversation = store.createConversation({
      kind: "issue",
      title: "External MR",
      repositoryId: repository.id,
      origin: "codebase",
    }, 2);
    store.setConversationStatus(conversation.id, "review", 3);
    const runner = new FakeRunner([
      { Number: 42, Status: "open", URL: "https://code.byted.org/team/harbor/merge_requests/42", SourceBranchName: "feat/x", TargetBranchName: "main" },
      { ReviewStatus: "approved", MeetReviewRules: true },
      { CheckRuns: [{ Status: "completed", Conclusion: "succeeded" }] },
    ]);
    const service = new DeliveryService(store, [new ManualDeliveryProvider(), new CodebaseDeliveryProvider(store, runner)]);
    const delivery = service.create(store.getConversation(conversation.id)!, {
      provider: "codebase",
      externalId: "42",
      changeUrl: "https://code.byted.org/team/harbor/merge_requests/42",
    }, 4);

    const refreshed = await service.refresh(delivery, 5);
    expect(refreshed).toEqual(expect.objectContaining({
      externalId: "42",
      headBranch: "feat/x",
      baseBranch: "main",
      reviewStatus: "approved",
      checkStatus: "passed",
      status: "merge_ready",
    }));
    expect(runner.calls).toEqual([
      ["mr", "view", "-N", "42", "-R", "team/harbor"],
      ["mr", "status", "-N", "42", "-R", "team/harbor"],
      ["mr", "checks", "list", "-N", "42", "-R", "team/harbor"],
    ]);
  });

  test("merge requires confirmation and is the only path that adds --yes", async () => {
    const store = new HarborStore(openDb(":memory:"));
    const repository = store.createRepository({
      workspaceId: "ws_personal",
      name: "harbor",
      scmProvider: "codebase",
      scmRepository: "team/harbor",
    }, 1);
    const conversation = store.createConversation({ kind: "issue", repositoryId: repository.id, origin: "codebase" }, 2);
    store.setConversationStatus(conversation.id, "review", 3);
    const runner = new FakeRunner([{}]);
    const service = new DeliveryService(store, [new CodebaseDeliveryProvider(store, runner)]);
    let delivery = service.create(store.getConversation(conversation.id)!, {
      provider: "codebase",
      externalId: "7",
      changeUrl: "https://code.byted.org/team/harbor/merge_requests/7",
    }, 4);
    delivery = service.applyProviderSnapshot(delivery, { reviewStatus: "approved", checkStatus: "passed" }, 5);
    await expect(service.merge(delivery, store.getConversation(conversation.id)!, {}, 6)).rejects.toThrow("明确同意");
    expect(runner.calls).toHaveLength(0);
    await service.merge(delivery, store.getConversation(conversation.id)!, { confirmed: true }, 7);
    expect(runner.calls[0]).toEqual(["mr", "merge", "-N", "7", "-R", "team/harbor", "--yes"]);
  });

  test("normalizes failed, pending and passed CI collections", () => {
    expect(codebaseCheckStatus({ CheckRuns: [{ Status: "completed", Conclusion: "failed" }] })).toBe("failed");
    expect(codebaseCheckStatus({ CheckRuns: [{ Status: "running", Conclusion: "" }] })).toBe("pending");
    expect(codebaseCheckStatus({ CheckRuns: [{ Status: "completed", Conclusion: "succeeded" }] })).toBe("passed");
    expect(codebaseCheckStatus({ CheckRuns: [] })).toBe("unknown");
  });
});

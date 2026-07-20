import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMsg } from "../protocol.js";
import { prepareRunExecution } from "../daemon/executor.js";
import { removeReviewCheckout } from "../daemon/worktree.js";
import { openDb } from "./db.js";
import { HarborStore } from "./store.js";
import { RunBus } from "./bus.js";
import { RunCoordinator, type DeviceTransport } from "./scheduler.js";

function git(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

function gitText(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

function createRepository(parent: string): string {
  const repository = join(parent, "repo");
  mkdirSync(repository);
  git(repository, ["init", "-b", "main"]);
  git(repository, ["config", "user.name", "Harbor Test"]);
  git(repository, ["config", "user.email", "harbor@example.test"]);
  writeFileSync(join(repository, "README.md"), "fixture\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["commit", "-m", "fixture"]);
  return repository;
}

function runStarts(messages: ServerMsg[]): Extract<ServerMsg, { type: "run_start" }>[] {
  return messages.filter((message): message is Extract<ServerMsg, { type: "run_start" }> => message.type === "run_start");
}

describe("scheduler → RunSpec → daemon worktree identity", () => {
  test("a user-selected Reviewer on another Device checks out the Provider-proven exact revision", () => {
    const root = mkdtempSync(join(tmpdir(), "harbor-cross-device-review-"));
    try {
      const source = createRepository(root);
      git(source, ["checkout", "-b", "feature"]);
      writeFileSync(join(source, "feature.txt"), "review this\n");
      git(source, ["add", "feature.txt"]);
      git(source, ["commit", "-m", "feature"]);
      const revision = gitText(source, ["rev-parse", "HEAD"]);
      const remote = join(root, "remote.git");
      git(root, ["init", "--bare", remote]);
      git(source, ["remote", "add", "origin", remote]);
      git(source, ["push", "origin", "main", "feature"]);
      const developerCheckout = join(root, "developer");
      const reviewerCheckout = join(root, "reviewer");
      git(root, ["clone", remote, developerCheckout]);
      git(root, ["clone", remote, reviewerCheckout]);

      const store = new HarborStore(openDb(":memory:"));
      const developerDevice = store.upsertDevice("developer-device", "hash-a", { clis: { codex: "1" }, endpoints: [] }, 1);
      const reviewerDevice = store.upsertDevice("reviewer-device", "hash-b", { clis: { codex: "1" }, endpoints: [] }, 2);
      const repository = store.createRepository({
        workspaceId: "ws_personal",
        name: "repo",
        remoteUrl: remote,
        defaultBranch: "main",
      }, 3);
      const developerMount = store.setRepositoryMount(repository.id, developerDevice.id, developerCheckout, 4);
      const reviewerMount = store.setRepositoryMount(repository.id, reviewerDevice.id, reviewerCheckout, 5);
      const developer = store.createAgent({ name: "developer", deviceId: developerDevice.id, backend: "codex", repositoryId: repository.id }, 6);
      const reviewer = store.createAgent({ name: "reviewer", deviceId: reviewerDevice.id, backend: "codex", repositoryId: repository.id, isolation: "worktree", permission: "auto-edit" }, 7);
      const issue = store.createConversation({ kind: "issue", title: "Cross-device review", agentId: developer.id, repositoryId: repository.id }, 8);
      store.setConversationStatus(issue.id, "review", 9);
      store.setConversationWorktreePath(issue.id, join(root, "developer-issue-worktree"), developerMount.id, 10);
      store.createDelivery({
        conversationId: issue.id,
        provider: "github",
        changeUrl: "https://github.example/acme/repo/pull/1",
        headBranch: "feature",
        baseBranch: "main",
        latestHeadSha: revision,
      }, 11);
      const sent: ServerMsg[] = [];
      const coordinator = new RunCoordinator(store, new RunBus(), {
        isOnline: (deviceId) => deviceId === reviewerDevice.id,
        send: (_deviceId, message) => { sent.push(message); return true; },
      }, 1);

      const review = coordinator.enqueueRun(store.getConversation(issue.id)!, reviewer, "Review exact head", "review");
      const spec = runStarts(sent)[0]!.spec;
      expect(spec).toEqual(expect.objectContaining({
        repositoryRoot: reviewerMount.path,
        executionRoot: reviewerMount.path,
        permission: "readonly",
        isolation: "none",
        worktreePath: null,
        reviewCheckout: {
          deliveryId: store.getDeliveryForConversation(issue.id)!.id,
          remoteUrl: remote,
          ref: "refs/heads/feature",
          revision,
        },
      }));
      const prepared = prepareRunExecution(spec, review.id);
      expect(gitText(prepared.executionRoot!, ["rev-parse", "HEAD"])).toBe(revision);
      expect(gitText(prepared.executionRoot!, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD");
      const cleanup = removeReviewCheckout(reviewerMount.path, prepared.executionRoot!);
      expect(cleanup.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("request changes and reviewer keep the mount root while reusing the existing worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "harbor-dispatch-worktree-"));
    try {
      const repositoryRoot = createRepository(root);
      const store = new HarborStore(openDb(":memory:"));
      const device = store.upsertDevice("worker", "hash", { clis: { codex: "0.144.2" }, endpoints: [] }, 1);
      const repository = store.createRepository({ workspaceId: "ws_personal", name: "repo" }, 2);
      const mount = store.setRepositoryMount(repository.id, device.id, repositoryRoot, 3);
      const builder = store.createAgent({
        name: "builder",
        deviceId: device.id,
        backend: "codex",
        repositoryId: repository.id,
        isolation: "worktree",
        permission: "auto-edit",
        sandboxNetworkAccess: true,
      }, 4);
      const reviewer = store.createAgent({
        name: "reviewer",
        deviceId: device.id,
        backend: "codex",
        repositoryId: repository.id,
        isolation: "worktree",
        permission: "readonly",
      }, 5);
      const issue = store.createConversation({
        kind: "issue",
        title: "Keep mount identity",
        description: "Implement and review in one worktree",
        agentId: builder.id,
        repositoryId: repository.id,
        origin: "web",
      }, 6);
      const sent: ServerMsg[] = [];
      const transport: DeviceTransport = {
        isOnline: () => true,
        send: (_deviceId, message) => {
          sent.push(message);
          return true;
        },
      };
      const coordinator = new RunCoordinator(store, new RunBus(), transport, 1);

      const first = coordinator.enqueueRun(issue, builder, "Implement", "implementation");
      const firstSpec = runStarts(sent)[0]!.spec;
      expect(firstSpec).toEqual(expect.objectContaining({
        repositoryRoot: mount.path,
        executionRoot: mount.path,
        worktreePath: null,
        sandboxNetworkAccess: true,
      }));
      const firstExecution = prepareRunExecution(firstSpec);
      expect(firstExecution.shouldReportWorktreeReady).toBe(true);
      expect(firstExecution.executionRoot).not.toBe(mount.path);

      coordinator.onWorktreeReady(first.id, issue.id, firstExecution.executionRoot!);
      coordinator.onRunDone({
        runId: first.id,
        status: "succeeded",
        claudeSessionId: "implementation-session-1",
        cost: null,
      });

      const changes = coordinator.enqueueRun(
        store.getConversation(issue.id)!,
        builder,
        "Address requested changes",
        "implementation",
      );
      const changesSpec = runStarts(sent)[1]!.spec;
      expect(changesSpec).toEqual(expect.objectContaining({
        repositoryRoot: mount.path,
        executionRoot: firstExecution.executionRoot,
        worktreePath: firstExecution.executionRoot,
        resume: "implementation-session-1",
      }));
      expect(prepareRunExecution(changesSpec)).toEqual({
        executionRoot: firstExecution.executionRoot,
        shouldReportWorktreeReady: false,
      });
      coordinator.onRunDone({
        runId: changes.id,
        status: "succeeded",
        claudeSessionId: "implementation-session-2",
        cost: null,
      });

      const review = coordinator.enqueueRun(store.getConversation(issue.id)!, reviewer, "Review", "review");
      const reviewSpec = runStarts(sent)[2]!.spec;
      expect(reviewSpec).toEqual(expect.objectContaining({
        repositoryRoot: mount.path,
        executionRoot: firstExecution.executionRoot,
        worktreePath: firstExecution.executionRoot,
        resume: null,
      }));
      expect(prepareRunExecution(reviewSpec)).toEqual({
        executionRoot: firstExecution.executionRoot,
        shouldReportWorktreeReady: false,
      });
      expect(store.getRun(review.id)?.repositoryMountId).toBe(mount.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

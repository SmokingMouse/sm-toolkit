import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMsg } from "../protocol.js";
import { prepareRunExecution } from "../daemon/executor.js";
import { openDb } from "./db.js";
import { HarborStore } from "./store.js";
import { RunBus } from "./bus.js";
import { RunCoordinator, type DeviceTransport } from "./scheduler.js";

function git(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
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

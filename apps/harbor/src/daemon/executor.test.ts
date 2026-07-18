import { describe, expect, test } from "bun:test";
import { EventType, type AgentEvent } from "@sm/agent";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunSpec } from "../protocol.js";
import { coalesceStreamingEvent, resolveRunAdditionalWritableDirs } from "./executor.js";
import { ensureWorktree } from "./worktree.js";

function event(type: AgentEvent["type"], text: string, sessionId = "session_1"): AgentEvent {
  return { type, backend: "claude", sessionId, data: { text } };
}

test("coalesces only adjacent text/thinking chunks from the same stream", () => {
  expect(coalesceStreamingEvent(event(EventType.Thinking, "think "), event(EventType.Thinking, "more"))).toEqual(
    event(EventType.Thinking, "think more"),
  );
  expect(coalesceStreamingEvent(event(EventType.TextChunk, "hello "), event(EventType.TextChunk, "world"))).toEqual(
    event(EventType.TextChunk, "hello world"),
  );
  expect(coalesceStreamingEvent(event(EventType.Thinking, "a"), event(EventType.TextChunk, "b"))).toBeNull();
  expect(coalesceStreamingEvent(event(EventType.Thinking, "a"), event(EventType.Thinking, "b", "session_2"))).toBeNull();
  expect(
    coalesceStreamingEvent(event(EventType.Thinking, "a"), {
      type: EventType.ToolCall,
      backend: "claude",
      sessionId: "session_1",
      data: { name: "Read" },
    }),
  ).toBeNull();
});

function git(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

function createRepository(parent: string, name: string): string {
  const repository = join(parent, name);
  mkdirSync(repository);
  git(repository, ["init", "-b", "main"]);
  git(repository, ["config", "user.name", "Harbor Test"]);
  git(repository, ["config", "user.email", "harbor@example.test"]);
  writeFileSync(join(repository, "README.md"), "fixture\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["commit", "-m", "fixture"]);
  return repository;
}

function runSpec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    backend: "codex",
    model: null,
    prompt: "implement",
    purpose: "implementation",
    repositoryRoot: null,
    executionRoot: null,
    permission: "auto-edit",
    systemPrompt: null,
    resume: null,
    conversationId: "c_executor",
    isolation: "worktree",
    worktreePath: null,
    ...overrides,
  };
}

describe("Codex worktree writable metadata gate", () => {
  test("grants only writable implementation runs and rejects a cross-Repository worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "harbor-executor-"));
    try {
      const repository = createRepository(root, "repo-a");
      const worktree = ensureWorktree(repository, "c_executor", null);
      const commonDir = realpathSync(join(repository, ".git"));
      const base = runSpec({ repositoryRoot: repository, worktreePath: worktree });

      expect(resolveRunAdditionalWritableDirs(base, worktree)).toEqual([commonDir]);
      expect(resolveRunAdditionalWritableDirs({ ...base, permission: "full" }, worktree)).toEqual([commonDir]);

      for (const restricted of [
        { ...base, permission: "readonly" as const },
        { ...base, permission: "default" as const },
        { ...base, purpose: "triage" as const },
        { ...base, purpose: "review" as const },
        { ...base, purpose: "verification" as const },
        { ...base, isolation: "none" as const },
        { ...base, backend: "claude" as const },
      ]) {
        expect(resolveRunAdditionalWritableDirs(restricted, worktree)).toEqual([]);
      }

      const otherRepository = createRepository(root, "repo-b");
      const otherWorktree = ensureWorktree(otherRepository, "c_other", null);
      expect(() => resolveRunAdditionalWritableDirs(base, otherWorktree)).toThrow("不属于声明的 Repository");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

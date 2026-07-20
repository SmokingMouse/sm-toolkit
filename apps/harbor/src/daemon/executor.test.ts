import { describe, expect, test } from "bun:test";
import { EventType, type AgentEvent } from "@sm/agent";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunSpec } from "../protocol.js";
import {
  coalesceStreamingEvent,
  agentActionTriggerEnvironment,
  materializeRunAttachments,
  readSelfDeployActionRequest,
  resolveRunAdditionalWritableDirs,
  runAgentSetup,
  submitSelfDeployAction,
} from "./executor.js";
import { ensureWorktree } from "./worktree.js";
import { assertAgentEnvironmentSafe } from "../agent-environment.js";

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

test("rejects Agent environment overrides that can change Runtime identity or Skill roots", () => {
  expect(() => assertAgentEnvironmentSafe({ HOME: "/tmp/other" })).toThrow("HOME");
  expect(() => assertAgentEnvironmentSafe({ codex_home: "/tmp/other" })).toThrow("codex_home");
  expect(() => assertAgentEnvironmentSafe({ PATH: "/tmp/bin" })).toThrow("PATH");
  expect(() => assertAgentEnvironmentSafe({ API_TOKEN: "allowed" })).not.toThrow();
});

describe("self-deploy action outbox", () => {
  test("accepts only the exact non-sensitive request shape", () => {
    const directory = mkdtempSync(join(tmpdir(), "harbor-action-outbox-"));
    const path = join(directory, "self-deploy.json");
    try {
      expect(readSelfDeployActionRequest(path)).toBeNull();
      writeFileSync(path, JSON.stringify({
        revision: "A".repeat(40),
        idempotencyKey: "deploy-event-1",
      }));
      expect(readSelfDeployActionRequest(path)).toEqual({
        revision: "a".repeat(40),
        idempotencyKey: "deploy-event-1",
      });
      writeFileSync(path, JSON.stringify({
        revision: "a".repeat(40),
        idempotencyKey: "deploy-event-1",
        target: "/tmp/injected",
      }));
      expect(() => readSelfDeployActionRequest(path)).toThrow("只允许");
      rmSync(path);
      symlinkSync(join(directory, "missing"), path);
      expect(() => readSelfDeployActionRequest(path)).toThrow("普通文件");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("submits outside the Agent sandbox with the short-lived token", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), init });
      return Response.json({ job: { id: "depjob_1" }, reused: false }, { status: 202 });
    }) as typeof fetch;
    const request = { revision: "b".repeat(40), idempotencyKey: "deploy-event-2" };
    await expect(submitSelfDeployAction(
      "http://127.0.0.1:17777/hooks/agent-actions/self-deployments",
      "short-lived-token",
      request,
      fakeFetch,
    )).resolves.toEqual({ jobId: "depjob_1", reused: false });
    const call = seen[0]!;
    expect(call.url).toEndWith("/hooks/agent-actions/self-deployments");
    expect((call.init?.headers as Record<string, string>).Authorization).toBe("Bearer short-lived-token");
    expect(JSON.parse(String(call.init?.body))).toEqual(request);
  });

  test("exposes only bounded non-sensitive trigger facts", () => {
    expect(agentActionTriggerEnvironment({
      eventType: "merge_request_merged",
      eventId: "evt_1",
      repositoryId: "repo_1",
      revision: "c".repeat(40),
    })).toEqual({
      HARBOR_AGENT_TRIGGER_EVENT_TYPE: "merge_request_merged",
      HARBOR_AGENT_TRIGGER_EVENT_ID: "evt_1",
      HARBOR_AGENT_TRIGGER_REPOSITORY_ID: "repo_1",
      HARBOR_AGENT_TRIGGER_REVISION: "c".repeat(40),
    });
    expect(() => agentActionTriggerEnvironment({ eventId: "x\0y" })).toThrow("无效");
  });
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

  test("Agent setup runs in the repository with configured env and fails loudly", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harbor-setup-"));
  try {
    await runAgentSetup(
      directory,
      'printf "%s" "$HARBOR_TEST_VALUE" > setup.out',
      null,
      { HARBOR_TEST_VALUE: "ready" },
      new AbortController().signal,
    );
    expect(readFileSync(join(directory, "setup.out"), "utf8")).toBe("ready");
    await expect(runAgentSetup(
      directory,
      "echo broken >&2; exit 7",
      null,
      {},
      new AbortController().signal,
    )).rejects.toThrow("broken");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  });

  test("Run attachments are materialized with safe unique names", () => {
  const result = materializeRunAttachments("r_test", [
    { name: "../screen.png", mime: "image/png", dataBase64: Buffer.from("one").toString("base64") },
    { name: "screen.png", mime: "image/png", dataBase64: Buffer.from("two").toString("base64") },
  ]);
  try {
    expect(result.directory).not.toBeNull();
    expect(result.paths).toHaveLength(2);
    expect(result.paths[0]!.path.startsWith(result.directory!)).toBe(true);
    expect(result.paths[1]!.path).not.toBe(result.paths[0]!.path);
    expect(readFileSync(result.paths[0]!.path, "utf8")).toBe("one");
    expect(readFileSync(result.paths[1]!.path, "utf8")).toBe("two");
  } finally {
    if (result.directory) rmSync(result.directory, { recursive: true, force: true });
  }
  });
});

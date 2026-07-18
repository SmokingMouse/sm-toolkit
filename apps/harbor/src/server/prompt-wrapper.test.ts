import { describe, expect, test } from "bun:test";
import type { Conversation, HarborAgent, PromptEventBlockKey, Run } from "../protocol.js";
import { openDb } from "./db.js";
import {
  getPromptBlockConfig,
  inferPromptEvent,
  listPromptBlockConfigs,
  renderRunPrompt,
  validatePromptTemplate,
} from "./prompt-wrapper.js";
import { HarborStore } from "./store.js";

function fixtures(
  origin: Conversation["origin"] = "web",
  kind: Conversation["kind"] = "issue",
  promptEvent: PromptEventBlockKey = "event.issue.assigned",
) {
  const conversation: Conversation = {
    id: "conversation_1",
    workspaceId: "ws_personal",
    kind,
    title: "Ship control plane",
    agentId: "agent_1",
    description: "Implement the control plane",
    priority: "medium",
    status: kind === "issue" ? "backlog" : "open",
    repositoryId: "repository_1",
    worktreePath: null,
    worktreeMountId: null,
    claudeSessionId: null,
    origin,
    originRef: origin === "automation" ? "automation_1" : null,
    createdAt: 1,
    updatedAt: 2,
  };
  const agent: HarborAgent = {
    id: "agent_1",
    workspaceId: "ws_personal",
    name: "builder",
    description: null,
    deviceId: "device_1",
    backend: "claude",
    model: "sonnet",
    permission: "auto-edit",
    repositoryId: "repository_1",
    isolation: "none",
    instruction: null,
    skillIds: [],
    createdAt: 1,
    archivedAt: null,
  };
  const run: Run = {
    id: "run_1",
    workspaceId: "ws_personal",
    conversationId: conversation.id,
    agentId: agent.id,
    deviceId: agent.deviceId,
    repositoryId: "repository_1",
    repositoryMountId: "mount_1",
    executionRoot: "/repo",
    prompt: "Implement the missing page",
    purpose: "implementation",
    promptEvent,
    triggerRef: null,
    status: "queued",
    claudeSessionId: null,
    error: null,
    cost: null,
    queuedAt: Date.UTC(2026, 6, 17, 7, 0, 0),
    startedAt: null,
    finishedAt: null,
  };
  return { conversation, agent, run };
}

describe("prompt blocks", () => {
  test("latest migration exposes eight Mew-style blocks and composes issue context + assignment", () => {
    const db = openDb(":memory:");
    const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
    expect(version).toBe(15);
    const store = new HarborStore(db);
    const input = fixtures();
    const rendered = renderRunPrompt(store, input);

    expect(listPromptBlockConfigs(store, "ws_personal")).toHaveLength(8);
    expect(rendered).toContain("Issue Reference");
    expect(rendered).toContain("Assignment");
    expect(rendered).toContain("Implement the missing page");
    expect(input.run.prompt).toBe("Implement the missing page");
    expect(getPromptBlockConfig(store, "ws_personal", "session.issue.context").isDefault).toBe(true);
  });

  test("infers event from source and conversation history", () => {
    expect(inferPromptEvent(fixtures("web", "issue").conversation, false)).toBe("event.issue.assigned");
    expect(inferPromptEvent(fixtures("feishu", "issue").conversation, false)).toBe("event.issue.mentioned");
    expect(inferPromptEvent(fixtures("web", "issue").conversation, true)).toBe("event.issue.message_created");
    expect(inferPromptEvent(fixtures("web", "chat", "event.chat.message_created").conversation, false)).toBe(
      "event.chat.message_created",
    );
    expect(inferPromptEvent(fixtures("automation", "issue").conversation, false)).toBe(
      "event.automation.schedule",
    );
  });

  test("custom blocks apply immediately and disabled event safely falls back to raw request", () => {
    const store = new HarborStore(openDb(":memory:"));
    const input = fixtures();
    store.setPromptBlock("ws_personal", "session.issue.context", true, "Context={{conversation.id}}", 10);
    store.setPromptBlock("ws_personal", "event.issue.assigned", true, "Agent={{agent.name}}\n{{prompt}}", 11);
    expect(renderRunPrompt(store, input)).toBe(
      "Context=conversation_1\n\n---\n\nAgent=builder\nImplement the missing page",
    );

    store.setPromptBlock("ws_personal", "event.issue.assigned", false, "Request={{prompt}}", 12);
    expect(renderRunPrompt(store, input)).toBe(
      "Context=conversation_1\n\n---\n\nImplement the missing page",
    );
  });

  test("validates event request retention while context can omit request", () => {
    expect(validatePromptTemplate("session.issue.context", "Issue={{conversation.id}}")).toBeNull();
    expect(validatePromptTemplate("event.issue.assigned", "hello")).toContain("当前请求");
    expect(validatePromptTemplate("event.issue.assigned", "{{unknown}} {{prompt}}")).toContain("未知变量");
    expect(validatePromptTemplate("event.issue.assigned", "Request: {{ latest_message.content }}")).toBeNull();
  });
});

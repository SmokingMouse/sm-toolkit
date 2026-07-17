import { describe, expect, test } from "bun:test";
import { openDb } from "./db.js";
import { HarborStore } from "./store.js";
import type { Conversation, HarborAgent, Run } from "../protocol.js";
import {
  getPromptWrapperConfig,
  promptSourceForConversation,
  renderRunPrompt,
  validatePromptTemplate,
} from "./prompt-wrapper.js";

function fixtures(origin: Conversation["origin"] = "web", kind: Conversation["kind"] = "issue") {
  const conversation: Conversation = {
    id: "conversation_1",
    kind,
    title: "Ship control plane",
    agentId: "agent_1",
    description: "Implement the control plane",
    priority: "medium",
    status: kind === "issue" ? "backlog" : "open",
    worktreePath: null,
    claudeSessionId: null,
    origin,
    originRef: origin === "automation" ? "automation_1" : null,
    createdAt: 1,
    updatedAt: 1,
  };
  const agent: HarborAgent = {
    id: "agent_1",
    name: "builder",
    description: null,
    deviceId: "device_1",
    backend: "claude",
    model: "sonnet",
    permission: "auto-edit",
    workdir: "/repo",
    isolation: "none",
    instruction: null,
    skillIds: [],
    createdAt: 1,
    archivedAt: null,
  };
  const run: Run = {
    id: "run_1",
    conversationId: conversation.id,
    agentId: agent.id,
    deviceId: agent.deviceId,
    prompt: "Implement the missing page",
    purpose: "implementation",
    status: "queued",
    claudeSessionId: null,
    error: null,
    cost: null,
    queuedAt: 1,
    startedAt: null,
    finishedAt: null,
  };
  return { conversation, agent, run };
}

describe("prompt wrapper", () => {
  test("latest migration and defaults render without mutating raw prompt", () => {
    const db = openDb(":memory:");
    const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
    expect(version).toBe(8);
    const store = new HarborStore(db);
    const input = fixtures();
    const rendered = renderRunPrompt(store, input);
    expect(rendered).toContain("Harbor Issue Context");
    expect(rendered).toContain("Implement the missing page");
    expect(rendered).toContain("Run purpose: implementation");
    expect(input.run.prompt).toBe("Implement the missing page");
    expect(getPromptWrapperConfig(store, "issue").isDefault).toBe(true);
  });

  test("automation source wins over issue kind", () => {
    expect(promptSourceForConversation(fixtures("automation", "issue").conversation)).toBe("automation");
    expect(promptSourceForConversation(fixtures("web", "chat").conversation)).toBe("chat");
  });

  test("custom template applies immediately and disabled returns raw prompt", () => {
    const store = new HarborStore(openDb(":memory:"));
    const input = fixtures();
    store.setPromptTemplate("issue", true, "Agent={{agent.name}}\n{{prompt}}", 10);
    expect(renderRunPrompt(store, input)).toBe("Agent=builder\nImplement the missing page");
    store.setPromptTemplate("issue", false, "{{prompt}}", 11);
    expect(renderRunPrompt(store, input)).toBe(input.run.prompt);
  });

  test("rejects missing prompt and unknown variables", () => {
    expect(validatePromptTemplate("hello")).toContain("{{prompt}}");
    expect(validatePromptTemplate("{{unknown}} {{prompt}}")).toContain("未知变量");
    expect(validatePromptTemplate("{{agent-name}} {{prompt}}")).toContain("未知变量");
    expect(validatePromptTemplate("Request: {{ prompt }}")).toBeNull();
  });
});

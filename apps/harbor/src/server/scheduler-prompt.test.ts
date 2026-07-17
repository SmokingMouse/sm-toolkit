import { expect, test } from "bun:test";
import { openDb } from "./db.js";
import { HarborStore } from "./store.js";
import { RunBus } from "./bus.js";
import { RunCoordinator, type DeviceTransport } from "./scheduler.js";
import type { ServerMsg } from "../protocol.js";

test("scheduler dispatches wrapped prompt while persisting the raw request", () => {
  const store = new HarborStore(openDb(":memory:"));
  const device = store.upsertDevice("worker", "hash", { clis: { claude: "2.1" }, endpoints: [] }, 1);
  const agent = store.createAgent(
    { name: "builder", deviceId: device.id, backend: "claude", workdir: "/repo", instruction: "Own the outcome." },
    2,
  );
  const skill = store.createSkill({
    name: "review-first",
    description: "Check existing behavior before editing",
    source: "manual",
    instruction: "Inspect the current implementation and tests before making changes.",
  }, 2);
  store.setAgentSkills(agent.id, [skill.id], 2);
  const conversation = store.createConversation(
    { kind: "issue", title: "Prompt boundary", agentId: agent.id, origin: "web" },
    3,
  );
  store.setPromptTemplate("issue", true, "Context={{conversation.id}}\nRequest={{prompt}}", 4);

  const sent: ServerMsg[] = [];
  const transport: DeviceTransport = {
    isOnline: () => true,
    send: (_deviceId, message) => {
      sent.push(message);
      return true;
    },
  };
  const coordinator = new RunCoordinator(store, new RunBus(), transport, 1);
  const run = coordinator.enqueueRun(conversation, agent, "raw user request");

  expect(store.getRun(run.id)?.prompt).toBe("raw user request");
  const start = sent.find((message) => message.type === "run_start");
  expect(start?.type).toBe("run_start");
  if (start?.type === "run_start") {
    expect(start.spec.prompt).toBe(`Context=${conversation.id}\nRequest=raw user request`);
    expect(start.spec.systemPrompt).toContain("Own the outcome.");
    expect(start.spec.systemPrompt).toContain("## Skill: review-first");
    expect(start.spec.systemPrompt).toContain("Inspect the current implementation");
  }
});

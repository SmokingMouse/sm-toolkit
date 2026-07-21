import { expect, test } from "bun:test";
import { openDb } from "./db.js";
import { HarborStore } from "./store.js";

test("Run freezes the caller principal and every child inherits it", () => {
  const db = openDb(":memory:");
  try {
    const store = new HarborStore(db);
    const workspace = store.defaultWorkspace();
    const member = store.membershipForAccount("acc_bootstrap", workspace.id)!;
    const device = store.upsertDevice("worker", "hash", { clis: { codex: "1" }, endpoints: [] }, 1);
    const agent = store.createAgent({ name: "shared", deviceId: device.id, backend: "codex", workdir: "/repo" }, 2);
    const conversation = store.createConversation({
      workspaceId: workspace.id,
      kind: "issue",
      title: "work",
      agentId: agent.id,
      repositoryId: agent.repositoryId,
    }, 3);
    const root = store.createRun({
      workspaceId: workspace.id,
      conversationId: conversation.id,
      agentId: agent.id,
      deviceId: device.id,
      repositoryId: agent.repositoryId,
      prompt: "root",
      promptEvent: "event.issue.assigned",
      principal: {
        type: "account",
        id: "acc_bootstrap",
        membershipId: member.id,
        initiator: { kind: "session" },
      },
    }, 4);
    const child = store.createRun({
      workspaceId: workspace.id,
      conversationId: conversation.id,
      agentId: agent.id,
      deviceId: device.id,
      repositoryId: agent.repositoryId,
      prompt: "child",
      promptEvent: "event.issue.message_created",
      parentRunId: root.id,
    }, 5);
    expect(root.principal).toEqual({
      type: "account",
      id: "acc_bootstrap",
      membershipId: member.id,
      initiator: { kind: "session" },
    });
    expect(child.principal).toEqual(root.principal);
  } finally {
    db.close();
  }
});

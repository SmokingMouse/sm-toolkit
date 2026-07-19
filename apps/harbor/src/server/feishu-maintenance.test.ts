import { expect, test } from "bun:test";
import type { IncomingAction, IncomingMessage } from "@sm/agent";
import type { Approval, Conversation, Run } from "../protocol.js";
import { FeishuEntry, type FeishuPort } from "./feishu.js";
import type { ApprovalService } from "./approvals.js";
import type { RunCoordinator } from "./scheduler.js";
import type { HarborStore } from "./store.js";

test("maintenance blocks run completion and approval card outbound send/update", async () => {
  const calls: string[] = [];
  const port = {
    connect: async () => {},
    onMessage: (_handler: (message: IncomingMessage) => void) => {},
    onAction: (_handler: (action: IncomingAction) => void) => {},
    send: async () => { calls.push("send"); return "message"; },
    reply: async () => { calls.push("reply"); return "message"; },
    update: async () => { calls.push("update"); },
    sendToChat: async () => { calls.push("sendToChat"); return "message"; },
  } as unknown as FeishuPort;
  const entry = new FeishuEntry(
    {} as HarborStore,
    {} as RunCoordinator,
    {} as ApprovalService,
    { appId: "app", appSecret: "secret", adminUserId: "admin", botName: "Harbor", allowedChats: ["chat"] },
    port,
    { botMode: "global" },
    () => true,
  );
  const run = { id: "run", status: "failed", error: "failed" } as Run;
  const conversation = { id: "conversation", kind: "issue", origin: "feishu", originRef: "chat|root" } as Conversation;
  const approval = { id: "approval", runId: "run", status: "pending" } as Approval;

  entry.notifyRunDone(run, conversation);
  entry.onApprovalCreated(approval, run, conversation);
  entry.onApprovalDecided({ ...approval, status: "allowed" });
  await Bun.sleep(10);
  expect(calls).toEqual([]);
});

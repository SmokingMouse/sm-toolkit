import { expect, test } from "bun:test";
import type { Content, IncomingAction, IncomingMessage } from "@sm/agent";
import { openDb } from "./db.js";
import { HarborStore } from "./store.js";
import { RunBus } from "./bus.js";
import { RunCoordinator } from "./scheduler.js";
import { FeishuEntry, type FeishuPort } from "./feishu.js";
import type { ApprovalService } from "./approvals.js";

class FakeLark implements FeishuPort {
  readonly source = "feishu";
  replies: { id: string; content: Content }[] = [];
  sends: { id: string; content: Content }[] = [];
  async connect() {}
  async close() {}
  onMessage(_handler: (msg: IncomingMessage) => Promise<void>) {}
  onAction(_handler: (action: IncomingAction) => void | Promise<void>) {}
  async reply(id: string, content: Content) {
    this.replies.push({ id, content });
    return `reply-${this.replies.length}`;
  }
  async update() {}
  async send() {
    return null;
  }
  async sendToChat(id: string, content: Content) {
    this.sends.push({ id, content });
    return `send-${this.sends.length}`;
  }
  async downloadResource(
    _messageId: string,
    resource: NonNullable<IncomingMessage["resources"]>[number],
  ) {
    return {
      name: resource.fileName ?? "attachment",
      mime: "text/plain",
      dataBase64: Buffer.from("CI failed").toString("base64"),
    };
  }
}

test("Lark binding maps group threads to Chats and enforces per-group listen/response modes", async () => {
  const store = new HarborStore(openDb(":memory:"));
  const device = store.upsertDevice(
    "worker",
    "hash",
    { clis: { claude: "2" }, endpoints: [] },
    1,
  );
  const repository = store.createRepository(
    { workspaceId: "ws_personal", name: "app" },
    2,
  );
  store.setRepositoryMount(repository.id, device.id, "/repo", 3);
  const agent = store.createAgent(
    {
      name: "helper",
      deviceId: device.id,
      backend: "claude",
      repositoryId: repository.id,
    },
    4,
  );
  const coordinator = new RunCoordinator(
    store,
    new RunBus(),
    { isOnline: () => false, send: () => false },
    2,
  );
  const channel = new FakeLark();
  const entry = new FeishuEntry(
    store,
    coordinator,
    {} as ApprovalService,
    {
      appId: "id",
      appSecret: "secret",
      adminUserId: "admin",
      botName: "Harbor",
      allowedChats: [],
    },
    channel,
  );
  store.upsertLarkWorkspaceBinding(
    {
      workspaceId: "ws_personal",
      chatId: "group-1",
      defaultAgentId: agent.id,
      listenMode: "mention",
      responseMode: "message",
    },
    5,
  );

  await entry.handleMessage({
    id: "plain",
    threadId: "group-1",
    chatId: "group-1",
    senderId: "member",
    text: "ignore this",
    chatType: "group",
    mentionedBot: false,
  });
  expect(store.listConversations({ workspaceId: "ws_personal" })).toHaveLength(
    0,
  );

  await entry.handleMessage({
    id: "question",
    threadId: "group-1",
    chatId: "group-1",
    senderId: "member",
    senderName: "Alice",
    text: "why is CI failing?",
    chatType: "group",
    mentionedBot: true,
    resources: [{ type: "file", fileKey: "file-1", fileName: "ci.log" }],
  });
  const conversation = store.listConversations({
    workspaceId: "ws_personal",
  })[0]!;
  expect(conversation).toEqual(
    expect.objectContaining({
      kind: "chat",
      origin: "feishu",
      agentId: agent.id,
    }),
  );
  expect(store.listConversationMessages(conversation.id)[0]?.body).toContain(
    "ci.log",
  );
  expect(store.listRunsByConversation(conversation.id)).toEqual([
    expect.objectContaining({ status: "queued" }),
  ]);
  expect(
    store.listRunAttachments(
      store.listRunsByConversation(conversation.id)[0]!.id,
    ),
  ).toEqual([
    {
      name: "ci.log",
      mime: "text/plain",
      dataBase64: Buffer.from("CI failed").toString("base64"),
    },
  ]);
  expect(channel.replies).toHaveLength(0);
  expect(channel.sends).toHaveLength(1);
  expect(store.getConversationForLarkMessage("send-1")?.id).toBe(
    conversation.id,
  );

  store.upsertLarkWorkspaceBinding(
    {
      workspaceId: "ws_personal",
      chatId: "group-custom",
      defaultAgentId: agent.id,
      listenMode: "mention",
      responseMode: "thread",
      botMode: "custom",
    },
    6,
  );
  const customMessage: IncomingMessage = {
    id: "custom-question",
    threadId: "custom-question",
    chatId: "group-custom",
    senderId: "member",
    senderName: "Bob",
    text: "handle this once",
    chatType: "group",
    mentionedBot: true,
  };
  await entry.handleMessage(customMessage);
  expect(store.listConversations({ workspaceId: "ws_personal" })).toHaveLength(
    1,
  );

  const customChannel = new FakeLark();
  const customEntry = new FeishuEntry(
    store,
    coordinator,
    {} as ApprovalService,
    {
      appId: "custom-id",
      appSecret: "custom-secret",
      adminUserId: "admin",
      botName: "Custom Harbor",
      allowedChats: [],
    },
    customChannel,
    { botMode: "custom", workspaceId: "ws_personal" },
  );
  await customEntry.handleMessage(customMessage);
  expect(store.listConversations({ workspaceId: "ws_personal" })).toHaveLength(
    2,
  );
  expect(customChannel.replies).toHaveLength(1);

  await entry.handleMessage({
    id: "dm",
    threadId: "dm-chat",
    chatId: "dm-chat",
    senderId: "admin",
    text: "run something",
    chatType: "dm",
  });
  expect(store.listConversations({ workspaceId: "ws_personal" })).toHaveLength(
    2,
  );
});

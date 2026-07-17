import { describe, expect, test } from "bun:test";
import type { ServerMsg } from "../protocol.js";
import type { ApprovalService } from "./approvals.js";
import { AutomationService } from "./automation.js";
import { RunBus } from "./bus.js";
import { openDb } from "./db.js";
import { buildRest } from "./rest.js";
import { RunCoordinator, type DeviceTransport } from "./scheduler.js";
import { HarborStore } from "./store.js";
import type { DeviceHub } from "./ws.js";

function restHarness() {
  const store = new HarborStore(openDb(":memory:"));
  const hub = {
    onlineIds: () => new Set<string>(),
    isOnline: () => false,
  } as unknown as DeviceHub;
  const app = buildRest(
    store,
    new RunBus(),
    hub,
    {} as RunCoordinator,
    {} as ApprovalService,
    {} as AutomationService,
    "test-token",
  );
  const request = (path: string, init?: RequestInit, workspace?: string) =>
    app.request(path, {
      ...init,
      headers: {
        Authorization: "Bearer test-token",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(workspace ? { "X-Harbor-Workspace": workspace } : {}),
        ...init?.headers,
      },
    });
  return { store, request };
}

describe("Workspace REST scope", () => {
  test("allows the same names while isolating repositories, agents, skills, and conversations", async () => {
    const { store, request } = restHarness();
    const device = store.upsertDevice("worker", "hash", { clis: { claude: "2.1" }, endpoints: [] }, 1);
    const workspaceResponse = await request("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "Product", slug: "product" }),
    });
    expect(workspaceResponse.status).toBe(201);
    const product = (await workspaceResponse.json()) as { id: string };

    const setup = async (workspace: string | undefined, path: string) => {
      const repositoryResponse = await request("/api/repositories", {
        method: "POST",
        body: JSON.stringify({ name: "app", device: device.id, path }),
      }, workspace);
      expect(repositoryResponse.status).toBe(201);
      const repository = (await repositoryResponse.json()) as { id: string };

      const agentResponse = await request("/api/agents", {
        method: "POST",
        body: JSON.stringify({ name: "builder", device: device.id, backend: "claude", repository: repository.id }),
      }, workspace);
      expect(agentResponse.status).toBe(201);
      const agent = (await agentResponse.json()) as { id: string; workspaceId: string };

      const skillResponse = await request("/api/skills", {
        method: "POST",
        body: JSON.stringify({ name: "review", instruction: "Inspect the diff." }),
      }, workspace);
      expect(skillResponse.status).toBe(201);

      const conversationResponse = await request("/api/conversations", {
        method: "POST",
        body: JSON.stringify({ kind: "issue", agent: agent.id, title: "Scoped issue" }),
      }, workspace);
      expect(conversationResponse.status).toBe(201);
      const conversation = (await conversationResponse.json()) as { id: string; repositoryId: string };
      expect(conversation.repositoryId).toBe(repository.id);
      return { agent, conversation };
    };

    const personal = await setup(undefined, "/personal/app");
    const scoped = await setup(product.id, "/product/app");

    const personalAgents = (await (await request("/api/agents")).json()) as { id: string; workspaceId: string }[];
    const productAgents = (await (await request("/api/agents", undefined, product.id)).json()) as { id: string; workspaceId: string }[];
    expect(personalAgents.map((agent) => agent.id)).toEqual([personal.agent.id]);
    expect(productAgents.map((agent) => agent.id)).toEqual([scoped.agent.id]);
    expect(personalAgents[0]?.workspaceId).toBe("ws_personal");
    expect(productAgents[0]?.workspaceId).toBe(product.id);

    expect(((await (await request("/api/repositories")).json()) as { name: string }[]).map((item) => item.name)).toEqual(["app"]);
    expect(((await (await request("/api/skills", undefined, product.id)).json()) as { name: string }[]).map((item) => item.name)).toEqual(["review"]);

    const hidden = await request(`/api/conversations/${personal.conversation.id}`, undefined, product.id);
    expect(hidden.status).toBe(404);
  });

  test("uses Agent as the only Repository configuration source", async () => {
    const { store, request } = restHarness();
    const device = store.upsertDevice("worker", "hash", { clis: { claude: "2.1" }, endpoints: [] }, 1);

    const missingRepository = await request("/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "unbound", device: device.id, backend: "claude" }),
    });
    expect(missingRepository.status).toBe(400);

    const createRepository = async (name: string, path: string) => {
      const response = await request("/api/repositories", {
        method: "POST",
        body: JSON.stringify({ name, device: device.id, path }),
      });
      expect(response.status).toBe(201);
      return (await response.json()) as { id: string };
    };
    const primary = await createRepository("primary", "/code/primary");
    const unrelated = await createRepository("unrelated", "/code/unrelated");
    const agentResponse = await request("/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "builder", device: device.id, backend: "claude", repository: primary.id }),
    });
    expect(agentResponse.status).toBe(201);
    const agent = (await agentResponse.json()) as { id: string };

    const override = await request("/api/conversations", {
      method: "POST",
      body: JSON.stringify({ kind: "issue", agent: agent.id, repository: unrelated.id, title: "Wrong target" }),
    });
    expect(override.status).toBe(400);

    const conversationResponse = await request("/api/conversations", {
      method: "POST",
      body: JSON.stringify({ kind: "issue", agent: agent.id, title: "Inherited target" }),
    });
    expect(conversationResponse.status).toBe(201);
    const conversation = (await conversationResponse.json()) as { id: string; repositoryId: string };
    expect(conversation.repositoryId).toBe(primary.id);

    const patchOverride = await request(`/api/conversations/${conversation.id}`, {
      method: "PATCH",
      body: JSON.stringify({ repository: unrelated.id }),
    });
    expect(patchOverride.status).toBe(400);
  });
});

describe("Repository mount execution snapshots", () => {
  test("binds a Run and worktree to one Repository mount", () => {
    const store = new HarborStore(openDb(":memory:"));
    const workspace = store.createWorkspace({ name: "Product", slug: "product" }, 1);
    const deviceA = store.upsertDevice("machine-a", "hash", { clis: { claude: "2.1" }, endpoints: [] }, 2);
    const deviceB = store.upsertDevice("machine-b", "hash", { clis: { claude: "2.1" }, endpoints: [] }, 2);
    const repository = store.createRepository({ workspaceId: workspace.id, name: "app" }, 3);
    const mount = store.setRepositoryMount(repository.id, deviceA.id, "/machine-a/app", 4);
    const agent = store.createAgent({
      workspaceId: workspace.id,
      name: "builder",
      deviceId: deviceA.id,
      backend: "claude",
      repositoryId: repository.id,
      isolation: "worktree",
    }, 5);
    const conversation = store.createConversation({
      workspaceId: workspace.id,
      kind: "issue",
      agentId: agent.id,
      repositoryId: repository.id,
      title: "Mount snapshot",
    }, 6);
    const sent: ServerMsg[] = [];
    const transport: DeviceTransport = {
      isOnline: () => false,
      send: (_deviceId, message) => { sent.push(message); return true; },
    };
    const coordinator = new RunCoordinator(store, new RunBus(), transport, 1);

    const first = coordinator.enqueueRun(conversation, agent, "implement");
    expect(first).toEqual(expect.objectContaining({
      workspaceId: workspace.id,
      repositoryId: repository.id,
      repositoryMountId: mount.id,
      executionRoot: "/machine-a/app",
    }));

    coordinator.onWorktreeReady(first.id, conversation.id, "/machine-a/app/.harbor-worktrees/issue");
    expect(store.getConversation(conversation.id)).toEqual(expect.objectContaining({
      worktreePath: "/machine-a/app/.harbor-worktrees/issue",
      worktreeMountId: mount.id,
    }));
    expect(store.getRun(first.id)?.executionRoot).toBe("/machine-a/app/.harbor-worktrees/issue");

    coordinator.cancelRun(first.id);
    const second = coordinator.enqueueRun(store.getConversation(conversation.id)!, agent, "continue");
    expect(second.executionRoot).toBe("/machine-a/app/.harbor-worktrees/issue");
    expect(store.repositoryMountUsage(mount.id)).toEqual({ runs: 2, activeRuns: 1, worktrees: 1, agents: 1, conversations: 1 });

    const agentWithoutMount = store.createAgent({
      workspaceId: workspace.id,
      name: "remote-builder",
      deviceId: deviceB.id,
      backend: "claude",
      repositoryId: repository.id,
    }, 7);
    const remoteConversation = store.createConversation({
      workspaceId: workspace.id,
      kind: "chat",
      agentId: agentWithoutMount.id,
      repositoryId: repository.id,
    }, 8);
    expect(() => coordinator.enqueueRun(remoteConversation, agentWithoutMount, "inspect")).toThrow("没有挂载到 Agent 设备");

    const personalRepository = store.createRepository({ workspaceId: "ws_personal", name: "personal-app" }, 9);
    store.setRepositoryMount(personalRepository.id, deviceA.id, "/personal/app", 9);
    const personalAgent = store.createAgent({ name: "personal", deviceId: deviceA.id, backend: "claude", repositoryId: personalRepository.id }, 9);
    expect(() => coordinator.enqueueRun(remoteConversation, personalAgent, "cross scope")).toThrow("不属于当前 Workspace");
    expect(sent).toHaveLength(0);
  });

  test("new-issue Automation follows the Agent current Repository", () => {
    const store = new HarborStore(openDb(":memory:"));
    const device = store.upsertDevice("worker", "hash", { clis: { claude: "2.1" }, endpoints: [] }, 1);
    const firstRepository = store.createRepository({ workspaceId: "ws_personal", name: "first" }, 2);
    store.setRepositoryMount(firstRepository.id, device.id, "/code/first", 2);
    const nextRepository = store.createRepository({ workspaceId: "ws_personal", name: "next" }, 3);
    store.setRepositoryMount(nextRepository.id, device.id, "/code/next", 3);
    const agent = store.createAgent({
      name: "builder",
      deviceId: device.id,
      backend: "claude",
      repositoryId: firstRepository.id,
    }, 4);
    const automation = store.createAutomation({
      name: "nightly",
      agentId: agent.id,
      repositoryId: firstRepository.id,
      cron: "0 0 * * *",
      prompt: "Run checks",
      mode: "new_issue",
    }, 5);
    store.setAgentRepository(agent.id, nextRepository.id);
    const coordinator = new RunCoordinator(store, new RunBus(), { isOnline: () => false, send: () => true }, 1);
    const service = new AutomationService(store, coordinator);

    (service as unknown as { fire: (id: string) => void }).fire(automation.id);

    const conversation = store.listConversations({ workspaceId: "ws_personal" }).find((item) => item.originRef === automation.id);
    expect(conversation?.repositoryId).toBe(nextRepository.id);
    expect(conversation && store.latestRunForConversation(conversation.id)).toEqual(expect.objectContaining({
      repositoryId: nextRepository.id,
      executionRoot: "/code/next",
    }));
  });
});

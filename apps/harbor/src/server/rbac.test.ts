import { expect, test } from "bun:test";
import type { WorkspaceMember } from "../protocol.js";
import { openDb } from "./db.js";
import { HarborStore } from "./store.js";
import { buildRest } from "./rest.js";
import { RunBus } from "./bus.js";
import { RunCoordinator } from "./scheduler.js";
import type { DeviceHub } from "./ws.js";
import type { ApprovalService } from "./approvals.js";
import type { AutomationService } from "./automation.js";

test("workspace member tokens enforce RBAC, private visibility, and env redaction", async () => {
  const store = new HarborStore(openDb(":memory:"));
  const device = store.upsertDevice("worker", "hash", { clis: { claude: "2" }, endpoints: [] }, 1);
  const repository = store.createRepository({ workspaceId: "ws_personal", name: "app" }, 2);
  store.setRepositoryMount(repository.id, device.id, "/repo", 3);
  const coordinator = new RunCoordinator(
    store,
    new RunBus(),
    { isOnline: () => false, send: () => false },
    2,
  );
  const app = buildRest(
    store,
    new RunBus(),
    { onlineIds: () => new Set<string>(), isOnline: () => false } as unknown as DeviceHub,
    coordinator,
    {} as ApprovalService,
    {} as AutomationService,
    "owner-token",
  );
  const request = (token: string, method: string, path: string, body?: unknown) => app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Harbor-Workspace": "ws_personal",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const memberResponse = await request("owner-token", "POST", "/api/members", { name: "Alice", role: "member" });
  expect(memberResponse.status).toBe(201);
  const member = await memberResponse.json() as WorkspaceMember;
  const tokenResponse = await request("owner-token", "POST", `/api/members/${member.id}/tokens`, { label: "Alice laptop" });
  const memberToken = (await tokenResponse.json() as { token: string }).token;

  expect((await request(memberToken, "GET", "/api/workspaces")).status).toBe(200);
  const denied = await request(memberToken, "POST", "/api/agents", {
    name: "denied",
    device: device.id,
    repository: repository.id,
  });
  expect(denied.status).toBe(403);

  await request("owner-token", "PATCH", `/api/members/${member.id}`, { role: "admin" });
  const unsafeEnvironment = await request(memberToken, "POST", "/api/agents", {
    name: "unsafe-builder",
    device: device.id,
    repository: repository.id,
    environment: { CODEX_HOME: "/tmp/other-codex-home" },
  });
  expect(unsafeEnvironment.status).toBe(400);
  expect(await unsafeEnvironment.text()).toContain("Runtime 保留变量");

  const created = await request(memberToken, "POST", "/api/agents", {
    name: "private-builder",
    device: device.id,
    repository: repository.id,
    visibility: "private",
    environment: { SECRET_TOKEN: "must-not-leak" },
  });
  expect(created.status).toBe(201);
  expect((await created.json() as { environment: Record<string, string> }).environment).toEqual({ SECRET_TOKEN: "••••••" });

  const bob = await (await request("owner-token", "POST", "/api/members", { name: "Bob", role: "member" })).json() as WorkspaceMember;
  const bobToken = (await (await request("owner-token", "POST", `/api/members/${bob.id}/tokens`, {})).json() as { token: string }).token;
  const bobAgents = await (await request(bobToken, "GET", "/api/agents")).json() as unknown[];
  expect(bobAgents).toHaveLength(0);
  const adminAgents = await (await request(memberToken, "GET", "/api/agents")).json() as { environment: Record<string, string> }[];
  expect(adminAgents).toHaveLength(1);
  expect(JSON.stringify(adminAgents)).not.toContain("must-not-leak");

  const owner = store.listWorkspaceMembers("ws_personal").find((candidate) => candidate.role === "owner")!;
  const lastOwner = await request("owner-token", "PATCH", `/api/members/${owner.id}`, { role: "admin" });
  expect(lastOwner.status).toBe(400);
});

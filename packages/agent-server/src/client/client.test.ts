import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentClient } from "./client.js";
import { AgentServer } from "../server/index.js";
import { MockEngine } from "../engines/index.js";
import { ConnectionManager, listenUnix, listenWebSocket, type WirePeer } from "../transport/index.js";
import { NotificationSchemas, type AttachResult, type NotificationParams } from "../protocol/index.js";
import { input, until } from "../test-helpers.test.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

for (const transport of ["unix", "ws"] as const) describe(`client over ${transport}`, () => {
  async function setup() {
    const directory = mkdtempSync(join(tmpdir(), "as-client-"));
    const engine = new MockEngine();
    let spawned = false;
    const server = new AgentServer({ databasePath: ":memory:", token: "test", engineFactory: () => { if (spawned) return new MockEngine(); spawned = true; return engine; }, allowedRoots: [directory], idleTimeoutMs: 0 });
    const manager = new ConnectionManager(server);
    const peers: WirePeer[] = [], accept = manager.accept.bind(manager);
    manager.accept = peer => { peers.push(peer); return accept(peer); };
    const listener = transport === "unix" ? listenUnix(manager, { path: join(directory, "sock") }) : listenWebSocket(manager);
    const endpoint = "path" in listener ? { transport: "unix" as const, path: listener.path } : { transport: "ws" as const, url: listener.url };
    const client = new AgentClient(endpoint, { token: "test", reconnect: { minDelayMs: 25, maxDelayMs: 25 } });
    cleanups.push(async () => {
      client.close(); await server.close(); listener.close();
      if ("url" in listener) await expect(Bun.connect({ hostname: "127.0.0.1", port: listener.port, socket: { data() {}, connectError() {} } })).rejects.toMatchObject({ code: "ECONNREFUSED" });
      expect(manager.size).toBe(0); rmSync(directory, { recursive: true, force: true });
    });
    await client.connect();
    return { directory, engine, server, manager, client, peers };
  }

  test("initializes, exposes capabilities and releases a closed connection", async () => {
    const { client, manager } = await setup();
    expect(client.initializeResult?.protocolVersion).toBe("as/1");
    expect((await client.request("server/health", {})).engines).toEqual([]);
    expect(manager.size).toBe(1); client.close();
    await until(() => manager.size === 0); expect(client.state).toBe("closed");
  });
  test("midfork: typed client exposes capability, lineage and inherited history", async () => {
    const { client, directory, server } = await setup();
    expect(client.initializeResult?.capabilities.midThreadFork).toBe(true);
    const { thread } = await client.request("thread/start", { model: "sonnet", backend: "claude", cwd: directory });
    await client.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "prefix" }] });
    const [item] = server.log.snapshot(thread.id).items;
    const fork = await client.fork({ threadId: thread.id, fromItemId: item.id, clientThreadId: "fork-key" });
    expect(fork.thread.forkedFrom).toEqual({ threadId: thread.id, itemId: item.id });
    expect((await client.request("thread/attach", { threadId: fork.thread.id })).items[0]).toMatchObject({ id: item.id, payload: item.payload, seq: item.seq });
    expect((await client.fork({ threadId: thread.id, fromItemId: item.id, clientThreadId: "fork-key" })).deduplicated).toBe(true);
    await expect(client.fork({ threadId: thread.id, fromItemId: "absent" })).rejects.toMatchObject({ code: -32602 });
  });
  test("foundation client: typed native notifications and convenience methods round trip", async () => {
    const { client, engine, directory } = await setup();
    Object.assign(engine, {
      engineControl: async (subtype: string, params: object) => ({ type: "control_response", response: { subtype: "success", request_id: "fixture", response: { subtype, ...params } } }),
      setPermission: async (permission: "plan") => { engine.emit({ type: "permissionChanged", permission }); },
    });
    const received: NotificationParams<"thread/engineEvent">[] = [];
    client.onNotification("thread/engineEvent", params => received.push(params));
    const { thread } = await client.request("thread/start", { model: "sonnet", backend: "claude", cwd: directory });
    engine.emit({ type: "engineEvent", backend: "claude", subtype: "hook_progress", payload: { untouched: [1, null] } });
    await until(() => received.length === 1);
    expect(received[0]).toEqual({ threadId: thread.id, backend: "claude", subtype: "hook_progress", payload: { untouched: [1, null] } });
    expect((await client.setPermission({ threadId: thread.id, permission: "plan" })).thread.permission).toBe("plan");
    expect(await client.setEffort({ threadId: thread.id, maxThinkingTokens: null })).toMatchObject({ response: { response: { subtype: "set_max_thinking_tokens", max_thinking_tokens: null } } });
    expect(await client.engineControl({ threadId: thread.id, subtype: "mcp_status", params: {} })).toMatchObject({ response: { response: { subtype: "mcp_status" } } });
    expect((await client.compact({ threadId: thread.id })).turn.threadId).toBe(thread.id);
    expect(client.initializeResult?.capabilities.engine).toMatchObject({ engineEvents: true, engineControl: true, permissionSet: true, effortSet: true, subAgentText: true, bashInput: true, compact: true });
  });

  test("N1/probe12: malformed notifications are reported and dropped without losing the socket or pending RPC", async () => {
    const { client, manager, peers } = await setup();
    const clientId = client.clientId, states: string[] = [], errors: Error[] = [], notifications: string[] = [];
    client.onStateChange(state => states.push(state)); client.onError(error => errors.push(error));
    client.onNotification("error", params => notifications.push(params.error.message));
    const health = client.request("server/health", {});
    for (const params of [
      { turnId: "", error: { code: -32015, message: "empty turnId" }, willRetry: false },
      { error: { code: -32015, message: "bad retry" }, willRetry: "no" },
      null,
    ]) peers[0].send(JSON.stringify({ jsonrpc: "2.0", method: "error", params }));
    peers[0].send(JSON.stringify({ jsonrpc: "2.0", method: "error", params: { error: { code: -32015, message: "valid after invalid" }, willRetry: false } }));
    await until(() => notifications.length === 1);
    expect(errors).toHaveLength(3); expect(notifications).toEqual(["valid after invalid"]);
    expect((await health).engines).toEqual([]);
    expect(client.state).toBe("connected"); expect(client.clientId).toBe(clientId);
    expect(states).toEqual([]); expect(manager.size).toBe(1);
    // Actual transport loss still disconnects the client.
    manager.disconnect(clientId!);
    await until(() => states.includes("disconnected"));
  });

  test("N1: ThreadManager sanitizes empty error turnIds for every attached client", async () => {
    const { client, engine, directory, manager } = await setup();
    const other = new AgentClient(client.endpoint, { token: "test", reconnect: false });
    cleanups.push(async () => other.close()); await other.connect();
    const { thread } = await client.request("thread/start", { model: "sonnet", backend: "claude", cwd: directory });
    await other.request("thread/attach", { threadId: thread.id });
    const received: NotificationParams<"error">[][] = [[], []], errors: Error[] = [], states: string[] = [];
    for (const [index, c] of [client, other].entries()) {
      c.onNotification("error", params => received[index].push(params));
      c.onError(error => errors.push(error)); c.onStateChange(state => states.push(state));
    }
    engine.emit({ type: "error", turnId: "", error: { code: -32015, message: "orphan" }, willRetry: false });
    await until(() => received.every(events => events.length === 1));
    for (const events of received) {
      expect(events[0]).not.toHaveProperty("turnId");
      expect(NotificationSchemas.error.safeParse(events[0]).success).toBe(true);
    }
    expect(errors).toEqual([]); expect(states).toEqual([]); expect(manager.size).toBe(2);
  });

  test("R4: automatic reconnect uses highest seen cursor and receives offline completion", async () => {
    const { client, directory, engine, manager, server } = await setup();
    const { thread } = await client.request("thread/start", { model: "sonnet", backend: "claude", cwd: directory });
    const { turn } = await client.request("turn/start", { threadId: thread.id, input: input("go") });
    engine.emit({ type: "itemStarted", turnId: turn.id, item: { id: "answer", type: "agentMessage", payload: { text: "" } } });
    await until(() => server.log.snapshot(thread.id).items.length === 2);
    await client.request("server/health", {});
    expect(client.sinceSeq(thread.id)).toBe(server.log.item(thread.id, "answer").seq);
    const oldId = client.clientId!;
    manager.disconnect(oldId);
    engine.emit({ type: "itemDelta", turnId: turn.id, itemId: "answer", kind: "text", text: "offline" });
    engine.emit({ type: "itemCompleted", turnId: turn.id, item: { id: "answer", type: "agentMessage", payload: { text: "offline" }, status: "completed" } });
    const snapshots: AttachResult[] = []; client.onSnapshot(snapshot => snapshots.push(snapshot));
    await until(() => client.state === "connected" && client.clientId !== oldId && snapshots.length === 1);
    expect(snapshots[0].items.map(item => item.id)).toEqual(["answer"]);
    expect(snapshots[0].items[0].payload).toEqual({ text: "offline" });
    expect(client.sinceSeq(thread.id)).toBe(server.log.item(thread.id, "answer").completedSeq!);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentClient } from "./client.js";
import { AgentServer } from "../server/index.js";
import { MockEngine } from "../engines/index.js";
import { ConnectionManager, listenUnix, listenWebSocket } from "../transport/index.js";
import type { AttachResult } from "../protocol/index.js";
import { input, until } from "../test-helpers.test.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

for (const transport of ["unix", "ws"] as const) describe(`client over ${transport}`, () => {
  async function setup() {
    const directory = mkdtempSync(join(tmpdir(), "as-client-"));
    const engine = new MockEngine();
    const server = new AgentServer({ databasePath: ":memory:", token: "test", engineFactory: () => engine, allowedRoots: [directory], idleTimeoutMs: 0 });
    const manager = new ConnectionManager(server);
    const listener = transport === "unix" ? listenUnix(manager, { path: join(directory, "sock") }) : listenWebSocket(manager);
    const endpoint = "path" in listener ? { transport: "unix" as const, path: listener.path } : { transport: "ws" as const, url: listener.url };
    const client = new AgentClient(endpoint, { token: "test", reconnect: { minDelayMs: 25, maxDelayMs: 25 } });
    cleanups.push(async () => {
      client.close(); await server.close(); listener.close();
      if ("url" in listener) await expect(fetch(listener.url.replace("ws:", "http:"), { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
      expect(manager.size).toBe(0); rmSync(directory, { recursive: true, force: true });
    });
    await client.connect();
    return { directory, engine, server, manager, client };
  }

  test("initializes, exposes capabilities and releases a closed connection", async () => {
    const { client, manager } = await setup();
    expect(client.initializeResult?.protocolVersion).toBe("as/1");
    expect((await client.request("server/health", {})).engines).toEqual([]);
    expect(manager.size).toBe(1); client.close();
    await until(() => manager.size === 0); expect(client.state).toBe("closed");
  });

  test("automatic reconnect rewinds unfinished items and emits a replacement snapshot", async () => {
    const { client, directory, engine, manager, server } = await setup();
    const { thread } = await client.request("thread/start", { backend: "claude", cwd: directory });
    const { turn } = await client.request("turn/start", { threadId: thread.id, input: input("go") });
    engine.emit({ type: "itemStarted", turnId: turn.id, item: { id: "answer", type: "agentMessage", payload: { text: "" } } });
    await until(() => server.log.snapshot(thread.id).items.length === 2);
    await client.request("server/health", {});
    expect(client.sinceSeq(thread.id)).toBe(1);
    const oldId = client.clientId!;
    manager.disconnect(oldId);
    engine.emit({ type: "itemDelta", turnId: turn.id, itemId: "answer", kind: "text", text: "offline" });
    engine.emit({ type: "itemCompleted", turnId: turn.id, item: { id: "answer", type: "agentMessage", payload: { text: "offline" }, status: "completed" } });
    const snapshots: AttachResult[] = []; client.onSnapshot(snapshot => snapshots.push(snapshot));
    await until(() => client.state === "connected" && client.clientId !== oldId && snapshots.length === 1);
    expect(snapshots[0].items.map(item => item.id)).toEqual(["answer"]);
    expect(snapshots[0].items[0].payload).toEqual({ text: "offline" });
    expect(client.sinceSeq(thread.id)).toBe(2);
  });
});

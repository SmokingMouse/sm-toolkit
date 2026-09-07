import { expect, test } from "bun:test";
import { AgentServer } from "../server/server.js";
import { ConnectionManager } from "./connection-manager.js";
import { listenWebSocket } from "./websocket.js";

test("S1: browser origins require an exact allowlist; allowed and non-browser clients still require token", async () => {
  const server = new AgentServer({ databasePath: ":memory:", token: "test-token", allowedRoots: [process.cwd()], idleTimeoutMs: 0 });
  const manager = new ConnectionManager(server), listener = listenWebSocket(manager, { allowedOrigins: ["https://app.example"] });
  try {
    for (const origin of ["https://evil.example.com", "null", "https://app.example.evil", "http://app.example", "https://app.example:444", ""]) {
      const response = await fetch(listener.url.replace("ws:", "http:"), { headers: { Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13", Origin: origin } });
      expect(response.status).toBe(403);
    }
    expect(manager.size).toBe(0);
    for (const origin of [undefined, "https://app.example"]) {
      const socket = new WebSocket(listener.url, origin ? { headers: { Origin: origin } } : {});
      try {
        await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("upgrade failed")); });
        const response = new Promise<any>(resolve => { socket.onmessage = event => resolve(JSON.parse(String(event.data))); });
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "as/1", client: { name: "test", version: "1", kind: "test", label: "test" } } }));
        expect((await response).error.code).toBe(-32005);
      } finally { socket.close(); }
    }
  } finally { listener.close(); await server.close(); }
});

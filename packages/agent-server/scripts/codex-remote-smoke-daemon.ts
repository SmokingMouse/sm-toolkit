import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDaemon } from "../src/daemon/runtime.js";
import { loadToken } from "../src/daemon/paths.js";

// A transparent recording transport in front of the actual configured daemon.
// Never substitutes an engine or manufactures a native protocol frame.
const root = process.env.CODEX_SMOKE_ROOT!;
const backend = process.env.CODEX_SMOKE_BACKEND === "claude" ? "claude" : "codex";
if (!root || process.env.HOME !== join(root, "home")) throw new Error("isolated smoke HOME required");
const daemon = await runDaemon({ graceMs: 0, codexTrace(direction, frame, connection) {
  appendFileSync(join(root, "wire.ndjson"), JSON.stringify({ connection, direction, ...frame }) + "\n");
} });
// Record the actual CLI init events before the native projection filters them.
const publish = daemon.server.log.publish.bind(daemon.server.log);
daemon.server.log.publish = frame => {
  if (frame.method === "thread/engineEvent" && frame.params.backend === "claude" && frame.params.subtype === "init") appendFileSync(join(root, "claude-init.ndjson"), JSON.stringify(frame) + "\n");
  publish(frame);
};
if (!daemon.codexIngressUrl) throw new Error("codex_ingress.enabled missing");
const token = loadToken(daemon.paths.tokenPath);
// Separate real native connection: explicit unsupported methods must fail,
// without asking the PTY to enter an unsupported UI mode.
const probe = new WebSocket(daemon.codexIngressUrl, { headers: { Authorization: `Bearer ${token}` } });
await new Promise<void>((resolve, reject) => { probe.onopen = () => resolve(); probe.onerror = () => reject(new Error("native probe connect failed")); });
let probeId = 0;
async function probeRequest(method: string, params = {}): Promise<Record<string, any>> {
  const id = ++probeId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`native probe timeout: ${method}`)), 10000);
    probe.onmessage = event => {
      const f = JSON.parse(String(event.data));
      if (f.id !== id) return;
      clearTimeout(timeout); resolve(f);
    };
    probe.send(JSON.stringify({ id, method, params }));
  });
}
const initialized = await probeRequest("initialize", { clientInfo: { name: "smoke-probe", version: "1" } });
if (initialized.error) throw new Error(JSON.stringify(initialized.error));
probe.send(JSON.stringify({ method: "initialized" }));
const unsupported = [];
for (const method of ["review/start", "thread/realtime/start"]) unsupported.push({ method, ...await probeRequest(method) });
writeFileSync(join(root, "unsupported-methods.json"), JSON.stringify(unsupported));
probe.close();
interface ProxyData { connection: number; upstream?: WebSocket; queue: string[] }
let connections = 0;
const sockets = new Set<Bun.ServerWebSocket<ProxyData>>();
const record = (connection: number, direction: string, text: string) => appendFileSync(join(root, "wire.ndjson"), JSON.stringify({ connection, direction, ...JSON.parse(text) }) + "\n");
const proxy = Bun.serve<ProxyData>({ hostname: "127.0.0.1", port: 0,
  fetch(request, server) {
    if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response("unauthorized", { status: 401 });
    if (server.upgrade(request, { data: { connection: ++connections, queue: [] } })) return;
    return new Response("upgrade required", { status: 426 });
  },
  websocket: { idleTimeout: 0, maxPayloadLength: 128 * 1024 * 1024,
    open(socket) {
      sockets.add(socket);
      const upstream = socket.data.upstream = new WebSocket(daemon.codexIngressUrl!, { headers: { Authorization: `Bearer ${token}` } });
      upstream.onopen = () => { for (const frame of socket.data.queue.splice(0)) upstream.send(frame); };
      upstream.onmessage = event => { const text = String(event.data); record(socket.data.connection, "AS>TUI", text); socket.send(text); };
      upstream.onclose = () => socket.close(); upstream.onerror = () => socket.close(1011, "upstream error");
    },
    message(socket, data) {
      const text = data.toString(); record(socket.data.connection, "TUI>AS", text);
      if (socket.data.upstream?.readyState === WebSocket.OPEN) socket.data.upstream.send(text); else socket.data.queue.push(text);
    },
    close(socket) { sockets.delete(socket); socket.data.upstream?.close(); },
  },
});
// Exercise the fj entry path through the real as/1 client. No native turn is
// sent here; the official TUI must resume this UUID and supply its first input.
const as1 = daemon.server.connectInProcess();
as1.onFrame(frame => appendFileSync(join(root, "fresh-as1.ndjson"), JSON.stringify(frame) + "\n"));
await as1.request("initialize", { protocolVersion: "as/1", token, client: { name: "smoke-as1", version: "1", kind: "cli", label: "smoke-as1" }, capabilities: {} });
await as1.notifyInitialized();
const fresh = await as1.request("thread/start", { backend, cwd: join(root, "workspace"), model: backend === "claude" ? "sonnet" : "gpt-5.6-sol", permission: "full" });
if (daemon.server.log.turns(fresh.thread.id).length !== 0) throw new Error("fresh thread already has turns");
as1.close();
writeFileSync(join(root, "smoke-endpoint.json"), JSON.stringify({ url: process.env.CODEX_SMOKE_TRANSPORT === "unix" ? daemon.codexIngressUnixUrl : `ws://127.0.0.1:${proxy.port}`, tokenPath: daemon.paths.tokenPath, databasePath: daemon.paths.databasePath, freshThreadId: backend === "claude" ? fresh.thread.id.slice(3) : fresh.thread.engineThreadId, freshAsThreadId: fresh.thread.id }));
let closing = false;
async function shutdown() {
  if (closing) return; closing = true;
  for (const socket of sockets) { socket.data.upstream?.close(); socket.terminate(); }
  void proxy.stop(true); proxy.unref(); await daemon.shutdown(); process.exit(0);
}
process.on("SIGTERM", () => void shutdown()); process.on("SIGINT", () => void shutdown());

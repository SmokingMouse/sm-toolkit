import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDaemon } from "../src/daemon/runtime.js";
import { loadToken } from "../src/daemon/paths.js";

// A transparent recording transport in front of the actual configured daemon.
// Never substitutes an engine or manufactures a native protocol frame.
const root = process.env.CODEX_SMOKE_ROOT!;
if (!root || process.env.HOME !== join(root, "home")) throw new Error("isolated smoke HOME required");
const daemon = await runDaemon({ graceMs: 0 });
if (!daemon.codexIngressUrl) throw new Error("codex_ingress.enabled missing");
const token = loadToken(daemon.paths.tokenPath);
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
writeFileSync(join(root, "smoke-endpoint.json"), JSON.stringify({ url: `ws://127.0.0.1:${proxy.port}`, tokenPath: daemon.paths.tokenPath, databasePath: daemon.paths.databasePath }));
let closing = false;
async function shutdown() {
  if (closing) return; closing = true;
  for (const socket of sockets) { socket.data.upstream?.close(); socket.terminate(); }
  void proxy.stop(true); proxy.unref(); await daemon.shutdown(); process.exit(0);
}
process.on("SIGTERM", () => void shutdown()); process.on("SIGINT", () => void shutdown());

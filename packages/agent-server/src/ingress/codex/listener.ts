import { timingSafeEqual } from "node:crypto";
import type { AgentServer } from "../../server/server.js";
import { ControlProcess, type ControlClient, type NativeObject } from "./control-process.js";
import { CodexSession } from "./session.js";

export const MAX_NATIVE_FRAME_BYTES = 128 * 1024 * 1024;
interface SocketData { session?: CodexSession }
export interface CodexListener { readonly url: string; readonly port: number; close(): Promise<void> }
export function listenCodex(server: AgentServer, options: {
  token: string; port?: number; hostname?: string; control?: ControlClient; audit?: (message: string) => void;
  trace?: (direction: "TUI>AS" | "AS>TUI", frame: NativeObject) => void;
}): CodexListener {
  const hostname = options.hostname ?? "127.0.0.1";
  if (hostname !== "127.0.0.1" && hostname !== "::1") throw new Error("codex-ingress must bind to loopback");
  if (!options.token) throw new Error("codex-ingress requires a bearer token");
  const token = Buffer.from(`Bearer ${options.token}`), control = options.control ?? new ControlProcess();
  const sockets = new Set<Bun.ServerWebSocket<SocketData>>();
  const listener = Bun.serve<SocketData>({ hostname, port: options.port ?? 0,
    fetch(request, listener) {
      const peer = listener.requestIP(request)?.address;
      if (peer !== "127.0.0.1" && peer !== "::1" && peer !== "::ffff:127.0.0.1") return new Response("Loopback required", { status: 403 });
      if (request.headers.has("origin")) return new Response("Browser origins forbidden", { status: 403 });
      const provided = Buffer.from(request.headers.get("authorization") ?? "");
      if (provided.length !== token.length || !timingSafeEqual(provided, token)) return new Response("Invalid bearer token", { status: 401 });
      if (listener.upgrade(request, { data: {} })) return;
      return new Response("WebSocket upgrade required", { status: 426 });
    },
    websocket: { maxPayloadLength: MAX_NATIVE_FRAME_BYTES, backpressureLimit: MAX_NATIVE_FRAME_BYTES * 2, closeOnBackpressureLimit: true, idleTimeout: 0,
      open(socket) {
        sockets.add(socket);
        try { socket.data.session = new CodexSession(server, control, { token: options.token, audit: options.audit,
          send(frame) { options.trace?.("AS>TUI", frame); if (socket.send(JSON.stringify(frame)) === 0) throw new Error("native socket closed"); },
          end() { socket.close(1000, "connection closed"); },
        }); } catch { socket.close(1011, "server unavailable"); }
      },
      message(socket, message) {
        if (typeof message !== "string") { socket.close(1003, "native JSON text required"); socket.data.session?.close(); return; }
        try { const frame = JSON.parse(message); options.trace?.("TUI>AS", frame); void socket.data.session?.receive(frame); }
        catch { socket.data.session?.parseError(); }
      },
      close(socket) { sockets.delete(socket); socket.data.session?.close(); },
    },
  });
  let closing: Promise<void> | undefined;
  return { url: `ws://${hostname === "::1" ? "[::1]" : hostname}:${listener.port}`, port: listener.port!, close() {
    if (closing) return closing;
    for (const socket of sockets) { socket.data.session?.close(); socket.terminate(); }
    sockets.clear(); void listener.stop(true); listener.unref();
    return closing = control.close();
  } };
}

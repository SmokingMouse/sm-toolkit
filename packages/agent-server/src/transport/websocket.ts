import { ConnectionManager, type ManagedConnection } from "./connection-manager.js";
import { MAX_MESSAGE_BYTES } from "./ndjson.js";

interface SocketData { connection?: ManagedConnection }
export interface WebSocketTransport { readonly url: string; readonly port: number; close(): Promise<void> }

export function listenWebSocket(manager: ConnectionManager, options: { port?: number; hostname?: string } = {}): WebSocketTransport {
  const hostname = options.hostname ?? "127.0.0.1";
  if (hostname !== "127.0.0.1" && hostname !== "::1") throw new Error("agent-server WebSocket must bind to loopback");
  const server = Bun.serve<SocketData>({
    hostname, port: options.port ?? 0,
    fetch(request, server) {
      if (server.upgrade(request, { data: {} })) return;
      return new Response("WebSocket upgrade required", { status: 426 });
    },
    websocket: {
      maxPayloadLength: MAX_MESSAGE_BYTES,
      backpressureLimit: 32 * 1024 * 1024,
      closeOnBackpressureLimit: true,
      idleTimeout: 0,
      open(socket) {
        try {
          socket.data.connection = manager.accept({
            send(text) { if (socket.send(text) === 0) throw new Error("WebSocket closed or message dropped"); },
            end() { socket.close(1000, "connection closed"); },
          });
        } catch { socket.close(1011, "server unavailable"); }
      },
      message(socket, message) {
        if (typeof message !== "string") { socket.close(1003, "AS requires text messages"); socket.data.connection?.close(); return; }
        socket.data.connection?.receive(message);
      },
      close(socket) { socket.data.connection?.close(); },
    },
  });
  return { port: server.port!, url: `ws://${hostname === "::1" ? "[::1]" : hostname}:${server.port}`, close: () => server.stop(true) };
}

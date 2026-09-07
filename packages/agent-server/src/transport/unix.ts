import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { ConnectionManager, type ManagedConnection } from "./connection-manager.js";
import { NDJSONDecoder, UnixWriter } from "./ndjson.js";

interface SocketData { connection: ManagedConnection; decoder: NDJSONDecoder; writer: UnixWriter }
export interface UnixTransport { readonly path: string; close(): void }

export function listenUnix(manager: ConnectionManager, options: { path: string }): UnixTransport {
  const { path } = options;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const sockets = new Set<Bun.Socket<SocketData>>();
  const disconnect = (socket: Bun.Socket<SocketData>) => {
    sockets.delete(socket); socket.data?.writer.dispose(); socket.data?.connection.close(); socket.end();
  };
  // Existing paths are never unlinked here. Only daemon ownership checks may remove stale sockets.
  const listener = Bun.listen<SocketData>({
    unix: path,
    socket: {
      open(socket) {
        const writer = new UnixWriter(socket);
        try {
          const connection = manager.accept({ send: text => writer.send(text), end() { try { writer.end(); } catch { socket.terminate(); } } });
          socket.data = { writer, connection, decoder: new NDJSONDecoder(line => connection.receive(line)) };
          sockets.add(socket);
        } catch { writer.dispose(); socket.end(); }
      },
      data(socket, data) { try { socket.data.decoder.push(data); } catch { disconnect(socket); } },
      drain(socket) { try { socket.data.writer.drain(); } catch { disconnect(socket); } },
      close: disconnect, end: disconnect, error: disconnect,
    },
  });
  chmodSync(path, 0o600);
  const identity = lstatSync(path);
  let closed = false;
  return { path, close() {
    if (closed) return; closed = true;
    for (const socket of sockets) disconnect(socket);
    listener.stop(true);
    try {
      const current = lstatSync(path);
      if (current.isSocket() && current.ino === identity.ino && current.dev === identity.dev) unlinkSync(path);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  } };
}

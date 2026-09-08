import { ErrorCode, ProtocolError } from "../protocol/index.js";
import type { AgentServer, InProcessClient } from "../server/index.js";

export interface WirePeer {
  /** Enqueue one message, preserving order and handling transport backpressure. */
  send(text: string): void;
  end(): void;
}

export class ManagedConnection {
  private ingress: Promise<void> = Promise.resolve();
  private disposed = false;
  readonly clientId: string;
  constructor(private readonly client: InProcessClient, private readonly peer: WirePeer, remove: () => void) {
    this.clientId = client.clientId;
    client.onFrame(frame => {
      try { peer.send(JSON.stringify(frame)); } catch { this.close(); }
    });
    client.onClose(() => { remove(); this.disposed = true; peer.end(); });
  }
  receive(text: string): void {
    // Parse errors use the same ingress queue as requests, never overtaking a response.
    this.ingress = this.ingress.then(async () => {
      if (this.disposed) return;
      let frame: unknown;
      try { frame = JSON.parse(text); }
      catch {
        this.peer.send(JSON.stringify({ jsonrpc: "2.0", id: null, error: new ProtocolError(ErrorCode.parse, "invalid JSON").toJSON() }));
        return;
      }
      await this.client.send(frame);
    }).catch(() => this.close());
  }
  close(): void { if (!this.disposed) this.client.close(); }
}

/** One wire connection is exactly one server client. Business routing stays in AgentServer. */
export class ConnectionManager {
  private readonly clients = new Map<string, ManagedConnection>();
  constructor(readonly server: AgentServer) {}
  get size(): number { return this.clients.size; }
  accept(peer: WirePeer): ManagedConnection {
    const client = this.server.connectInProcess();
    const connection = new ManagedConnection(client, peer, () => this.clients.delete(client.clientId));
    this.clients.set(client.clientId, connection);
    return connection;
  }
  disconnect(clientId: string): void { this.clients.get(clientId)?.close(); }
  close(): void { for (const connection of [...this.clients.values()]) connection.close(); }
}

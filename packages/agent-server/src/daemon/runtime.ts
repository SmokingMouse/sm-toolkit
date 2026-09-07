import { appendFileSync, chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { AgentServer, type ServerOptions } from "../server/index.js";
import { ConnectionManager, listenUnix, listenWebSocket, type UnixTransport, type WebSocketTransport } from "../transport/index.js";
import { ensureParent, loadToken, resolveDaemonPaths, type DaemonPaths } from "./paths.js";
import { claimPid, removeStaleSocket } from "./process.js";

export interface DaemonOptions { paths?: DaemonPaths; graceMs?: number; wsPort?: number; serverOptions?: ServerOptions; logger?: (message: string) => void }
const ConfigSchema = z.object({
  allowed_roots: z.array(z.string()).optional(), maxQueuedTurns: z.number().int().nonnegative().optional(),
  orphanTimeoutMs: z.number().int().nonnegative().optional(), idleTimeoutMs: z.number().int().nonnegative().optional(),
});
function readConfig(path: string): ServerOptions {
  if (!existsSync(path)) return {};
  const { allowed_roots, ...options } = ConfigSchema.parse(Bun.TOML.parse(readFileSync(path, "utf8")));
  return { ...options, ...(allowed_roots ? { allowedRoots: allowed_roots } : {}) };
}
export interface RunningDaemon {
  readonly server: AgentServer; readonly manager: ConnectionManager; readonly paths: DaemonPaths;
  readonly webSocketUrl?: string; readonly closed: Promise<void>;
  shutdown(reason?: string): Promise<void>;
}
export async function runDaemon(options: DaemonOptions = {}): Promise<RunningDaemon> {
  const paths = options.paths ?? resolveDaemonPaths(), graceMs = options.graceMs ?? 1000;
  if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 300_000) throw new Error("graceMs must be an integer from 0 to 300000");
  const releasePid = claimPid(paths.pidPath, paths.socketPath, graceMs);
  let server: AgentServer | undefined, unix: UnixTransport | undefined, ws: WebSocketTransport | undefined;
  const logger = options.logger ?? ((message: string) => console.log(message));
  const log = (message: string) => {
    const line = `${new Date().toISOString()} ${message}`;
    appendFileSync(paths.logPath, line + "\n", { mode: 0o600 }); logger(line);
  };
  try {
    await removeStaleSocket(paths.socketPath);
    const token = loadToken(paths.tokenPath, true);
    ensureParent(paths.logPath); appendFileSync(paths.logPath, "", { mode: 0o600 }); chmodSync(paths.logPath, 0o600);
    server = new AgentServer({ databasePath: paths.databasePath, ...readConfig(paths.configPath), ...options.serverOptions, token });
    const manager = new ConnectionManager(server);
    unix = listenUnix(manager, { path: paths.socketPath });
    if (options.wsPort !== undefined) ws = listenWebSocket(manager, { port: options.wsPort });
    const endpoint = JSON.stringify({ pid: process.pid, socketPath: paths.socketPath, ...(ws ? { webSocketUrl: ws.url } : {}) }) + "\n";
    writeFileSync(paths.endpointPath, endpoint, { mode: 0o600 }); chmodSync(paths.endpointPath, 0o600);
    log(`agent-server ready pid=${process.pid} socket=${paths.socketPath} source=${paths.socketSource}${ws ? ` ws=${ws.url}` : ""} tokenFile=${paths.tokenPath} logFile=${paths.logPath}`);
    let resolveClosed!: () => void;
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    let shuttingDown: Promise<void> | undefined;
    return { server, manager, paths, webSocketUrl: ws?.url, closed, shutdown(reason = "server_shutdown") {
      if (shuttingDown) return shuttingDown;
      shuttingDown = (async () => {
        log(`agent-server shutting down reason=${reason} graceMs=${graceMs}`);
        try { await server!.close(reason, graceMs); }
        finally {
          unix!.close(); ws?.close();
          if (existsSync(paths.endpointPath) && readFileSync(paths.endpointPath, "utf8") === endpoint) unlinkSync(paths.endpointPath);
          releasePid(); log("agent-server stopped"); resolveClosed();
        }
      })();
      return shuttingDown;
    } };
  } catch (error) {
    unix?.close(); ws?.close(); await server?.close(); releasePid(); throw error;
  }
}

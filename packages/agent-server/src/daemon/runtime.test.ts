import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentClient } from "../client/index.js";
import { MockEngine } from "../engines/index.js";
import { until } from "../test-helpers.test.js";
import { loadToken, resolveDaemonPaths } from "./paths.js";
import { readPid } from "./process.js";
import { readConfig, runDaemon } from "./runtime.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function temporary() {
  const directory = mkdtempSync("/tmp/as-daemon-");
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("socket path precedence and state paths are independent of the caller's HOME", () => {
  const home = "/tmp/home", runtime = "/tmp/runtime", state = "/tmp/state";
  expect(resolveDaemonPaths({ HOME: home }).socketPath).toBe(join(home, ".sm-toolkit/agent-server.sock"));
  expect(resolveDaemonPaths({ HOME: home, XDG_STATE_HOME: state }).socketPath).toBe(join(state, "sm-toolkit/agent-server.sock"));
  expect(resolveDaemonPaths({ HOME: home, XDG_STATE_HOME: state, XDG_RUNTIME_DIR: runtime }).socketPath).toBe(join(runtime, "sm-toolkit/agent-server.sock"));
  const explicit = resolveDaemonPaths({ HOME: home, XDG_STATE_HOME: state, XDG_RUNTIME_DIR: runtime, AGENT_SERVER_SOCKET_PATH: "/tmp/custom.sock" });
  expect(explicit.socketPath).toBe("/tmp/custom.sock"); expect(explicit.socketSource).toBe("AGENT_SERVER_SOCKET_PATH");
  expect(explicit.tokenPath).toBe(join(state, "sm-toolkit/agent-server/token"));
  expect(resolveDaemonPaths({ HOME: home, XDG_RUNTIME_DIR: "relative" }).socketPath).toBe(join(home, ".sm-toolkit/agent-server.sock"));
});

test("readConfig: missing file returns empty options", () => {
  expect(readConfig(join(temporary(), "config.toml"))).toEqual({});
});

test("readConfig: readonly_auto_allow and readonly_commands map to camelCase ServerOptions", () => {
  const path = join(temporary(), "config.toml");
  writeFileSync(path, 'readonly_auto_allow = false\nreadonly_commands = ["ls", "whoami"]\nallowed_roots = ["/tmp"]\n');
  expect(readConfig(path)).toEqual({ readonlyAutoAllow: false, readonlyCommands: ["ls", "whoami"], allowedRoots: ["/tmp"] });
});

test("readConfig: readonly_auto_allow=true is preserved (not treated as absent)", () => {
  const path = join(temporary(), "config.toml");
  writeFileSync(path, "readonly_auto_allow = true\n");
  expect(readConfig(path)).toEqual({ readonlyAutoAllow: true });
});

test("token is generated once, reused and restricted to 0600", () => {
  const path = join(temporary(), "token");
  const first = loadToken(path, true), second = loadToken(path, true);
  expect(first).toMatch(/^[a-f0-9]{64}$/); expect(second).toBe(first);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("grace broadcasts to unix and WS before closing MockEngine, then releases files", async () => {
  const directory = temporary(), paths = resolveDaemonPaths({ HOME: directory, AGENT_SERVER_SOCKET_PATH: join(directory, "sock") });
  const engine = new MockEngine();
  const daemon = await runDaemon({ paths, graceMs: 60, wsPort: 0, logger: () => {}, serverOptions: { allowedRoots: [directory], engineFactory: () => engine, idleTimeoutMs: 0 } });
  cleanups.push(() => daemon.shutdown());
  const token = loadToken(paths.tokenPath);
  const a = await AgentClient.connectUnix({ path: paths.socketPath, token, reconnect: false });
  const b = await AgentClient.connectWebSocket({ url: daemon.webSocketUrl!, token, reconnect: false });
  cleanups.push(() => { a.close(); b.close(); });
  await a.request("thread/start", { backend: "claude", cwd: directory });
  const shutdowns: number[] = [];
  a.onNotification("server/shuttingDown", params => shutdowns.push(params.graceMs));
  b.onNotification("server/shuttingDown", params => shutdowns.push(params.graceMs));
  expect(readPid(paths.pidPath)?.record?.pid).toBe(process.pid);
  for (const path of [paths.socketPath, paths.pidPath, paths.tokenPath, paths.endpointPath, paths.logPath]) expect(statSync(path).mode & 0o777).toBe(0o600);
  const start = Date.now(), closing = daemon.shutdown("test");
  expect(daemon.shutdown()).toBe(closing);
  await until(() => shutdowns.length === 2);
  expect(shutdowns).toEqual([60, 60]); expect(engine.closed).toBe(false);
  await closing;
  expect(Date.now() - start).toBeGreaterThanOrEqual(60); expect(engine.closed).toBe(true);
  expect(daemon.manager.size).toBe(0);
  for (const path of [paths.socketPath, paths.pidPath, paths.endpointPath]) expect(existsSync(path)).toBe(false);
  expect(existsSync(paths.tokenPath)).toBe(true);
  const log = readFileSync(paths.logPath, "utf8");
  expect(log).toContain(paths.socketPath); expect(log).toContain("source=AGENT_SERVER_SOCKET_PATH"); expect(log).not.toContain(token);
});

test("run reclaims a dead pid but never replaces a regular file at the socket path", async () => {
  const directory = temporary(), paths = resolveDaemonPaths({ HOME: directory, AGENT_SERVER_SOCKET_PATH: join(directory, "sock") });
  writeFileSync(paths.pidPath, "2147483647\n"); writeFileSync(paths.socketPath, "keep");
  await expect(runDaemon({ paths, logger: () => {} })).rejects.toThrow("non-socket");
  expect(readFileSync(paths.socketPath, "utf8")).toBe("keep"); expect(existsSync(paths.pidPath)).toBe(false);
});

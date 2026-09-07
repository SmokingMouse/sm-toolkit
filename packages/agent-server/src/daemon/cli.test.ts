import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentClient } from "../client/index.js";
import { until } from "../test-helpers.test.js";
import { loadToken, resolveDaemonPaths } from "./paths.js";
import { ownsProcess, readPid } from "./process.js";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const bin = fileURLToPath(new URL("../../bin/agent-server", import.meta.url));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function setup() {
  const home = mkdtempSync("/tmp/as-cli-");
  const env = { PATH: process.env.PATH!, HOME: home, AGENT_SERVER_SOCKET_PATH: join(home, "sock"), XDG_RUNTIME_DIR: "", XDG_STATE_HOME: "" };
  const paths = resolveDaemonPaths(env);
  async function command(args: string[], executable = false) {
    const proc = Bun.spawn(executable ? [bin, ...args] : [process.execPath, cli, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill("SIGTERM"), 3000);
    try {
      const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { stdout, stderr, exit };
    } finally { clearTimeout(timer); }
  }
  cleanups.push(async () => {
    const pid = readPid(paths.pidPath)?.record;
    if (pid && pid.pid !== process.pid && ownsProcess(pid)) {
      process.kill(pid.pid, "SIGTERM");
      await until(() => !ownsProcess(pid), "fixture daemon stops");
    }
    rmSync(home, { recursive: true, force: true });
  });
  return { home, env, paths, command };
}

describe("agent-server executable lifecycle (temporary HOME, no real engines)", () => {
  test("bin is executable and status without a daemon gives a clear error", async () => {
    const { command } = setup();
    expect(statSync(bin).mode & 0o111).not.toBe(0);
    const result = await command(["daemon", "status"], true);
    expect(result.exit).toBe(1); expect(result.stderr).toContain("not running"); expect(result.stdout).toBe("");
  });

  test("start, health status, graceful stop, token reuse and repeated status", async () => {
    const { paths, command } = setup();
    const started = await command(["daemon", "start", "--grace-ms", "40", "--ws-port", "0"]);
    expect(started).toMatchObject({ exit: 0, stderr: "" });
    expect(JSON.parse(started.stdout)).toMatchObject({ socketPath: paths.socketPath, engines: [] });
    const firstToken = loadToken(paths.tokenPath), pid = readPid(paths.pidPath)!.record!;
    const endpoint = JSON.parse(readFileSync(paths.endpointPath, "utf8"));
    expect(endpoint.webSocketUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    const status = await command(["daemon", "status"]);
    expect(status.exit).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ uptimeMs: expect.any(Number), threads: { running: 0, idle: 0, closed: 0 }, engines: [] });
    const again = await command(["daemon", "start"]); expect(again.exit).toBe(0); expect(readPid(paths.pidPath)!.record!.pid).toBe(pid.pid);
    const client = await AgentClient.connectWebSocket({ url: endpoint.webSocketUrl, token: firstToken, reconnect: false });
    const shutdowns: number[] = []; client.onNotification("server/shuttingDown", p => shutdowns.push(p.graceMs));
    try {
      const stopped = await command(["daemon", "stop"]);
      expect(stopped).toMatchObject({ exit: 0, stderr: "" }); expect(stopped.stdout).toContain("stopped"); expect(shutdowns).toEqual([40]);
    } finally { client.close(); }
    expect(ownsProcess(pid)).toBe(false);
    for (const path of [paths.pidPath, paths.socketPath, paths.endpointPath]) expect(existsSync(path)).toBe(false);
    expect((await command(["daemon", "status"])).stderr).toContain("not running");
    expect((await command(["daemon", "start", "--grace-ms", "0"])).exit).toBe(0);
    expect(loadToken(paths.tokenPath)).toBe(firstToken);
    expect((await command(["daemon", "stop"])).exit).toBe(0);
    expect(readFileSync(paths.logPath, "utf8")).toContain("agent-server stopped");
    expect(readFileSync(paths.logPath, "utf8")).not.toContain(firstToken);
  });

  test("dead pid and stale socket from a killed local listener are reclaimed", async () => {
    const { paths, env, command } = setup();
    const fake = Bun.spawn([process.execPath, "-e", "Bun.listen({unix:process.env.AGENT_SERVER_SOCKET_PATH,socket:{data(){}}});"], { env, stdout: "ignore", stderr: "ignore" });
    await until(() => existsSync(paths.socketPath));
    fake.kill("SIGKILL"); await fake.exited;
    writeFileSync(paths.pidPath, String(fake.pid) + "\n");
    expect((await command(["daemon", "status"])).stderr).toContain("stale");
    const result = await command(["daemon", "start", "--grace-ms", "0"]);
    expect(result).toMatchObject({ exit: 0, stderr: "" });
    expect(readPid(paths.pidPath)!.record!.pid).not.toBe(fake.pid);
    expect((await command(["daemon", "stop"])).exit).toBe(0);
  });

  test("stale stop reports absence; live unverified pids are never signalled", async () => {
    const { paths, command } = setup();
    writeFileSync(paths.pidPath, "2147483647\n");
    const stale = await command(["daemon", "stop"]);
    expect(stale.exit).toBe(1); expect(stale.stderr).toContain("stale"); expect(existsSync(paths.pidPath)).toBe(false);
    writeFileSync(paths.pidPath, String(process.pid));
    expect((await command(["daemon", "stop"])).exit).toBe(1);
    expect((await command(["daemon", "start"])).stderr).toContain("unverified live pid");
    expect(readFileSync(paths.pidPath, "utf8")).toBe(String(process.pid));
  });

  test("foreground run handles SIGINT and releases pid/socket", async () => {
    const { paths, env } = setup();
    const proc = Bun.spawn([process.execPath, cli, "run", "--grace-ms", "0"], { env, stdout: "pipe", stderr: "pipe" });
    try {
      await until(() => existsSync(paths.endpointPath));
      const client = await AgentClient.connectUnix({ path: paths.socketPath, token: loadToken(paths.tokenPath), reconnect: false });
      expect((await client.request("server/health", {})).engines).toEqual([]); client.close();
      proc.kill("SIGINT"); expect(await proc.exited).toBe(0);
      expect(existsSync(paths.pidPath)).toBe(false); expect(existsSync(paths.socketPath)).toBe(false);
      expect(await new Response(proc.stdout).text()).toContain("reason=SIGINT");
      expect(await new Response(proc.stderr).text()).toBe("");
    } finally { if (proc.exitCode === null) { proc.kill("SIGTERM"); await proc.exited; } }
  });

  test("invalid flags and a blocked socket path fail without leaving a daemon", async () => {
    const { paths, command } = setup();
    expect((await command(["run", "--ws-port", "65536"])).exit).toBe(1);
    expect((await command(["daemon", "start", "--grace-ms", "-1"])).exit).toBe(1);
    writeFileSync(paths.socketPath, "user data");
    const start = await command(["daemon", "start"]);
    expect(start.exit).toBe(1); expect(start.stderr).toContain("failed to start");
    expect(readFileSync(paths.socketPath, "utf8")).toBe("user data"); expect(existsSync(paths.pidPath)).toBe(false);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { AgentServer } from "../server/server.js";
import { client, input } from "../test-helpers.test.js";
import { CodexEngine, descendantPids, readProcessTable, spawnCodexProcess } from "./codex.js";

// Real processes, real signals. The peer is offline, but the process tree it builds is
// genuine: `/bin/sh -c "<cmd>; :"` forks the command as a grandchild, and the peer's
// turn/interrupt kills only the shell, so the grandchild is reparented to init exactly
// as codex 0.153.4 leaves it. Nothing here may outlive the test.
const fixture = resolve(import.meta.dir, "../../scripts/fixtures/fake-codex-exec-server.ts");
const COMMAND = "sleep 600";

const cleanup: Array<() => Promise<void> | void> = [];
const strays = new Set<number>();
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) try { await close(); } catch {}
  for (const pid of strays) { try { process.kill(pid, "SIGKILL"); } catch {} }
  strays.clear();
});

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function poll(predicate: () => boolean | Promise<boolean>, description: string, timeoutMs = 10_000): Promise<number> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out after ${timeoutMs}ms: ${description}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return Date.now() - started;
}

/** An AS server whose codex engines talk to the exec peer through the production spawner. */
function harness(options: { reaping?: boolean } = {}) {
  const codexPids: number[] = [];
  const server = new AgentServer({ databasePath: ":memory:", allowedRoots: [tmpdir()], idleTimeoutMs: 0, engineFactory: () => new CodexEngine({
    // Reaping off reproduces the pre-fix engine; the signals are simply never delivered.
    ...(options.reaping === false ? { signalProcess: () => false } : {}),
    spawnProcess: (_command, _args, opts) => {
      const child = spawnCodexProcess(process.execPath, [fixture], { ...opts, env: { ...opts.env, FAKE_EXEC_COMMAND: COMMAND } });
      if (child.pid) { codexPids.push(child.pid); strays.add(child.pid); }
      return child;
    },
  }) });
  cleanup.push(() => server.close());
  return { server, codexPids };
}

/** Starts a thread and a turn, then waits for the peer's shell and its grandchild. */
async function runningCommand(options: { reaping?: boolean } = {}) {
  const { server, codexPids } = harness(options);
  const c = await client(server);
  const { thread } = await c.request("thread/start", { backend: "codex", model: "gpt-6-astra", cwd: tmpdir(), permission: "full" });
  const { turn } = await c.request("turn/start", { threadId: thread.id, input: input("run the command") });
  const codex = codexPids[0]!;
  const tree = async () => descendantPids(codex, await readProcessTable());
  await poll(async () => (await tree()).length >= 2, "shell and command grandchild are up");
  const [shell, sleeper] = await tree();
  strays.add(shell!); strays.add(sleeper!);
  return { server, c, thread, turn, codex, shell: shell!, sleeper: sleeper!, tree };
}

describe("Codex interrupt/close process reaping (real process tree)", () => {
  test("control: without reaping the peer's interrupt orphans the command onto init and it survives close", async () => {
    const { c, thread, turn, codex, shell, sleeper, tree } = await runningCommand({ reaping: false });
    await c.request("turn/interrupt", { threadId: thread.id, turnId: turn.id });
    await poll(() => !alive(shell), "the peer killed only the shell");
    // Reparented to init: the command is gone from the process tree but still running.
    expect(await tree()).not.toContain(sleeper);
    await c.request("thread/close", { threadId: thread.id, reason: "test" });
    await poll(() => !alive(codex), "the app-server exited on close");
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(alive(sleeper)).toBe(true); // the leak this fix exists to remove
  }, 20_000);
  test("interrupt kills the orphaned command within 10s and thread/close leaves nothing behind", async () => {
    const { c, thread, turn, codex, shell, sleeper } = await runningCommand();
    await c.request("turn/interrupt", { threadId: thread.id, turnId: turn.id });
    const elapsed = await poll(() => !alive(sleeper), "orphaned command reaped after interrupt", 10_000);
    expect(elapsed).toBeLessThan(10_000);
    expect(alive(shell)).toBe(false);
    await c.request("thread/close", { threadId: thread.id, reason: "test" });
    await poll(() => !alive(codex) && !alive(shell) && !alive(sleeper), "nothing survives thread/close");
  }, 20_000);
  test("thread/close alone reaps a still-running command through the app-server's process group", async () => {
    const { c, thread, codex, shell, sleeper } = await runningCommand();
    await c.request("thread/close", { threadId: thread.id, reason: "test" });
    for (const pid of [codex, shell, sleeper]) await poll(() => !alive(pid), "the process group died with the thread");
  }, 20_000);
  test("server shutdown reaps a still-running command", async () => {
    const { server, codex, shell, sleeper } = await runningCommand();
    await server.close("server_shutdown");
    for (const pid of [codex, shell, sleeper]) await poll(() => !alive(pid), "the process group died with the daemon");
  }, 20_000);
});

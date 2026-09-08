// Real Claude CLI, isolated daemon state, explicit sonnet and asserted system/init frame.
// Run from the repository: bun packages/agent-server/scripts/readonly-expansion-smoke.ts [absolute-output-path]
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDaemon } from "../src/daemon/runtime.js";
import { loadToken, resolveDaemonPaths } from "../src/daemon/paths.js";

const root = mkdtempSync(join(tmpdir(), "readonly-expansion-smoke-"));
const home = join(root, "home"), cwd = join(root, "workspace"), output = process.argv[2] ?? join(root, "x");
assert.match(output, /^\/[A-Za-z0-9_./-]+$/, "output must be an absolute path without shell syntax");
assert.equal(existsSync(output), false, "output must not already exist");
mkdirSync(cwd, { recursive: true });
mkdirSync(home);
execFileSync("git", ["init", "-q", cwd]);
writeFileSync(join(cwd, "a.txt"), "hello\n");
execFileSync("git", ["add", "a.txt"], { cwd });
execFileSync("git", ["-c", "user.name=readonly-smoke", "-c", "user.email=readonly@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "--no-gpg-sign", "-qm", "init"], { cwd });
const isolated: NodeJS.ProcessEnv = { ...process.env, HOME: home };
for (const name of ["XDG_RUNTIME_DIR", "XDG_STATE_HOME", "AGENT_SERVER_SOCKET_PATH"]) delete isolated[name];
const paths = resolveDaemonPaths(isolated);
const daemon = await runDaemon({ paths, graceMs: 0, logger: () => {}, serverOptions: { allowedRoots: [root], idleTimeoutMs: 0 } });
console.log(`ISOLATION socket=${paths.socketPath} db=${paths.databasePath} cwd=${cwd}`);
const client = daemon.server.connectInProcess(), frames: any[] = [];
client.onFrame(frame => frames.push(frame));
async function until(check: () => boolean, label: string, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timeout: ${label}`);
    await Bun.sleep(100);
  }
}
try {
  await client.request("initialize", { protocolVersion: "as/1", token: loadToken(paths.tokenPath), client: { name: "readonly-expansion-smoke", version: "1", kind: "cli", label: "readonly expansion regression" }, capabilities: { pendingRequests: true, engineEvents: true, bashInput: true } });
  await client.notifyInitialized();
  const { thread } = await client.request("thread/start", { backend: "claude", cwd, model: "sonnet", permission: "readonly" });
  console.log(`THREAD ${thread.id} permission=readonly requested model=sonnet`);
  const warm = await client.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "Reply with exactly OK. Do not use tools." }] });
  const init = () => frames.find(frame => frame.method === "thread/engineEvent" && frame.params.threadId === thread.id && frame.params.subtype === "init");
  await until(() => !!init(), "system/init");
  const model = init().params.payload.model;
  assert.match(String(model), /sonnet/i, "init model must be sonnet");
  console.log(`ASSERT PASS init frame model=${JSON.stringify(model)}`);
  await until(() => daemon.server.log.turns(thread.id).find(t => t.id === warm.turn.id)?.status === "completed", "warm turn completed");
  const read = await client.request("turn/start", { threadId: thread.id, input: [{ type: "bash", command: "find . -name '*.txt'" }] });
  await until(() => daemon.server.log.turns(thread.id).find(t => t.id === read.turn.id)?.status === "completed", "quoted find completed");
  assert.equal(daemon.server.log.pendingRequests(thread.id).length, 0);
  assert.equal(daemon.server.log.readonlyAutoAllows(thread.id).length, 1);
  console.log("ASSERT PASS quoted find: pendingRequests=0 readonly_auto_allow=1");
  const command = `git log {--output=${output},HEAD}`;
  await client.request("turn/start", { threadId: thread.id, input: [{ type: "bash", command }] });
  await until(() => daemon.server.log.pendingRequests(thread.id).length === 1, "git brace approval");
  const pending = daemon.server.log.pendingRequests(thread.id)[0]!;
  assert.equal(pending.method, "item/commandExecution/requestApproval");
  assert.equal((pending.params as any).command, command);
  assert.equal(daemon.server.log.readonlyAutoAllows(thread.id).length, 1);
  assert.equal(existsSync(output), false);
  console.log(`ASSERT PASS command=${JSON.stringify(command)} pendingRequests=1 new readonly_auto_allow=0 fileExists=false`);
} finally { await daemon.shutdown(); }
assert.equal(existsSync(output), false);
console.log(`ASSERT PASS after shutdown fileExists=false; evidence root=${root}`);

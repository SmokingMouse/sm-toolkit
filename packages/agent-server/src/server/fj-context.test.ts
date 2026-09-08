import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { client, setup, input } from "../test-helpers.test.js";
import { sessionEnvironment } from "../engines/session.js";
import { buildCodexThreadParams } from "../engines/codex.js";
import { buildClaudeLaunch } from "../engines/claude.js";
import type { AgentServer } from "../index.js";
const servers: AgentServer[] = [];
test("fj full permission maps to native bypass and Codex ordinary tier on start/resume", () => {
  for (const engineThreadId of [undefined, "native-resume"]) expect(buildCodexThreadParams({ backend: "codex", threadId: "th", engineThreadId, model: "gpt-6-astra", permission: "full", serviceTier: "default" })).toMatchObject({ model: "gpt-6-astra", approvalPolicy: "never", sandbox: "danger-full-access", serviceTier: "default" });
  const launch = buildClaudeLaunch({ backend: "claude", threadId: "th", model: "sonnet", permission: "full" });
  expect(launch.args[launch.args.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
  expect(launch.args).toContain("--allow-dangerously-skip-permissions");
  expect(launch.args).not.toContain("--dangerously-skip-permissions");
});
test("interrupt and close remain available while another client holds an input lease", async () => {
  const { server } = setup(); servers.push(server); const a = await client(server), b = await client(server);
  const { thread } = await a.request("thread/start", { model: "gpt-6-astra", backend: "codex", cwd: process.cwd() });
  await a.request("thread/lease/acquire", { threadId: thread.id });
  await expect(b.request("turn/start", { threadId: thread.id, input: input("blocked") })).rejects.toMatchObject({ code: -32012 });
  const { turn } = await a.request("turn/start", { threadId: thread.id, input: input("go") });
  expect(await b.request("turn/interrupt", { threadId: thread.id, turnId: turn.id })).toEqual({});
  expect(server.leases.read(thread.id)?.holder.clientId).toBe(a.clientId);
  expect(await b.request("thread/close", { threadId: thread.id })).toEqual({});
  expect(server.threads.get(thread.id).status.type).toBe("closed");
  expect(server.leases.read(thread.id)).toBeUndefined();
});
afterEach(async () => { for (const s of servers.splice(0)) await s.close(); });
test("serviceTier is Codex-only and cannot silently disappear on Claude start/resume", async () => {
  const { server, engines } = setup(); servers.push(server); const c = await client(server);
  await expect(c.request("thread/start", { model: "sonnet", backend: "claude", cwd: process.cwd(), serviceTier: "default" })).rejects.toMatchObject({ code: -32008, message: "serviceTier requires Codex" });
  expect(engines).toHaveLength(0);
  const { thread } = await c.request("thread/start", { model: "sonnet", backend: "claude", cwd: process.cwd() });
  await c.request("thread/close", { threadId: thread.id });
  await expect(c.request("thread/resume", { threadId: thread.id, serviceTier: "default" })).rejects.toMatchObject({ code: -32008, message: "serviceTier requires Codex" });
  expect(engines).toHaveLength(1);
});
test("fjContext rejects traversal, arbitrary env, missing/fable models and unsupported tier before spawn", async () => {
  const { server, engines } = setup(); servers.push(server); const c = await client(server);
  const valid = { backend: "codex" as const, cwd: process.cwd(), model: "gpt-6-astra", permission: "full" as const, serviceTier: "default" as const, fjContext: { root: process.cwd(), cid: "fj-test" } };
  for (const patch of [{ model: undefined }, { model: "fable" }, { permission: undefined }, { serviceTier: "priority" }, { fjContext: { root: "/", cid: "ok" } }, { fjContext: { root: process.cwd(), cid: "../other" } }, { fjContext: { root: process.cwd(), cid: "ok", PATH: "/evil" } }, { env: { FENJUE_ROOT: "/evil" } }]) {
    await expect(c.request("thread/start", { ...valid, ...patch } as any)).rejects.toBeDefined();
  }
  expect(engines).toHaveLength(0);
});
test("two persisted fj contexts route tool subprocess mail to separate root/cid, including resume", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "as-fj-")));
  const roots = [join(root, "one"), join(root, "two")]; for (const r of roots) mkdirSync(r);
  const { server, engines } = setup({ allowedRoots: [root] }); servers.push(server); const c = await client(server);
  for (const [i, r] of roots.entries()) {
    const { thread } = await c.request("thread/start", { backend: "codex", cwd: r, model: "gpt-6-astra", permission: "full", serviceTier: "default", fjContext: { root: r, cid: `fj-${i}`, seat: `seat-${i}` } });
    const env = sessionEnvironment(engines.at(-1)!.options!, { ...process.env, HERDR_PANE_ID: "leader", HERDR_AGENT: "leader", FENJUE_ROOT: "/wrong", FENJUE_CID: "wrong" });
    expect(env.HERDR_PANE_ID).toBeUndefined(); expect(env.HERDR_AGENT).toBeUndefined();
    const p = Bun.spawnSync([process.execPath, "-e", 'const fs=require("node:fs"),p=require("node:path"); const dir=p.join(process.env.FENJUE_ROOT,".fenjue","tasks",process.env.FENJUE_CID);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(p.join(dir,"mail.ndjson"),process.env.FENJUE_CID)'], { env });
    expect(p.exitCode).toBe(0); expect(readFileSync(join(r, ".fenjue/tasks", `fj-${i}`, "mail.ndjson"), "utf8")).toBe(`fj-${i}`);
    await c.request("thread/close", { threadId: thread.id });
    await c.request("thread/resume", { threadId: thread.id });
    expect(engines.at(-1)!.options!.fjContext).toEqual({ root: r, cid: `fj-${i}`, seat: `seat-${i}` });
    await expect(c.request("thread/resume", { threadId: thread.id, fjContext: { root: r, cid: "other" } })).rejects.toBeDefined();
  }
});
for (const fault of ["lost ready", "lost RPC response", "client disconnect"]) test(`first contract retry after ${fault}: exactly one thread and one turn`, async () => {
  const { server, engines } = setup(); servers.push(server); let c = await client(server);
  const params = { backend: "codex" as const, cwd: process.cwd(), model: "gpt-6-astra", permission: "full" as const, serviceTier: "default" as const, fjContext: { root: process.cwd(), cid: "fj-retry" }, clientThreadId: "fj-stable-attempt" };
  const first = await c.request("thread/start", params);
  const turn = { threadId: first.thread.id, clientTurnId: "fj-stable-attempt:contract", input: input("contract") };
  if (fault !== "lost ready") await c.request("turn/start", turn);
  c.close(); c = await client(server);
  expect((await c.request("thread/start", params)).thread.id).toBe(first.thread.id);
  await c.request("turn/start", turn);
  expect(server.log.allThreads()).toHaveLength(1); expect(server.log.turns(first.thread.id)).toHaveLength(1); expect(engines).toHaveLength(1); expect(engines[0].sent).toHaveLength(1);
});

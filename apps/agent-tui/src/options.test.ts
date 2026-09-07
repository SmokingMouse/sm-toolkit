import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, chmodSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseOptions, readToken } from "./options.js";
import { TuiModel } from "./model.js";
import { publishReady, threadStartParams } from "./handoff.js";

test("fj stable startup options and first-turn gate", () => {
  const dir = mkdtempSync("/tmp/tui-ready-");
  const nonceFile = join(dir, "nonce"); writeFileSync(nonceFile, "nonce", { mode: 0o600 });
  const args = ["--new", "--backend", "codex", "--model", "gpt-6-astra", "--permission", "full", "--service-tier", "default", "--client-thread-id", "stable", "--ready-file", "/tmp/ready", "--ready-nonce-file", nonceFile, "--await-first-turn", "--fj-root", "/tmp", "--fj-cid", "fj-test"];
  expect(parseOptions(args)).toMatchObject({ model: "gpt-6-astra", permission: "full", serviceTier: "default", clientThreadId: "stable", readyNonce: "nonce", awaitFirstTurn: true, fjContext: { root: "/tmp", cid: "fj-test" } });
  expect(parseOptions(args).clientThreadId).toBe(parseOptions(args).clientThreadId);
  expect(() => parseOptions(args.map(v => v === "gpt-6-astra" ? "fable" : v))).toThrow();
  const model = new TuiModel(); model.awaitFirstTurn = true; expect(model.waitingForFirstTurn).toBe(true);
  model.activeTurnId = "turn"; expect(model.waitingForFirstTurn).toBe(false);
  try {
    const options = parseOptions(args); options.readyFile = join(dir, "ready.json");
    const thread = { id: "th_ready", clientThreadId: options.clientThreadId, backend: "codex" as const, cwd: options.cwd, createdAtMs: 0, engineThreadId: "native", status: { type: "idle" as const } };
    expect(threadStartParams(options)).toMatchObject({ clientThreadId: "stable", serviceTier: "default", permission: "full" });
    expect(() => publishReady(options, { ...thread, clientThreadId: "other" })).toThrow("identity");
    expect(() => publishReady(options, { ...thread, status: { type: "closed" } })).toThrow("resume");
    publishReady(options, thread);
    expect(statSync(options.readyFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(options.readyFile, "utf8"))).toMatchObject({ nonce: "nonce", threadId: thread.id, clientThreadId: "stable" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI accepts attach/new and validates contradictory or incomplete options", () => {
  expect(parseOptions(["--attach", "th"], { HOME: "/home/test" }).endpoint).toEqual({ transport: "unix", path: "/home/test/.sm-toolkit/agent-server.sock" });
  expect(parseOptions(["--new", "--backend", "codex", "--cwd", "/tmp", "--ws", "ws://127.0.0.1:1234"]).backend).toBe("codex");
  expect(parseOptions(["--attach", "th", "--socket", "/tmp/sock"]).endpoint).toEqual({ transport: "unix", path: "/tmp/sock" });
  for (const args of [[], ["--new"], ["--new", "--backend", "other"], ["--attach", "th", "--new"], ["--attach", "th", "--socket", "x", "--ws", "ws://localhost"], ["--attach", "th", "--cwd", "/tmp"], ["--attach", "th", "--ws", "https://localhost"], ["--unknown"]]) expect(() => parseOptions(args)).toThrow();
});
test("P1-3 --permission is validated and only accepted for new threads", () => {
  expect(parseOptions(["--new", "--backend", "claude", "--permission", "full"]).permission).toBe("full");
  expect(parseOptions(["--new", "--backend", "claude"]).permission).toBe("default");
  expect(() => parseOptions(["--attach", "th", "--permission", "full"])).toThrow();
  expect(() => parseOptions(["--new", "--backend", "claude", "--permission", "invalid"])).toThrow();
});
test("uses daemon XDG resolution without creating or modifying token files", () => {
  expect(parseOptions(["--attach", "th", "--socket", "/original/as.sock", "--token-path", "/original/token"], { HOME: "/other", XDG_STATE_HOME: "/other/state" })).toMatchObject({ endpoint: { path: "/original/as.sock" }, tokenPath: "/original/token" });
  expect(parseOptions(["--attach", "th"], { HOME: "/h", XDG_STATE_HOME: "/state", XDG_RUNTIME_DIR: "/run" })).toMatchObject({ endpoint: { path: "/run/sm-toolkit/agent-server.sock" }, tokenPath: "/state/sm-toolkit/agent-server/token" });
  const home = mkdtempSync("/tmp/tui-token-"); const token = join(home, "token");
  try { expect(() => readToken(token)).toThrow("Start the daemon"); writeFileSync(token, "test\n", { mode: 0o640 }); expect(readToken(token)).toBe("test"); expect(statSync(token).mode & 0o777).toBe(0o640); }
  finally { rmSync(home, { recursive: true, force: true }); }
});
test("ready nonce uses a private file, rejects public files and symlinks; Claude rejects service tier", () => {
  const dir = mkdtempSync("/tmp/tui-nonce-");
  try {
    const file = join(dir, "nonce"), link = join(dir, "link"); writeFileSync(file, "secret", { mode: 0o600 }); symlinkSync(file, link);
    const args = ["--new", "--backend", "codex", "--ready-file", join(dir, "ready"), "--client-thread-id", "stable", "--ready-nonce-file"];
    expect(parseOptions([...args, file]).readyNonce).toBe("secret");
    expect(() => parseOptions([...args, link])).toThrow();
    chmodSync(file, 0o644); expect(() => parseOptions([...args, file])).toThrow("private");
    expect(() => parseOptions(["--new", "--backend", "claude", "--service-tier", "default"])).toThrow("requires Codex");
    expect(() => parseOptions(["--new", "--backend", "codex", "--ready-nonce", "secret"])).toThrow();
  } finally { rmSync(dir, { recursive: true }); }
});
test("executable bin has help and clear errors without a daemon", async () => {
  const bin = resolve(import.meta.dir, "../bin/agent-tui"); expect(statSync(bin).mode & 0o111).not.toBe(0);
  const help = Bun.spawn([bin, "--help"], { stdout: "pipe", stderr: "pipe" });
  expect(await new Response(help.stdout).text()).toContain("--attach"); expect(await help.exited).toBe(0);
  const home = mkdtempSync("/tmp/tui-bin-");
  const env = { ...process.env, HOME: home, XDG_STATE_HOME: join(home, "state"), XDG_RUNTIME_DIR: "", HERDR_PANE_ID: "", AGENT_SERVER_SOCKET_PATH: join(home, "absent.sock") };
  try {
    const noToken = Bun.spawn([bin, "--attach", "th"], { env, stdout: "pipe", stderr: "pipe" });
    expect(await new Response(noToken.stderr).text()).toContain("Cannot read agent-server token"); expect(await noToken.exited).toBe(1);
    const dir = join(env.XDG_STATE_HOME, "sm-toolkit", "agent-server"); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "token"), "test\n");
    const noDaemon = Bun.spawn([bin, "--attach", "th"], { env, stdout: "pipe", stderr: "pipe" });
    const error = await new Response(noDaemon.stderr).text(); expect(error).toContain("Cannot connect to agent-server"); expect(error).toContain("agent-server start"); expect(error).not.toContain("requires an interactive terminal"); expect(await noDaemon.exited).toBe(1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

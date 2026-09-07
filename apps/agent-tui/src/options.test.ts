import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseOptions, readToken } from "./options.js";

test("CLI accepts attach/new and validates contradictory or incomplete options", () => {
  expect(parseOptions(["--attach", "th"], { HOME: "/home/test" }).endpoint).toEqual({ transport: "unix", path: "/home/test/.sm-toolkit/agent-server.sock" });
  expect(parseOptions(["--new", "--backend", "codex", "--cwd", "/tmp", "--ws", "ws://127.0.0.1:1234"]).backend).toBe("codex");
  expect(parseOptions(["--attach", "th", "--socket", "/tmp/sock"]).endpoint).toEqual({ transport: "unix", path: "/tmp/sock" });
  for (const args of [[], ["--new"], ["--new", "--backend", "other"], ["--attach", "th", "--new"], ["--attach", "th", "--socket", "x", "--ws", "ws://localhost"], ["--attach", "th", "--cwd", "/tmp"], ["--attach", "th", "--ws", "https://localhost"], ["--unknown"]]) expect(() => parseOptions(args)).toThrow();
});
test("uses daemon XDG resolution without creating or modifying token files", () => {
  expect(parseOptions(["--attach", "th"], { HOME: "/h", XDG_STATE_HOME: "/state", XDG_RUNTIME_DIR: "/run" })).toMatchObject({ endpoint: { path: "/run/sm-toolkit/agent-server.sock" }, tokenPath: "/state/sm-toolkit/agent-server/token" });
  const home = mkdtempSync("/tmp/tui-token-"); const token = join(home, "token");
  try { expect(() => readToken(token)).toThrow("Start the daemon"); writeFileSync(token, "test\n", { mode: 0o640 }); expect(readToken(token)).toBe("test"); expect(statSync(token).mode & 0o777).toBe(0o640); }
  finally { rmSync(home, { recursive: true, force: true }); }
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

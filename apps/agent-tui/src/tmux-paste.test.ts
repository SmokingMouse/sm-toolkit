import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MockEngine } from "@smokingmouse/agent-server";
import { AgentClient } from "@smokingmouse/agent-server/client";
import { resolveDaemonPaths, runDaemon } from "@smokingmouse/agent-server/daemon";

const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;
async function waitFor(check: () => boolean | Promise<boolean>, reason: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`tmux paste: ${reason} timed out after 10000ms`);
    await Bun.sleep(20);
  }
}

async function withTmux(run: (context: {
  home: string; env: NodeJS.ProcessEnv;
  tmux: (args: string[], input?: Buffer) => Promise<string>;
}) => Promise<void>): Promise<void> {
  // The minimal-PATH suite still exercises real tmux installed by Homebrew.
  const executable = Bun.which("tmux") ?? ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].find(existsSync);
  if (!executable) throw new Error("tmux paste regression requires tmux (macOS: brew install tmux)");
  const home = mkdtempSync("/tmp/tui-tmux-");
  const env = { ...process.env, HOME: home, XDG_STATE_HOME: join(home, "state"), XDG_RUNTIME_DIR: home, HERDR_PANE_ID: "", TERM: "xterm-256color", SHELL: "/bin/sh", TMUX: "" };
  const tmux = async (args: string[], input?: Buffer) => {
    const proc = Bun.spawn([executable, "-S", join(home, "tmux.sock"), "-f", "/dev/null", ...args], { env, stdin: input ?? "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`tmux ${args[0]} exit ${code}: ${stderr}`);
    return stdout;
  };
  try { await run({ home, env, tmux }); }
  finally {
    try { await tmux(["kill-server"]); } catch { /* Only this test's unique socket. */ }
    rmSync(home, { recursive: true, force: true });
  }
}

test("P0-1 tmux paste-buffer sends CR inside real bracketed paste framing", async () => {
  await withTmux(async ({ home, tmux }) => {
    const captured = join(home, "stdin.bin"), script = join(home, "dump.ts");
    writeFileSync(captured, "");
    writeFileSync(script, `import { appendFileSync } from "node:fs";
process.stdin.setRawMode(true);
process.stdin.on("data", data => appendFileSync(${JSON.stringify(captured)}, data));
process.stdin.resume();
process.stdout.write("\\x1b[?2004hREADY");
`);
    await tmux(["new-session", "-d", "-x", "140", "-y", "32", `${quote(process.execPath)} ${quote(script)}`]);
    await waitFor(async () => (await tmux(["capture-pane", "-p"])).includes("READY"), "raw input probe ready");
    await tmux(["load-buffer", "-"], Buffer.from("line one\nline two\nline three"));
    await tmux(["paste-buffer", "-p"]);
    await waitFor(() => readFileSync(captured, "utf8").includes("\x1b[201~"), "raw paste bytes captured");
    expect(readFileSync(captured, "utf8")).toBe("\x1b[200~line one\rline two\rline three\x1b[201~");
  });
}, 30_000);

test("P0-1 real tmux paste renders separate lines and sends only LF to daemon", async () => {
  await withTmux(async ({ home, env, tmux }) => {
    const paths = resolveDaemonPaths({ ...env, AGENT_SERVER_SOCKET_PATH: join(home, "agent.sock") });
    const engine = new MockEngine();
    const daemon = await runDaemon({ paths, wsPort: 0, logger: () => {}, serverOptions: { allowedRoots: [home], engineFactory: () => engine, idleTimeoutMs: 0 } });
    let client: AgentClient | undefined;
    try {
      client = await AgentClient.connectUnix({ path: paths.socketPath, token: readFileSync(paths.tokenPath, "utf8").trim(), client: { name: "tmux-test", label: "tmux-test", kind: "test", version: "1" }, reconnect: false });
      const { thread } = await client.request("thread/start", { backend: "claude", cwd: home });
      const command = [process.execPath, resolve(import.meta.dir, "../bin/agent-tui"), "--attach", thread.id, "--socket", paths.socketPath].map(quote).join(" ");
      await tmux(["new-session", "-d", "-x", "140", "-y", "32", command]);
      await waitFor(async () => (await tmux(["capture-pane", "-p"])).includes(thread.id), "TUI attached");
      const text = "def hello():\n    print(1)\n    return 2";
      await tmux(["load-buffer", "-"], Buffer.from(text)); await tmux(["paste-buffer", "-p"]);
      let screen = "";
      await waitFor(async () => { screen = await tmux(["capture-pane", "-p"]); return screen.includes("return 2"); }, "three-line input rendered");
      expect(screen.split("\n").filter(line => /def hello|print\(1\)|return 2/.test(line))).toEqual(["> def hello():", "      print(1)", "      return 2"]);
      expect(engine.sent).toHaveLength(0);
      await tmux(["send-keys", "Enter"]);
      await waitFor(() => engine.sent.length === 1, "paste delivered to daemon engine");
      expect(engine.sent[0].input).toEqual([{ type: "text", text }]);
    } finally { client?.close(); await daemon.shutdown(); }
  });
}, 30_000);

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { AgentClient } from "@smokingmouse/agent-server/client";
import { resolveDaemonPaths } from "@smokingmouse/agent-server/daemon";
import { plain } from "./render.js";

test("P0-2 PTY: SIGKILL daemon, resume same thread, next answer succeeds; closed thread resumes too", async () => {
  const home = mkdtempSync("/tmp/as-recover-");
  // Deliberately do not inherit shell, credential, XDG, Herdr or terminal state.
  const env = { HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, XDG_STATE_HOME: join(home, "state"), TERM: "xterm-256color" };
  const paths = resolveDaemonPaths(env);
  let daemon: ReturnType<typeof Bun.spawn> | undefined, tui: ReturnType<typeof Bun.spawn> | undefined, observer: AgentClient | undefined, screen = "";
  const wait = async (condition: () => boolean, reason: string) => {
    const deadline = Date.now() + 7000;
    while (!condition()) { if (Date.now() > deadline) throw new Error(`${reason}\n${plain(screen).slice(-2000)}`); await Bun.sleep(10); }
  };
  const start = async () => {
    let output = "";
    daemon = Bun.spawn([process.execPath, resolve(import.meta.dir, "fixtures/mock-daemon.ts")], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const collect = async (stream: ReadableStream<Uint8Array>) => { const decoder = new TextDecoder(); for await (const chunk of stream) output += decoder.decode(chunk, { stream: true }); };
    void collect(daemon.stdout as ReadableStream<Uint8Array>); void collect(daemon.stderr as ReadableStream<Uint8Array>);
    await wait(() => output.includes("READY") || daemon!.exitCode !== null, "daemon ready");
    if (!output.includes("READY")) throw new Error(output);
  };
  const frame = () => plain(screen.split("\x1b[H").at(-1) ?? "");
  const write = (text: string) => { screen = ""; tui!.terminal!.write(text); };
  const connect = () => AgentClient.connectUnix({ path: paths.socketPath, token: readFileSync(paths.tokenPath, "utf8").trim(), reconnect: false });
  try {
    await start(); observer = await connect();
    const { thread } = await observer.request("thread/start", { backend: "claude", cwd: home, model: "mock-model" });
    observer.close(); const decoder = new TextDecoder();
    tui = Bun.spawn([process.execPath, resolve(import.meta.dir, "../bin/agent-tui"), "--attach", thread.id, "--socket", paths.socketPath], {
      env, terminal: { cols: 120, rows: 30, data(_terminal, bytes) { screen += decoder.decode(bytes, { stream: true }); } },
    });
    await wait(() => frame().includes("mock-model"), "initial attach");
    for (const prompt of ["first", "second"]) { write(`${prompt}\r`); await wait(() => frame().includes(`ANSWER<${prompt}>`), "answer before kill"); }
    screen = ""; daemon!.kill(9); await daemon!.exited;
    await wait(() => screen.includes("连接中断"), "disconnect detected");
    await start();
    await wait(() => frame().includes("已重连并补齐历史"), "reattached with recovery hint");
    expect(frame()).toContain("可恢复 · /resume"); expect(frame()).toContain(thread.id.slice(0, 11));
    expect(frame().match(/ANSWER<first>/g)).toHaveLength(1); expect(frame().match(/ANSWER<second>/g)).toHaveLength(1);
    write(`/resume ${thread.id}\r`); await wait(() => frame().includes("已切换会话"), "engine resumed");
    write("third\r"); await wait(() => frame().includes("ANSWER<third>"), "post-restart turn completes");
    expect(frame().match(/ANSWER<first>/g)).toHaveLength(1); expect(frame().match(/ANSWER<second>/g)).toHaveLength(1);
    observer = await connect(); await observer.request("thread/close", { threadId: thread.id });
    await wait(() => frame().includes("closed（可恢复"), "closed thread recovery hint");
    write(`/resume ${thread.id}\r`); await wait(() => frame().includes("已切换会话"), "closed engine resumed");
    write("fourth\r"); await wait(() => frame().includes("ANSWER<fourth>"), "closed thread can answer again");
    tui.terminal!.write("\x03\x03"); expect(await tui.exited).toBe(0);
  } finally {
    observer?.close();
    if (tui) { if (tui.exitCode === null) tui.kill(); await tui.exited; tui.terminal?.close(); }
    if (daemon) { if (daemon.exitCode === null) daemon.kill(9); await daemon.exited; }
    rmSync(home, { recursive: true, force: true });
  }
}, 30000);

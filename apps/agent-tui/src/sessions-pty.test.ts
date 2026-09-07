import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { MockEngine } from "@smokingmouse/agent-server";
import { AgentClient } from "@smokingmouse/agent-server/client";
import { resolveDaemonPaths, runDaemon, type RunningDaemon } from "@smokingmouse/agent-server/daemon";
import { shortId } from "./sessions.js";

test("sessions PTY: /new /clear /threads /fork /resume, Ctrl-N Ctrl-T, disconnect sinceSeq and daemon restart", async () => {
  const home = mkdtempSync("/tmp/as-sessions-"), env = { ...process.env, HOME: home, XDG_STATE_HOME: join(home, "state"), XDG_RUNTIME_DIR: "", AGENT_SERVER_SOCKET_PATH: "", HERDR_PANE_ID: "", TERM: "xterm-256color" };
  const paths = resolveDaemonPaths(env), engines: MockEngine[] = [], requests: Array<{ method: string; params: any }> = [];
  let daemon: RunningDaemon | undefined, observer: AgentClient | undefined, proc: ReturnType<typeof Bun.spawn> | undefined, screen = "";
  const wait = async (predicate: () => boolean, reason: string) => {
    const deadline = Date.now() + 6000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error(`${reason}\n${screen.slice(-2500)}`); await Bun.sleep(10); }
  };
  const start = async () => {
    const running = await runDaemon({ paths, graceMs: 10, logger: () => {}, serverOptions: { allowedRoots: [home], idleTimeoutMs: 0, engineFactory: () => { const engine = new MockEngine(); engines.push(engine); return engine; } } });
    const accept = running.manager.accept.bind(running.manager);
    running.manager.accept = peer => {
      const connection = accept(peer), receive = connection.receive.bind(connection);
      let tui = false;
      connection.receive = text => {
        const frame = JSON.parse(text);
        if (frame.method === "initialize") tui = frame.params.client.name === "agent-tui";
        if (tui) requests.push(frame);
        receive(text);
      };
      return connection;
    };
    return running;
  };
  const write = (text: string) => { screen = ""; proc!.terminal!.write(text); };
  const attached = async (id: string) => wait(() => screen.includes(`已切换会话 ${id}`) && screen.includes(shortId(id)), `attached ${id}`);
  const create = async (keys: string) => {
    const count = engines.length; write(keys);
    await wait(() => engines.length === count + 1 && !!engines.at(-1)?.options, `created by ${JSON.stringify(keys)}`);
    const engine = engines.at(-1)!, id = engine.options!.threadId;
    await attached(id);
    expect(engine.options?.cwd).toBe(realpathSync(home)); expect(engine.options?.model).toBe("mock-model");
    return { engine, id };
  };
  try {
    daemon = await start();
    observer = await AgentClient.connectUnix({ path: paths.socketPath, token: readFileSync(paths.tokenPath, "utf8").trim(), reconnect: false });
    const { thread } = await observer.request("thread/start", { backend: "claude", cwd: home, model: "mock-model" });
    const first = engines[0], decoder = new TextDecoder();
    proc = Bun.spawn([resolve(import.meta.dir, "../bin/agent-tui"), "--attach", thread.id, "--socket", paths.socketPath], {
      env, terminal: { cols: 180, rows: 36, data(_terminal, data) { screen += decoder.decode(data, { stream: true }); } },
    });
    await wait(() => screen.includes(shortId(thread.id)) && screen.includes("model mock-model"), "initial status");
    expect(screen).toContain(home); expect(screen).toContain("mock-model");
    write("original prompt\r"); await wait(() => first.sent.length === 1, "first prompt");
    const turnId = first.sent[0].turnId;
    first.emit({ type: "itemStarted", turnId, item: { id: "original-answer", type: "agentMessage", payload: { text: "original history" } } });
    await wait(() => screen.includes("original history"), "original history drawn");
    const second = await create("/new\rhello world" + "/new\r".repeat(9));
    expect(screen).toContain("按键已丢弃");
    expect(screen).not.toContain("> /newhello world");
    expect(second.engine.sent).toHaveLength(0);
    expect(first.closed).toBe(false); expect(first.interrupted).toHaveLength(0); expect(screen).not.toContain("original history");
    await create("/clear\r");
    const fourth = await create("\x0e");
    const forked = await create("/fork\r");
    expect(forked.engine.options?.forkSession).toBe(true);
    expect(forked.engine.options?.engineThreadId).toBe(fourth.engine.engineThreadId!);
    expect(engines.slice(0, -1).every(e => !e.closed)).toBe(true);

    write(`/resume ${thread.id}\r`); await attached(thread.id);
    expect(screen).toContain("original history");
    write("/threads\r"); await wait(() => screen.includes("会话选择") && screen.includes("original prompt"), "threads selector with first prompt");
    expect(screen).toContain("running"); expect(screen).toContain(home); expect(screen).toMatch(/\d{4}-\d{2}-\d{2}T/);
    const countBeforeCancel = requests.filter(r => r.method === "thread/attach").length;
    write("\x1b"); await wait(() => screen.includes("Ctrl-N 新建"), "Esc cancels picker");
    expect(requests.filter(r => r.method === "thread/attach")).toHaveLength(countBeforeCancel);
    for (const keys of ["/resume\r", "\x14"]) {
      write(keys); await wait(() => screen.includes("会话选择"), "resume/Ctrl-T picker");
      const selection = screen.match(/> (th_[a-z0-9-]+)/)?.[1]; expect(selection).toBeDefined();
      write("\x1b[B"); await wait(() => screen.includes("会话选择"), "down");
      write("\x1b[A"); await wait(() => screen.includes(`> ${selection}`), "up returns to first");
      write("\r"); await wait(() => screen.includes("已切换会话") && screen.includes(selection!), "Enter attaches selection");
    }
    write(`/resume ${thread.id}\r`); await attached(thread.id);
    observer.close(); daemon.manager.close();
    first.emit({ type: "itemCompleted", turnId, item: { id: "original-answer", type: "agentMessage", payload: { text: "completed while offline" } } });
    await wait(() => screen.includes("已重连并恢复会话") && screen.includes("completed while offline"), "disconnect replay");
    expect(requests.some(r => r.method === "thread/attach" && r.params.threadId === thread.id && r.params.sinceSeq > 0)).toBe(true);
    expect(first.spawnCount).toBe(1);
    const beforeRestart = requests.length, engineCount = engines.length;
    screen = ""; await daemon.shutdown("restart_test"); daemon = await start();
    await wait(() => screen.includes("已重连并补齐历史") && screen.includes(shortId(thread.id)), "same thread after daemon restart");
    expect(screen).toContain("可恢复 · /resume");
    expect(requests.slice(beforeRestart).filter(r => r.method === "thread/attach").map(r => r.params.threadId)).toEqual([thread.id]);
    expect(requests.slice(beforeRestart).some(r => r.method === "thread/attach" && r.params.sinceSeq > 0)).toBe(true);
    expect(screen).toContain("completed while offline"); expect(engines).toHaveLength(engineCount);
    write(`/resume ${thread.id}\r`); await attached(thread.id);
    expect(engines).toHaveLength(engineCount + 1);
    write("after restart\r"); await wait(() => engines.at(-1)!.sent.length === 1, "new turn after restart reaches resumed engine");
    const resumed = engines.at(-1)!;
    resumed.emit({ type: "itemStarted", turnId: resumed.sent[0].turnId, item: { id: "resumed-answer", type: "agentMessage", payload: { text: "" } } });
    resumed.emit({ type: "itemCompleted", turnId: resumed.sent[0].turnId, item: { id: "resumed-answer", type: "agentMessage", payload: { text: "ANSWER AFTER RESTART" } } });
    await wait(() => screen.includes("ANSWER AFTER RESTART"), "resumed engine streams answer");
    expect(requests.filter(r => r.method === "turn/start")).toHaveLength(2);
    expect(requests.some(r => r.method === "thread/close")).toBe(false);
    expect(requests.some(r => r.method === "thread/detach" && r.params.threadId === second.id)).toBe(true);
    proc.terminal!.write("\x03\x03"); expect(await proc.exited).toBe(0);
  } finally {
    if (proc) { if (proc.exitCode === null) proc.kill(); await proc.exited; proc.terminal?.close(); }
    observer?.close(); await daemon?.shutdown(); rmSync(home, { recursive: true, force: true });
  }
}, 30000);

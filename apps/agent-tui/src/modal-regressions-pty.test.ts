import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { MockEngine } from "@smokingmouse/agent-server";
import { AgentClient } from "@smokingmouse/agent-server/client";
import { resolveDaemonPaths, runDaemon } from "@smokingmouse/agent-server/daemon";
import type { PendingServerRequest } from "@smokingmouse/agent-server/protocol";
import { shortId } from "./sessions.js";

async function harness() {
  const home = mkdtempSync("/tmp/tui-modal-regression-");
  const env = { ...process.env, HOME: home, XDG_STATE_HOME: join(home, "state"), XDG_RUNTIME_DIR: "", AGENT_SERVER_SOCKET_PATH: "", HERDR_PANE_ID: "", TERM: "xterm-256color" };
  const paths = resolveDaemonPaths(env), engines: MockEngine[] = [], requests: any[] = [], held: Array<() => void> = [];
  let screen = "", stall: (message: any) => boolean = () => false;
  const daemon = await runDaemon({ paths, graceMs: 10, logger: () => {}, serverOptions: { allowedRoots: [home], idleTimeoutMs: 0, engineFactory: () => { const engine = new MockEngine(); engines.push(engine); return engine; } } });
  const accept = daemon.manager.accept.bind(daemon.manager);
  daemon.manager.accept = peer => {
    let tui = false;
    const connection = accept(peer), receive = connection.receive.bind(connection);
    connection.receive = text => {
      const message = JSON.parse(text);
      if (message.method === "initialize") tui = message.params.client.name === "agent-tui";
      if (tui) requests.push(message);
      if (tui && stall(message)) held.push(() => receive(text)); else receive(text);
    };
    return connection;
  };
  const phone = await AgentClient.connectUnix({ path: paths.socketPath, token: readFileSync(paths.tokenPath, "utf8").trim(), reconnect: false });
  const { thread: closed } = await phone.request("thread/start", { backend: "claude", cwd: home });
  await phone.request("thread/close", { threadId: closed.id });
  const { thread } = await phone.request("thread/start", { backend: "claude", cwd: home });
  const engine = engines.at(-1)!;
  const decoder = new TextDecoder();
  const proc = Bun.spawn([resolve(import.meta.dir, "../bin/agent-tui"), "--attach", thread.id, "--socket", paths.socketPath], { env, terminal: { cols: 180, rows: 36, data(_t, data) { screen += decoder.decode(data, { stream: true }); } } });
  const frame = () => screen.slice(screen.lastIndexOf("\x1b[H")).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
  const wait = async (predicate: () => boolean, why: string, timeout = 6000) => {
    const deadline = Date.now() + timeout;
    while (!predicate()) { if (Date.now() > deadline) throw new Error(`${why}\n${frame()}`); await Bun.sleep(10); }
  };
  const write = (keys: string) => { screen = ""; proc.terminal!.write(keys); };
  const cleanup = async () => { if (proc.exitCode === null) proc.kill(); await proc.exited; proc.terminal?.close(); phone.close(); await daemon.shutdown(); rmSync(home, { recursive: true, force: true }); };
  try {
    await wait(() => frame().includes(shortId(thread.id)) && frame().endsWith("> "), "initial frame");
    write("go\r"); await wait(() => engine.sent.length === 1 && frame().includes("已发送"), "turn ready");
    const turnId = engine.sent[0].turnId;
    engine.emit({ type: "itemStarted", turnId, item: { id: "tool", type: "toolCall", payload: { name: "ask", input: {} } } });
    await wait(() => frame().includes("Tool ask"), "valid tool item");
    const card = (questions: boolean, id: string, respond: (result: any) => void) => {
      const params = { threadId: thread.id, turnId, itemId: "tool", requestId: id, startedAtMs: Date.now() };
      const request: PendingServerRequest = questions
        ? { method: "item/tool/requestUserInput", params: { ...params, isBlocking: true, questions: [{ id: "q", question: "Answer?" }] } }
        : { method: "item/commandExecution/requestApproval", params: { ...params, command: "rm -rf /important", cwd: home } };
      engine.emit({ type: "approval", request, respond });
    };
    return { home, engine, phone, thread, closed, turnId, requests, held, stall: (fn: typeof stall) => { stall = fn; }, frame, write, wait, card, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

for (const confirmation of ["rewind", "resume"]) test(`fn-review2 P1-1 / cmds-review P1-1 PTY: card preempts ${confirmation}, stale y never confirms it`, async () => {
  const h = await harness();
  try {
    h.write(confirmation === "rewind" ? "/rewind native-uuid \r" : `/resume ${h.closed.id} \r`);
    await h.wait(() => h.frame().includes("[y/N]"), "confirmation visible");
    let decision: any;
    h.card(false, "approval", value => { decision = value; });
    await h.wait(() => h.frame().includes("Action Required") && h.frame().includes("已取消回滚/恢复确认"), "card cancels old confirmation");
    expect(h.frame()).not.toContain("[y/N]");
    h.write("y"); await h.wait(() => !!decision && !h.frame().includes("Action Required"), "approval only");
    expect(decision).toEqual({ decision: "accept" });
    h.write("y"); await h.wait(() => h.frame().endsWith("> y"), "next y is visible message draft");
    expect(h.requests.filter(r => r.method === "thread/engineControl" || r.method === "thread/resume")).toHaveLength(0);
    expect(h.engine.sent).toHaveLength(1);
  } finally { await h.cleanup(); }
}, 15000);

test("fn-review2 P1-2 PTY: question edits during acquire/sending survive timeout only in card context", async () => {
  const h = await harness();
  try {
    let response: any;
    h.card(true, "question", value => { response = value; });
    await h.wait(() => h.frame().includes("Answer?"), "question shown");
    h.stall(() => true);
    h.write("我的回答\r"); await h.wait(() => h.held.length === 1, "acquire held");
    h.write("补充说明"); await h.wait(() => h.frame().includes("> 我的回答补充说明"), "acquire edit stays on card");
    h.held.shift()!();
    await h.wait(() => h.held.length === 1 && h.frame().includes("等待服务器确认"), "sending held");
    h.stall(message => !message.method); // Hold the answer, allow lease cleanup.
    h.write("后续\r\r"); await h.wait(() => h.frame().includes("> 我的回答补充说明后续"), "sending edits and repeated Enter isolated");
    await h.wait(() => h.frame().includes("回复超时"), "timeout fallback", 6500);
    expect(h.frame()).toContain("> 我的回答补充说明后续");
    expect(h.requests.filter(r => r.method === "turn/start")).toHaveLength(1);
    h.stall(() => false);
    while (h.held.length) h.held.shift()!();
    await h.wait(() => !!response && !h.frame().includes("Action Required"), "late confirmation");
    expect(response).toEqual({ answers: { q: { answers: ["我的回答"] } } });
    expect(h.frame()).toMatch(/> $/);
    h.write("\r"); await Bun.sleep(100);
    expect(h.requests.filter(r => r.method === "turn/start")).toHaveLength(1);
  } finally { await h.cleanup(); }
}, 20000);

test("fn-review2 P2-1 PTY: card keeps view shortcuts, thread scan and emergency stop usable", async () => {
  const h = await harness();
  try {
    h.engine.emit({ type: "itemStarted", turnId: h.turnId, item: { id: "reason", type: "reasoning", payload: { text: "reasoning-visible" } } });
    h.engine.emit({ type: "itemStarted", turnId: h.turnId, item: { id: "plan", type: "plan", payload: { text: "plan-visible" } } });
    h.engine.emit({ type: "engineEvent", backend: "claude", subtype: "fixture-log", payload: { text: "log-entry" } });
    h.card(false, "approval", () => {});
    await h.wait(() => h.frame().includes("Action Required"), "card shown");
    h.write("\x0c"); await h.wait(() => h.frame().includes("展开 · Ctrl-L") && h.frame().includes("fixture-log"), "Ctrl-L displays log during card");
    h.write("\x1b[17~"); await h.wait(() => !h.frame().includes("Ctrl-L /log [焦点]"), "F6 changes panel focus");
    h.write("\x12"); await h.wait(() => h.frame().includes("reasoning-visible"), "Ctrl-R unfolds reasoning");
    h.write("\x10"); await h.wait(() => h.frame().includes("Plan: [折叠"), "Ctrl-P folds plan");
    h.write("\x0e"); await h.wait(() => h.frame().includes("Ctrl-N 新建会话会离开卡片"), "Ctrl-N explicit semantic exception");
    h.write("\x14"); await h.wait(() => h.frame().includes("已加载 2 个会话"), "Ctrl-T scans while card owns input");
    expect(h.frame()).toContain("Action Required"); expect(h.frame()).not.toContain("会话选择 ·");
    const count = h.requests.filter(r => ["thread/attach", "thread/fork", "turn/start"].includes(r.method)).length;
    h.write("\r\r"); await Bun.sleep(80);
    expect(h.requests.filter(r => ["thread/attach", "thread/fork", "turn/start"].includes(r.method))).toHaveLength(count);
    h.write("\x03"); await h.wait(() => h.engine.interrupted.includes(h.turnId), "Ctrl-C interrupts");
  } finally { await h.cleanup(); }
}, 20000);

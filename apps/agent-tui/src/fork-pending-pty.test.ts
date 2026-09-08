import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { MockEngine } from "@smokingmouse/agent-server";
import { AgentClient } from "@smokingmouse/agent-server/client";
import { resolveDaemonPaths, runDaemon, type RunningDaemon } from "@smokingmouse/agent-server/daemon";
import { shortId } from "./sessions.js";

for (const midThreadFork of [true, false]) test(`protocol PTY: pending state withdrawal/count/reconnect and fork picker/direct/origin (midThreadFork=${midThreadFork})`, async () => {
  const home = mkdtempSync("/tmp/as-fork-pending-"), env = { ...process.env, HOME: home, XDG_STATE_HOME: join(home, "state"), XDG_RUNTIME_DIR: "", AGENT_SERVER_SOCKET_PATH: "", HERDR_PANE_ID: "", TERM: "xterm-256color" };
  const paths = resolveDaemonPaths(env), engines: MockEngine[] = [], requests: any[] = [], notifications: any[] = [];
  let daemon: RunningDaemon | undefined, phone: AgentClient | undefined, proc: ReturnType<typeof Bun.spawn> | undefined, screen = "";
  const frame = () => screen.slice(screen.lastIndexOf("\x1b[H")).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
  const wait = async (predicate: () => boolean, reason: string) => {
    const deadline = Date.now() + 6000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error(`${reason}\n${frame()}`); await Bun.sleep(10); }
  };
  const write = (keys: string) => { screen = ""; proc!.terminal!.write(keys); };
  try {
    daemon = await runDaemon({ paths, graceMs: 10, logger: () => {}, serverOptions: { allowedRoots: [home], idleTimeoutMs: 0, engineFactory: () => { const e = new MockEngine(); engines.push(e); return e; } } });
    // Exercise new notifications alone and simulate an older daemon capability response.
    const accept = daemon.manager.accept.bind(daemon.manager);
    daemon.manager.accept = peer => {
      let tui = false;
      const connection = accept({ end: () => peer.end(), send(text) {
        const message = JSON.parse(text);
        if (tui && message.result?.protocolVersion) message.result.capabilities.midThreadFork = midThreadFork;
        if (tui && message.method) {
          if (["serverRequest/resolved", "serverRequest/expired"].includes(message.method)) return;
          notifications.push(message);
        }
        peer.send(JSON.stringify(message));
      } });
      const receive = connection.receive.bind(connection);
      connection.receive = text => {
        const message = JSON.parse(text);
        if (message.method === "initialize") tui = message.params.client.name === "agent-tui";
        if (tui) requests.push(message);
        receive(text);
      };
      return connection;
    };
    phone = await AgentClient.connectUnix({ path: paths.socketPath, token: readFileSync(paths.tokenPath, "utf8").trim(), reconnect: false, client: { name: "phone", kind: "test", version: "1", label: "测试手机" }, capabilities: { pendingRequests: true, serverRequests: ["item/commandExecution/requestApproval"] } });
    const { thread } = await phone.request("thread/start", { backend: "claude", cwd: home });
    const decoder = new TextDecoder();
    proc = Bun.spawn([resolve(import.meta.dir, "../bin/agent-tui"), "--attach", thread.id, "--socket", paths.socketPath], { env, terminal: { cols: 180, rows: 36, data(_terminal, data) { screen += decoder.decode(data, { stream: true }); } } });
    await wait(() => frame().includes(shortId(thread.id)) && frame().endsWith("> "), "first raw-input frame");
    expect(requests.find(r => r.method === "initialize").params.capabilities.pendingRequests).toBe(true);
    write("source prompt\r"); await wait(() => engines[0].sent.length === 1, "turn delivered");
    const source = engines[0], turnId = source.sent[0].turnId;
    for (const [id, text] of [["middle-item-123456789", "MIDDLE SUMMARY"], ["tail-item-123456789", "TAIL SUMMARY"]]) {
      source.emit({ type: "itemStarted", turnId, item: { id, type: "agentMessage", payload: { text } } });
      source.emit({ type: "itemCompleted", turnId, item: { id, type: "agentMessage", payload: { text } } });
    }
    await wait(() => frame().includes("TAIL SUMMARY"), "history delivered");
    const approval = (requestId: string) => source.emit({ type: "approval", request: { method: "item/commandExecution/requestApproval", params: { threadId: thread.id, turnId, itemId: "middle-item-123456789", requestId, startedAtMs: Date.now(), command: `echo ${requestId}`, cwd: home } }, respond: () => {} });
    approval("other-client");
    await wait(() => frame().includes("Command: echo other-client") && phone!.pendingRequests.has("other-client"), "pending approval");
    expect(frame()).toContain("待处理 1"); expect(frame()).toContain("y 允许");
    phone.pendingRequests.get("other-client")!.respond({ decision: "accept" });
    await wait(() => frame().includes("已由 测试手机 处理") && frame().includes("待处理 0"), "new notification withdraws card");
    expect(frame()).not.toContain("y 允许"); expect(frame()).not.toContain("Action Required");
    expect(notifications.some(n => n.method === "thread/pendingRequests" && n.params.status === "resolved")).toBe(true);
    // A literal approval shortcut now goes to the input draft, not a second response.
    write("y"); await wait(() => frame().endsWith("> y"), "withdrawn shortcut is normal input"); write("\x7f");
    await wait(() => frame().endsWith("> "), "draft cleared before next approval arrives");
    for (const reason of ["timeout", "turn_interrupted"]) {
      approval(reason); await wait(() => frame().includes(`Command: echo ${reason}`), "expiring card visible");
      source.emit({ type: "approvalExpired", turnId, requestId: reason, reason });
      await wait(() => frame().includes(reason === "timeout" ? "请求超时" : "请求已撤回") && frame().includes("待处理 0"), "expiry notice");
      expect(frame()).not.toContain("y 允许");
    }
    approval("survives-reconnect"); await wait(() => frame().includes("Command: echo survives-reconnect"), "pending before reconnect");
    const priorAttach = requests.filter(r => r.method === "thread/attach").length;
    daemon.manager.close();
    await wait(() => requests.filter(r => r.method === "thread/attach").length > priorAttach && frame().includes("已重连并恢复会话") && frame().includes("Command: echo survives-reconnect"), "attach snapshot restores pending card");
    expect(frame()).toContain("待处理 1"); expect(frame()).toContain("y 允许");
    source.emit({ type: "approvalExpired", turnId, requestId: "survives-reconnect", reason: "turn_interrupted" });
    source.emit({ type: "turnCompleted", turnId, status: "completed" });
    await wait(() => frame().includes("待处理 0") && frame().includes("claude idle"), "turn idle");

    write("/fork \r"); await wait(() => frame().includes("分叉 item 选择"), "fork picker");
    if (midThreadFork) {
      expect(frame()).toContain("agentMessage | Agent: MIDDLE SUMMARY"); expect(frame()).toContain("userMessage");
      expect(frame().indexOf("userMessage")).toBeLessThan(frame().indexOf("MIDDLE SUMMARY"));
      write("\x1b[B"); await wait(() => frame().includes(`> #3 ${shortId("middle-item-123456789")}`), "select middle item");
    } else {
      expect(frame()).toContain("当前 daemon 不支持从中间分叉"); expect(frame()).toContain("末尾分叉"); expect(frame()).not.toContain("#2");
    }
    write("\r"); await wait(() => engines.length === 2 && frame().includes(`已切换会话 ${engines[1].options?.threadId}`), "fork attaches branch");
    const forkRequest = requests.find(r => r.method === "thread/fork");
    expect(forkRequest.params.fromItemId).toBe(midThreadFork ? "middle-item-123456789" : undefined);
    expect(engines[1].options?.seedHistory?.map(i => i.id)).toContain("middle-item-123456789");
    expect(engines[1].options?.seedHistory?.some(i => i.id === "tail-item-123456789")).toBe(!midThreadFork);
    const originItem = midThreadFork ? "middle-item-123456789" : "tail-item-123456789";
    write("/threads \r"); await wait(() => frame().includes("会话选择") && frame().includes(`forkedFrom ${shortId(thread.id)} / ${shortId(originItem)}`), "threads shows origin");
    write("\x1b"); await wait(() => frame().includes("Ctrl-N 新建"), "cancel threads");
    write(`/resume ${thread.id}\r`); await wait(() => frame().includes(`已切换会话 ${thread.id}`), "return source");
    const count = requests.filter(r => r.method === "thread/fork").length;
    write("/fork middle-item-123456789\r");
    if (midThreadFork) {
      await wait(() => engines.length === 3 && frame().includes(`已切换会话 ${engines[2].options?.threadId}`), "direct fork switches");
      expect(requests.filter(r => r.method === "thread/fork").at(-1).params.fromItemId).toBe("middle-item-123456789");
    } else {
      await wait(() => frame().includes("当前 daemon 不支持从中间分叉"), "direct unsupported shows fallback");
      expect(requests.filter(r => r.method === "thread/fork")).toHaveLength(count);
      write("\x1b"); await wait(() => frame().includes("Ctrl-N 新建"), "cancel unsupported fork");
    }
    proc.terminal!.write("\x03\x03"); expect(await proc.exited).toBe(0);
  } finally {
    if (proc) { if (proc.exitCode === null) proc.kill(); await proc.exited; proc.terminal?.close(); }
    phone?.close(); await daemon?.shutdown(); rmSync(home, { recursive: true, force: true });
  }
}, 25000);

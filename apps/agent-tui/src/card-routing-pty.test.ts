import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { MockEngine } from "@smokingmouse/agent-server";
import { AgentClient } from "@smokingmouse/agent-server/client";
import { resolveDaemonPaths, runDaemon, type RunningDaemon } from "@smokingmouse/agent-server/daemon";
import type { PendingServerRequest } from "@smokingmouse/agent-server/protocol";
import { shortId } from "./sessions.js";

for (const questions of [false, true]) for (const picker of [false, true]) {
  test(`P1-1 PTY: repeated Enter stays on ${questions ? "question" : "approval"} card over ${picker ? "fork picker" : "input"}`, async () => {
    const home = mkdtempSync("/tmp/as-card-routing-");
    const env = { ...process.env, HOME: home, XDG_STATE_HOME: join(home, "state"), XDG_RUNTIME_DIR: "", AGENT_SERVER_SOCKET_PATH: "", HERDR_PANE_ID: "", TERM: "xterm-256color" };
    const paths = resolveDaemonPaths(env), engine = new MockEngine(), requests: any[] = [], held: Array<() => void> = [];
    let stall = false, screen = "", daemon: RunningDaemon | undefined, phone: AgentClient | undefined, proc: ReturnType<typeof Bun.spawn> | undefined;
    const frame = () => screen.slice(screen.lastIndexOf("\x1b[H")).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
    const wait = async (predicate: () => boolean, reason: string) => {
      const deadline = Date.now() + 6000;
      while (!predicate()) { if (Date.now() > deadline) throw new Error(`${reason}\n${frame()}`); await Bun.sleep(10); }
    };
    const write = (keys: string) => { screen = ""; proc!.terminal!.write(keys); };
    try {
      daemon = await runDaemon({ paths, graceMs: 10, logger: () => {}, serverOptions: { allowedRoots: [home], idleTimeoutMs: 0, engineFactory: () => engine } });
      const accept = daemon.manager.accept.bind(daemon.manager);
      daemon.manager.accept = peer => {
        let tui = false;
        const connection = accept(peer), receive = connection.receive.bind(connection);
        connection.receive = text => {
          const message = JSON.parse(text);
          if (message.method === "initialize") tui = message.params.client.name === "agent-tui";
          if (tui) requests.push(message);
          if (tui && stall) held.push(() => receive(text));
          else receive(text);
        };
        return connection;
      };
      phone = await AgentClient.connectUnix({ path: paths.socketPath, token: readFileSync(paths.tokenPath, "utf8").trim(), reconnect: false, client: { name: "phone", kind: "test", version: "1", label: "测试手机" } });
      const { thread } = await phone.request("thread/start", { backend: "claude", cwd: home });
      const decoder = new TextDecoder();
      proc = Bun.spawn([resolve(import.meta.dir, "../bin/agent-tui"), "--attach", thread.id, "--socket", paths.socketPath], { env, terminal: { cols: 180, rows: 32, data(_terminal, data) { screen += decoder.decode(data, { stream: true }); } } });
      await wait(() => frame().includes(shortId(thread.id)) && frame().endsWith("> "), "initial frame");
      write("go\r"); await wait(() => engine.sent.length === 1 && frame().includes("已发送"), "turn delivered and lease released");
      const turnId = engine.sent[0].turnId;
      for (const id of ["middle", "tail"]) {
        engine.emit({ type: "itemStarted", turnId, item: { id, type: "agentMessage", payload: { text: id } } });
        engine.emit({ type: "itemCompleted", turnId, item: { id, type: "agentMessage", payload: { text: id } } });
      }
      await wait(() => frame().includes("Agent: tail"), "history delivered");
      if (picker) { write("/fork \r"); await wait(() => frame().includes("分叉 item 选择"), "fork picker opened"); }
      else { write("/fork middle"); await wait(() => frame().endsWith("> /fork middle"), "fork command drafted"); }
      const params = { threadId: thread.id, turnId, itemId: "middle", requestId: "card", startedAtMs: Date.now() };
      const request: PendingServerRequest = questions
        ? { method: "item/tool/requestUserInput", params: { ...params, isBlocking: true, questions: [{ id: "q", question: "Answer?" }] } }
        : { method: "item/commandExecution/requestApproval", params: { ...params, command: "rm -rf /important", cwd: home } };
      engine.emit({ type: "approval", request, respond: () => {} });
      await wait(() => frame().includes("Action Required"), "card owns screen");
      expect(frame()).not.toContain("分叉 item 选择");
      const transitions = () => requests.filter(r => ["thread/fork", "thread/attach", "thread/detach", "turn/start"].includes(r.method));
      const before = transitions().length;
      stall = true;
      write(questions ? "answer\r" : "y");
      await wait(() => held.length === 1, "lease acquisition held");
      expect(requests.at(-1).method).toBe("thread/lease/acquire");
      write("\r\r\r"); await wait(() => frame().includes("Action Required"), "Enter handled during lease acquisition");
      await Bun.sleep(100);
      expect(transitions()).toHaveLength(before);
      held.shift()!();
      await wait(() => held.length === 1 && frame().includes("等待服务器确认"), "response held in sending state");
      write("\r\r\r"); await wait(() => frame().includes("等待服务器确认"), "Enter handled during confirmation");
      await Bun.sleep(100);
      expect(transitions()).toHaveLength(before);
      expect(frame()).toContain(shortId(thread.id));
      stall = false; held.shift()!();
      await wait(() => frame().includes("待处理 0") && !frame().includes("Action Required"), "card resolved");
      await Bun.sleep(100);
      expect(transitions()).toHaveLength(before);
      expect(frame()).toContain(shortId(thread.id));
      if (picker) expect(frame()).toContain("分叉 item 选择");
      else expect(frame()).toContain("> /fork middle");
      proc.terminal!.write("\x03\x03"); expect(await proc.exited).toBe(0);
    } finally {
      if (proc) { if (proc.exitCode === null) proc.kill(); await proc.exited; proc.terminal?.close(); }
      phone?.close(); await daemon?.shutdown(); rmSync(home, { recursive: true, force: true });
    }
  }, 20000);
}

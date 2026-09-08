import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TuiModel } from "./model.js";
import { plain } from "./render.js";

export type AgentState = "working" | "idle" | "blocked";
export function herdrSocket(env: NodeJS.ProcessEnv = process.env): string {
  return env.HERDR_SOCKET_PATH || join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "herdr", "herdr.sock");
}
export function title(threadId: string, backend: string, state: AgentState): string {
  const prefix = state === "working" ? "⠋ " : state === "blocked" ? "Action Required · " : backend === "claude" ? "✳ " : "";
  return `\x1b]0;${prefix}agent-tui ${plain(threadId).replace(/\n/g, " ")}\x07`;
}

/** Herdr protocol 19 is newline JSON with string id, method, params (not JSON-RPC). */
export function report(path: string, method: string, params: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const socket = createConnection({ path }); let buffer = "", settled = false;
    const finish = (error?: Error) => { if (settled) return; settled = true; socket.destroy(); error ? reject(error) : resolve(); };
    socket.setTimeout(750, () => finish(new Error("Herdr socket timed out")));
    socket.on("error", finish); socket.on("end", () => finish(new Error("Herdr closed without a response")));
    socket.on("connect", () => socket.write(JSON.stringify({ id, method, params }) + "\n"));
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk;
      if (buffer.length > 65536) { finish(new Error("Herdr response too large")); return; }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try { const response = JSON.parse(line); if (response.id === id) finish(response.error ? new Error(response.error.message ?? "Herdr rejected report") : undefined); }
        catch { finish(new Error("Invalid Herdr response")); }
      }
    });
  });
}

export function startHerdr(model: TuiModel, write: (text: string) => void, env: NodeJS.ProcessEnv = process.env): () => Promise<void> {
  if (!env.HERDR_PANE_ID) return async () => {};
  const path = herdrSocket(env), pane = env.HERDR_PANE_ID;
  let stopped = false, lastTitle = "", reported = "", running = false, sequence = Date.now() * 1000;
  let work: Promise<void> = Promise.resolve();
  const update = () => {
    if (stopped || !model.thread) return;
    const thread = model.thread, state = model.agentState;
    const nextTitle = title(thread.id, thread.backend, state);
    if (lastTitle !== nextTitle) { write(nextTitle); lastTitle = nextTitle; }
    const key = `${thread.id}:${state}`;
    if (reported === key || running) return;
    running = true;
    const common = { pane_id: pane, source: "agent-tui", agent: thread.backend, agent_session_id: thread.id };
    work = (async () => {
      try {
        await report(path, "pane.report_agent", { ...common, seq: ++sequence, state });
        await report(path, "pane.report_agent_session", { ...common, seq: ++sequence, session_start_source: "attach" });
        reported = key;
      } catch (error) {
        model.message = `Herdr: ${error instanceof Error ? error.message : String(error)}`; model.changed();
      } finally { running = false; }
      if (!stopped && reported === key && `${model.thread?.id}:${model.agentState}` !== key) update();
    })();
  };
  write("\x1b[22;0t");
  const unsubscribe = model.onChange(update), heartbeat = setInterval(() => { reported = ""; update(); }, 10_000);
  update();
  return async () => { stopped = true; unsubscribe(); clearInterval(heartbeat); await work; write("\x1b[23;0t"); };
}

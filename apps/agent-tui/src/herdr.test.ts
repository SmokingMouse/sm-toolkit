import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { herdrSocket, report, startHerdr, title } from "./herdr.js";
import { TuiModel } from "./model.js";

test("Herdr socket priority and local Claude/Codex OSC detection conventions", () => {
  expect(herdrSocket({ HOME: "/home/test" })).toBe("/home/test/.config/herdr/herdr.sock");
  expect(herdrSocket({ HOME: "/home/test", XDG_CONFIG_HOME: "/config" })).toBe("/config/herdr/herdr.sock");
  expect(herdrSocket({ HERDR_SOCKET_PATH: "/sock", XDG_CONFIG_HOME: "/config" })).toBe("/sock");
  expect(title("th", "claude", "working")).toBe("\x1b]0;⠋ agent-tui th\x07");
  expect(title("th", "claude", "idle")).toBe("\x1b]0;✳ agent-tui th\x07");
  expect(title("th", "codex", "blocked")).toContain("Action Required");
  expect(title("th\x07injected\n", "codex", "idle")).toBe("\x1b]0;agent-tui thinjected \x07");
});

test("registers agent and AS thread using Herdr schema, serializes status changes, restores title", async () => {
  const home = mkdtempSync("/tmp/tui-herdr-"); const path = join(home, "sock");
  const requests: Array<{ id: string; method: string; params: Record<string, unknown> }> = [];
  const server = createServer(socket => {
    let buffer = ""; socket.setEncoding("utf8");
    socket.on("data", data => { buffer += data; if (!buffer.includes("\n")) return; const r = JSON.parse(buffer.trim()); requests.push(r); socket.end(JSON.stringify({ id: r.id, result: {} }) + "\n"); });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  const model = new TuiModel(); model.connection = "connected";
  model.thread = { id: "th_demo", engineThreadId: "native-id", backend: "claude", status: { type: "idle" }, cwd: "/tmp", createdAtMs: 0 };
  const output: string[] = []; const stop = startHerdr(model, t => output.push(t), { HERDR_PANE_ID: "pane_test", HERDR_SOCKET_PATH: path });
  const wait = async (n: number) => { const end = Date.now() + 2000; while (requests.length < n) { if (Date.now() > end) throw new Error("reports timed out"); await Bun.sleep(5); } };
  try {
    await wait(2);
    expect(requests.map(r => r.method)).toEqual(["pane.report_agent", "pane.report_agent_session"]);
    expect(requests[0].params).toMatchObject({ pane_id: "pane_test", agent: "claude", source: "agent-tui", state: "idle", agent_session_id: "th_demo" });
    expect(requests[1].params.agent_session_id).toBe("th_demo");
    model.thread.status = { type: "running" }; model.changed(); await wait(4);
    expect(requests[2].params.state).toBe("working"); expect(output.some(s => s.includes("⠋"))).toBe(true);
    model.connection = "disconnected"; model.changed(); await wait(6);
    expect(requests[4].params.state).toBe("blocked"); expect(output.some(s => s.includes("Action Required"))).toBe(true);
    expect(requests.every(r => typeof r.id === "string")).toBe(true);
    expect(requests.map(r => r.params.seq)).toEqual([...requests.map(r => r.params.seq)].sort());
  } finally { await stop(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(home, { recursive: true, force: true }); }
  expect(output[0]).toBe("\x1b[22;0t"); expect(output.at(-1)).toBe("\x1b[23;0t");
});
test("outside Herdr is a no-op and absent Herdr fails explicitly without stopping TUI", async () => {
  const model = new TuiModel(); const output: string[] = [];
  await startHerdr(model, t => output.push(t), {})(); expect(output).toEqual([]);
  await expect(report(`/tmp/no-herdr-${crypto.randomUUID()}`, "pane.report_agent", {})).rejects.toThrow();
});

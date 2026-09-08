import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const keys = {
  y: "y", n: "n", s: "s", a: "a", text: "Z", digit: "1", enter: "\r", escape: "\x1b", tab: "\t", shiftTab: "\x1b[Z",
  up: "\x1b[A", down: "\x1b[B", pageup: "\x1b[5~", pagedown: "\x1b[6~", backspace: "\x7f", clear: "\x15",
  paste: "\x1b[200~y\nZ\x1b[201~", newline: "\n", log: "\x0c", f6: "\x1b[17~", reasoning: "\x12", plan: "\x10", threads: "\x14", new: "\x0e", interrupt: "\x03",
};
const modes = ["approval-card", "question-card", "approval-card-sending", "question-card-sending", "rewind", "resume", "threads", "fork", "permissions", "completion", "busy", "input"];

for (const mode of modes) test(`modal penetration PTY matrix: ${mode} × ${Object.keys(keys).join("/")}`, async () => {
  const home = mkdtempSync("/tmp/tui-matrix-");
  try {
    for (const [key, bytes] of Object.entries(keys)) {
      const output = join(home, `${key}.json`);
      let screen = "";
      const decoder = new TextDecoder();
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/modal-terminal.ts"), mode, output], {
        env: { ...process.env, HOME: home, TERM: "xterm-256color" },
        terminal: { cols: 180, rows: 32, data(_t, data) { screen += decoder.decode(data, { stream: true }); } },
      });
      const read = (): any => JSON.parse(readFileSync(output, "utf8"));
      const wait = async (predicate: () => boolean) => {
        const deadline = Date.now() + 4000;
        while (!predicate()) { if (Date.now() > deadline) throw new Error(`${mode}/${key}: timeout\n${screen}`); await Bun.sleep(5); }
      };
      try {
        await wait(() => existsSync(output) && screen.includes("\x1b[H"));
        const before = read();
        proc.terminal!.write(bytes);
        await wait(() => read().revision > before.revision);
        await Bun.sleep(25); // Settle fixture RPC microtasks and scheduled frame.
        const state = read(), methods: string[] = state.calls.map((c: any) => c.method);
        const card = mode.includes("card"), sending = mode.includes("sending");
        const expected: string[] = [];
        if (key === "interrupt") expected.push("turn/interrupt");
        else if (key === "threads" && mode !== "busy") expected.push("thread/list", "thread/items/list");
        else if (key === "new" && !card && mode !== "busy") expected.push("thread/start", "thread/attach", "thread/detach");
        else if (card && !sending && (mode === "approval-card" ? ["y", "n", "s", "a", "escape"].includes(key) : key === "escape")) expected.push("card/respond");
        else if (mode === "rewind" && key === "y") expected.push("thread/engineControl");
        else if (mode === "resume" && key === "y") expected.push("thread/attach", "thread/detach");
        else if (mode === "threads" && key === "enter") expected.push("thread/attach", "thread/detach");
        else if (mode === "fork" && key === "enter") expected.push("thread/fork", "thread/attach", "thread/detach");
        else if (mode === "permissions" && key === "enter") expected.push("thread/permission/set");
        else if (mode === "input" && key === "enter") expected.push("turn/start");
        else if (mode === "input" && key === "tab") expected.push("thread/effort/set");
        else if (mode === "input" && key === "shiftTab") expected.push("thread/permission/set");
        const semantic = methods.filter(m => !m.startsWith("thread/lease/"));
        expect(semantic, `${mode}/${key} RPC ownership`).toEqual(expected);
        if (!["input", "completion"].includes(mode)) expect(state.input, `${mode}/${key} input isolation`).toBe(before.input);
        if (card && key === "new") { expect(state.thread).toBe("source"); expect(state.discardNote).toContain("Ctrl-N"); }
        if (card && key === "threads") { expect(state.focus[0]).toBe("card"); expect(state.focus).toContain("threads"); }
        if (card && ["text", "paste"].includes(key)) expect(state.card.draft).toBe(key === "text" ? "Z" : "y\nZ");
        if (card && sending && ["y", "n", "s", "a"].includes(key)) expect(state.card.draft).toBe(key);
        if (key === "log") expect(state.log).toBe(true);
        if (key === "reasoning") expect(state.reasoning).toBe(true);
        if (key === "plan") expect(state.plan).toBe(false);
        if (key === "f6") expect(state.panelFocus).toBe("tasks");
        if (["rewind", "resume"].includes(mode) && ["n", "enter", "escape", "interrupt"].includes(key)) expect(state[mode]).toBeUndefined();
        expect(proc.exitCode).toBeNull();
      } finally {
        proc.kill(); await proc.exited; proc.terminal?.close();
      }
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 40000);

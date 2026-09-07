import type { AgentClient } from "@smokingmouse/agent-server/client";
import type { TuiModel } from "./model.js";
import { Controller, type Key } from "./controller.js";
import { render } from "./render.js";
import { TerminalInput } from "./terminal-input.js";

export async function runTerminal(client: AgentClient, model: TuiModel): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("agent-tui requires an interactive terminal (TTY)");
  const input = process.stdin, output = process.stdout, wasRaw = input.isRaw;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop!: () => void;
  const done = new Promise<void>(resolve => { stop = resolve; });
  const controller = new Controller(client, model, stop);
  const draw = () => { timer = undefined; output.write("\x1b[H" + render(model, output.columns, output.rows).replace(/\n/g, "\x1b[K\r\n") + "\x1b[K"); };
  const schedule = () => { controller.resize(output.columns, output.rows); if (!timer) timer = setTimeout(draw, 32); };
  // Complete each async edit before applying the next key in the same PTY chunk.
  let edits = Promise.resolve();
  const keyboard = new TerminalInput((text: string | undefined, key: Key) => { if (controller.sessions.busy || (key.ctrl && ["c", "n", "t"].includes(key.name ?? ""))) void controller.key(text, key); else edits = edits.then(() => controller.key(text, key)); });
  const data = (chunk: Buffer) => keyboard.write(chunk);
  const dispose = model.onChange(schedule);
  input.setRawMode(true); input.resume();
  output.write("\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[2J");
  input.on("data", data); input.on("end", stop); output.on("resize", schedule);
  process.on("SIGTERM", stop); process.on("SIGHUP", stop);
  try { draw(); await done; }
  finally {
    clearTimeout(timer); dispose(); keyboard.close(); input.off("data", data); input.off("end", stop); output.off("resize", schedule);
    process.off("SIGTERM", stop); process.off("SIGHUP", stop);
    input.setRawMode(wasRaw); input.pause(); output.write("\x1b[?2004l\x1b[?25h\x1b[?1049l");
  }
}

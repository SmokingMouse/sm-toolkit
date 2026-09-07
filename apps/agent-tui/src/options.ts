import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { resolveDaemonPaths } from "@smokingmouse/agent-server/paths";
import type { ClientEndpoint } from "@smokingmouse/agent-server/client";
import { PermissionSchema } from "@smokingmouse/agent-server/protocol";
import type { Permission } from "./modes.js";

export interface Options { attach?: string; backend?: "claude" | "codex"; permission: Permission; cwd: string; endpoint: ClientEndpoint; tokenPath: string; help: boolean }
export const help = `agent-tui --attach <threadId> [--socket <path> | --ws <url>]
agent-tui --new --backend claude|codex --cwd <dir> [--permission <mode>] [--socket <path> | --ws <url>]

Enter: send / queue; /steer <text>: steer active turn; Ctrl-C: interrupt, twice: exit
Shift-Enter / Ctrl-J: newline; bracketed paste: preserve multiline text
@path: file completion / image attachment; /: commands and local skills
Up/Down: select completion; Tab/Enter: insert; Esc: dismiss
/image <path>: send image; /paste-image: attach clipboard image (macOS pngpaste)
Shift+Tab: permissions; /permissions: picker; Tab: effort; /effort low|medium|high|max
/model <name>; /compact [instructions]; /takeover; /release; /context <window tokens>
Ctrl-R: reasoning; Ctrl-P: plan; PageUp/PageDown: history; approvals: y/s/n/a
Questions: number selects/toggles, Enter advances/submits; type a free answer
Token and default socket use agent-server HOME/XDG resolution.`;

export function parseOptions(args: string[], env: NodeJS.ProcessEnv = process.env): Options {
  const { values: v } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    attach: { type: "string" }, new: { type: "boolean" }, backend: { type: "string" }, cwd: { type: "string" }, permission: { type: "string" },
    socket: { type: "string" }, ws: { type: "string" }, help: { type: "boolean", short: "h" },
  } });
  const paths = resolveDaemonPaths(env);
  if (!v.help) {
    if (!!v.attach === !!v.new) throw new Error("Choose exactly one of --attach <threadId> or --new");
    if (v.new && v.backend !== "claude" && v.backend !== "codex") throw new Error("--new requires --backend claude|codex");
    if (v.attach && (v.backend || v.cwd || v.permission)) throw new Error("--backend, --cwd and --permission are only valid with --new");
    if (v.socket && v.ws) throw new Error("--socket and --ws are mutually exclusive");
    if (v.ws && !["ws:", "wss:"].includes(new URL(v.ws).protocol)) throw new Error("--ws requires a ws:// or wss:// URL");
  }
  return { attach: v.attach, backend: v.backend as Options["backend"], permission: PermissionSchema.parse(v.permission ?? "default"), cwd: resolve(v.cwd || process.cwd()),
    endpoint: v.ws ? { transport: "ws", url: v.ws } : { transport: "unix", path: resolve(v.socket || paths.socketPath) }, tokenPath: paths.tokenPath, help: !!v.help };
}

export function readToken(path: string): string {
  try { const token = readFileSync(path, "utf8").trim(); if (!token) throw new Error("empty token"); return token; }
  catch { throw new Error(`Cannot read agent-server token at ${path}. Start the daemon with agent-server start (using the same HOME/XDG_STATE_HOME).`); }
}

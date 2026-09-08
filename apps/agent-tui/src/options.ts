import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { readFileSync, openSync, fstatSync, closeSync, constants } from "node:fs";
import { resolveDaemonPaths } from "@smokingmouse/agent-server/paths";
import type { ClientEndpoint } from "@smokingmouse/agent-server/client";
import { PermissionSchema } from "@smokingmouse/agent-server/protocol";
import type { Permission } from "./modes.js";
import { blockedEngineCommands } from "./engine-commands.js";

export interface Options { attach?: string; backend?: "claude" | "codex"; model?: string; serviceTier?: "default"; clientThreadId: string; readyFile?: string; readyNonce?: string; awaitFirstTurn: boolean; fjContext?: { root: string; cid: string; seat?: string }; permission: Permission; cwd: string; endpoint: ClientEndpoint; tokenPath: string; help: boolean }
export const help = `agent-tui --attach <threadId> [--socket <path> | --ws <url>]
agent-tui --new --backend claude|codex --cwd <dir> [--permission <mode>] [--socket <path> | --ws <url>]
Startup: --model <name> --service-tier default --client-thread-id <stable-id>
fj handoff: --ready-file <path> --ready-nonce-file <private-file> --await-first-turn --fj-root <dir> --fj-cid <cid> [--fj-seat <name>]
Authentication: --token-path <path> (override HOME/XDG token resolution)

Enter: send / queue; /steer <text>: steer active turn; Ctrl-C: interrupt, twice: exit
Ctrl-N /new /clear: new thread; Ctrl-T /threads /resume [id]: sessions; /fork [itemId]: fork
Shift-Enter / Ctrl-J: newline; bracketed paste: preserve multiline text
@path: file completion / image attachment; /: commands and local skills
Up/Down: select completion; Tab/Enter: insert; Esc: dismiss
/image <path>: send image; /paste-image: attach clipboard image (macOS pngpaste)
Shift+Tab: permissions; /permissions: picker; Tab: effort; /effort low|medium|high|max
/model <name>; /compact [instructions]; /takeover; /release
!<shell command>: standalone bash input; Ctrl-C interrupts; no image attachments
/diff: workspace diff; /context: native context usage; /context <window tokens>: set window
/usage: usage table; /cost: session cost; /mcp: MCP server status; /btw <question>: side question
/rewind <native message UUID> [last seen user UUID]: rewind conversation after physical y/N
Rewind UUIDs come from native Claude history, not TUI item IDs; old items are audit records after rewind
/help: this help; result panels share the screen with live history; Esc closes, PageUp/PageDown scrolls
Engine commands require Claude support; ${blockedEngineCommands.join(" ")} are not allowed
Ctrl-R: reasoning; Ctrl-P: plan; PageUp/PageDown: history; approvals: y/s/n/a
Ctrl-L /log: system log; /tasks: tasks; /agents [id]: subagents; F6: panel focus
Questions: number selects/toggles, Enter advances/submits; type a free answer
Cards keep separate drafts (also during confirmation); Ctrl-N is blocked until cards resolve
Ctrl-L / F6 / Ctrl-R / Ctrl-P / Ctrl-T / Ctrl-C remain available during cards
Cards cancel pending rewind/resume confirmations; Enter/n/Esc cancels, only physical y confirms
Token and default socket use agent-server HOME/XDG resolution.`;

export function parseOptions(args: string[], env: NodeJS.ProcessEnv = process.env): Options {
  const { values: v } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    attach: { type: "string" }, new: { type: "boolean" }, backend: { type: "string" }, cwd: { type: "string" }, permission: { type: "string" },
    socket: { type: "string" }, "token-path": { type: "string" }, ws: { type: "string" }, help: { type: "boolean", short: "h" },
    model: { type: "string" }, "service-tier": { type: "string" }, "client-thread-id": { type: "string" },
    "ready-file": { type: "string" }, "ready-nonce-file": { type: "string" }, "await-first-turn": { type: "boolean" },
    "fj-root": { type: "string" }, "fj-cid": { type: "string" }, "fj-seat": { type: "string" },
  } });
  const paths = resolveDaemonPaths(env);
  if (!v.help) {
    if (!!v.attach === !!v.new) throw new Error("Choose exactly one of --attach <threadId> or --new");
    if (v.new && v.backend !== "claude" && v.backend !== "codex") throw new Error("--new requires --backend claude|codex");
    if (v.attach && (v.backend || v.cwd || v.permission)) throw new Error("--backend, --cwd and --permission are only valid with --new");
    if (v.socket && v.ws) throw new Error("--socket and --ws are mutually exclusive");
    if (v.ws && !["ws:", "wss:"].includes(new URL(v.ws).protocol)) throw new Error("--ws requires a ws:// or wss:// URL");
    if (v["service-tier"] !== undefined && v["service-tier"] !== "default") throw new Error("--service-tier must be default");
    if (v["service-tier"] && v.backend !== "codex") throw new Error("--service-tier requires Codex");
    if (v.model !== undefined && (!v.model.trim() || /fable/i.test(v.model))) throw new Error("--model must be explicit and non-fable");
    if (!!v["fj-root"] !== !!v["fj-cid"]) throw new Error("--fj-root and --fj-cid must be paired");
    if (v["fj-root"] && (!v.model || !v.permission || !v["client-thread-id"])) throw new Error("fj requires --model, --permission and --client-thread-id");
    if (v["ready-file"] && (!v["ready-nonce-file"] || !v["client-thread-id"])) throw new Error("--ready-file requires --ready-nonce-file and --client-thread-id");
    if (v.attach && (v.model || v["service-tier"] || v["fj-root"])) throw new Error("thread options are only valid with --new");
  }
  const permission = PermissionSchema.safeParse(v.permission ?? "default");
  if (!permission.success) throw new Error(`--permission 需为 ${PermissionSchema.options.join("|")}`);
  return { attach: v.attach, backend: v.backend as Options["backend"], model: v.model, serviceTier: v["service-tier"] as "default" | undefined,
    clientThreadId: v["client-thread-id"] ?? crypto.randomUUID(), readyFile: v["ready-file"], readyNonce: !v.help && v["ready-nonce-file"] ? readReadyNonce(v["ready-nonce-file"]) : undefined, awaitFirstTurn: !!v["await-first-turn"],
    fjContext: v["fj-root"] ? { root: resolve(v["fj-root"]), cid: v["fj-cid"]!, ...(v["fj-seat"] ? { seat: v["fj-seat"] } : {}) } : undefined,
    permission: permission.data, cwd: resolve(v.cwd || process.cwd()),
    endpoint: v.ws ? { transport: "ws", url: v.ws } : { transport: "unix", path: resolve(v.socket || paths.socketPath) }, tokenPath: resolve(v["token-path"] || paths.tokenPath), help: !!v.help };
}

function readReadyNonce(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error("ready nonce file must be private and owned by this user");
    const nonce = readFileSync(fd, "utf8").trim();
    if (!nonce) throw new Error("ready nonce file is empty");
    return nonce;
  } finally { closeSync(fd); }
}

export function readToken(path: string): string {
  try { const token = readFileSync(path, "utf8").trim(); if (!token) throw new Error("empty token"); return token; }
  catch { throw new Error(`Cannot read agent-server token at ${path}. Start the daemon with agent-server start (using the same HOME/XDG_STATE_HOME).`); }
}

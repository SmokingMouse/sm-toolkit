import type { JsonObject } from "@smokingmouse/agent-server/protocol";
import { controlSuccess, contextUsage } from "./modes.js";
import { object } from "./observations.js";

export const engineCommands: Record<string, string> = {
  "/diff": "get_workspace_diff", "/context": "get_context_usage", "/usage": "get_usage",
  "/cost": "get_session_cost", "/mcp": "mcp_status", "/rewind": "rewind_conversation", "/btw": "side_question",
};
export interface EngineCommand { command: string; subtype: string; params: JsonObject }
export interface OutputLine { text: string; tone?: "add" | "remove" | "heading" }
export interface EnginePanel { title: string; lines: OutputLine[] }

export function engineCommand(command: string, args: string[]): EngineCommand | undefined {
  // These native commands are outside the daemon allowlist; never send as prompts.
  if (["/add-dir", "/cd", "/login", "/logout", "/feedback", "/plugin", "/engineControl"].includes(command)) throw new Error(`${command} 未在引擎控制白名单开放，请使用原生 Claude Code`);
  if (!Object.hasOwn(engineCommands, command)) return;
  const params: JsonObject = {};
  if (command === "/rewind") {
    if (!args.length || args.length > 2) throw new Error("用法：/rewind <原生消息 UUID> [最后已见用户消息 UUID]；TUI itemId 不是原生 UUID");
    params.target_message_uuid = args[0];
    if (args[1]) params.last_seen_user_message_uuid = args[1];
  } else if (command === "/btw") {
    if (!args.length) throw new Error("用法：/btw <question>");
    params.question = args.join(" ");
  } else if (args.length) throw new Error(`用法：${command}`);
  return { command, subtype: engineCommands[command], params };
}

export function controlPayload(frame: unknown): JsonObject {
  controlSuccess(frame);
  return object(object(object(frame).response).response) as JsonObject;
}
const display = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value) ?? "—";
const lines = (text: string): OutputLine[] => text.split("\n").map(text => ({ text }));
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Native 2.1.258 context response uses totalTokens/rawMaxTokens (not AS Usage). */
export function nativeContext(data: JsonObject): { tokens?: number; window?: number } {
  return { tokens: number(data.totalTokens), window: number(data.rawMaxTokens) };
}

function table(data: unknown, prefix = ""): OutputLine[] {
  if (data === null || typeof data !== "object") return lines(`${prefix || "value"} | ${display(data)}`);
  return Object.entries(data).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return value !== null && typeof value === "object" && Object.keys(value).length ? table(value, path) : lines(`${path} | ${display(value)}`);
  });
}

export function renderEngineResult(command: string, data: JsonObject): EnginePanel {
  let result: OutputLine[] = [];
  if (command === "/diff") {
    // Native workspace diff wraps stats/hunks in response.diff; null means unavailable.
    if (data.diff === null) return { title: command, lines: lines("工作区差异不可用（非 Git 工作区或读取失败）") };
    if (data.diff && typeof data.diff === "object" && !Array.isArray(data.diff)) data = data.diff;
    const diff = (text: string) => text.split("\n").map(text => ({ text, tone: text.startsWith("+") ? "add" as const : text.startsWith("-") ? "remove" as const : /^(?:@@|diff |Index:)/.test(text) ? "heading" as const : undefined }));
    if (typeof data.diff === "string") result = diff(data.diff);
    else if (Array.isArray(data.hunks)) {
      for (const value of data.hunks) {
        const file = object(value);
        result.push({ text: `File: ${display(file.path)}`, tone: "heading" });
        if (Array.isArray(file.hunks)) for (const value of file.hunks) {
          const hunk = object(value);
          result.push({ text: `@@ -${display(hunk.oldStart)},${display(hunk.oldLines)} +${display(hunk.newStart)},${display(hunk.newLines)} @@`, tone: "heading" });
          if (Array.isArray(hunk.lines)) result.push(...diff(hunk.lines.map(display).join("\n")));
        }
      }
      for (const key of ["skippedLarge", "restricted"]) if (Array.isArray(data[key]) && data[key].length) result.push(...lines(`${key}: ${display(data[key])}`));
      if (Array.isArray(data.perFileStats)) for (const value of data.perFileStats) {
        const stat = object(value);
        if (!(data.hunks as unknown[]).some(value => object(value).path === stat.path)) result.push(...lines(`File: ${display(stat.path)} · ${display(stat)}`));
      }
      if (!result.length) result = lines("工作区无差异");
    } else result = table(data);
  } else if (command === "/context") {
    const { tokens, window } = nativeContext(data), usage = contextUsage(tokens, window ?? 0, 20);
    result = lines(`Context [${usage.bar}] ${usage.percent ?? "?"}% · ${tokens ?? "?"} / ${window ?? "?"} tokens`);
    if (Array.isArray(data.categories)) result.push(...data.categories.map(c => ({ text: `${display(object(c).name)} | ${display(object(c).tokens)} tokens` })));
    if (tokens === undefined || window === undefined) result.push(...table(data));
  } else if (command === "/mcp" && Array.isArray(data.mcpServers)) {
    result = data.mcpServers.length ? data.mcpServers.flatMap(value => {
      const server = object(value);
      return lines(`[${display(server.status)}] ${display(server.name)}${server.error ? ` · ${display(server.error)}` : ""}`);
    }) : lines("没有 MCP 服务器");
  } else if (command === "/rewind") {
    result = lines(data.rewound === true ? "会话已回滚（引擎确认）；历史为 daemon 已记录事件" : `未回滚：${display(data.error ?? "引擎未确认 rewound")}`);
    if (typeof data.prefillText === "string" && data.prefillText) result.push(...lines(`原输入：${data.prefillText}`));
  } else if (typeof data.text === "string") result = lines(data.text);
  else if (command === "/btw" && typeof data.response === "string") result = lines(data.response);
  else result = [{ text: "指标 | 值", tone: "heading" }, ...table(data)];
  return { title: command, lines: result.length ? result : lines("引擎返回空结果") };
}

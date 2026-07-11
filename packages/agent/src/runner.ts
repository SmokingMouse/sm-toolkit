/**
 * CLIRunner —— 历史遗留的薄门面,对外签名(CLIRunner/CLIEvent/CLIRunnerOptions)保持
 * 不变(self-agent 生产环境直接消费它,见 apps/self-agent/src/bot.ts),内部委托给
 * 新的 ClaudeBackend(见 backends/claude.ts)。以前这里自己 spawn + 解析 stream-json
 * + 做 endpoints.yaml → env 切换;现在这些能力整体搬进了 ClaudeBackend(功能更全:
 * vision/fork-session/交互式工具协议/tools 白名单),这个文件只剩「形状适配」。
 *
 * 只跑过 claude(从未支持 codex),所以只委托 ClaudeBackend——这是历史事实,不是新限制。
 */

import { ClaudeBackend } from "./backends/claude.js";
import { EventType, type AgentEvent, type Cost } from "./events.js";
import type { RunOptions as BackendRunOptions, PermissionPolicy } from "./backend.js";

export type { Cost } from "./events.js";

export type CLIEvent =
  | { type: "init"; sessionId: string; model: string; tools: string[] }
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; output: string; isError: boolean }
  | { type: "result"; text: string; sessionId: string; cost: Cost }
  | { type: "error"; message: string };

/** 历史 CLIRunner.run() 的选项形状 —— 字段/语义原样保留,不新增。 */
export interface CLIRunnerOptions {
  endpoint: string;
  sessionId?: string;
  workspace?: string;
  permission?: "default" | "acceptEdits" | "bypassPermissions";
  systemPrompt?: string;
  signal?: AbortSignal;
}

// 历史三档 → 新 PermissionPolicy 四档。"default" 映射到同名新档(纯
// --permission-mode default,不额外禁工具)——这正是 self-agent 生产 harness 用的
// 那一档,不能被悄悄改成更严格的 "readonly"(那个会多挂 --disallowedTools)。
const PERMISSION_MAP: Record<NonNullable<CLIRunnerOptions["permission"]>, PermissionPolicy> = {
  default: "default",
  acceptEdits: "auto-edit",
  bypassPermissions: "full",
};

function toCLIEvent(e: AgentEvent, fallbackModel: string): CLIEvent | null {
  const sid = e.sessionId ?? "";
  switch (e.type) {
    case EventType.SessionStart:
      return {
        type: "init",
        sessionId: sid,
        model: String(e.data.model ?? fallbackModel),
        tools: Array.isArray(e.data.tools) ? (e.data.tools as string[]) : [],
      };
    case EventType.TextChunk:
      return { type: "text", text: String(e.data.text ?? "") };
    case EventType.ToolCall:
      return {
        type: "tool_call",
        id: String(e.data.id ?? ""),
        name: String(e.data.name ?? ""),
        input: e.data.input,
      };
    case EventType.ToolCallDone:
      return {
        type: "tool_result",
        id: String(e.data.id ?? ""),
        output: String(e.data.output ?? ""),
        isError: Boolean(e.data.isError),
      };
    case EventType.Result:
      return {
        type: "result",
        text: String(e.data.text ?? ""),
        sessionId: sid,
        cost: e.data.cost as Cost,
      };
    case EventType.Error:
      return { type: "error", message: String(e.data.message ?? "claude CLI error") };
    default:
      // file_change / image_output: CLIRunner 历史上从未消费(只跑 claude,不跑
      // codex/image 后端),故没有对应 CLIEvent 变体可映射。
      return null;
  }
}

export class CLIRunner {
  #backend = new ClaudeBackend();

  async *run(prompt: string, opts: CLIRunnerOptions): AsyncGenerator<CLIEvent> {
    const permission = PERMISSION_MAP[opts.permission ?? "default"];
    const runOpts: BackendRunOptions = {
      model: opts.endpoint,
      resume: opts.sessionId ?? null,
      workspace: opts.workspace ?? null,
      cwd: opts.workspace ?? null,
      permission,
      systemPrompt: opts.systemPrompt ?? null,
      signal: opts.signal,
    };
    for await (const e of this.#backend.run(prompt, runOpts)) {
      const ce = toCLIEvent(e, opts.endpoint);
      if (ce) yield ce;
    }
  }
}

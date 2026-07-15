/**
 * 统一 Event 模型 —— 各 CLI 后端归一后的共同信封,SDK 对外唯一事件契约。
 * 移植自 agent-gateway(github:SmokingMouse/agent-gateway) src/events.ts,原样搬入。
 *
 * 归一边界(经实测+评审确定):
 *   - 主干统一:session_start / text_chunk / result —— 各家语义接近,归一。
 *   - 工具层不统一:tool_call / file_change 原样透传。claude 写文件发 tool_call(Write),
 *     codex 发 file_change,SDK 不强行抹平 —— 接口层统一即可,工具细节看各自工作环境。
 */

// 不用 enum(node type-stripping 不支持),用 const 对象 + union。
export const EventType = {
  SessionStart: "session_start",
  TextChunk: "text_chunk",
  /** extended thinking 流式片段(data.text)。claude 2.x 默认先出 thinking 块再出
   * 正文,不透传的话上游在思考期(effort 高时可达分钟级)对进程活动完全失明。 */
  Thinking: "thinking",
  ToolCall: "tool_call",
  ToolCallDone: "tool_call_done",
  FileChange: "file_change",
  ImageOutput: "image_output", // 生图产物:data.paths = 本地图片路径数组
  Result: "result",
  Error: "error",
} as const;

export type EventType = (typeof EventType)[keyof typeof EventType];

export interface Cost {
  /** claude 直报;codex 为 null 或按单价估算 */
  usd: number | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** 首次写入缓存的开销(claude cache_creation_input_tokens;codex 不报,0) */
  cacheCreation: number;
  /** true = usd 是上游按单价估出来的(codex),非后端直报 */
  estimated: boolean;
  /**
   * 主 agent「当前上下文窗口实际占用」≈ 最后一条 assistant message 的
   * input_tokens + cache_read + cache_creation。区别于上面的 inputTokens/
   * cachedTokens(那是整轮跨迭代的累计和,且含同模型 subagent 消耗),专供
   * 算「context 占用%」用,而非成本。后端报不出(codex/无 usage)时为 null。
   */
  contextTokens: number | null;
}

export interface AgentEvent {
  type: EventType;
  backend: string;
  sessionId: string | null;
  data: Record<string, unknown>;
}

export function fmtEvent(e: AgentEvent): string {
  const sid = (e.sessionId ?? "").slice(0, 8);
  const data = JSON.stringify(e.data);
  return `[${e.backend.padEnd(6)} ${sid.padEnd(8)}] ${e.type.padEnd(13)} ${data.slice(0, 120)}`;
}

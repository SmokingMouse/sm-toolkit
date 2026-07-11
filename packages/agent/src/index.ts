// ── CLI 运行时引擎(吸收自 agent-gateway,claude/codex 统一 Backend 抽象) ──
export { EventType, fmtEvent, type AgentEvent, type Cost } from "./events.js";
export type { Backend, RunOptions, PermissionPolicy } from "./backend.js";
export { ClaudeBackend } from "./backends/claude.js";
export { CodexBackend } from "./backends/codex.js";
export { MockBackend } from "./backends/mock.js";

// ── 历史门面(self-agent 消费,内部已委托给 ClaudeBackend) ──
export { CLIRunner, type CLIEvent, type CLIRunnerOptions } from "./runner.js";

// ── Channel(平台适配接口,不变) ──
export type {
  Channel,
  IncomingMessage,
  IncomingAction,
  Content,
  ModelGroup,
  ContentAction,
  CommandInfo,
} from "./channel.js";

/**
 * Run prompt 的 server 侧两段式 pipeline。
 *
 * - session context：稳定的对象事实与平台边界；
 * - event block：本次触发原因与当前请求。
 *
 * 原始 runs.prompt 不修改；仅 scheduler 下发 RunSpec 时组合渲染。
 */

import type {
  Conversation,
  HarborAgent,
  PromptBlockConfig,
  PromptBlockKey,
  PromptBlockPhase,
  PromptContextBlockKey,
  PromptEventBlockKey,
  PromptSource,
  PromptVariableDefinition,
  Run,
} from "../protocol.js";
import type { HarborStore } from "./store.js";

interface PromptBlockDefinition {
  key: PromptBlockKey;
  source: PromptSource;
  phase: PromptBlockPhase;
  label: string;
  description: string;
  defaultTemplate: string;
}

export const PROMPT_VARIABLES: PromptVariableDefinition[] = [
  { name: "prompt", description: "本次 Run 的原始请求（兼容旧模板）" },
  { name: "latest_message.content", description: "触发本次 Run 的当前消息或任务内容" },
  { name: "conversation.id", description: "当前 Issue / Chat ID" },
  { name: "conversation.kind", description: "当前会话类型" },
  { name: "conversation.title", description: "当前 Issue / Chat 标题" },
  { name: "conversation.description", description: "当前 Issue 描述" },
  { name: "conversation.status", description: "当前会话阶段" },
  { name: "conversation.priority", description: "当前 Issue 优先级" },
  { name: "conversation.origin", description: "当前会话来源" },
  { name: "conversation.originRef", description: "来源对象 ID（如 Automation ID）" },
  { name: "conversation.createdAt", description: "会话创建时间（UTC RFC3339）" },
  { name: "conversation.updatedAt", description: "会话更新时间（UTC RFC3339）" },
  { name: "agent.id", description: "本次执行的 Agent ID" },
  { name: "agent.name", description: "本次执行的 Agent 名称" },
  { name: "agent.backend", description: "本次执行 Runtime" },
  { name: "agent.model", description: "本次执行模型" },
  { name: "agent.deviceId", description: "本次执行设备 ID" },
  { name: "agent.workdir", description: "本次执行工作目录" },
  { name: "run.id", description: "当前 Run ID" },
  { name: "run.purpose", description: "当前 Run 的执行意图" },
  { name: "run.promptEvent", description: "触发本次 Run 的 event block key" },
  { name: "trigger.event_id", description: "触发对象 ID；无外部对象时回落为 Run ID" },
  { name: "now.date", description: "触发日期（UTC YYYY-MM-DD）" },
  { name: "now.datetime", description: "触发时间（UTC RFC3339）" },
];

export const PROMPT_BLOCK_DEFINITIONS: PromptBlockDefinition[] = [
  {
    key: "session.issue.context",
    source: "issue",
    phase: "context",
    label: "Context",
    description: "每次 Issue Run 都会先注入的稳定事实与平台边界。",
    defaultTemplate: `## Issue Reference

Issue ID: {{conversation.id}}
Title: {{conversation.title}}
Description: {{conversation.description}}
Status: {{conversation.status}}
Priority: {{conversation.priority}}
Created: {{conversation.createdAt}}
Updated: {{conversation.updatedAt}}
Workspace: {{agent.workdir}}

## Platform Boundaries

Use issue details and older messages only as background; the current event request has higher priority.
If local context is incomplete, inspect the repository and Harbor run history before acting.
Do not create progress messages manually. Put progress in tool output and the completion report in your final answer; Harbor records the run result.
Do not update Issue status or delivery metadata unless the current request explicitly asks; Harbor's control plane owns lifecycle transitions.
Do not check remote deployment state unless the current request explicitly asks for remote acceptance or deployment verification.`,
  },
  {
    key: "event.issue.assigned",
    source: "issue",
    phase: "event",
    label: "Assigned",
    description: "Issue 首次指派给 Agent 并开始执行。",
    defaultTemplate: `## Assignment

You were assigned this Issue. Own the requested outcome and verify it against the repository state.
Treat the Issue description as the durable goal and the assignment request below as the immediate instruction.

<assignment_request>
{{latest_message.content}}
</assignment_request>`,
  },
  {
    key: "event.issue.mentioned",
    source: "issue",
    phase: "event",
    label: "Mentioned",
    description: "飞书等入口通过 @ 提到 Agent 并创建 Issue。",
    defaultTemplate: `## Mention Trigger

You were mentioned from {{conversation.origin}}. Respond to the request that caused the mention; do not infer work from unrelated older messages.

<mentioned_message>
{{latest_message.content}}
</mentioned_message>`,
  },
  {
    key: "event.issue.message_created",
    source: "issue",
    phase: "event",
    label: "New message",
    description: "已有 Issue 收到返工、Review 或其他新请求。",
    defaultTemplate: `## Current Request

Treat the message below as the current task for this run. It overrides older issue messages, previous session plans, workflow defaults, and recalled context. Do not continue prior work unless this message explicitly asks for it.

<latest_user_message>
{{latest_message.content}}
</latest_user_message>`,
  },
  {
    key: "session.chat.context",
    source: "chat",
    phase: "context",
    label: "Context",
    description: "每次 Chat Run 复用的会话、Agent 与工作目录事实。",
    defaultTemplate: `## Chat Reference

Conversation ID: {{conversation.id}}
Agent: {{agent.name}} ({{agent.backend}} / {{agent.model}})
Workspace: {{agent.workdir}}
Run purpose: {{run.purpose}}

Use older chat turns only as background. Answer the latest message directly and do not silently continue a previous plan.`,
  },
  {
    key: "event.chat.message_created",
    source: "chat",
    phase: "event",
    label: "New message",
    description: "Chat 中触发新一轮 Run 的当前消息。",
    defaultTemplate: `## Current Request

Treat the message below as the current request for this turn. It has priority over recalled context and earlier plans.

<latest_user_message>
{{latest_message.content}}
</latest_user_message>`,
  },
  {
    key: "event.automation.schedule",
    source: "automation",
    phase: "event",
    label: "Schedule",
    description: "Cron 到点后无人值守触发。",
    defaultTemplate: `## Scheduled Automation

Automation ID: {{trigger.event_id}}
Triggered at: {{now.datetime}}
Agent: {{agent.name}}
Workspace: {{agent.workdir}}

This run was triggered by schedule and may be unattended. Complete the request without waiting for follow-up, make blockers explicit, and leave a self-contained final report.

<automation_request>
{{latest_message.content}}
</automation_request>`,
  },
  {
    key: "event.automation.manual",
    source: "automation",
    phase: "event",
    label: "Manual",
    description: "用户在 Automation 页面手动执行一次。",
    defaultTemplate: `## Manual Automation Run

Automation ID: {{trigger.event_id}}
Started at: {{now.datetime}}
Agent: {{agent.name}}
Workspace: {{agent.workdir}}

This automation was started manually. Run it once now; do not infer missed schedules or create recurring work beyond the request.

<automation_request>
{{latest_message.content}}
</automation_request>`,
  },
];

export const PROMPT_BLOCK_KEYS = PROMPT_BLOCK_DEFINITIONS.map((definition) => definition.key);

const VARIABLE_PATTERN = /{{\s*([A-Za-z][A-Za-z0-9._]*)\s*}}/g;
const ANY_VARIABLE_PATTERN = /{{\s*([^{}]+?)\s*}}/g;
const VARIABLE_SET = new Set(PROMPT_VARIABLES.map((variable) => variable.name));
const REQUEST_VARIABLES = new Set(["prompt", "latest_message.content"]);
const DEFINITION_BY_KEY = new Map(PROMPT_BLOCK_DEFINITIONS.map((definition) => [definition.key, definition]));

export function validatePromptTemplate(key: PromptBlockKey, template: string): string | null {
  if (!template.trim()) return "template 不能为空";
  if (template.length > 20_000) return "template 不能超过 20000 字符";
  const found = [...template.matchAll(ANY_VARIABLE_PATTERN)].map((match) => match[1]!.trim());
  const unknown = [...new Set(found.filter((variable) => !VARIABLE_SET.has(variable)))];
  if (unknown.length) return `未知变量：${unknown.map((variable) => `{{${variable}}}`).join(", ")}`;
  const definition = definitionFor(key);
  if (definition.phase === "event" && !found.some((variable) => REQUEST_VARIABLES.has(variable))) {
    return "event template 必须包含 {{latest_message.content}} 或 {{prompt}}，防止丢失当前请求";
  }
  return null;
}

export function inferPromptEvent(conversation: Conversation, hasPreviousRuns: boolean): PromptEventBlockKey {
  if (conversation.origin === "automation") return "event.automation.schedule";
  if (conversation.kind === "chat") return "event.chat.message_created";
  if (conversation.kind === "issue_draft") return "event.issue.message_created";
  if (hasPreviousRuns) return "event.issue.message_created";
  return conversation.origin === "feishu" ? "event.issue.mentioned" : "event.issue.assigned";
}

export function getPromptBlockConfig(store: HarborStore, key: PromptBlockKey): PromptBlockConfig {
  const definition = definitionFor(key);
  const override = store.getPromptBlock(key);
  return {
    key,
    source: definition.source,
    phase: definition.phase,
    label: definition.label,
    description: definition.description,
    enabled: override?.enabled ?? true,
    template: override?.template.trim() ? override.template : definition.defaultTemplate,
    isDefault: !override,
    updatedAt: override?.updatedAt ?? null,
    variables: PROMPT_VARIABLES,
  };
}

export function listPromptBlockConfigs(store: HarborStore): PromptBlockConfig[] {
  return PROMPT_BLOCK_DEFINITIONS.map((definition) => getPromptBlockConfig(store, definition.key));
}

export function renderRunPrompt(
  store: HarborStore,
  input: { run: Run; conversation: Conversation; agent: HarborAgent },
): string {
  const values = promptValues(input);
  const contextKey = contextKeyFor(input.run.promptEvent);
  const context = contextKey ? getPromptBlockConfig(store, contextKey) : null;
  const event = getPromptBlockConfig(store, input.run.promptEvent);

  let contextText = "";
  if (context?.enabled) {
    assertValid(context);
    contextText = renderTemplate(context.template, values);
    // v9 之前的 source wrapper 同时包含 context + request。迁移后保持原样生效；
    // 用户 reset context 后会自然切换到新的 context + event 组合。
    if (containsRequestVariable(context.template)) return contextText;
  }

  let eventText = input.run.prompt;
  if (event.enabled) {
    assertValid(event);
    eventText = renderTemplate(event.template, values);
  }
  return [contextText, eventText].filter(Boolean).join("\n\n---\n\n");
}

function definitionFor(key: PromptBlockKey): PromptBlockDefinition {
  const definition = DEFINITION_BY_KEY.get(key);
  if (!definition) throw new Error(`未知 Prompt block：${key}`);
  return definition;
}

function contextKeyFor(event: PromptEventBlockKey): PromptContextBlockKey | null {
  if (event.startsWith("event.issue.")) return "session.issue.context";
  if (event === "event.chat.message_created") return "session.chat.context";
  return null;
}

function containsRequestVariable(template: string): boolean {
  return [...template.matchAll(ANY_VARIABLE_PATTERN)].some((match) => REQUEST_VARIABLES.has(match[1]!.trim()));
}

function assertValid(config: PromptBlockConfig): void {
  const invalid = validatePromptTemplate(config.key, config.template);
  if (invalid) throw new Error(`Prompt block(${config.key}) 配置无效：${invalid}`);
}

function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(VARIABLE_PATTERN, (_match, name: string) => values[name] ?? "");
}

function promptValues(input: {
  run: Run;
  conversation: Conversation;
  agent: HarborAgent;
}): Record<string, string> {
  const triggerTime = new Date(input.run.queuedAt);
  return {
    prompt: input.run.prompt,
    "latest_message.content": input.run.prompt,
    "conversation.id": input.conversation.id,
    "conversation.kind": input.conversation.kind,
    "conversation.title": input.conversation.title ?? "(untitled)",
    "conversation.description": input.conversation.description ?? "(no description)",
    "conversation.status": input.conversation.status,
    "conversation.priority": input.conversation.priority,
    "conversation.origin": input.conversation.origin,
    "conversation.originRef": input.conversation.originRef ?? "-",
    "conversation.createdAt": new Date(input.conversation.createdAt).toISOString(),
    "conversation.updatedAt": new Date(input.conversation.updatedAt).toISOString(),
    "agent.id": input.agent.id,
    "agent.name": input.agent.name,
    "agent.backend": input.agent.backend,
    "agent.model": input.agent.model ?? "CLI default",
    "agent.deviceId": input.agent.deviceId,
    "agent.workdir": input.agent.workdir,
    "run.id": input.run.id,
    "run.purpose": input.run.purpose,
    "run.promptEvent": input.run.promptEvent,
    "trigger.event_id": input.run.triggerRef ?? input.run.id,
    "now.date": triggerTime.toISOString().slice(0, 10),
    "now.datetime": triggerTime.toISOString(),
  };
}

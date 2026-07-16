/**
 * Run prompt 的 server 侧结构化包装。
 * 原始 runs.prompt 不修改；仅 scheduler 下发 RunSpec 时渲染。
 */

import type {
  Conversation,
  HarborAgent,
  PromptSource,
  PromptWrapperConfig,
  Run,
} from "../protocol.js";
import type { HarborStore } from "./store.js";

export const PROMPT_SOURCES: PromptSource[] = ["issue", "chat", "automation"];

export const PROMPT_WRAPPER_VARIABLES = [
  "prompt",
  "conversation.id",
  "conversation.kind",
  "conversation.title",
  "conversation.status",
  "conversation.origin",
  "conversation.originRef",
  "agent.name",
  "agent.backend",
  "agent.model",
  "agent.workdir",
  "run.id",
] as const;

const DEFAULT_TEMPLATES: Record<PromptSource, string> = {
  issue: `## Harbor Issue Context
- Issue: {{conversation.id}}
- Title: {{conversation.title}}
- Status: {{conversation.status}}
- Agent: {{agent.name}} ({{agent.backend}} / {{agent.model}})
- Workspace: {{agent.workdir}}
- Run: {{run.id}}

Use earlier session context as background. The current request below has highest priority.

## Current Request
{{prompt}}`,
  chat: `## Harbor Chat Context
- Conversation: {{conversation.id}}
- Agent: {{agent.name}} ({{agent.backend}} / {{agent.model}})
- Workspace: {{agent.workdir}}
- Run: {{run.id}}

Answer the current request below. Treat earlier session context as background when present.

## Current Request
{{prompt}}`,
  automation: `## Harbor Automation Context
- Automation: {{conversation.originRef}}
- Issue: {{conversation.id}}
- Title: {{conversation.title}}
- Agent: {{agent.name}} ({{agent.backend}} / {{agent.model}})
- Workspace: {{agent.workdir}}
- Run: {{run.id}}

This run was scheduled and may be unattended. Complete the current request below and make blockers explicit in the final result.

## Current Request
{{prompt}}`,
};

const VARIABLE_PATTERN = /{{\s*([A-Za-z][A-Za-z0-9.]*)\s*}}/g;
const ANY_VARIABLE_PATTERN = /{{\s*([^{}]+?)\s*}}/g;
const VARIABLE_SET = new Set<string>(PROMPT_WRAPPER_VARIABLES);

export function validatePromptTemplate(template: string): string | null {
  if (!template.trim()) return "template 不能为空";
  if (template.length > 20_000) return "template 不能超过 20000 字符";
  const found = [...template.matchAll(ANY_VARIABLE_PATTERN)].map((m) => m[1]!.trim());
  const unknown = [...new Set(found.filter((v) => !VARIABLE_SET.has(v)))];
  if (unknown.length) return `未知变量：${unknown.map((v) => `{{${v}}}`).join(", ")}`;
  if (!found.includes("prompt")) return "template 必须包含 {{prompt}}，防止丢失当前请求";
  return null;
}

export function promptSourceForConversation(conv: Conversation): PromptSource {
  if (conv.origin === "automation") return "automation";
  return conv.kind === "issue" ? "issue" : "chat";
}

export function getPromptWrapperConfig(store: HarborStore, source: PromptSource): PromptWrapperConfig {
  const override = store.getPromptTemplate(source);
  return override
    ? { ...override, isDefault: false }
    : {
        source,
        enabled: true,
        template: DEFAULT_TEMPLATES[source],
        isDefault: true,
        updatedAt: null,
      };
}

export function listPromptWrapperConfigs(store: HarborStore): PromptWrapperConfig[] {
  return PROMPT_SOURCES.map((source) => getPromptWrapperConfig(store, source));
}

export function renderRunPrompt(
  store: HarborStore,
  input: { run: Run; conversation: Conversation; agent: HarborAgent },
): string {
  const source = promptSourceForConversation(input.conversation);
  const config = getPromptWrapperConfig(store, source);
  if (!config.enabled) return input.run.prompt;
  const invalid = validatePromptTemplate(config.template);
  if (invalid) throw new Error(`Prompt wrapper(${source}) 配置无效：${invalid}`);

  const values: Record<(typeof PROMPT_WRAPPER_VARIABLES)[number], string> = {
    prompt: input.run.prompt,
    "conversation.id": input.conversation.id,
    "conversation.kind": input.conversation.kind,
    "conversation.title": input.conversation.title ?? "(untitled)",
    "conversation.status": input.conversation.status,
    "conversation.origin": input.conversation.origin,
    "conversation.originRef": input.conversation.originRef ?? "-",
    "agent.name": input.agent.name,
    "agent.backend": input.agent.backend,
    "agent.model": input.agent.model ?? "CLI default",
    "agent.workdir": input.agent.workdir,
    "run.id": input.run.id,
  };
  return config.template.replace(VARIABLE_PATTERN, (_match, name: string) => values[name as keyof typeof values]);
}

import type { LLMClient, EndpointMatch } from '@smokingmouse/llm'

export const BUILTIN_ALIASES: Record<string, string> = {
  // Claude 系列
  claude: 'claude-fable-5',
  fa: 'claude-fable-5',
  fable: 'claude-fable-5',
  op: 'claude-opus-4-8',
  opus: 'claude-opus-4-8',
  so: 'claude-sonnet-5',
  sonnet: 'claude-sonnet-5',
  // DeepSeek 系列
  ds: 'deepseek-v4-flash',
  'ds-flash': 'deepseek-v4-flash',
  dr: 'deepseek-v4-pro',
  'ds-pro': 'deepseek-v4-pro',
  // Gemini 系列
  gf: 'gemini-2.5-flash',
  flash: 'gemini-3.7-flash-high',
  '3.7': 'gemini-3.7-flash-high',
  '3.6': 'gemini-3.6-flash-high',
  // Kimi 系列
  k3: 'k3',
  kimi: 'k3',
  // OpenAI / GPT 系列
  gpt: 'gpt-5.6',
  '5.6': 'gpt-5.6',
  '5.5': 'gpt-5.5',
  '5.4': 'gpt-5.4',
  // 豆包 / 通义
  qw: 'qwen3.5-plus',
  seed: 'doubao-seed-2.0-code',
  doubao: 'doubao-seed-2.0-code',
}

export type ResolveResult =
  | { type: 'exact'; name: string }
  | { type: 'provider'; provider: string }
  | { type: 'ambiguous'; query: string; candidates: EndpointMatch[] }
  | { type: 'not_found'; query: string }

/**
 * 智能解析用户输入的 endpoint/model/provider 参数
 */
export function resolveModelTarget(
  client: LLMClient,
  input: string,
  options?: { isInteractive?: boolean },
): ResolveResult {
  const trimmed = input.trim()
  if (!trimmed) return { type: 'not_found', query: input }

  const providers = client.listProviders()
  const isInteractive = options?.isInteractive ?? false

  // 1. Qualified id: "provider:model"
  if (trimmed.includes(':')) {
    try {
      const { name } = client.getEndpointConfig(trimmed)
      return { type: 'exact', name }
    } catch {}
  }

  // 2. Alias
  const aliased = BUILTIN_ALIASES[trimmed.toLowerCase()]
  if (aliased) {
    try {
      const { name } = client.getEndpointConfig(aliased)
      return { type: 'exact', name }
    } catch {}
  }

  // 3. Exact model name match
  for (const prov of providers) {
    if (prov.models.includes(trimmed)) {
      return { type: 'exact', name: `${prov.name}:${trimmed}` }
    }
  }

  // 4. Provider match
  const matchedProv = providers.find(
    (p) => p.name.toLowerCase() === trimmed.toLowerCase(),
  )
  if (matchedProv) {
    if (matchedProv.models.length === 1) {
      return {
        type: 'exact',
        name: `${matchedProv.name}:${matchedProv.models[0]!}`,
      }
    }
    if (isInteractive) {
      return { type: 'provider', provider: matchedProv.name }
    }
    return {
      type: 'exact',
      name: `${matchedProv.name}:${matchedProv.models[0]!}`,
    }
  }

  // 5. Fuzzy / Substring search
  const matches = client.searchEndpoints(trimmed)
  if (matches.length === 0) {
    return { type: 'not_found', query: trimmed }
  }

  if (matches.length === 1) {
    return { type: 'exact', name: matches[0]!.qualified }
  }

  // 检查是否有且仅有一个具备 API Key 的候选
  const withKey = matches.filter((m) => m.hasKey)
  if (withKey.length === 1) {
    return { type: 'exact', name: withKey[0]!.qualified }
  }

  // 多个候选
  if (isInteractive) {
    return { type: 'ambiguous', query: trimmed, candidates: matches }
  }

  // 非交互模式（如 llm flash -p "..."）默认取分数最高项
  return { type: 'exact', name: matches[0]!.qualified }
}

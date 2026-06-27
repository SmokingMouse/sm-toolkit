export interface Cost {
  usd: number | null
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  cacheCreation: number
  estimated: boolean
  contextTokens: number | null
}

export type CLIEvent =
  | { type: 'init'; sessionId: string; model: string; tools: string[] }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; output: string; isError: boolean }
  | { type: 'result'; text: string; sessionId: string; cost: Cost }
  | { type: 'error'; message: string }

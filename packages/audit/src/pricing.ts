export interface ModelPricing {
  input: number  // USD per token
  output: number // USD per token
}

export const PRICING: Record<string, ModelPricing> = {
  'deepseek-chat': { input: 0.14e-6, output: 0.28e-6 },
  'deepseek-reasoner': { input: 0.55e-6, output: 2.19e-6 },
  'gemini-2.5-flash': { input: 0.075e-6, output: 0.30e-6 },
  'qwen3.5-plus': { input: 0.8e-6, output: 2.0e-6 },
  'claude-sonnet-4-20250514': { input: 3.0e-6, output: 15.0e-6 },
}

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const p = PRICING[model]
  if (!p) return null
  return inputTokens * p.input + outputTokens * p.output
}

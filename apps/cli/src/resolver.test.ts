import { describe, it, expect } from 'bun:test'
import { resolveModelTarget, BUILTIN_ALIASES } from './resolver.js'
import { LLMClient } from '@smokingmouse/llm'

describe('resolveModelTarget', () => {
  const client = new LLMClient()

  it('resolves built-in aliases', () => {
    const r1 = resolveModelTarget(client, 'fable')
    expect(r1.type).toBe('exact')
    expect((r1 as any).name).toContain('claude-fable-5')

    const r2 = resolveModelTarget(client, '3.7')
    expect(r2.type).toBe('exact')
    expect((r2 as any).name).toContain('gemini-3.7-flash-high')

    const r3 = resolveModelTarget(client, 'k3')
    expect(r3.type).toBe('exact')
    expect((r3 as any).name).toContain('k3')
  })

  it('resolves multi-model provider in interactive mode as provider view', () => {
    const res = resolveModelTarget(client, 'cpa', { isInteractive: true })
    expect(res.type).toBe('provider')
    expect((res as any).provider).toBe('cpa')
  })

  it('resolves ambiguous keyword in interactive mode', () => {
    const res = resolveModelTarget(client, 'flash', { isInteractive: true })
    // If multiple flash models exist
    if (res.type === 'ambiguous') {
      expect(res.candidates.length).toBeGreaterThan(1)
    } else {
      expect(res.type).toBe('exact')
    }
  })

  it('resolves unique substring', () => {
    const res = resolveModelTarget(client, 'seed-2.0-code')
    expect(res.type).toBe('exact')
  })
})

import { describe, it, expect } from 'bun:test'
import { searchEndpoints, resolveEndpoint } from './config.js'
import type { ConfigFile } from './types.js'

const mockConfig: ConfigFile = {
  default: 'k3',
  providers: {
    claude: {
      api_key_env: 'ANTHROPIC_API_KEY',
      anthropic_url: 'https://api.anthropic.com',
      models: [
        'claude-opus-4-6[1m]',
        'claude-fable-5',
        'claude-opus-4-8',
        'claude-sonnet-5',
      ],
    },
    cpa: {
      api_key_env: 'CPA_API_KEY',
      openai_url: 'https://cpa.example.com/v1',
      models: [
        'gpt-5.6',
        'gemini-3.7-flash-high',
        'gemini-3.6-flash-high',
        'claude-sonnet-4-6',
      ],
    },
    kimi: {
      api_key_env: 'KIMI_API_KEY',
      openai_url: 'https://api.moonshot.cn/v1',
      models: ['k3', 'kimi-for-coding'],
    },
  },
}

describe('searchEndpoints', () => {
  it('returns all endpoints when query is empty, prioritizing recent and hasKey', () => {
    process.env.ANTHROPIC_API_KEY = 'test'
    process.env.CPA_API_KEY = 'test'
    delete process.env.KIMI_API_KEY

    const results = searchEndpoints(mockConfig, '', {
      recent: ['claude:claude-fable-5'],
    })

    expect(results.length).toBe(10)
    // fable should be top because it is in recent
    expect(results[0]?.model).toBe('claude-fable-5')
    expect(results[0]?.isRecent).toBe(true)
  })

  it('matches by model substring', () => {
    const results = searchEndpoints(mockConfig, 'fable')
    expect(results.length).toBe(1)
    expect(results[0]?.model).toBe('claude-fable-5')
    expect(results[0]?.provider).toBe('claude')
  })

  it('matches by numerical version substring', () => {
    const results = searchEndpoints(mockConfig, '3.7')
    expect(results.length).toBe(1)
    expect(results[0]?.model).toBe('gemini-3.7-flash-high')
    expect(results[0]?.provider).toBe('cpa')
  })

  it('matches multi-term search (provider + model keyword)', () => {
    const results = searchEndpoints(mockConfig, 'cpa 3.6')
    expect(results.length).toBe(1)
    expect(results[0]?.model).toBe('gemini-3.6-flash-high')
  })

  it('matches provider name', () => {
    const results = searchEndpoints(mockConfig, 'kimi')
    expect(results.length).toBe(2)
    expect(results.map((r) => r.model)).toContain('k3')
  })
  it('marks native provider (without custom URLs) as having key by default', () => {
    delete process.env.ANTHROPIC_API_KEY
    const nativeConfig: ConfigFile = {
      default: 'claude-fable-5',
      providers: {
        claude: {
          api_key_env: 'ANTHROPIC_API_KEY',
          models: ['claude-fable-5'],
        },
      },
    }
    const results = searchEndpoints(nativeConfig, '')
    expect(results.length).toBe(1)
    expect(results[0]?.hasKey).toBe(true)
  })
})

describe('resolveEndpoint substring fallback', () => {
  it('resolves unique substring match', () => {
    const { name, endpoint } = resolveEndpoint(mockConfig, 'fable')
    expect(name).toBe('claude-fable-5')
    expect(endpoint.model).toBe('claude-fable-5')
  })

  it('resolves exact match before substring', () => {
    const { name } = resolveEndpoint(mockConfig, 'k3')
    expect(name).toBe('k3')
  })
})

import { describe, it, expect, beforeEach } from 'bun:test'
import { getRecentEndpoints, recordRecentEndpoint } from './recent.js'
import { existsSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'

describe('recent module', () => {
  const home = process.env.HOME ?? '~'
  const xdg = process.env.XDG_CONFIG_HOME ?? resolve(home, '.config')
  const file = resolve(xdg, 'sm/recent.json')

  beforeEach(() => {
    if (existsSync(file)) {
      try {
        unlinkSync(file)
      } catch {}
    }
  })

  it('records and retrieves recent endpoints in MRU order', () => {
    recordRecentEndpoint('claude:claude-fable-5')
    recordRecentEndpoint('cpa:gemini-3.7-flash-high')

    let list = getRecentEndpoints()
    expect(list[0]).toBe('cpa:gemini-3.7-flash-high')
    expect(list[1]).toBe('claude:claude-fable-5')

    // Re-recording an existing one moves it to top
    recordRecentEndpoint('claude:claude-fable-5')
    list = getRecentEndpoints()
    expect(list[0]).toBe('claude:claude-fable-5')
    expect(list[1]).toBe('cpa:gemini-3.7-flash-high')
    expect(list.length).toBe(2)
  })

  it('handles empty / non-existent file gracefully', () => {
    const list = getRecentEndpoints()
    expect(Array.isArray(list)).toBe(true)
  })
})

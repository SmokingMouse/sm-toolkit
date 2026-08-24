import { describe, it, expect } from 'bun:test'
import { getCurrentVersion, isNewerVersion } from './update.js'

describe('update module', () => {
  it('reads current version from package.json', () => {
    const version = getCurrentVersion()
    expect(version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('correctly compares semantic versions', () => {
    expect(isNewerVersion('0.4.0', '0.5.0')).toBe(true)
    expect(isNewerVersion('0.4.0', '1.0.0')).toBe(true)
    expect(isNewerVersion('0.4.0', '0.4.1')).toBe(true)
    expect(isNewerVersion('0.4.0', '0.4.0')).toBe(false)
    expect(isNewerVersion('0.5.0', '0.4.0')).toBe(false)
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(false)
  })
})

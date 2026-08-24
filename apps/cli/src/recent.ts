import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

function getRecentFilePath(): string {
  const home = process.env.HOME ?? '~'
  const xdg = process.env.XDG_CONFIG_HOME ?? resolve(home, '.config')
  return resolve(xdg, 'sm/recent.json')
}

interface RecentData {
  recent?: string[]
}

const MAX_RECENT_COUNT = 20

/** 读取最近使用的 endpoint 列表（按最近使用时间倒序） */
export function getRecentEndpoints(): string[] {
  const file = getRecentFilePath()
  if (!existsSync(file)) return []
  try {
    const raw = readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as RecentData
    if (Array.isArray(parsed?.recent)) {
      return parsed.recent.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    }
    return []
  } catch {
    return []
  }
}

/** 记录 endpoint 到最近使用列表最前 */
export function recordRecentEndpoint(endpointName: string): void {
  const name = endpointName.trim()
  if (!name) return

  const file = getRecentFilePath()
  try {
    const list = getRecentEndpoints()
    const filtered = list.filter((item) => item !== name)
    filtered.unshift(name)
    const nextList = filtered.slice(0, MAX_RECENT_COUNT)

    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ recent: nextList }, null, 2), 'utf-8')
  } catch {
    // 静默忽略写失败，不阻断主流程
  }
}

import { readSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import type { LLMClient, EndpointMatch, ProviderInfo } from '@smokingmouse/llm'
import { getRecentEndpoints } from './recent.js'

// ── ANSI styling ────────────────────────────────────────

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  bgCyan: '\x1b[46m\x1b[30m',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  clearLine: '\x1b[2K',
  moveUp: (n: number) => (n > 0 ? `\x1b/${n}A`.replace('/', '[') : ''),
}

const MAX_VISIBLE = 10

export interface PickEndpointOptions {
  initialQuery?: string
  providerLock?: string
}

type PickerView = 'flat' | 'providers' | 'provider-models'

// ── string highlight helper ─────────────────────────────

function highlightMatch(text: string, query: string): string {
  if (!query.trim()) return text
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return text

  // 尝试在 text 中查找 term 出现的区间
  const lower = text.toLowerCase()
  const matched = new Array<boolean>(text.length).fill(false)

  for (const term of terms) {
    let pos = 0
    while (pos < lower.length) {
      const idx = lower.indexOf(term, pos)
      if (idx === -1) break
      for (let i = idx; i < idx + term.length; i++) {
        matched[i] = true
      }
      pos = idx + term.length
    }
  }

  let out = ''
  let inHighlight = false
  for (let i = 0; i < text.length; i++) {
    if (matched[i] && !inHighlight) {
      out += `${c.cyan}${c.bold}`
      inHighlight = true
    } else if (!matched[i] && inHighlight) {
      out += `${c.reset}`
      inHighlight = false
    }
    out += text[i]
  }
  if (inHighlight) out += c.reset
  return out
}

export function pickEndpoint(
  client: LLMClient,
  options?: PickEndpointOptions,
): string | null {
  const recentList = getRecentEndpoints()
  const providers = client.listProviders()

  if (providers.length === 0) {
    console.error('没有可用的 provider')
    return null
  }

  let view: PickerView = options?.providerLock ? 'provider-models' : 'flat'
  let activeProvider = options?.providerLock ?? ''
  let query = options?.initialQuery ?? ''
  let cursor = 0
  let viewportOffset = 0

  // 获取当前视图下的列表项
  function getItems(): {
    label: string
    sublabel?: string
    status?: string
    tag?: string
    value: string
    hasKey?: boolean
  }[] {
    if (view === 'flat') {
      const matches = client.searchEndpoints(query, { recent: recentList })
      return matches.map((m) => {
        let tag = ''
        if (m.isRecent) tag = `${c.cyan}⚡ recent${c.reset}`
        else if (m.isDefault) tag = `${c.yellow}★ default${c.reset}`

        const status = m.hasKey
          ? `${c.green}✓${c.reset}`
          : `${c.red}✗ no key${c.reset}`

        return {
          label: m.model,
          sublabel: m.provider,
          status,
          tag,
          value: m.qualified,
          hasKey: m.hasKey,
        }
      })
    }

    if (view === 'providers') {
      const q = query.trim().toLowerCase()
      const filtered = q
        ? providers.filter(
            (p) =>
              p.name.toLowerCase().includes(q) ||
              p.models.some((m) => m.toLowerCase().includes(q)),
          )
        : providers

      return filtered.map((p) => ({
        label: p.name,
        sublabel: `${p.models.length} 个模型`,
        status: p.hasKey ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`,
        value: p.name,
        hasKey: p.hasKey,
      }))
    }

    // provider-models
    const prov = providers.find((p) => p.name === activeProvider)
    if (!prov) return []
    const q = query.trim().toLowerCase()
    const filteredModels = q
      ? prov.models.filter((m) => m.toLowerCase().includes(q))
      : prov.models

    return filteredModels.map((m) => {
      const qualified = `${activeProvider}:${m}`
      const isRecent = recentList.includes(qualified) || recentList.includes(m)
      const isDefault = client.defaultEndpoint === m

      let tag = ''
      if (isRecent) tag = `${c.cyan}⚡ recent${c.reset}`
      else if (isDefault) tag = `${c.yellow}★ default${c.reset}`

      const status = prov.hasKey
        ? `${c.green}✓${c.reset}`
        : `${c.red}✗ no key${c.reset}`

      return {
        label: m,
        sublabel: activeProvider,
        status,
        tag,
        value: qualified,
        hasKey: prov.hasKey,
      }
    })
  }

  function render(items: ReturnType<typeof getItems>): string {
    const lines: string[] = []
    lines.push('')

    // Header
    let title = ''
    if (view === 'flat') {
      title = `${c.bold}llm${c.reset} ${c.dim}— 选择模型 (${items.length} 个匹配)${c.reset}`
    } else if (view === 'providers') {
      title = `${c.bold}llm${c.reset} ${c.dim}— 选择厂商 (${items.length} 个厂商)${c.reset}`
    } else {
      title = `${c.bold}llm${c.reset} ${c.dim}— ${activeProvider} 模型列表 (${items.length} 个)${c.reset}`
    }
    lines.push(`  ${title}`)

    // Search bar
    const searchPrompt = `  ${c.cyan}›${c.reset} ${c.dim}搜索:${c.reset} `
    const searchContent = query
      ? `${c.bold}${query}${c.reset}${c.cyan}▌${c.reset}`
      : `${c.dim}输入关键词快速过滤 (支持拼音/子串)...${c.reset}`
    lines.push(searchPrompt + searchContent)
    lines.push('')

    if (items.length === 0) {
      lines.push(`    ${c.gray}没有匹配的模型或厂商${c.reset}`)
      lines.push('')
    } else {
      // 调整 viewport
      if (cursor < viewportOffset) {
        viewportOffset = cursor
      } else if (cursor >= viewportOffset + MAX_VISIBLE) {
        viewportOffset = cursor - MAX_VISIBLE + 1
      }
      const visibleItems = items.slice(
        viewportOffset,
        viewportOffset + MAX_VISIBLE,
      )

      for (let i = 0; i < visibleItems.length; i++) {
        const item = visibleItems[i]!
        const realIdx = viewportOffset + i
        const isSelected = realIdx === cursor

        const rawLabel = item.label
        const highlightedLabel = highlightMatch(rawLabel, query)
        const paddedLabel =
          highlightedLabel +
          ' '.repeat(Math.max(0, 30 - rawLabel.length))
        const sublabel = (item.sublabel ?? '').padEnd(16)
        const tag = (item.tag ?? '').padEnd(14)
        const status = item.status ?? ''

        if (isSelected) {
          lines.push(
            `  ${c.cyan}❯${c.reset} ${c.bold}${c.white}${paddedLabel}${c.reset} ${c.dim}${sublabel}${c.reset} ${tag} ${status}`,
          )
        } else {
          lines.push(
            `    ${item.hasKey === false ? c.gray : c.white}${paddedLabel}${c.reset} ${c.dim}${sublabel}${c.reset} ${tag} ${status}`,
          )
        }
      }

      // 滚动指示
      if (items.length > MAX_VISIBLE) {
        const hasUp = viewportOffset > 0
        const hasDown = viewportOffset + MAX_VISIBLE < items.length
        const scrollIndicator = `${hasUp ? '▲' : ' '} ${realIndexStr(cursor + 1, items.length)} ${hasDown ? '▼' : ' '}`
        lines.push(`  ${c.dim}${scrollIndicator.padStart(50)}${c.reset}`)
      } else {
        lines.push('')
      }
    }

    // 底部帮助提示
    let hint = ''
    if (view === 'flat') {
      hint = '↑↓ 选择  Enter 确认  Tab 厂商模式  Esc 清除/退出'
    } else if (view === 'providers') {
      hint = '↑↓ 选择厂商  Enter 展开  Tab 全部模型  Esc 退出'
    } else {
      hint = '↑↓ 选择模型  Enter 确认  Esc 返回厂商列表'
    }
    lines.push(`  ${c.dim}${hint}${c.reset}`)
    lines.push('')

    return lines.join('\n')
  }

  function realIndexStr(cur: number, total: number): string {
    return `[${cur}/${total}]`
  }

  // 终端设置
  const saved = spawnSync('stty', ['-g'], {
    stdio: ['inherit', 'pipe', 'inherit'],
  }).stdout?.toString().trim()

  spawnSync('stty', ['-icanon', '-echo', '-isig', 'min', '1', 'time', '0'], {
    stdio: 'inherit',
  })

  let items = getItems()
  let lastOutput = render(items)
  let lastLineCount = lastOutput.split('\n').length

  process.stderr.write(c.hideCursor + lastOutput)

  const buf = Buffer.alloc(64)

  try {
    while (true) {
      let n: number
      try {
        n = readSync(0, buf, 0, buf.length, null)
      } catch (e: any) {
        if (e?.code === 'EAGAIN') continue
        throw e
      }
      if (n <= 0) return null

      const key = buf.toString('utf8', 0, n)

      // Ctrl-C (\x03), Ctrl-D (\x04)
      if (key === '\x03' || key === '\x04') return null

      // Enter
      if (key === '\r' || key === '\n') {
        if (items.length === 0) continue
        const selected = items[cursor]
        if (!selected) continue

        if (view === 'providers') {
          // 进入该 provider 的模型列表
          activeProvider = selected.value
          view = 'provider-models'
          query = ''
          cursor = 0
          viewportOffset = 0
        } else {
          // 选中模型并返回
          return selected.value
        }
      }
      // Esc
      else if (key === '\x1b') {
        if (view === 'provider-models') {
          // 返回厂商列表
          view = 'providers'
          query = ''
          cursor = 0
          viewportOffset = 0
        } else if (query.length > 0) {
          // 清空搜索词
          query = ''
          cursor = 0
          viewportOffset = 0
        } else {
          // 退出
          return null
        }
      }
      // Tab: 切换视图模式
      else if (key === '\t') {
        if (view === 'flat') {
          view = 'providers'
        } else if (view === 'providers') {
          view = 'flat'
        } else {
          view = 'flat'
        }
        query = ''
        cursor = 0
        viewportOffset = 0
      }
      // Backspace
      else if (key === '\x7f' || key === '\x08') {
        if (query.length > 0) {
          query = query.slice(0, -1)
          cursor = 0
          viewportOffset = 0
        }
      }
      // Ctrl-U (清空输入)
      else if (key === '\x15') {
        query = ''
        cursor = 0
        viewportOffset = 0
      }
      // 方向键 Up / Ctrl-P
      else if (key === '\x1b[A' || key === '\x1bOA' || key === '\x10') {
        if (items.length > 0) {
          cursor = (cursor - 1 + items.length) % items.length
        }
      }
      // 方向键 Down / Ctrl-N
      else if (key === '\x1b[B' || key === '\x1bOB' || key === '\x0e') {
        if (items.length > 0) {
          cursor = (cursor + 1) % items.length
        }
      }
      // PageUp
      else if (key === '\x1b[5~') {
        if (items.length > 0) {
          cursor = Math.max(0, cursor - MAX_VISIBLE)
        }
      }
      // PageDown
      else if (key === '\x1b[6~') {
        if (items.length > 0) {
          cursor = Math.min(items.length - 1, cursor + MAX_VISIBLE)
        }
      }
      // Home / Ctrl-A
      else if (key === '\x1b[H' || key === '\x1b[1~' || key === '\x01') {
        cursor = 0
      }
      // End / Ctrl-E
      else if (key === '\x1b[F' || key === '\x1b[4~' || key === '\x05') {
        if (items.length > 0) cursor = items.length - 1
      }
      // 普通可打印字符输入 (ASCII 32 ~ 126 或 UTF-8 字符)
      else if (!key.startsWith('\x1b') && !/[\x00-\x1f]/.test(key)) {
        query += key
        cursor = 0
        viewportOffset = 0
      }

      // 重新计算并渲染
      items = getItems()
      if (cursor >= items.length) {
        cursor = Math.max(0, items.length - 1)
      }

      const nextOutput = render(items)
      const nextLineCount = nextOutput.split('\n').length

      // 擦除上一帧并重绘
      process.stderr.write(c.moveUp(lastLineCount) + '\r')
      for (let i = 0; i < Math.max(lastLineCount, nextLineCount); i++) {
        process.stderr.write(c.clearLine + '\n')
      }
      process.stderr.write(c.moveUp(Math.max(lastLineCount, nextLineCount)) + '\r')
      process.stderr.write(nextOutput)

      lastOutput = nextOutput
      lastLineCount = nextLineCount
    }
  } finally {
    // 退出清理
    process.stderr.write(c.moveUp(lastLineCount) + '\r')
    for (let i = 0; i < lastLineCount + 1; i++) {
      process.stderr.write(c.clearLine + '\n')
    }
    process.stderr.write(c.moveUp(lastLineCount + 1) + '\r')
    process.stderr.write(c.showCursor)
    if (saved) spawnSync('stty', [saved], { stdio: 'inherit' })
  }
}

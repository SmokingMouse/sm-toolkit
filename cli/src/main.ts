#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { LLMClient } from '@sm/llm'
import type { Message } from '@sm/llm'

const client = new LLMClient()

// ── ANSI helpers ────────────────────────────────────────

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  white: '\x1b[37m',
  bgCyan: '\x1b[46m\x1b[30m',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  clearLine: '\x1b[2K',
  moveUp: (n: number) => `\x1b[${n}A`,
}

// ── interactive picker (two-level) ──────────────────────

function renderList(
  title: string,
  items: { label: string; detail?: string; status?: string }[],
  cursor: number,
  hint: string,
): string {
  const lines: string[] = []
  lines.push('')
  lines.push(`  ${c.bold}llm${c.reset} ${c.dim}— ${title}${c.reset}`)
  lines.push('')

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    const selected = i === cursor
    const label = item.label.padEnd(20)
    const detail = (item.detail ?? '').padEnd(28)
    const status = item.status ?? ''

    if (selected) {
      lines.push(
        `  ${c.cyan}›${c.reset} ${c.bold}${c.cyan}${label}${c.reset} ${detail} ${status}`,
      )
    } else {
      lines.push(
        `    ${c.white}${label}${c.reset} ${c.dim}${detail}${c.reset} ${status}`,
      )
    }
  }

  lines.push('')
  lines.push(`  ${c.dim}${hint}${c.reset}`)
  lines.push('')
  return lines.join('\n')
}

function selectFromList(
  title: string,
  items: { label: string; detail?: string; status?: string }[],
  hint: string,
): Promise<number | null> {
  if (items.length === 0) return Promise.resolve(null)

  let cursor = 0
  const total = items.length

  const output = renderList(title, items, cursor, hint)
  process.stderr.write(c.hideCursor + output)
  const lineCount = output.split('\n').length - 1

  return new Promise<number | null>((resolve) => {
    const stdin = process.stdin
    stdin.setRawMode(true)
    stdin.resume()

    function redraw() {
      process.stderr.write(c.moveUp(lineCount) + '\r')
      process.stderr.write(renderList(title, items, cursor, hint))
    }

    function cleanup(result: number | null) {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.removeListener('data', onData)
      process.stderr.write(c.moveUp(lineCount) + '\r')
      for (let i = 0; i < lineCount + 1; i++) {
        process.stderr.write(c.clearLine + '\n')
      }
      process.stderr.write(c.moveUp(lineCount + 1) + '\r')
      process.stderr.write(c.showCursor)
      resolve(result)
    }

    function onData(data: Buffer) {
      const key = data.toString()

      if (key === '\x03' || key === 'q' || key === '\x1b') {
        cleanup(null)
        return
      }

      if (key === '\r' || key === '\n') {
        cleanup(cursor)
        return
      }

      if (key === '\x1b[A' || key === 'k') {
        cursor = (cursor - 1 + total) % total
        redraw()
        return
      }

      if (key === '\x1b[B' || key === 'j') {
        cursor = (cursor + 1) % total
        redraw()
        return
      }
    }

    stdin.on('data', onData)
  })
}

async function pickEndpoint(): Promise<string | null> {
  const providers = client.listProviders()
  if (providers.length === 0) {
    console.error('没有可用的 provider')
    return null
  }

  // level 1: pick provider
  const providerItems = providers.map((p) => ({
    label: p.name,
    detail: `${p.models.length} 个模型`,
    status: p.hasKey ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`,
  }))
  const providerIdx = await selectFromList(
    '选择厂商',
    providerItems,
    '↑↓ 选择  Enter 确认  q 退出',
  )
  if (providerIdx === null) return null

  const provider = providers[providerIdx]!

  // single model → skip level 2
  if (provider.models.length === 1) {
    return provider.models[0]!
  }

  // level 2: pick model
  const modelItems = provider.models.map((m) => ({
    label: m,
  }))
  const modelIdx = await selectFromList(
    `${provider.name} — 选择模型`,
    modelItems,
    '↑↓ 选择  Enter 确认  Esc 返回  q 退出',
  )
  if (modelIdx === null) return null

  return provider.models[modelIdx]!
}

// ── endpoint resolution (prefix + alias) ──────────────────

const ALIASES: Record<string, string> = {
  ds: 'deepseek-chat',
  dr: 'deepseek-reasoner',
  gf: 'gemini-2.5-flash',
  qw: 'qwen3.5-plus',
}

function resolveEndpointName(input: string): string | null {
  try {
    const { name } = client.getEndpointConfig(input)
    return name
  } catch {
    // try alias
    const aliased = ALIASES[input]
    if (aliased) {
      try {
        const { name } = client.getEndpointConfig(aliased)
        return name
      } catch {}
    }
    return null
  }
}

// ── help ──────────────────────────────────────────────────

function printHelp() {
  const providers = client.listProviders()
  const defaultModel = client.defaultEndpoint

  console.log(`llm — 统一 LLM 命令行

用法:
  llm                           交互选择模型，启动 Claude Code session
  llm <model|provider>          直接指定模型启动交互 session
  llm <model> -p "prompt"      直调 API
  llm -p "prompt"               直调 API（default: ${defaultModel}）
  echo "data" | llm -p "..."   stdin + prompt

选项:
  -p, --prompt    提示词（有则走 API，无则启动交互 session）
  -s, --system    system prompt
  -f, --file      读文件内容拼入 user message
  --temperature   温度（0.0-2.0）
  --json-mode     要求模型返回 JSON（response_format: json_object）
  --stream        流式输出
  --json          JSON 格式输出（含 usage）
  --list          列出所有 providers
  -h, --help      帮助

Providers:`)
  for (const p of providers) {
    const status = p.hasKey ? '✓' : '✗'
    console.log(`  ${status} ${p.name}`)
    for (const m of p.models) {
      const def = m === defaultModel ? ' *' : ''
      console.log(`      ${m}${def}`)
    }
  }
  console.log(`\n  * = default（直调 API 时使用）`)
  console.log(`\n示例:`)
  console.log(`  llm                     交互选择模型`)
  console.log(`  llm claude              打开 Claude Code 交互（单模型厂商直接启动）`)
  console.log(`  llm ds -p "hello"       用 deepseek-chat 直调 API`)
  console.log(`  llm -p "hello" --stream 流式输出`)
}

// ── arg parsing ──────────────────────────────────────────

interface Args {
  endpoint?: string
  prompt?: string
  system?: string
  file?: string
  temperature?: number
  json: boolean
  jsonMode: boolean
  stream: boolean
  list: boolean
  help: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    json: false,
    jsonMode: false,
    stream: false,
    list: false,
    help: false,
  }
  let i = 0

  while (i < argv.length) {
    const a = argv[i]
    if (a === '-p' || a === '--prompt') {
      args.prompt = argv[++i]
    } else if (a === '-s' || a === '--system') {
      args.system = argv[++i]
    } else if (a === '-f' || a === '--file') {
      args.file = argv[++i]
    } else if (a === '--temperature') {
      args.temperature = parseFloat(argv[++i]!)
    } else if (a === '--json') {
      args.json = true
    } else if (a === '--json-mode') {
      args.jsonMode = true
    } else if (a === '--stream') {
      args.stream = true
    } else if (a === '--list') {
      args.list = true
    } else if (a === '-h' || a === '--help' || a === 'help') {
      args.help = true
    } else if (!a!.startsWith('-') && !args.endpoint) {
      args.endpoint = a
    }
    i++
  }

  return args
}

// ── stdin ────────────────────────────────────────────────

async function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null

  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf-8').trim()
  return text || null
}

// ── message building ────────────────────────────────────

function buildMessages(
  prompt: string,
  system?: string,
  fileContent?: string,
  stdinData?: string,
): Message[] {
  const messages: Message[] = []
  if (system) {
    messages.push({ role: 'system', content: system })
  }

  let userContent = ''
  if (stdinData) userContent += stdinData + '\n\n'
  if (fileContent) userContent += fileContent + '\n\n'
  userContent += prompt

  messages.push({ role: 'user', content: userContent.trim() })
  return messages
}

// ── interactive session ─────────────────────────────────

async function execClaude(endpointName?: string): Promise<void> {
  const { name, endpoint: ep } = client.getEndpointConfig(endpointName, 'anthropic')
  const { spawn } = await import('node:child_process')

  const env: Record<string, string> = { ...process.env } as Record<
    string,
    string
  >
  if (ep.base_url) env.ANTHROPIC_BASE_URL = ep.base_url

  const key = process.env[ep.api_key_env]
  if (key) env.ANTHROPIC_API_KEY = key

  const args = ['--model', ep.model]
  // non-Anthropic provider: --bare forces API key auth only, skips OAuth
  if (ep.base_url) args.push('--bare')
  console.error(`→ Claude Code [${name}] model=${ep.model}`)

  const child = spawn('claude', args, {
    env,
    stdio: 'inherit',
  })

  const code = await new Promise<number>((resolve) => {
    child.on('close', (c) => resolve(c ?? 1))
  })
  process.exit(code)
}

// ── main ────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.help) {
    printHelp()
    return
  }

  if (args.list) {
    printHelp()
    return
  }

  // resolve endpoint name (fuzzy match)
  let endpoint = args.endpoint
  if (endpoint) {
    const resolved = resolveEndpointName(endpoint)
    if (!resolved) {
      console.error(
        `未知 endpoint: "${endpoint}"\n运行 llm --list 查看可用 endpoints`,
      )
      process.exit(1)
    }
    endpoint = resolved
  }

  const stdinData = await readStdin()
  const hasPrompt = !!args.prompt || !!stdinData

  // no prompt, no endpoint → interactive picker
  if (!hasPrompt && !endpoint) {
    if (!process.stdin.isTTY) {
      printHelp()
      return
    }
    const picked = await pickEndpoint()
    if (!picked) return
    endpoint = picked
  }

  // no prompt → interactive session
  if (!hasPrompt) {
    await execClaude(endpoint)
    return
  }

  // API call
  const prompt = args.prompt ?? ''
  const fileContent = args.file ? readFileSync(args.file, 'utf-8') : undefined
  const messages = buildMessages(
    prompt,
    args.system,
    fileContent,
    stdinData ?? undefined,
  )

  const chatOpts = {
    temperature: args.temperature,
    json_mode: args.jsonMode || undefined,
  }

  if (args.stream) {
    for await (const chunk of client.stream(endpoint, messages, chatOpts)) {
      if (chunk.type === 'text_delta') {
        process.stdout.write(chunk.text)
      } else if (chunk.type === 'done') {
        process.stdout.write('\n')
        if (args.json) {
          console.error(JSON.stringify(chunk.result, null, 2))
        }
      }
    }
  } else {
    const result = await client.chat(endpoint, messages, chatOpts)

    if (args.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(result.text)
    }
  }
}

main().catch((e) => {
  console.error(e.message ?? e)
  process.exit(1)
})

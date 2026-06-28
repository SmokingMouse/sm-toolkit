#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { LLMClient } from '@sm/llm'
import type { Message } from '@sm/llm'

const client = new LLMClient()

// ── endpoint resolution (prefix + alias) ──────────────────

const ALIASES: Record<string, string> = {
  ds: 'deepseek-chat',
  dr: 'deepseek-reasoner',
  gf: 'gemini-flash',
  qw: 'qwen-plus',
}

function resolveEndpointName(input: string): string | null {
  const endpoints = client.listEndpoints()
  const names = endpoints.map((e) => e.name)
  if (names.includes(input)) return input
  if (ALIASES[input] && names.includes(ALIASES[input])) return ALIASES[input]
  const match = names.find(
    (n) => n.startsWith(input) || n.replace(/-/g, '').startsWith(input),
  )
  return match ?? null
}

// ── help ──────────────────────────────────────────────────

function printHelp() {
  const endpoints = client.listEndpoints()
  const defaultEp = client.defaultEndpoint

  console.log(`llm — 统一 LLM 命令行

用法:
  llm <endpoint>                 启动 Claude Code 交互 session
  llm <endpoint> -p "prompt"     直调 API
  llm -p "prompt"                直调 API（default endpoint）
  echo "data" | llm -p "..."    stdin + prompt
  llm -p "..." -f file          读文件作为上下文

选项:
  -p, --prompt    提示词（有则走 API，无则启动交互 session）
  -s, --system    system prompt
  -f, --file      读文件内容拼入 user message
  --stream        流式输出
  --json          JSON 格式输出（含 usage）
  --list          列出所有 endpoints
  -h, --help      帮助

Endpoints:`)
  for (const ep of endpoints) {
    const status = ep.hasKey ? '✓' : '✗'
    const def = ep.name === defaultEp ? ' *' : ''
    const url = ep.base_url ? ` [${ep.base_url}]` : ' [anthropic]'
    console.log(`  ${status} ${ep.name}${def} → ${ep.model}${url}`)
  }
  console.log(`\n  * = default（直调 API 时使用）`)
  console.log(`\n示例:`)
  console.log(`  llm claude              打开 Claude Code 交互`)
  console.log(`  llm ds -p "hello"       用 deepseek-chat 直调 API`)
  console.log(`  llm -p "hello" --stream 流式输出`)
}

// ── arg parsing ──────────────────────────────────────────

interface Args {
  endpoint?: string
  prompt?: string
  system?: string
  file?: string
  json: boolean
  stream: boolean
  list: boolean
  help: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { json: false, stream: false, list: false, help: false }
  let i = 0

  while (i < argv.length) {
    const a = argv[i]
    if (a === '-p' || a === '--prompt') {
      args.prompt = argv[++i]
    } else if (a === '-s' || a === '--system') {
      args.system = argv[++i]
    } else if (a === '-f' || a === '--file') {
      args.file = argv[++i]
    } else if (a === '--json') {
      args.json = true
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
  const { name, endpoint: ep } = client.getEndpointConfig(endpointName)
  const { spawn } = await import('node:child_process')

  const env: Record<string, string> = { ...process.env } as Record<
    string,
    string
  >
  if (ep.base_url) env.ANTHROPIC_BASE_URL = ep.base_url

  const key = process.env[ep.api_key_env]
  if (key) env.ANTHROPIC_API_KEY = key

  const args = ['--model', ep.model]
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

  // no prompt → interactive session
  if (!hasPrompt) {
    if (!endpoint) {
      printHelp()
      return
    }
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

  if (args.stream) {
    for await (const chunk of client.stream(endpoint, messages)) {
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
    const result = await client.chat(endpoint, messages)

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

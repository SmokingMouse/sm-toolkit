#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { LLMClient } from '@sm/llm'
import type { Message } from '@sm/llm'

function usage(): never {
  console.log(`Usage:
  llm [endpoint] -p "prompt"          直调 API
  llm [endpoint] -s "system" -p "..."  带 system prompt
  llm [endpoint] -f file -p "..."      读文件作为上下文
  echo "data" | llm [endpoint]         stdin 作为数据
  llm [endpoint]                       打开 Claude Code 交互 session
  llm --list                           列出 endpoints + key 状态
  llm --json -p "..."                  JSON 输出含 usage
  llm --stream -p "..."               流式输出

Options:
  -p, --prompt    提示词
  -s, --system    system prompt
  -f, --file      读文件内容拼入 user message
  --json          JSON 格式输出（含 usage）
  --stream        流式输出
  --list          列出所有 endpoints
  -h, --help      帮助`)
  process.exit(0)
}

interface Args {
  endpoint?: string
  prompt?: string
  system?: string
  file?: string
  json: boolean
  stream: boolean
  list: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { json: false, stream: false, list: false }
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
    } else if (a === '-h' || a === '--help') {
      usage()
    } else if (!a.startsWith('-') && !args.endpoint) {
      args.endpoint = a
    }
    i++
  }

  return args
}

async function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null

  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf-8').trim()
  return text || null
}

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

async function execClaude(
  client: LLMClient,
  endpoint?: string,
): Promise<void> {
  const { name, endpoint: ep } = client.getEndpointConfig(endpoint)
  const { spawn } = await import('node:child_process')

  const env: Record<string, string> = { ...process.env } as Record<string, string>
  if (ep.base_url) env.ANTHROPIC_BASE_URL = ep.base_url

  const keyEnv = ep.api_key_env
  const key = process.env[keyEnv]
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

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const client = new LLMClient()

  if (args.list) {
    const endpoints = client.listEndpoints()
    console.log('Endpoints:')
    for (const ep of endpoints) {
      const status = ep.hasKey ? '✓' : '✗'
      const def = ep.name === client.defaultEndpoint ? ' (default)' : ''
      const url = ep.base_url ? ` [${ep.base_url}]` : ' [anthropic]'
      console.log(`  ${status} ${ep.name}${def} → ${ep.model}${url}`)
    }
    return
  }

  const stdinData = await readStdin()
  const hasPrompt = !!args.prompt || !!stdinData

  if (!hasPrompt) {
    await execClaude(client, args.endpoint)
    return
  }

  const prompt = args.prompt ?? ''
  const fileContent = args.file ? readFileSync(args.file, 'utf-8') : undefined

  const messages = buildMessages(prompt, args.system, fileContent, stdinData ?? undefined)

  if (args.stream) {
    for await (const chunk of client.stream(args.endpoint, messages)) {
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
    const result = await client.chat(args.endpoint, messages)

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

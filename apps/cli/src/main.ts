#!/usr/bin/env bun
import { readFileSync, readSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { LLMClient, benchEndpoint } from '@smokingmouse/llm'
import type { Message, BenchMeasurement, EndpointConfig } from '@smokingmouse/llm'

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
): number | null {
  if (items.length === 0) return null

  let cursor = 0
  const total = items.length

  const output = renderList(title, items, cursor, hint)
  const lineCount = output.split('\n').length - 1

  // 不碰 process.stdin：bun 的 stdin reader 一旦启动无法真正释放（pause 停不掉
  // 在途 read），会和随后 spawn 的 claude 争抢 tty 字节——终端应答序列（DA/XTVERSION/
  // 鼠标上报）被偷走 ESC 前缀后，尾巴以明文漏进 claude 输入框。
  // 改为 stty 设终端模式 + readSync(0) 同步读，父进程全程零 stdin reader。
  const saved = spawnSync('stty', ['-g'], {
    stdio: ['inherit', 'pipe', 'inherit'],
  }).stdout?.toString().trim()
  spawnSync('stty', ['-icanon', '-echo', '-isig', 'min', '1', 'time', '0'], {
    stdio: 'inherit',
  })
  process.stderr.write(c.hideCursor + output)

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

      if (key === '\x03' || key === '\x04' || key === 'q' || key === '\x1b') return null
      if (key === '\r' || key === '\n') return cursor

      if (key === '\x1b[A' || key === 'k') {
        cursor = (cursor - 1 + total) % total
      } else if (key === '\x1b[B' || key === 'j') {
        cursor = (cursor + 1) % total
      } else {
        continue
      }
      process.stderr.write(c.moveUp(lineCount) + '\r')
      process.stderr.write(renderList(title, items, cursor, hint))
    }
  } finally {
    process.stderr.write(c.moveUp(lineCount) + '\r')
    for (let i = 0; i < lineCount + 1; i++) {
      process.stderr.write(c.clearLine + '\n')
    }
    process.stderr.write(c.moveUp(lineCount + 1) + '\r')
    process.stderr.write(c.showCursor)
    if (saved) spawnSync('stty', [saved], { stdio: 'inherit' })
  }
}

function pickEndpoint(): string | null {
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
  const providerIdx = selectFromList(
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
  const modelIdx = selectFromList(
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
  --json          JSON 格式输出（含 usage；配 --list 输出 provider 状态 JSON）
  --fallback      逗号分隔的 endpoint 链，依次尝试直到成功（配 -p 使用）
  --list          列出所有 providers
  -h, --help      帮助

子命令:
  llm vision -f <file> -p <prompt> [-m model]
      图片/视频/音频理解。图片走 openai-compat（默认 Gemini），
      视频/音频走 Gemini Files API（上传+轮询，进度打 stderr）
  llm image -p <prompt> [--backend imagen|codex] [--aspect 16:9] [--count N]
            [--negative "..."] [--ref FILE] [--target-size N] [--output DIR]
      生图。imagen 默认（快/可控），codex = GPT-Image-1 via codex exec
      （支持 --ref 参考图）。stdout 每行一个图片绝对路径
  llm bench [filter...] [--quick] [--tokens N] [--timeout S] [--json]
      全端点测速：联通 / 首响延迟(ttft) / 解码吞吐(tps)。
      filter = provider 名或模型名前缀。详见 llm bench --help

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
  fallback?: string
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
    } else if (a === '--fallback') {
      args.fallback = argv[++i]
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

  const env: Record<string, string> = { ...process.env } as Record<
    string,
    string
  >
  const key = process.env[ep.api_key_env]

  if (ep.base_url) {
    // 代理 endpoint：key 缺失时 claude 会以"无凭证"启动并要求 /login，
    // 必须在这里拦下报错，而不是静默拉起
    if (!key) {
      console.error(`✗ 环境变量 ${ep.api_key_env} 未设置，endpoint [${name}] 需要 API key`)
      console.error(`  检查 endpoints.yaml 的 env_file 是否存在且包含 ${ep.api_key_env}=...`)
      console.error(`  运行 llm --list 查看各 provider 的 key 状态（✓/✗）`)
      process.exit(1)
    }
    env.ANTHROPIC_BASE_URL = ep.base_url
    // 代理（super-relay 等）通过 ANTHROPIC_AUTH_TOKEN 认证，同时也设
    // ANTHROPIC_API_KEY 以兼容不同版本的 claude CLI
    env.ANTHROPIC_AUTH_TOKEN = key
    env.ANTHROPIC_API_KEY = key
    // 代理 endpoint 的推导默认值：tier 全部映射到该模型（否则 subagent /
    // 后台任务会去找代理上不存在的官方 tier 模型）、放宽超时、关非必要流量。
    // endpoints.yaml 的 claude.env 可覆盖这里任何一项。
    env.ANTHROPIC_MODEL = ep.model
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = ep.model
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = ep.model
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = ep.model
    env.ANTHROPIC_DEFAULT_FABLE_MODEL = ep.model
    env.ANTHROPIC_SMALL_FAST_MODEL = ep.model
    env.API_TIMEOUT_MS ??= '3000000'
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ??= '1'
  } else if (key) {
    env.ANTHROPIC_API_KEY = key
  }

  // endpoints.yaml 的 claude: 块——顶层为全局，provider 级覆盖同名 env、args 追加。
  // 优先级：自动推导 < 全局 claude.env < provider claude.env
  const settings = client.claudeSettings
  for (const [k, v] of Object.entries({
    ...settings.env,
    ...ep.claude?.env,
  })) {
    env[k] = String(v)
  }

  const args = ['--model', ep.model]
  args.push(...(settings.args ?? []).map(String))
  args.push(...(ep.claude?.args ?? []).map(String))
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

// ── subcommands: vision / image ─────────────────────────

async function cmdVision(argv: string[]): Promise<void> {
  let file: string | undefined
  let prompt: string | undefined
  let model: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-f' || a === '--file') file = argv[++i]
    else if (a === '-p' || a === '--prompt') prompt = argv[++i]
    else if (a === '-m' || a === '--model') model = argv[++i]
  }
  if (!file || !prompt) {
    console.error('用法: llm vision -f <file> -p <prompt> [-m model]')
    process.exit(1)
  }
  const text = await client.vision(file, prompt, {
    endpoint: model,
    onProgress: (m) => console.error(`… ${m}`),
  })
  console.log(text)
}

async function cmdImage(argv: string[]): Promise<void> {
  let prompt: string | undefined
  let backend: 'imagen' | 'codex' | undefined
  let aspect: string | undefined
  let count: number | undefined
  let negative: string | undefined
  let ref: string | undefined
  let targetSize: number | undefined
  let output: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-p' || a === '--prompt') prompt = argv[++i]
    else if (a === '--backend') backend = argv[++i] as 'imagen' | 'codex'
    else if (a === '-a' || a === '--aspect') aspect = argv[++i]
    else if (a === '-n' || a === '--count') count = parseInt(argv[++i]!, 10)
    else if (a === '--negative') negative = argv[++i]
    else if (a === '--ref') ref = argv[++i]
    else if (a === '--target-size') targetSize = parseInt(argv[++i]!, 10)
    else if (a === '-o' || a === '--output') output = argv[++i]
  }
  if (!prompt) {
    console.error(
      '用法: llm image -p <prompt> [--backend imagen|codex] [--aspect R] [--count N] [--negative S] [--ref FILE] [--target-size N] [--output DIR]',
    )
    process.exit(1)
  }
  if (backend && backend !== 'imagen' && backend !== 'codex') {
    console.error(`未知 backend: "${backend}"（可选 imagen / codex）`)
    process.exit(1)
  }
  const paths = await client.image({
    prompt,
    backend,
    aspect,
    count,
    negative,
    ref,
    targetSize,
    output,
    onProgress: (m) => console.error(`… ${m}`),
  })
  for (const p of paths) console.log(p)
}

// ── subcommand: bench ───────────────────────────────────

interface BenchRow {
  provider: string
  model: string
  qualified: string
  ep?: EndpointConfig
  status: 'pending' | 'ok' | 'error' | 'skip'
  reason?: string
  m?: BenchMeasurement
}

// 完整错误信息留在 row.reason（--json 要全文），表格/进度行渲染时才截断
function benchErrMsg(e: any, timeoutS: number): string {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError')
    return `超时 >${timeoutS}s`
  const code = e?.cause?.code ?? e?.code
  let msg = String(e?.message ?? e).replace(/\s+/g, ' ')
  if (code && !msg.includes(String(code))) msg = `${code}: ${msg}`
  return msg
}

function fmtTtft(r: BenchRow): string {
  const ms = r.m?.ttft_ms
  return ms == null ? '-' : `${(ms / 1000).toFixed(2)}s`
}

// 均摊每个 delta >100 token = 整块缓冲送达，tps 是灌包速度不是解码速度
function isBurst(r: BenchRow): boolean {
  const m = r.m
  return !!m && m.deltas > 0 && m.output_tokens / m.deltas > 100
}

function fmtTps(r: BenchRow): string {
  const tps = r.m?.tps
  if (tps == null) return '-'
  return `${r.m!.tokens_estimated ? '~' : ''}${tps.toFixed(1)}${isBurst(r) ? '*' : ''}`
}

async function cmdBench(argv: string[]): Promise<void> {
  let tokens = 256
  let timeoutS = 60
  let quick = false
  let json = false
  let concurrency = 1
  let protocol: 'openai' | 'anthropic' | undefined
  const filters: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--tokens') tokens = parseInt(argv[++i]!, 10)
    else if (a === '--timeout') timeoutS = parseInt(argv[++i]!, 10)
    else if (a === '--quick') quick = true
    else if (a === '--json') json = true
    else if (a === '--concurrency')
      concurrency = Math.max(1, parseInt(argv[++i]!, 10))
    else if (a === '--protocol') {
      const p = argv[++i]
      if (p !== 'openai' && p !== 'anthropic') {
        console.error(`--protocol 只接受 openai / anthropic，收到 "${p}"`)
        process.exit(1)
      }
      protocol = p
    } else if (a === '-h' || a === '--help') {
      console.log(`llm bench — endpoints.yaml 全端点测速（联通 + ttft + tps）

用法:
  llm bench                     全部 provider × 全部模型
  llm bench cpa kimi            只测这些 provider（也可给模型名/限定名前缀）
  llm bench --quick             每个 provider 只测第一个模型

选项:
  --tokens N        每次生成的 max_tokens（默认 256）
  --timeout S       单请求超时秒数（默认 60）
  --concurrency N   provider 内并发请求数（默认 1，防误触发限流；provider 间天然并行）
  --protocol P      强制线协议 openai|anthropic（默认按 llm -p 的解析规则：
                    双协议 provider 走 openai；claude session 实际走 anthropic，
                    要测那条路加 --protocol anthropic）
  --json            输出 JSON 结果（进度仍打 stderr）

指标: ttft = 首个可见 token 延迟；tps = output_tokens / (总时长 - ttft)，
端点没报 usage 时按字符数/4 估算（显示带 ~ 前缀）。单次请求无重试，测的是裸网络真相。`)
      return
    } else if (!a.startsWith('-')) filters.push(a)
  }

  // build rows（保持 yaml 声明顺序）
  const providers = client.listProviders()
  const rows: BenchRow[] = []
  for (const prov of providers) {
    let models = prov.models
    if (filters.length > 0 && !filters.includes(prov.name)) {
      models = models.filter((m) =>
        filters.some((f) => m.startsWith(f) || `${prov.name}:${m}`.startsWith(f)),
      )
      if (models.length === 0) continue
    }
    if (quick) models = models.slice(0, 1)

    for (const model of models) {
      const row: BenchRow = {
        provider: prov.name,
        model,
        qualified: `${prov.name}:${model}`,
        status: 'pending',
      }
      if (!prov.hasKey) {
        row.status = 'skip'
        row.reason = `no key (${prov.api_key_env})`
      } else {
        try {
          row.ep = client.getEndpointConfig(row.qualified, protocol).endpoint
        } catch (e: any) {
          row.status = 'skip'
          row.reason = String(e?.message ?? e).slice(0, 96)
        }
      }
      rows.push(row)
    }
  }

  if (rows.length === 0) {
    console.error(
      filters.length > 0
        ? `没有 endpoint 命中过滤条件: ${filters.join(' ')}`
        : '没有可测的 endpoint',
    )
    process.exit(1)
  }

  // run：provider 间并行，provider 内按 --concurrency 排队（默认串行防限流）
  const pending = rows.filter((r) => r.status === 'pending')
  const width = String(pending.length).length
  let done = 0

  const runRow = async (row: BenchRow) => {
    try {
      row.m = await benchEndpoint(row.ep!, row.qualified, {
        max_tokens: tokens,
        timeout_ms: timeoutS * 1000,
      })
      row.status = 'ok'
    } catch (e: any) {
      row.status = 'error'
      row.reason = benchErrMsg(e, timeoutS)
    }
    done++
    const tag =
      row.status === 'ok' ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`
    const detail =
      row.status === 'ok'
        ? `ttft ${fmtTtft(row)}  tps ${fmtTps(row)}`
        : (row.reason ?? '').slice(0, 96)
    console.error(
      `  [${String(done).padStart(width)}/${pending.length}] ${tag} ${row.qualified}  ${c.dim}${detail}${c.reset}`,
    )
  }

  const byProvider = new Map<string, BenchRow[]>()
  for (const r of pending) {
    const g = byProvider.get(r.provider) ?? []
    g.push(r)
    byProvider.set(r.provider, g)
  }
  if (pending.length > 0) {
    console.error(
      `→ bench ${pending.length} 个 endpoint（${byProvider.size} 个 provider 并行 × 内部并发 ${concurrency}），tokens=${tokens} timeout=${timeoutS}s`,
    )
  }
  await Promise.all(
    [...byProvider.values()].map(async (group) => {
      const queue = [...group]
      const workers = Array.from(
        { length: Math.min(concurrency, queue.length) },
        async () => {
          while (queue.length > 0) await runRow(queue.shift()!)
        },
      )
      await Promise.all(workers)
    }),
  )

  if (json) {
    console.log(
      JSON.stringify(
        rows.map((r) => ({
          provider: r.provider,
          model: r.model,
          endpoint: r.qualified,
          base_url: r.ep?.base_url ?? null,
          protocol: r.ep?.protocol ?? null,
          status: r.status,
          reason: r.reason ?? null,
          ttft_ms: r.m?.ttft_ms ?? null,
          total_ms: r.m?.total_ms ?? null,
          output_tokens: r.m?.output_tokens ?? null,
          tokens_estimated: r.m?.tokens_estimated ?? null,
          tps: r.m?.tps ?? null,
          deltas: r.m?.deltas ?? null,
        })),
        null,
        2,
      ),
    )
    return
  }

  // final table
  const okN = rows.filter((r) => r.status === 'ok').length
  const errN = rows.filter((r) => r.status === 'error').length
  const skipN = rows.filter((r) => r.status === 'skip').length
  const w = Math.min(36, Math.max(24, ...rows.map((r) => r.model.length)))

  console.log('')
  console.log(
    `${c.bold}llm bench${c.reset} ${c.dim}— ${c.reset}${c.green}${okN} ✓${c.reset} · ${c.red}${errN} ✗${c.reset} · ${c.dim}${skipN} skip · tokens=${tokens} timeout=${timeoutS}s${protocol ? ` protocol=${protocol}` : ''}${c.reset}`,
  )
  for (const prov of providers) {
    const group = rows.filter((r) => r.provider === prov.name)
    if (group.length === 0) continue

    // skip 行没有 resolved ep，回退到 provider 声明的 URL（与默认解析同序：openai 优先）
    const urls = [
      ...new Set(
        group.map(
          (r) =>
            r.ep?.base_url ?? prov.openai_url ?? prov.anthropic_url ?? '官方 API',
        ),
      ),
    ]
    console.log('')
    console.log(`${c.bold}${prov.name}${c.reset}  ${c.dim}${urls.join(' / ')}${c.reset}`)

    if (
      group.length > 1 &&
      group.every((r) => r.status === 'skip' && r.reason === group[0]!.reason)
    ) {
      console.log(`  ${c.dim}– 跳过 ×${group.length}: ${group[0]!.reason}${c.reset}`)
      continue
    }
    for (const r of group) {
      if (r.status === 'ok') {
        console.log(
          `  ${c.green}✓${c.reset} ${r.model.padEnd(w)} ttft ${fmtTtft(r).padStart(6)}  tps ${fmtTps(r).padStart(7)}  ${String(r.m!.output_tokens).padStart(4)} tok  ${(r.m!.total_ms / 1000).toFixed(1).padStart(5)}s`,
        )
      } else if (r.status === 'error') {
        console.log(
          `  ${c.red}✗${c.reset} ${r.model.padEnd(w)} ${c.red}${(r.reason ?? '').slice(0, 96)}${c.reset}`,
        )
      } else {
        console.log(
          `  ${c.dim}– ${r.model.padEnd(w)} skip: ${r.reason}${c.reset}`,
        )
      }
    }
  }

  const oks = rows.filter((r) => r.status === 'ok' && r.m)
  if (oks.length > 0) {
    const fastest = oks
      .filter((r) => r.m!.ttft_ms != null)
      .sort((a, b) => a.m!.ttft_ms! - b.m!.ttft_ms!)[0]
    // 缓冲送达的 tps 是灌包速度，不参与吞吐榜
    const streamed = oks.filter((r) => r.m!.tps != null && !isBurst(r))
    const top = streamed.sort((a, b) => b.m!.tps! - a.m!.tps!)[0]
    console.log('')
    if (fastest)
      console.log(
        `  最快首响 ${c.cyan}${fastest.qualified}${c.reset} ${fmtTtft(fastest)}`,
      )
    if (top)
      console.log(
        `  最高吞吐 ${c.cyan}${top.qualified}${c.reset} ${fmtTps(top)} tok/s`,
      )
    if (oks.some(isBurst))
      console.log(
        `  ${c.dim}* = 响应整块缓冲送达（非逐 token 流），tps 为灌包速度，不计入吞吐榜${c.reset}`,
      )
    console.log('')
  }
}

// ── main ────────────────────────────────────────────────

async function main() {
  const rawArgv = process.argv.slice(2)
  if (rawArgv[0] === 'vision') return cmdVision(rawArgv.slice(1))
  if (rawArgv[0] === 'image') return cmdImage(rawArgv.slice(1))
  if (rawArgv[0] === 'bench') return cmdBench(rawArgv.slice(1))

  const args = parseArgs(rawArgv)

  if (args.help) {
    printHelp()
    return
  }

  if (args.list) {
    if (args.json) {
      console.log(JSON.stringify(client.listProviders(), null, 2))
    } else {
      printHelp()
    }
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
    const picked = pickEndpoint()
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

  if (args.fallback) {
    const chain = args.fallback.split(',').map((s) => s.trim()).filter(Boolean)
    const result = await client.chatWithFallback(chain, messages, chatOpts)
    console.log(args.json ? JSON.stringify(result, null, 2) : result.text)
    return
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

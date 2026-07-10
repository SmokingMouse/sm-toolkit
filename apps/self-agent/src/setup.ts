import { execSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import * as readline from 'node:readline'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { LLMClient } from '@sm/llm'
import { loadConfig } from './config.js'
import type { ServerConfig, HarnessConfig } from './config.js'

// ── terminal helpers ────────────────────────────────────

const c = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(`  ${question} `, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N'
  const answer = await prompt(`${question} [${hint}]`)
  if (!answer) return defaultYes
  return answer.toLowerCase().startsWith('y')
}

function openUrl(url: string) {
  spawnSync('open', [url], { stdio: 'ignore' })
}

async function detectAdminUserId(): Promise<boolean> {
  const config = readServerConfig()
  const { app_id, app_secret } = config.feishu

  if (!app_id || !app_secret) {
    console.log(`  ${c.red('飞书 Bot 未配置，无法自动检测。')}`)
    return false
  }

  console.log()
  console.log(`  ${c.dim('正在启动临时连接...')}`)
  console.log(`  ${c.bold('请在飞书中私聊机器人，发送任意消息。')}`)
  console.log()

  try {
    const { createLarkChannel, LoggerLevel } = await import('@larksuiteoapi/node-sdk')
    const channel = createLarkChannel({
      appId: app_id,
      appSecret: app_secret,
      transport: 'websocket',
      loggerLevel: LoggerLevel.error,
      policy: { requireMention: false, dmMode: 'open' },
    })

    let disconnectFn: (() => void) | undefined
    const userId = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('timeout'))
      }, 60_000)

      channel.on('message', (msg) => {
        clearTimeout(timeout)
        resolve(msg.senderId)
      })

      channel.connect().then(() => {
        // hold a ref to force-close later
        const ws = (channel as any)._ws ?? (channel as any).ws
        disconnectFn = () => { try { ws?.close?.() } catch {} }
      }).catch(reject)
    })

    // close the temporary WebSocket so the process can exit
    disconnectFn?.()
    // unref any remaining handles
    setTimeout(() => {}, 0).unref()

    console.log(`  ${c.green('✓')} 检测到 User ID: ${c.bold(userId)}`)
    const cfg = readServerConfig()
    cfg.admin.feishu_user_id = userId
    writeServerConfig(cfg)
    console.log(`  ${c.green('✓')} 已保存为管理员`)
    return true
  } catch (err) {
    if (err instanceof Error && err.message === 'timeout') {
      console.log(`  ${c.red('✗')} 60 秒内未收到消息，已超时`)
    } else {
      console.log(`  ${c.red('✗')} 检测失败: ${err instanceof Error ? err.message : 'unknown'}`)
    }
    return false
  }
}

// ── config I/O ──────────────────────────────────────────

function configPath(): string {
  const config = loadConfig()
  return join(config.rootDir, 'config', 'server.yaml')
}

function readServerConfig(): ServerConfig {
  return parseYaml(readFileSync(configPath(), 'utf-8')) as ServerConfig
}

function writeServerConfig(config: ServerConfig) {
  writeFileSync(configPath(), stringifyYaml(config))
}

function harnessesDir(): string {
  return join(loadConfig().rootDir, 'harnesses')
}

function writeHarnessConfig(name: string, config: HarnessConfig) {
  const dir = join(harnessesDir(), name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'harness.yaml'), stringifyYaml(config))
  if (!existsSync(join(dir, 'CLAUDE.md'))) {
    writeFileSync(join(dir, 'CLAUDE.md'), `# ${name}\n\nAgent personality and instructions go here.\n`)
  }
}

// ── check functions ─────────────────────────────────────

interface CheckResult {
  name: string
  ok: boolean
  detail: string
  required: boolean
  fix?: () => Promise<boolean>
}

async function checkClaudeCli(): Promise<CheckResult> {
  try {
    const version = execSync('claude --version', { timeout: 5000, encoding: 'utf-8' }).trim()
    return { name: 'Claude CLI', ok: true, detail: version, required: true }
  } catch {
    return {
      name: 'Claude CLI', ok: false, detail: 'claude 命令未找到', required: true,
      fix: async () => {
        console.log(`\n  安装: ${c.cyan('npm install -g @anthropic-ai/claude-code')}\n`)
        if (await confirm('安装完成后重试?')) {
          try { execSync('claude --version', { timeout: 5000 }); return true } catch { return false }
        }
        return false
      },
    }
  }
}

async function checkClaudeAuth(): Promise<CheckResult> {
  try {
    const output = execSync(
      'claude -p "respond with ok" --output-format json --max-budget-usd 0.05 --model haiku',
      { timeout: 30000, encoding: 'utf-8' },
    )
    const result = JSON.parse(output)
    if (result.is_error) return { name: 'Claude Auth', ok: false, detail: `API error: ${result.result}`, required: true }
    return { name: 'Claude Auth', ok: true, detail: 'OK', required: true }
  } catch (err) {
    return {
      name: 'Claude Auth', ok: false, detail: `认证失败`, required: true,
      fix: async () => {
        if (await confirm('打开 Claude 登录?')) {
          spawnSync('claude', ['login'], { stdio: 'inherit' })
          return true
        }
        return false
      },
    }
  }
}

async function selectEndpoint(interactive: boolean): Promise<CheckResult> {
  const config = loadConfig()
  const harnessName = process.env.HARNESS ?? 'assistant'
  const current = config.harness.endpoint

  let llm: LLMClient
  try {
    llm = new LLMClient()
  } catch {
    return { name: 'Model', ok: true, detail: `${current}（无法读取 endpoints.yaml）`, required: false }
  }

  const providers = llm.listProviders()
  const allModels = providers.flatMap((p) => p.models)
  const isValid = allModels.includes(current) || (() => { try { llm.getEndpointConfig(current); return true } catch { return false } })()

  if (!interactive) {
    if (isValid) {
      const provider = providers.find((p) => p.models.includes(current))
      const keyStatus = provider?.hasKey ? 'key ✓' : 'OAuth'
      return { name: 'Model', ok: true, detail: `${current} (${keyStatus})`, required: true }
    }
    return { name: 'Model', ok: false, detail: `${current} 不在 endpoints.yaml 中`, required: true }
  }

  // interactive: 始终展示模型选择
  if (providers.length === 0) {
    return { name: 'Model', ok: false, detail: 'endpoints.yaml 中没有配置任何接入点', required: true }
  }

  console.log(`\n  ${c.bold('选择模型')}（endpoints.yaml）：\n`)
  const choices: string[] = []
  for (const p of providers) {
    const icon = p.hasKey ? c.green('✓') : c.yellow('○')
    const auth = p.hasKey ? '' : c.dim(' (OAuth)')
    console.log(`  ${icon} ${c.bold(p.name)}${auth}`)
    for (const m of p.models) {
      choices.push(m)
      const marker = m === current ? c.cyan(' ← 当前') : ''
      console.log(`      ${choices.length}. ${m}${marker}`)
    }
  }

  const currentIdx = choices.indexOf(current)
  const defaultHint = currentIdx >= 0 ? `回车保持 ${current}` : ''
  console.log()
  const input = await prompt(`${c.cyan('?')} 选择 [1-${choices.length}]（${defaultHint}）:`)

  if (!input && isValid) {
    return { name: 'Model', ok: true, detail: `${current}（保持不变）`, required: true }
  }

  const idx = parseInt(input, 10) - 1
  if (idx >= 0 && idx < choices.length) {
    const selected = choices[idx]!
    const harness: HarnessConfig = { ...config.harness, endpoint: selected }
    writeHarnessConfig(harnessName, harness)
    return { name: 'Model', ok: true, detail: `${selected} ✓`, required: true }
  }

  if (isValid) {
    return { name: 'Model', ok: true, detail: `${current}（保持不变）`, required: true }
  }
  return { name: 'Model', ok: false, detail: `${current} 无效`, required: true }
}

async function selectFeishuBot(interactive: boolean): Promise<CheckResult> {
  const config = readServerConfig()
  const { app_id, app_secret } = config.feishu
  const hasConfig = !!(app_id && app_secret)

  // 验证当前配置
  let isValid = false
  if (hasConfig) {
    try {
      const { Client } = await import('@larksuiteoapi/node-sdk')
      const client = new Client({ appId: app_id, appSecret: app_secret })
      await client.im.chat.list({ params: { page_size: 1 } })
      isValid = true
    } catch {}
  }

  if (!interactive) {
    if (isValid) return { name: 'Feishu Bot', ok: true, detail: `App ${app_id} ✓`, required: true }
    if (!hasConfig) return { name: 'Feishu Bot', ok: false, detail: '未配置', required: true }
    return { name: 'Feishu Bot', ok: false, detail: '凭证无效', required: true }
  }

  // interactive: 显示当前状态，给机会更换
  if (isValid) {
    console.log(`\n  ${c.bold('飞书机器人')}: ${c.green('✓')} App ${app_id}`)
    const change = await confirm('  更换机器人?', false)
    if (!change) return { name: 'Feishu Bot', ok: true, detail: `App ${app_id} ✓`, required: true }
  } else {
    console.log(`\n  ${c.bold('配置飞书机器人')}`)
    if (!hasConfig) {
      const url = 'https://open.feishu.cn/app'
      console.log(`\n  ${c.dim('需要飞书企业自建应用（带机器人能力）')}`)
      console.log(`  → ${c.cyan(url)}`)
      console.log(`  ${c.dim('创建应用 → 添加机器人能力 → 开通 im 权限 → 发布')}\n`)
      if (await confirm('  打开浏览器?', false)) openUrl(url)
    }
  }

  console.log()
  const inputId = await prompt(`${c.cyan('?')} App ID${hasConfig ? ` (当前 ${app_id}, 回车保留)` : ''}:`)
  const inputSecret = await prompt(`${c.cyan('?')} App Secret:`)
  if (!inputSecret && !isValid) return { name: 'Feishu Bot', ok: false, detail: '未配置', required: true }
  if (!inputSecret) return { name: 'Feishu Bot', ok: true, detail: `App ${app_id}（保持不变）`, required: true }

  const finalId = inputId || app_id
  console.log(`  ${c.dim('验证凭证...')}`)
  try {
    const { Client } = await import('@larksuiteoapi/node-sdk')
    const client = new Client({ appId: finalId, appSecret: inputSecret })
    await client.im.chat.list({ params: { page_size: 1 } })
  } catch {
    console.log(`  ${c.red('✗')} 凭证验证失败`)
    return { name: 'Feishu Bot', ok: false, detail: '凭证无效', required: true }
  }

  const cfg = readServerConfig()
  cfg.feishu.app_id = finalId
  cfg.feishu.app_secret = inputSecret
  writeServerConfig(cfg)
  console.log(`  ${c.green('✓')} 已保存`)
  return { name: 'Feishu Bot', ok: true, detail: `App ${finalId} ✓`, required: true }
}

async function checkAdminConfig(): Promise<CheckResult> {
  const config = readServerConfig()
  if (!config.admin.feishu_user_id) {
    return {
      name: 'Admin User', ok: false, detail: '未配置（开放模式，所有人可用）', required: false,
      fix: async () => {
        console.log()
        console.log(`  ${c.bold('配置管理员')}`)
        console.log(`  ${c.dim('管理员接收新用户的审批请求。不配置则所有人可直接使用。')}`)
        console.log()
        console.log(`  1. ${c.bold('自动检测')} — 临时启动 bot，你私聊它一条消息，自动捕获 User ID`)
        console.log(`  2. ${c.bold('手动输入')} — 从飞书管理后台获取 User ID`)
        console.log(`     ${c.dim('https://feishu.cn/admin/contacts/')}`)
        console.log(`  3. ${c.bold('跳过')} — 开放模式，所有人可用`)
        console.log()

        const choice = await prompt(`${c.cyan('?')} 选择 [1/2/3]:`)

        if (choice === '1') {
          return await detectAdminUserId()
        }

        if (choice === '2') {
          const userId = await prompt(`${c.cyan('?')} Admin User ID:`)
          if (!userId) return false
          const cfg = readServerConfig()
          cfg.admin.feishu_user_id = userId
          writeServerConfig(cfg)
          console.log(`  ${c.green('✓')} 已保存`)
          return true
        }

        console.log(`  ${c.dim('已跳过。')}`)
        return false
      },
    }
  }
  return { name: 'Admin User', ok: true, detail: `ID: ${config.admin.feishu_user_id}`, required: true }
}

// ── harness selector ────────────────────────────────────

async function selectHarness(): Promise<string | null> {
  const dir = harnessesDir()
  if (!existsSync(dir)) return null

  const harnesses = readdirSync(dir).filter(
    (f) => !f.startsWith('.') && existsSync(join(dir, f, 'harness.yaml')),
  )
  if (harnesses.length === 0) return null

  console.log(`\n  ${c.bold('可用 Harness')}：\n`)
  for (let i = 0; i < harnesses.length; i++) {
    const h = harnesses[i]!
    const yaml = parseYaml(readFileSync(join(dir, h, 'harness.yaml'), 'utf-8')) as HarnessConfig
    const current = h === (process.env.HARNESS ?? 'assistant')
    const prefix = current ? c.cyan('›') : ' '
    console.log(`  ${prefix} ${i + 1}. ${c.bold(h)} (${yaml.endpoint})`)
  }

  console.log()
  const input = await prompt(`${c.cyan('?')} 选择 [1-${harnesses.length}]（回车用当前）:`)
  if (!input) return process.env.HARNESS ?? 'assistant'

  const idx = parseInt(input, 10) - 1
  if (idx < 0 || idx >= harnesses.length) return null
  return harnesses[idx]!
}

// ── main ────────────────────────────────────────────────

export async function runSetup(interactive = true): Promise<boolean> {
  const harnessName = process.env.HARNESS ?? 'assistant'

  console.log()
  console.log(`  ${c.bold('Self Agent — Setup')}`)
  console.log(`  ${c.dim(`Harness: ${harnessName}`)}`)
  console.log()

  if (interactive) {
    const selected = await selectHarness()
    if (selected && selected !== harnessName) {
      console.log(`\n  ${c.yellow('提示')}: 重新启动时使用 ${c.cyan(`HARNESS=${selected}`)} 切换\n`)
    }
  }

  const checks: CheckResult[] = []

  // selectEndpoint is special: it's interactive by design, not a check/fix pattern
  const checkFns: Array<() => Promise<CheckResult>> = [
    checkClaudeCli,
    checkClaudeAuth,
    () => selectEndpoint(interactive),
    () => selectFeishuBot(interactive),
    checkAdminConfig,
  ]

  for (const checkFn of checkFns) {
    let result = await checkFn()
    const icon = result.ok ? c.green('✓') : result.required ? c.red('✗') : c.yellow('○')
    console.log(`  ${icon} ${result.name}: ${result.detail}`)

    if (!result.ok && result.fix && interactive) {
      const fixed = await result.fix()
      if (fixed) {
        result = await checkFn()
        const newIcon = result.ok ? c.green('✓') : c.red('✗')
        console.log(`  ${newIcon} ${result.name}: ${result.detail}`)
      }
    }

    checks.push(result)
  }

  const allRequired = checks.every((ch) => ch.ok || !ch.required)
  console.log()
  if (allRequired) {
    console.log(`  ${c.green('All checks passed. Ready to start.')}`)
  } else {
    const failed = checks.filter((ch) => !ch.ok && ch.required)
    console.log(`  ${c.red(`${failed.length} required check(s) failed.`)} Run ${c.cyan('bun run setup')} again.`)
  }
  console.log()
  return allRequired
}

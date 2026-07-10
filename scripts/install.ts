#!/usr/bin/env bun
import { execSync, spawnSync } from 'node:child_process'
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  chmodSync,
} from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import * as readline from 'node:readline'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { loadEndpoints, listProviders } from '@sm/llm'
import type { ConfigFile } from '@sm/llm'

const ROOT = resolve(import.meta.dir, '..')
const HOME = process.env.HOME ?? '~'
const ENDPOINTS_PATH = resolve(HOME, '.claude/global/endpoints.yaml')
const ENDPOINTS_TEMPLATE = join(ROOT, 'packages/llm/endpoints.example.yaml')

// ── terminal helpers ────────────────────────────────────

const c = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
}

function step(title: string) {
  console.log(`\n${c.bold(c.cyan(`── ${title} `))}`)
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

// ── Step A: prereqs ─────────────────────────────────────

async function checkClaudeCli(): Promise<void> {
  try {
    const version = execSync('claude --version', { timeout: 5000, encoding: 'utf-8' }).trim()
    console.log(`  ${c.green('✓')} Claude CLI: ${version}`)
  } catch {
    console.log(`  ${c.red('✗')} Claude CLI 未找到`)
    console.log(`  安装: ${c.cyan('npm install -g @anthropic-ai/claude-code')}`)
    await confirm('  安装完成后按回车继续')
  }
}

// ── Step C: model config ────────────────────────────────

function upsertEnvFile(rawPath: string, updates: Record<string, string>): void {
  if (Object.keys(updates).length === 0) return
  const path = rawPath.replace(/^~/, HOME)
  const isNew = !existsSync(path)
  const lines = isNew ? [] : readFileSync(path, 'utf-8').split('\n')

  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`
    const idx = lines.findIndex((l) => l.trim().startsWith(`${key}=`))
    if (idx >= 0) lines[idx] = line
    else lines.push(line)
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop()

  writeFileSync(path, lines.join('\n') + '\n')
  if (isNew) chmodSync(path, 0o600)
}

async function configureModels(): Promise<void> {
  if (!existsSync(ENDPOINTS_PATH)) {
    mkdirSync(dirname(ENDPOINTS_PATH), { recursive: true })
    writeFileSync(ENDPOINTS_PATH, readFileSync(ENDPOINTS_TEMPLATE, 'utf-8'))
    console.log(`  ${c.green('✓')} 已创建 ${ENDPOINTS_PATH}`)
  }

  // merge template providers into the existing config (union, keep existing untouched)
  const current = parseYaml(readFileSync(ENDPOINTS_PATH, 'utf-8')) as ConfigFile
  const template = parseYaml(readFileSync(ENDPOINTS_TEMPLATE, 'utf-8')) as ConfigFile
  let changed = false
  for (const [name, prov] of Object.entries(template.providers)) {
    if (!current.providers[name]) {
      current.providers[name] = prov
      changed = true
      console.log(`  ${c.green('✓')} 新增 provider: ${name}`)
    }
  }
  if (changed) writeFileSync(ENDPOINTS_PATH, stringifyYaml(current))

  const config = loadEndpoints(ENDPOINTS_PATH) // also loads env_file into process.env
  const providers = listProviders(config)

  console.log(`\n  ${c.bold('可用模型')}：\n`)
  for (const p of providers) {
    const icon = p.hasKey ? c.green('✓') : c.yellow('○')
    console.log(`  ${icon} ${c.bold(p.name)} — ${p.models.join(', ')}`)
  }
  console.log()

  const keyUpdates: Record<string, string> = {}
  for (const [name, prov] of Object.entries(config.providers)) {
    if (process.env[prov.api_key_env]) continue
    const value = await prompt(`${c.cyan('?')} ${name} (${prov.api_key_env}) API key（回车跳过）:`)
    if (value) {
      keyUpdates[prov.api_key_env] = value
      process.env[prov.api_key_env] = value
    }
  }
  upsertEnvFile(config.env_file ?? '~/.agent-gateway.env', keyUpdates)

  const allModels = Object.values(config.providers).flatMap((p) => p.models)
  console.log(`\n  ${c.bold('默认模型')}（当前: ${config.default}）：\n`)
  allModels.forEach((m, i) => {
    const marker = m === config.default ? c.cyan(' ← 当前') : ''
    console.log(`      ${i + 1}. ${m}${marker}`)
  })
  const input = await prompt(`\n${c.cyan('?')} 选择 [1-${allModels.length}]（回车保持不变）:`)
  const idx = parseInt(input, 10) - 1
  if (idx >= 0 && idx < allModels.length && allModels[idx] !== config.default) {
    current.default = allModels[idx]!
    writeFileSync(ENDPOINTS_PATH, stringifyYaml(current))
    console.log(`  ${c.green('✓')} 默认模型设为 ${allModels[idx]}`)
  }
}

// ── Step D/E: bun link ──────────────────────────────────

function linkPackage(dir: string, label: string): void {
  const result = spawnSync('bun', ['link'], { cwd: dir, stdio: 'pipe', encoding: 'utf-8' })
  if (result.status === 0) {
    console.log(`  ${c.green('✓')} ${label}`)
  } else {
    console.log(`  ${c.red('✗')} ${label}: ${result.stderr?.trim() || 'bun link failed'}`)
  }
}

function registerPackages(): void {
  const packagesDir = join(ROOT, 'packages')
  for (const name of readdirSync(packagesDir)) {
    const dir = join(packagesDir, name)
    const pkgPath = join(dir, 'package.json')
    if (!existsSync(pkgPath)) continue
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    if (typeof pkg.name === 'string' && pkg.name.startsWith('@sm/')) {
      linkPackage(dir, pkg.name)
    }
  }
  console.log(`\n  ${c.dim('其他项目里跑 `bun link @sm/<包名>` 即可引用。')}`)
}

function registerCli(): void {
  const cliDir = join(ROOT, 'apps/cli')
  linkPackage(cliDir, '@sm/cli（全局命令 llm）')
}

// ── Step F: install apps ────────────────────────────────

function discoverInstallableApps(): string[] {
  const appsDir = join(ROOT, 'apps')
  return readdirSync(appsDir).filter((name) => {
    if (name === 'cli') return false
    const pkgPath = join(appsDir, name, 'package.json')
    if (!existsSync(pkgPath)) return false
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    return typeof pkg.scripts?.setup === 'string'
  })
}

async function installApps(): Promise<void> {
  const apps = discoverInstallableApps()
  if (apps.length === 0) {
    console.log(`  ${c.dim('没有发现可安装的 app。')}`)
    return
  }
  for (const name of apps) {
    const install = await confirm(`  安装/配置 ${c.bold(name)}？`, false)
    if (!install) continue
    const dir = join(ROOT, 'apps', name)
    spawnSync('bun', ['run', 'setup'], { cwd: dir, stdio: 'inherit' })
  }
}

// ── main ─────────────────────────────────────────────────

async function main() {
  console.log(`\n  ${c.bold('sm-toolkit — Install')}`)

  step('环境检查')
  await checkClaudeCli()

  step('安装依赖')
  execSync('bun install', { cwd: ROOT, stdio: 'inherit' })

  step('配置模型')
  await configureModels()

  step('注册 SDK')
  registerPackages()

  step('注册全局命令')
  registerCli()

  step('安装 App')
  await installApps()

  console.log(`\n  ${c.green('Setup 完成。')}\n`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

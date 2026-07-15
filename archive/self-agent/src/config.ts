import { readFileSync, existsSync, copyFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { join } from 'node:path'
import { loadEndpoints, listProviders } from '@sm/llm'

export interface ServerConfig {
  admin: {
    feishu_user_id: string
  }
  feishu: {
    app_id: string
    app_secret: string
  }
}

export interface HarnessConfig {
  endpoint: string
  permission: 'default' | 'acceptEdits' | 'bypassPermissions'
}

export interface AppConfig {
  server: ServerConfig
  harness: HarnessConfig
  harnessDir: string
  rootDir: string
}

const ROOT_DIR = join(import.meta.dir, '..')
const CONFIG_DIR = join(ROOT_DIR, 'config')
const HARNESSES_DIR = join(ROOT_DIR, 'harnesses')

function loadServerConfig(): ServerConfig {
  const path = join(CONFIG_DIR, 'server.yaml')
  if (!existsSync(path)) {
    copyFileSync(join(CONFIG_DIR, 'server.example.yaml'), path)
  }
  const raw = readFileSync(path, 'utf-8')
  return parseYaml(raw) as ServerConfig
}

function loadHarnessConfig(name: string): { config: HarnessConfig; dir: string } {
  const dir = join(HARNESSES_DIR, name)
  const yamlPath = join(dir, 'harness.yaml')

  if (!existsSync(yamlPath)) {
    const available = existsSync(HARNESSES_DIR)
      ? readdirSafe(HARNESSES_DIR).join(', ')
      : '(none)'
    throw new Error(`Harness "${name}" not found at ${dir}. Available: ${available}`)
  }

  const raw = readFileSync(yamlPath, 'utf-8')
  const parsed = parseYaml(raw) as Partial<HarnessConfig>

  return {
    config: {
      endpoint: parsed.endpoint ?? 'claude',
      permission: parsed.permission ?? 'default',
    },
    dir,
  }
}

function readdirSafe(dir: string): string[] {
  try {
    const { readdirSync } = require('node:fs') as typeof import('node:fs')
    return readdirSync(dir).filter((f: string) => !f.startsWith('.'))
  } catch {
    return []
  }
}

let _config: AppConfig | null = null

export function loadConfig(harnessName?: string): AppConfig {
  if (_config) return _config

  const name = harnessName ?? process.env.HARNESS ?? 'assistant'
  const server = loadServerConfig()
  const { config: harness, dir: harnessDir } = loadHarnessConfig(name)

  _config = { server, harness, harnessDir, rootDir: ROOT_DIR }
  return _config
}

export interface ModelGroup {
  provider: string
  models: string[]
  isNative: boolean
}

export function listAvailableModels(): ModelGroup[] {
  try {
    const endpoints = loadEndpoints()
    return listProviders(endpoints).map((p) => ({
      provider: p.name,
      models: p.models,
      isNative: !p.openai_url && !p.anthropic_url,
    }))
  } catch {
    return []
  }
}

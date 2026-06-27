import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { EndpointConfig, EndpointsFile, EndpointInfo } from './types.js'

const DEFAULT_CONFIG_PATH = resolve(
  process.env.HOME ?? '~',
  '.claude/global/endpoints.yaml',
)

let _cached: EndpointsFile | null = null
let _cachedPath: string | null = null

export function loadEndpoints(path?: string): EndpointsFile {
  const p = path ?? DEFAULT_CONFIG_PATH
  if (_cached && _cachedPath === p) return _cached

  if (!existsSync(p)) {
    throw new Error(`endpoints.yaml not found: ${p}`)
  }
  const raw = readFileSync(p, 'utf-8')
  const parsed = parseYaml(raw) as EndpointsFile
  if (!parsed.endpoints || typeof parsed.endpoints !== 'object') {
    throw new Error(`invalid endpoints.yaml: missing "endpoints" map`)
  }
  if (!parsed.default) {
    throw new Error(`invalid endpoints.yaml: missing "default" field`)
  }

  if (parsed.env_file) {
    loadEnvFile(parsed.env_file)
  }

  _cached = parsed
  _cachedPath = p
  return parsed
}

export function resolveEndpoint(
  config: EndpointsFile,
  name?: string,
): { name: string; endpoint: EndpointConfig } {
  const n = name ?? config.default
  const ep = config.endpoints[n]
  if (!ep) {
    const available = Object.keys(config.endpoints).join(', ')
    throw new Error(`unknown endpoint "${n}". available: ${available}`)
  }
  return { name: n, endpoint: ep }
}

export function getApiKey(ep: EndpointConfig): string {
  const key = process.env[ep.api_key_env]
  if (!key) {
    throw new Error(
      `API key not found: env var ${ep.api_key_env} is not set`,
    )
  }
  return key
}

export function listEndpoints(config: EndpointsFile): EndpointInfo[] {
  return Object.entries(config.endpoints).map(([name, ep]) => ({
    name,
    model: ep.model,
    base_url: ep.base_url,
    hasKey: !!process.env[ep.api_key_env],
  }))
}

function loadEnvFile(envPath: string): void {
  const p = envPath.replace(/^~/, process.env.HOME ?? '')
  if (!existsSync(p)) return

  const content = readFileSync(p, 'utf-8')
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const val = trimmed.slice(eqIdx + 1).trim()
    if (!process.env[key]) {
      process.env[key] = val
    }
  }
}

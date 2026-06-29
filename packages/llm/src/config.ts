import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type {
  ConfigFile,
  ProviderConfig,
  EndpointConfig,
  EndpointInfo,
  ProviderInfo,
} from './types.js'

const DEFAULT_CONFIG_PATH = resolve(
  process.env.HOME ?? '~',
  '.claude/global/endpoints.yaml',
)

let _cached: ConfigFile | null = null
let _cachedPath: string | null = null

export function loadEndpoints(path?: string): ConfigFile {
  const p = path ?? DEFAULT_CONFIG_PATH
  if (_cached && _cachedPath === p) return _cached

  if (!existsSync(p)) {
    throw new Error(`endpoints.yaml not found: ${p}`)
  }
  const raw = readFileSync(p, 'utf-8')
  const parsed = parseYaml(raw) as ConfigFile
  if (!parsed.providers || typeof parsed.providers !== 'object') {
    throw new Error(`invalid endpoints.yaml: missing "providers" map`)
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

export type Protocol = 'openai' | 'anthropic'

export function resolveEndpoint(
  config: ConfigFile,
  name?: string,
  preferProtocol?: Protocol,
): { name: string; endpoint: EndpointConfig } {
  const n = name ?? config.default

  // 1. exact model name match
  for (const [, prov] of Object.entries(config.providers)) {
    if (prov.models.includes(n)) {
      return { name: n, endpoint: toEndpointConfig(prov, n, preferProtocol) }
    }
  }

  // 2. exact provider name match → use first model
  const provider = config.providers[n]
  if (provider) {
    const model = provider.models[0]!
    return {
      name: model,
      endpoint: toEndpointConfig(provider, model, preferProtocol),
    }
  }

  // 3. prefix match on model names
  for (const [, prov] of Object.entries(config.providers)) {
    const match = prov.models.find((m) => m.startsWith(n))
    if (match) {
      return {
        name: match,
        endpoint: toEndpointConfig(prov, match, preferProtocol),
      }
    }
  }

  const allModels = Object.values(config.providers).flatMap((p) => p.models)
  throw new Error(`unknown model "${n}". available: ${allModels.join(', ')}`)
}

function toEndpointConfig(
  prov: ProviderConfig,
  model: string,
  preferProtocol?: Protocol,
): EndpointConfig {
  let base_url: string | undefined
  let protocol: Protocol

  if (preferProtocol === 'anthropic' && prov.anthropic_url) {
    base_url = prov.anthropic_url
    protocol = 'anthropic'
  } else if (preferProtocol === 'openai' && prov.openai_url) {
    base_url = prov.openai_url
    protocol = 'openai'
  } else if (prov.openai_url) {
    base_url = prov.openai_url
    protocol = 'openai'
  } else if (prov.anthropic_url) {
    base_url = prov.anthropic_url
    protocol = 'anthropic'
  } else {
    protocol = 'anthropic'
  }

  return { base_url, api_key_env: prov.api_key_env, model, protocol }
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

export function listEndpoints(config: ConfigFile): EndpointInfo[] {
  const result: EndpointInfo[] = []
  for (const [provName, prov] of Object.entries(config.providers)) {
    const hasKey = !!process.env[prov.api_key_env]
    for (const model of prov.models) {
      result.push({
        name: model,
        model,
        provider: provName,
        openai_url: prov.openai_url,
        anthropic_url: prov.anthropic_url,
        hasKey,
      })
    }
  }
  return result
}

export function listProviders(config: ConfigFile): ProviderInfo[] {
  return Object.entries(config.providers).map(([name, prov]) => ({
    name,
    openai_url: prov.openai_url,
    anthropic_url: prov.anthropic_url,
    hasKey: !!process.env[prov.api_key_env],
    models: prov.models,
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

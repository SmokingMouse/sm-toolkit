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

  // 0. provider-qualified id: "<provider>:<model>" — disambiguates model names
  // that exist under multiple providers (e.g. deepseek-v4-flash is listed under
  // both "deepseek" and "ark-coding"; a bare model-name search below would
  // silently pick whichever provider iterates first). Falls through to the
  // legacy global search when the left side isn't a real provider name, so
  // existing bare-name/prefix callers are unaffected.
  const colonIdx = n.indexOf(':')
  if (colonIdx > 0) {
    const provName = n.slice(0, colonIdx)
    const modelName = n.slice(colonIdx + 1)
    const prov = config.providers[provName]
    if (prov) {
      if (!prov.models.includes(modelName)) {
        throw new Error(
          `model "${modelName}" not found under provider "${provName}". available: ${prov.models.join(', ')}`,
        )
      }
      return { name: n, endpoint: toEndpointConfig(prov, modelName, preferProtocol) }
    }
  }

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
  const hasAnthropic = !!prov.anthropic_url
  const hasOpenai = !!prov.openai_url
  // No URL of either kind configured (e.g. the native "claude" provider) means
  // "ambient CLI, no override" — always allowed regardless of preferProtocol.
  // A provider that configured ONE protocol's URL but was asked for the OTHER
  // (e.g. gemini: openai_url only, asked for 'anthropic') is a genuine
  // incompatibility and must throw — silently falling back used to hand callers
  // a base_url whose wire protocol didn't match what they asked for.
  const native = !hasAnthropic && !hasOpenai

  if (preferProtocol && !native) {
    if (preferProtocol === 'anthropic' && !hasAnthropic) {
      throw new Error(
        `model "${model}" has no anthropic-protocol endpoint (only openai_url configured)`,
      )
    }
    if (preferProtocol === 'openai' && !hasOpenai) {
      throw new Error(
        `model "${model}" has no openai-protocol endpoint (only anthropic_url configured)`,
      )
    }
  }

  let base_url: string | undefined
  let protocol: Protocol

  if (native) {
    protocol = preferProtocol ?? 'anthropic'
  } else if (preferProtocol === 'anthropic') {
    base_url = prov.anthropic_url
    protocol = 'anthropic'
  } else if (preferProtocol === 'openai') {
    base_url = prov.openai_url
    protocol = 'openai'
  } else if (hasOpenai) {
    base_url = prov.openai_url
    protocol = 'openai'
  } else {
    base_url = prov.anthropic_url
    protocol = 'anthropic'
  }

  return { base_url, api_key_env: prov.api_key_env, model, protocol, claude: prov.claude }
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

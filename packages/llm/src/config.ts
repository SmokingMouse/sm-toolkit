import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type {
  ConfigFile,
  ProviderConfig,
  EndpointConfig,
  EndpointInfo,
  ProviderInfo,
  EndpointMatch,
} from './types.js'

// endpoints.yaml 搜索顺序（先命中先用）：
//   1. loadEndpoints(path) 显式参数
//   2. $SM_ENDPOINTS_PATH
//   3. $XDG_CONFIG_HOME/sm/endpoints.yaml（默认 ~/.config/sm/endpoints.yaml）—— 规范位置
//   4. ~/.claude/global/endpoints.yaml —— legacy 位置，兼容既有部署
// 模板见包内 endpoints.example.yaml。API key 永远走环境变量，yaml 里只写变量名。
function defaultConfigPath(): string {
  if (process.env.SM_ENDPOINTS_PATH) return process.env.SM_ENDPOINTS_PATH
  const home = process.env.HOME ?? '~'
  const xdg = process.env.XDG_CONFIG_HOME ?? resolve(home, '.config')
  const candidates = [
    resolve(xdg, 'sm/endpoints.yaml'),
    resolve(home, '.claude/global/endpoints.yaml'), // legacy
  ]
  // 都不存在时返回规范位置，让 "not found" 报错指向该建文件的地方。
  return candidates.find((c) => existsSync(c)) ?? candidates[0]!
}

let _cached: ConfigFile | null = null
let _cachedPath: string | null = null

/** 当前生效的 endpoints.yaml 路径（可能不存在——调用方自行判断建文件）。 */
export function resolveConfigPath(): string {
  return defaultConfigPath()
}

/** 外部编辑了 endpoints.yaml / env_file 之后调用，下次 loadEndpoints 重读磁盘。 */
export function clearEndpointsCache(): void {
  _cached = null
  _cachedPath = null
}

export function loadEndpoints(path?: string): ConfigFile {
  const p = path ?? defaultConfigPath()
  if (_cached && _cachedPath === p) return _cached

  if (!existsSync(p)) {
    throw new Error(
      `endpoints.yaml not found: ${p} (set $SM_ENDPOINTS_PATH or create ~/.config/sm/endpoints.yaml; template: endpoints.example.yaml in @smokingmouse/llm)`,
    )
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

  // 4. substring match on model names if unique match (prefer hasKey models)
  const nLower = n.toLowerCase()
  const substringMatches: { prov: ProviderConfig; model: string; qualified: string; hasKey: boolean }[] = []
  for (const [provName, prov] of Object.entries(config.providers)) {
    for (const m of prov.models) {
      if (m.toLowerCase().includes(nLower)) {
        substringMatches.push({
          prov,
          model: m,
          qualified: `${provName}:${m}`,
          hasKey: !!process.env[prov.api_key_env],
        })
      }
    }
  }

  if (substringMatches.length === 1) {
    const match = substringMatches[0]!
    return {
      name: match.model,
      endpoint: toEndpointConfig(match.prov, match.model, preferProtocol),
    }
  } else if (substringMatches.length > 1) {
    const withKey = substringMatches.filter((m) => m.hasKey)
    if (withKey.length === 1) {
      const match = withKey[0]!
      return {
        name: match.model,
        endpoint: toEndpointConfig(match.prov, match.model, preferProtocol),
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

  return { base_url, api_key_env: prov.api_key_env, model, protocol, claude: prov.claude, codex: prov.codex }
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
    api_key_env: prov.api_key_env,
    openai_url: prov.openai_url,
    anthropic_url: prov.anthropic_url,
    hasKey: !!process.env[prov.api_key_env],
    models: prov.models,
  }))
}

function fuzzySubsequenceMatch(text: string, pattern: string): boolean {
  let tIdx = 0
  let pIdx = 0
  while (tIdx < text.length && pIdx < pattern.length) {
    if (text[tIdx] === pattern[pIdx]) {
      pIdx++
    }
    tIdx++
  }
  return pIdx === pattern.length
}

export function searchEndpoints(
  config: ConfigFile,
  query?: string,
  options?: {
    recent?: string[]
  },
): EndpointMatch[] {
  const q = (query ?? '').trim().toLowerCase()
  const terms = q.length > 0 ? q.split(/\s+/).filter(Boolean) : []
  const recentList = options?.recent ?? []

  const results: EndpointMatch[] = []

  for (const [provName, prov] of Object.entries(config.providers)) {
    const hasKey = !!process.env[prov.api_key_env]
    const provLower = provName.toLowerCase()

    for (const model of prov.models) {
      const modelLower = model.toLowerCase()
      const qualified = `${provName}:${model}`
      const qualifiedLower = qualified.toLowerCase()
      const isDefault = config.default === model

      const recentIdx = recentList.findIndex(
        (r) => r === qualified || r === model || r === `${provName}/${model}`,
      )
      const isRecent = recentIdx !== -1

      if (terms.length === 0) {
        let score = 0
        if (isRecent) {
          score += 1000 - Math.min(recentIdx, 50) * 10
        }
        if (hasKey) score += 50
        if (isDefault) score += 20

        results.push({
          name: model,
          model,
          provider: provName,
          qualified,
          hasKey,
          isDefault,
          isRecent,
          score,
        })
        continue
      }

      let totalMatchScore = 0
      let allTermsMatched = true

      for (const term of terms) {
        let termScore = 0

        if (modelLower === term) {
          termScore = Math.max(termScore, 500)
        } else if (qualifiedLower === term) {
          termScore = Math.max(termScore, 450)
        } else if (modelLower.startsWith(term)) {
          termScore = Math.max(termScore, 350)
        } else if (qualifiedLower.startsWith(term)) {
          termScore = Math.max(termScore, 300)
        } else if (modelLower.includes(term)) {
          const idx = modelLower.indexOf(term)
          const isBoundary =
            idx === 0 ||
            /[\-_./]/.test(modelLower[idx - 1]!) ||
            idx + term.length === modelLower.length ||
            /[\-_./]/.test(modelLower[idx + term.length]!)
          termScore = Math.max(termScore, isBoundary ? 260 : 200)
        } else if (provLower === term) {
          termScore = Math.max(termScore, 180)
        } else if (provLower.startsWith(term)) {
          termScore = Math.max(termScore, 140)
        } else if (provLower.includes(term)) {
          termScore = Math.max(termScore, 100)
        } else if (fuzzySubsequenceMatch(qualifiedLower, term)) {
          termScore = Math.max(termScore, 60)
        } else {
          allTermsMatched = false
          break
        }

        totalMatchScore += termScore
      }

      if (!allTermsMatched) continue

      if (hasKey) totalMatchScore += 30
      if (isRecent) totalMatchScore += 20 - Math.min(recentIdx, 10)
      if (isDefault) totalMatchScore += 10

      results.push({
        name: model,
        model,
        provider: provName,
        qualified,
        hasKey,
        isDefault,
        isRecent,
        score: totalMatchScore,
      })
    }
  }

  return results.sort((a, b) => b.score - a.score)
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

import type { ConfigFile } from './types.js'

/**
 * Gemini 原生 REST 入口（Files API / Imagen 走原生协议，不经 openai-compat 前缀）。
 * 从 endpoints.yaml 里找 openai_url 指向 generativelanguage.googleapis.com 的
 * provider，取其域名根 + API key——不硬编码 provider 名，改配置不用改代码。
 */
export function geminiNative(config: ConfigFile): {
  root: string
  key: string
  models: string[]
} {
  for (const prov of Object.values(config.providers)) {
    const m = (prov.openai_url ?? '').match(
      /^(https?:\/\/generativelanguage\.googleapis\.com)/,
    )
    if (m) {
      const key = process.env[prov.api_key_env]
      if (!key) {
        throw new Error(`Gemini API key not set: ${prov.api_key_env}`)
      }
      return { root: m[1]!, key, models: prov.models }
    }
  }
  throw new Error(
    'no Gemini provider in endpoints.yaml (need a provider whose openai_url is on generativelanguage.googleapis.com)',
  )
}

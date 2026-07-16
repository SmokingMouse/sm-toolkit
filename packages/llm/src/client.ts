import {
  loadEndpoints,
  resolveEndpoint,
  listEndpoints,
  listProviders,
} from './config.js'
import type { Protocol } from './config.js'
import { openaiProvider } from './providers/openai.js'
import { anthropicProvider } from './providers/anthropic.js'
import { mediaKind, analyzeImage, analyzeMedia } from './vision.js'
import type { VisionProgress } from './vision.js'
import { generateImage } from './image.js'
import type { ImageOptions } from './image.js'
import { geminiNative } from './gemini.js'
import type {
  ClaudeSettings,
  ConfigFile,
  EndpointConfig,
  Message,
  ChatOptions,
  ChatResult,
  StreamChunk,
  EndpointInfo,
  ProviderInfo,
  Provider,
} from './types.js'

function selectProvider(ep: EndpointConfig): Provider {
  return ep.protocol === 'openai' ? openaiProvider : anthropicProvider
}

export class LLMClient {
  #config: ConfigFile

  constructor(configPath?: string) {
    this.#config = loadEndpoints(configPath)
  }

  async chat(
    endpoint: string | undefined,
    messages: Message[],
    opts?: ChatOptions,
  ): Promise<ChatResult> {
    const { name, endpoint: ep } = resolveEndpoint(this.#config, endpoint)
    const provider = selectProvider(ep)
    return provider.chat(ep, messages, {
      ...opts,
      endpointName: name,
    } as ChatOptions & { endpointName: string })
  }

  async *stream(
    endpoint: string | undefined,
    messages: Message[],
    opts?: ChatOptions,
  ): AsyncGenerator<StreamChunk> {
    const { name, endpoint: ep } = resolveEndpoint(this.#config, endpoint)
    const provider = selectProvider(ep)
    yield* provider.stream(ep, messages, {
      ...opts,
      endpointName: name,
    } as ChatOptions & { endpointName: string })
  }

  /**
   * Try each endpoint name in `chain` in order (skipping ones with no API key
   * configured), returning the first successful chat() result. Generalizes
   * agent-gateway's old hardcoded TASK_ROUTING fallback chains — the chain is
   * just a list of endpoints.yaml names the caller supplies, not a baked-in
   * provider table, so it stays config-driven instead of code-driven.
   */
  async chatWithFallback(
    chain: string[],
    messages: Message[],
    opts?: ChatOptions,
  ): Promise<ChatResult> {
    const errors: string[] = []
    for (const endpointName of chain) {
      let ep: EndpointConfig
      try {
        ep = resolveEndpoint(this.#config, endpointName).endpoint
      } catch (e: any) {
        errors.push(`${endpointName}: ${e?.message ?? e}`)
        continue
      }
      if (!process.env[ep.api_key_env]) {
        errors.push(`${endpointName}: no API key (${ep.api_key_env} not set)`)
        continue
      }
      try {
        return await this.chat(endpointName, messages, opts)
      } catch (e: any) {
        errors.push(`${endpointName}: ${e?.message ?? e}`)
      }
    }
    throw new Error(`all endpoints in fallback chain failed → ${errors.join(' | ')}`)
  }

  /**
   * 图片/视频/音频理解。图片走 openai-compat inline base64（默认 Gemini
   * provider 首模型），视频/音频走 Gemini 原生 Files API，按扩展名分发。
   * 返回分析文本。
   */
  async vision(
    file: string,
    prompt: string,
    opts?: { endpoint?: string; onProgress?: VisionProgress },
  ): Promise<string> {
    if (mediaKind(file) === 'image') {
      const name = opts?.endpoint ?? geminiNative(this.#config).models[0]!
      const { endpoint: ep } = resolveEndpoint(this.#config, name, 'openai')
      return analyzeImage(ep, file, prompt)
    }
    const model = opts?.endpoint
      ? resolveEndpoint(this.#config, opts.endpoint).endpoint.model
      : undefined
    return analyzeMedia(this.#config, file, prompt, model, opts?.onProgress)
  }

  /** 生图（imagen / codex）。返回图片绝对路径列表。 */
  async image(opts: ImageOptions): Promise<string[]> {
    return generateImage(this.#config, opts)
  }

  listEndpoints(): EndpointInfo[] {
    return listEndpoints(this.#config)
  }

  listProviders(): ProviderInfo[] {
    return listProviders(this.#config)
  }

  get defaultEndpoint(): string {
    return this.#config.default
  }

  get claudeSettings(): ClaudeSettings {
    return this.#config.claude ?? {}
  }

  getEndpointConfig(
    name?: string,
    protocol?: Protocol,
  ): { name: string; endpoint: EndpointConfig } {
    return resolveEndpoint(this.#config, name, protocol)
  }
}

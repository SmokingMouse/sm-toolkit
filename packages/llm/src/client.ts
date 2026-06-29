import {
  loadEndpoints,
  resolveEndpoint,
  listEndpoints,
  listProviders,
} from './config.js'
import type { Protocol } from './config.js'
import { openaiProvider } from './providers/openai.js'
import { anthropicProvider } from './providers/anthropic.js'
import type {
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

  listEndpoints(): EndpointInfo[] {
    return listEndpoints(this.#config)
  }

  listProviders(): ProviderInfo[] {
    return listProviders(this.#config)
  }

  get defaultEndpoint(): string {
    return this.#config.default
  }

  getEndpointConfig(
    name?: string,
    protocol?: Protocol,
  ): { name: string; endpoint: EndpointConfig } {
    return resolveEndpoint(this.#config, name, protocol)
  }
}

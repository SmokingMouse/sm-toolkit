import { loadEndpoints, resolveEndpoint, listEndpoints } from './config.js'
import { openaiProvider } from './providers/openai.js'
import { anthropicProvider } from './providers/anthropic.js'
import type {
  EndpointsFile,
  EndpointConfig,
  Message,
  ChatOptions,
  ChatResult,
  StreamChunk,
  EndpointInfo,
  Provider,
} from './types.js'

function selectProvider(ep: EndpointConfig): Provider {
  if (!ep.base_url) return anthropicProvider
  return openaiProvider
}

export class LLMClient {
  #config: EndpointsFile

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

  get defaultEndpoint(): string {
    return this.#config.default
  }

  getEndpointConfig(name?: string): { name: string; endpoint: EndpointConfig } {
    return resolveEndpoint(this.#config, name)
  }
}

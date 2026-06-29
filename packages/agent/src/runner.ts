import { spawn } from 'node:child_process'
import * as readline from 'node:readline'
import { loadEndpoints, resolveEndpoint, getApiKey } from '@sm/llm'
import type { EndpointConfig, ConfigFile } from '@sm/llm'
import type { CLIEvent, Cost } from './events.js'

export interface RunOptions {
  endpoint: string
  sessionId?: string
  workspace?: string
  permission?: 'default' | 'acceptEdits' | 'bypassPermissions'
  systemPrompt?: string
  args?: string[]
  signal?: AbortSignal
  configPath?: string
}

function resolveCLIEnv(
  ep: EndpointConfig,
): Record<string, string> {
  const env: Record<string, string> = {}
  if (ep.base_url) env.ANTHROPIC_BASE_URL = ep.base_url
  env.ANTHROPIC_API_KEY = getApiKey(ep)
  return env
}

function buildArgs(opts: RunOptions): string[] {
  const args: string[] = [
    '--output-format', 'stream-json',
    '--verbose',
  ]

  if (opts.sessionId) args.push('--resume', opts.sessionId)
  if (opts.systemPrompt) args.push('--system-prompt', opts.systemPrompt)

  if (opts.workspace) {
    args.push('--add-dir', opts.workspace)
    switch (opts.permission) {
      case 'bypassPermissions':
        args.push('--dangerously-skip-permissions')
        break
      case 'acceptEdits':
        args.push('--permission-mode', 'acceptEdits')
        break
      default:
        args.push('--permission-mode', 'default')
    }
  }

  if (opts.args) args.push(...opts.args)
  return args
}

export class CLIRunner {
  #config: ConfigFile

  constructor(configPath?: string) {
    this.#config = loadEndpoints(configPath)
  }

  async *run(prompt: string, opts: RunOptions): AsyncGenerator<CLIEvent> {
    const { endpoint: ep } = resolveEndpoint(this.#config, opts.endpoint, 'anthropic')
    const cliEnv = resolveCLIEnv(ep)

    const args = ['-p', prompt, '--model', ep.model, ...buildArgs(opts)]

    const proc = spawn('claude', args, {
      env: { ...process.env, ...cliEnv },
      cwd: opts.workspace,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const onAbort = () => proc.kill('SIGTERM')
    opts.signal?.addEventListener('abort', onAbort)

    proc.stderr?.resume()

    const rl = readline.createInterface({ input: proc.stdout! })
    let sessionId = opts.sessionId ?? ''
    let lastAssistantContext: number | null = null

    try {
      for await (const line of rl) {
        const trimmed = line.trim()
        if (!trimmed) continue

        let obj: any
        try {
          obj = JSON.parse(trimmed)
        } catch {
          continue
        }

        const t = obj.type

        if (t === 'system' && obj.subtype === 'init') {
          sessionId = obj.session_id ?? sessionId
          yield {
            type: 'init',
            sessionId,
            model: obj.model ?? ep.model,
            tools: obj.tools ?? [],
          }
        } else if (
          t === 'stream_event' &&
          obj.event?.type === 'content_block_delta' &&
          obj.event?.delta?.type === 'text_delta'
        ) {
          const delta = obj.event.delta.text
          if (typeof delta === 'string' && delta.length > 0) {
            yield { type: 'text', text: delta }
          }
        } else if (t === 'assistant') {
          const au = obj.message?.usage
          if (au) {
            lastAssistantContext =
              (au.input_tokens ?? 0) +
              (au.cache_read_input_tokens ?? 0) +
              (au.cache_creation_input_tokens ?? 0)
          }
          for (const b of obj.message?.content ?? []) {
            if (b.type === 'tool_use') {
              yield {
                type: 'tool_call',
                id: b.id,
                name: b.name,
                input: b.input,
              }
            }
          }
        } else if (t === 'user') {
          for (const b of obj.message?.content ?? []) {
            if (b.type === 'tool_result') {
              yield {
                type: 'tool_result',
                id: b.tool_use_id,
                output:
                  typeof b.content === 'string'
                    ? b.content
                    : JSON.stringify(b.content),
                isError: !!b.is_error,
              }
            }
          }
        } else if (t === 'result') {
          if (obj.is_error) {
            yield { type: 'error', message: obj.result || 'claude CLI error' }
            return
          }
          const u = obj.usage ?? {}
          const cost: Cost = {
            usd: obj.total_cost_usd ?? null,
            inputTokens: u.input_tokens ?? 0,
            outputTokens: u.output_tokens ?? 0,
            cachedTokens: u.cache_read_input_tokens ?? 0,
            cacheCreation: u.cache_creation_input_tokens ?? 0,
            estimated: false,
            contextTokens:
              lastAssistantContext ??
              (u.input_tokens ?? 0) +
                (u.cache_read_input_tokens ?? 0) +
                (u.cache_creation_input_tokens ?? 0),
          }
          yield {
            type: 'result',
            text: obj.result ?? '',
            sessionId: sessionId,
            cost,
          }
        } else if (t === 'error') {
          yield {
            type: 'error',
            message: obj.message ?? obj.error ?? 'claude error',
          }
        }
      }

      await new Promise<void>((res) => proc.on('close', () => res()))
    } finally {
      opts.signal?.removeEventListener('abort', onAbort)
      if (!proc.killed) proc.kill('SIGTERM')
    }
  }
}

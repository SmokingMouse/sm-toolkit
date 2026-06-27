import { CLIRunner } from './runner.js'
import { createSessionStore, type SessionStore } from './session.js'
import type { Channel, InboundTask, OutboundEvent } from './channel.js'
import type { CLIEvent } from './events.js'
import type { Store } from '@sm/store'

export interface OrchestratorConfig {
  endpoint: string
  workspace?: string
  permission?: 'default' | 'acceptEdits' | 'bypassPermissions'
  configPath?: string
}

export class Orchestrator {
  #runner: CLIRunner
  #sessions: SessionStore
  #channel: Channel
  #config: OrchestratorConfig
  #ac: AbortController | null = null

  constructor(
    channel: Channel,
    store: Store,
    config: OrchestratorConfig,
  ) {
    this.#channel = channel
    this.#runner = new CLIRunner(config.configPath)
    this.#sessions = createSessionStore(store, config.endpoint)
    this.#config = config
  }

  async start(): Promise<void> {
    this.#ac = new AbortController()

    await this.#channel.subscribe(async (task: InboundTask) => {
      try {
        await this.#handle(task)
      } catch (e: any) {
        await this.#channel.emit(task.externalId, {
          type: 'error',
          data: { message: e?.message ?? 'unknown error' },
        })
      }
    })
  }

  async stop(): Promise<void> {
    this.#ac?.abort()
    await this.#channel.close?.()
  }

  async #handle(task: InboundTask): Promise<void> {
    const sessionId = await this.#sessions.getSessionId(task.externalId)

    for await (const event of this.#runner.run(task.prompt, {
      endpoint: this.#config.endpoint,
      sessionId: sessionId ?? undefined,
      workspace: this.#config.workspace,
      permission: this.#config.permission,
      signal: this.#ac?.signal,
    })) {
      if (event.type === 'init' || event.type === 'result') {
        const sid =
          event.type === 'init' ? event.sessionId : event.sessionId
        if (sid) {
          await this.#sessions.saveSessionId(task.externalId, sid)
        }
      }

      await this.#channel.emit(task.externalId, cliEventToOutbound(event))
    }

    await this.#sessions.touch(task.externalId)
  }
}

function cliEventToOutbound(event: CLIEvent): OutboundEvent {
  return { type: event.type, data: event }
}

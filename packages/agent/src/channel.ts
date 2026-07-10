// ── incoming types ──────────────────────────────────────

export interface IncomingMessage {
  id: string
  threadId: string
  chatId: string
  senderId: string
  text: string
  chatType: 'dm' | 'group'
}

export interface IncomingAction {
  operatorId: string
  messageId: string
  value: string
}

// ── content types (Orchestrator → Channel rendering) ────

export interface ModelGroup {
  provider: string
  models: Array<{ name: string; isCurrent: boolean; actionValue: string }>
}

export interface ContentAction {
  label: string
  style: 'primary' | 'danger' | 'default'
  value: string
}

export interface CommandInfo {
  command: string
  description: string
}

export type Content =
  | { type: 'pending' }
  | { type: 'result'; text: string; metadata?: string }
  | { type: 'error'; message: string }
  | { type: 'model_selector'; current?: string; groups: ModelGroup[] }
  | {
      type: 'approval_request'
      userName: string
      source: string
      originalMessage: string
      actions: ContentAction[]
    }
  | { type: 'help'; commands: CommandInfo[] }

// ── channel interface ───────────────────────────────────

export interface Channel {
  readonly source: string

  connect(): Promise<void>
  close(): Promise<void>

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void
  onAction(handler: (action: IncomingAction) => void | Promise<void>): void

  reply(toMessageId: string, content: Content): Promise<string | null>
  update(messageId: string, content: Content): Promise<void>
  send(userId: string, content: Content): Promise<string | null>
}

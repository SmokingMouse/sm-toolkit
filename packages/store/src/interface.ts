export interface SessionRecord {
  id: string
  externalId?: string
  endpoint: string
  claudeSessionId?: string
  createdAt: number
  lastActiveAt: number
  metadata?: Record<string, unknown>
}

export interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
  timestamp?: number
}

export interface SessionTable {
  get(id: string): Promise<SessionRecord | null>
  getByExternalId(externalId: string): Promise<SessionRecord | null>
  upsert(record: SessionRecord): Promise<void>
  touch(id: string): Promise<void>
}

export interface MessageTable {
  append(sessionId: string, messages: Message[]): Promise<void>
  getHistory(sessionId: string, limit?: number): Promise<Message[]>
  truncate(sessionId: string, keepLast: number): Promise<void>
}

export interface Store {
  sessions: SessionTable
  messages: MessageTable
  close(): Promise<void>
}

export interface KVStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

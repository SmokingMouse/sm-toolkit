import type { Store, SessionTable, MessageTable, SessionRecord, Message } from './interface.js'

class MemorySessionTable implements SessionTable {
  #data = new Map<string, SessionRecord>()
  #byExternal = new Map<string, string>()

  async get(id: string): Promise<SessionRecord | null> {
    return this.#data.get(id) ?? null
  }

  async getByExternalId(externalId: string): Promise<SessionRecord | null> {
    const id = this.#byExternal.get(externalId)
    return id ? (this.#data.get(id) ?? null) : null
  }

  async upsert(record: SessionRecord): Promise<void> {
    this.#data.set(record.id, { ...record })
    if (record.externalId) {
      this.#byExternal.set(record.externalId, record.id)
    }
  }

  async touch(id: string): Promise<void> {
    const r = this.#data.get(id)
    if (r) r.lastActiveAt = Date.now()
  }
}

class MemoryMessageTable implements MessageTable {
  #data = new Map<string, Message[]>()

  async append(sessionId: string, messages: Message[]): Promise<void> {
    const existing = this.#data.get(sessionId) ?? []
    existing.push(...messages.map((m) => ({ ...m })))
    this.#data.set(sessionId, existing)
  }

  async getHistory(sessionId: string, limit?: number): Promise<Message[]> {
    const all = this.#data.get(sessionId) ?? []
    if (limit !== undefined) return all.slice(-limit)
    return [...all]
  }

  async truncate(sessionId: string, keepLast: number): Promise<void> {
    const all = this.#data.get(sessionId) ?? []
    this.#data.set(sessionId, all.slice(-keepLast))
  }
}

export function createMemoryStore(): Store {
  return {
    sessions: new MemorySessionTable(),
    messages: new MemoryMessageTable(),
    async close() {},
  }
}

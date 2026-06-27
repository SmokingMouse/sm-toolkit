import type { Store } from '@sm/store'

export interface SessionStore {
  getSessionId(externalId: string): Promise<string | null>
  saveSessionId(externalId: string, claudeSessionId: string): Promise<void>
  touch(externalId: string): Promise<void>
}

export function createSessionStore(
  store: Store,
  endpoint: string,
): SessionStore {
  return {
    async getSessionId(externalId) {
      const record = await store.sessions.getByExternalId(externalId)
      return record?.claudeSessionId ?? null
    },

    async saveSessionId(externalId, claudeSessionId) {
      const existing = await store.sessions.getByExternalId(externalId)
      if (existing) {
        await store.sessions.upsert({
          ...existing,
          claudeSessionId,
          lastActiveAt: Date.now(),
        })
      } else {
        await store.sessions.upsert({
          id: crypto.randomUUID(),
          externalId,
          endpoint,
          claudeSessionId,
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
        })
      }
    },

    async touch(externalId) {
      const record = await store.sessions.getByExternalId(externalId)
      if (record) {
        await store.sessions.touch(record.id)
      }
    },
  }
}

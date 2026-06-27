import type { Store, SessionTable, MessageTable, SessionRecord, Message } from './interface.js'

interface PgClient {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>
  end(): Promise<void>
}

const SCHEMA = (prefix: string) => `
CREATE TABLE IF NOT EXISTS ${prefix}sessions (
  id TEXT PRIMARY KEY,
  external_id TEXT UNIQUE,
  endpoint TEXT NOT NULL,
  claude_session_id TEXT,
  created_at BIGINT NOT NULL,
  last_active_at BIGINT NOT NULL,
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_${prefix}sessions_external ON ${prefix}sessions(external_id);

CREATE TABLE IF NOT EXISTS ${prefix}messages (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES ${prefix}sessions(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_${prefix}messages_session ON ${prefix}messages(session_id);
`

class PgSessionTable implements SessionTable {
  #client: PgClient
  #prefix: string

  constructor(client: PgClient, prefix: string) {
    this.#client = client
    this.#prefix = prefix
  }

  async get(id: string): Promise<SessionRecord | null> {
    const { rows } = await this.#client.query(
      `SELECT * FROM ${this.#prefix}sessions WHERE id = $1`,
      [id],
    )
    return rows[0] ? rowToSession(rows[0]) : null
  }

  async getByExternalId(externalId: string): Promise<SessionRecord | null> {
    const { rows } = await this.#client.query(
      `SELECT * FROM ${this.#prefix}sessions WHERE external_id = $1`,
      [externalId],
    )
    return rows[0] ? rowToSession(rows[0]) : null
  }

  async upsert(record: SessionRecord): Promise<void> {
    await this.#client.query(
      `INSERT INTO ${this.#prefix}sessions (id, external_id, endpoint, claude_session_id, created_at, last_active_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT(id) DO UPDATE SET
         external_id = EXCLUDED.external_id,
         endpoint = EXCLUDED.endpoint,
         claude_session_id = EXCLUDED.claude_session_id,
         last_active_at = EXCLUDED.last_active_at,
         metadata = EXCLUDED.metadata`,
      [
        record.id,
        record.externalId ?? null,
        record.endpoint,
        record.claudeSessionId ?? null,
        record.createdAt,
        record.lastActiveAt,
        record.metadata ? JSON.stringify(record.metadata) : null,
      ],
    )
  }

  async touch(id: string): Promise<void> {
    await this.#client.query(
      `UPDATE ${this.#prefix}sessions SET last_active_at = $1 WHERE id = $2`,
      [Date.now(), id],
    )
  }
}

class PgMessageTable implements MessageTable {
  #client: PgClient
  #prefix: string

  constructor(client: PgClient, prefix: string) {
    this.#client = client
    this.#prefix = prefix
  }

  async append(sessionId: string, messages: Message[]): Promise<void> {
    for (const m of messages) {
      await this.#client.query(
        `INSERT INTO ${this.#prefix}messages (session_id, role, content, timestamp) VALUES ($1, $2, $3, $4)`,
        [sessionId, m.role, m.content, m.timestamp ?? Date.now()],
      )
    }
  }

  async getHistory(sessionId: string, limit?: number): Promise<Message[]> {
    const query = limit
      ? `SELECT * FROM (SELECT * FROM ${this.#prefix}messages WHERE session_id = $1 ORDER BY id DESC LIMIT $2) sub ORDER BY id ASC`
      : `SELECT * FROM ${this.#prefix}messages WHERE session_id = $1 ORDER BY id ASC`
    const { rows } = limit
      ? await this.#client.query(query, [sessionId, limit])
      : await this.#client.query(query, [sessionId])
    return rows.map((r: any) => ({
      role: r.role,
      content: r.content,
      timestamp: Number(r.timestamp),
    }))
  }

  async truncate(sessionId: string, keepLast: number): Promise<void> {
    await this.#client.query(
      `DELETE FROM ${this.#prefix}messages WHERE session_id = $1 AND id NOT IN (
         SELECT id FROM ${this.#prefix}messages WHERE session_id = $1 ORDER BY id DESC LIMIT $2
       )`,
      [sessionId, keepLast],
    )
  }
}

function rowToSession(row: any): SessionRecord {
  return {
    id: row.id,
    externalId: row.external_id ?? undefined,
    endpoint: row.endpoint,
    claudeSessionId: row.claude_session_id ?? undefined,
    createdAt: Number(row.created_at),
    lastActiveAt: Number(row.last_active_at),
    metadata: row.metadata ?? undefined,
  }
}

export async function createPgStore(
  url: string,
  tablePrefix?: string,
): Promise<Store> {
  // @ts-ignore - pg is an optional peer dependency
  const { default: pg } = await import('pg')
  const client = new pg.Client({ connectionString: url })
  await client.connect()

  const prefix = tablePrefix ?? ''
  await client.query(SCHEMA(prefix))

  return {
    sessions: new PgSessionTable(client as unknown as PgClient, prefix),
    messages: new PgMessageTable(client as unknown as PgClient, prefix),
    async close() {
      await client.end()
    },
  }
}

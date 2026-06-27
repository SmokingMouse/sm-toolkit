import { Database } from 'bun:sqlite'
import type { Store, SessionTable, MessageTable, SessionRecord, Message } from './interface.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  external_id TEXT UNIQUE,
  endpoint TEXT NOT NULL,
  claude_session_id TEXT,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_external ON sessions(external_id);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
`

class SQLiteSessionTable implements SessionTable {
  #db: Database

  constructor(db: Database) {
    this.#db = db
  }

  async get(id: string): Promise<SessionRecord | null> {
    const row = this.#db
      .query('SELECT * FROM sessions WHERE id = ?')
      .get(id) as any
    return row ? rowToSession(row) : null
  }

  async getByExternalId(externalId: string): Promise<SessionRecord | null> {
    const row = this.#db
      .query('SELECT * FROM sessions WHERE external_id = ?')
      .get(externalId) as any
    return row ? rowToSession(row) : null
  }

  async upsert(record: SessionRecord): Promise<void> {
    this.#db
      .query(
        `INSERT INTO sessions (id, external_id, endpoint, claude_session_id, created_at, last_active_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           external_id = excluded.external_id,
           endpoint = excluded.endpoint,
           claude_session_id = excluded.claude_session_id,
           last_active_at = excluded.last_active_at,
           metadata = excluded.metadata`,
      )
      .run(
        record.id,
        record.externalId ?? null,
        record.endpoint,
        record.claudeSessionId ?? null,
        record.createdAt,
        record.lastActiveAt,
        record.metadata ? JSON.stringify(record.metadata) : null,
      )
  }

  async touch(id: string): Promise<void> {
    this.#db
      .query('UPDATE sessions SET last_active_at = ? WHERE id = ?')
      .run(Date.now(), id)
  }
}

class SQLiteMessageTable implements MessageTable {
  #db: Database

  constructor(db: Database) {
    this.#db = db
  }

  async append(sessionId: string, messages: Message[]): Promise<void> {
    const stmt = this.#db.query(
      'INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)',
    )
    const tx = this.#db.transaction(() => {
      for (const m of messages) {
        stmt.run(sessionId, m.role, m.content, m.timestamp ?? Date.now())
      }
    })
    tx()
  }

  async getHistory(sessionId: string, limit?: number): Promise<Message[]> {
    const query = limit
      ? 'SELECT * FROM (SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC'
      : 'SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC'
    const rows = (
      limit
        ? this.#db.query(query).all(sessionId, limit)
        : this.#db.query(query).all(sessionId)
    ) as any[]
    return rows.map((r) => ({
      role: r.role,
      content: r.content,
      timestamp: r.timestamp,
    }))
  }

  async truncate(sessionId: string, keepLast: number): Promise<void> {
    this.#db
      .query(
        `DELETE FROM messages WHERE session_id = ? AND id NOT IN (
           SELECT id FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?
         )`,
      )
      .run(sessionId, sessionId, keepLast)
  }
}

function rowToSession(row: any): SessionRecord {
  return {
    id: row.id,
    externalId: row.external_id ?? undefined,
    endpoint: row.endpoint,
    claudeSessionId: row.claude_session_id ?? undefined,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
  }
}

export function createSQLiteStore(path: string): Store {
  const db = new Database(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(SCHEMA)
  return {
    sessions: new SQLiteSessionTable(db),
    messages: new SQLiteMessageTable(db),
    async close() {
      db.close()
    },
  }
}

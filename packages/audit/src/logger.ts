import { Database } from 'bun:sqlite'
import { estimateCost } from './pricing.js'

export interface AuditEntry {
  timestamp: number
  endpoint: string
  model?: string
  action: 'chat' | 'tool_call' | 'approval' | 'error'
  inputTokens: number
  outputTokens: number
  costUsd: number | null
  durationMs: number
  sessionId?: string
  detail?: string
}

export interface AuditFilter {
  endpoint?: string
  action?: string
  sessionId?: string
  since?: number
  until?: number
  limit?: number
}

export interface TimeRange {
  since: number
  until: number
}

export interface AuditSummary {
  totalCalls: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCostUsd: number
  byEndpoint: Record<
    string,
    {
      calls: number
      inputTokens: number
      outputTokens: number
      costUsd: number
    }
  >
}

export interface AuditConfig {
  backend: 'sqlite'
  path: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  endpoint TEXT NOT NULL,
  model TEXT,
  action TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  session_id TEXT,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_endpoint ON audit_log(endpoint);
`

export interface AuditLogger {
  log(entry: AuditEntry): Promise<void>
  query(filter: AuditFilter): Promise<AuditEntry[]>
  summary(range: TimeRange): Promise<AuditSummary>
  close(): Promise<void>
}

export function createAuditLogger(config: AuditConfig): AuditLogger {
  const db = new Database(config.path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(SCHEMA)

  return {
    async log(entry) {
      const cost =
        entry.costUsd ??
        (entry.model
          ? estimateCost(entry.model, entry.inputTokens, entry.outputTokens)
          : null)

      db.query(
        `INSERT INTO audit_log (timestamp, endpoint, model, action, input_tokens, output_tokens, cost_usd, duration_ms, session_id, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        entry.timestamp,
        entry.endpoint,
        entry.model ?? null,
        entry.action,
        entry.inputTokens,
        entry.outputTokens,
        cost,
        entry.durationMs,
        entry.sessionId ?? null,
        entry.detail ?? null,
      )
    },

    async query(filter) {
      const conditions: string[] = []
      const params: unknown[] = []

      if (filter.endpoint) {
        conditions.push('endpoint = ?')
        params.push(filter.endpoint)
      }
      if (filter.action) {
        conditions.push('action = ?')
        params.push(filter.action)
      }
      if (filter.sessionId) {
        conditions.push('session_id = ?')
        params.push(filter.sessionId)
      }
      if (filter.since) {
        conditions.push('timestamp >= ?')
        params.push(filter.since)
      }
      if (filter.until) {
        conditions.push('timestamp <= ?')
        params.push(filter.until)
      }

      const where = conditions.length
        ? `WHERE ${conditions.join(' AND ')}`
        : ''
      const limit = filter.limit ? `LIMIT ${filter.limit}` : ''
      const sql = `SELECT * FROM audit_log ${where} ORDER BY timestamp DESC ${limit}`

      const rows = db.query(sql).all(...params as any) as any[]
      return rows.map(rowToEntry)
    },

    async summary(range) {
      const rows = db
        .query(
          `SELECT
            endpoint,
            COUNT(*) as calls,
            SUM(input_tokens) as input_tokens,
            SUM(output_tokens) as output_tokens,
            SUM(COALESCE(cost_usd, 0)) as cost_usd
           FROM audit_log
           WHERE timestamp >= ? AND timestamp <= ?
           GROUP BY endpoint`,
        )
        .all(range.since, range.until) as any[]

      const byEndpoint: AuditSummary['byEndpoint'] = {}
      let totalCalls = 0
      let totalInput = 0
      let totalOutput = 0
      let totalCost = 0

      for (const r of rows) {
        byEndpoint[r.endpoint] = {
          calls: r.calls,
          inputTokens: r.input_tokens,
          outputTokens: r.output_tokens,
          costUsd: r.cost_usd,
        }
        totalCalls += r.calls
        totalInput += r.input_tokens
        totalOutput += r.output_tokens
        totalCost += r.cost_usd
      }

      return {
        totalCalls,
        totalInputTokens: totalInput,
        totalOutputTokens: totalOutput,
        totalCostUsd: totalCost,
        byEndpoint,
      }
    },

    async close() {
      db.close()
    },
  }
}

function rowToEntry(row: any): AuditEntry {
  return {
    timestamp: row.timestamp,
    endpoint: row.endpoint,
    model: row.model ?? undefined,
    action: row.action,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    durationMs: row.duration_ms,
    sessionId: row.session_id ?? undefined,
    detail: row.detail ?? undefined,
  }
}

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { loadConfig } from './config.js'

let _db: Database | null = null

function getDb(): Database {
  if (_db) return _db
  const config = loadConfig()
  const dbPath = join(config.rootDir, 'data', 'self-agent.db')
  mkdirSync(dirname(dbPath), { recursive: true })
  _db = new Database(dbPath, { create: true })
  _db.exec('PRAGMA journal_mode = WAL')
  _db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      thread_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'feishu',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_active TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  _db.exec(`
    CREATE TABLE IF NOT EXISTS acl_approvals (
      user_id TEXT PRIMARY KEY,
      user_name TEXT,
      approved_by TEXT,
      permanent INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  return _db
}

export function getSession(
  threadId: string,
): { sessionId: string; endpoint: string } | null {
  const db = getDb()
  const row = db
    .query('SELECT session_id, endpoint FROM sessions WHERE thread_id = ?')
    .get(threadId) as { session_id: string; endpoint: string } | null
  if (!row) return null
  if (!row.session_id) return null
  return { sessionId: row.session_id, endpoint: row.endpoint }
}

export function saveSession(
  threadId: string,
  sessionId: string,
  endpoint: string,
  channel = 'feishu',
): void {
  const db = getDb()
  db.query(
    `INSERT INTO sessions (thread_id, session_id, endpoint, channel)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET
       session_id = excluded.session_id,
       endpoint = excluded.endpoint,
       last_active = datetime('now')`,
  ).run(threadId, sessionId, endpoint, channel)
}

export function touchSession(threadId: string): void {
  const db = getDb()
  db.query(
    "UPDATE sessions SET last_active = datetime('now') WHERE thread_id = ?",
  ).run(threadId)
}

export function isUserApproved(userId: string): boolean {
  const db = getDb()
  const row = db
    .query('SELECT 1 FROM acl_approvals WHERE user_id = ?')
    .get(userId)
  return row !== null
}

export function approveUser(
  userId: string,
  userName: string,
  approvedBy: string,
  permanent: boolean,
): void {
  const db = getDb()
  db.query(
    `INSERT INTO acl_approvals (user_id, user_name, approved_by, permanent)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       permanent = excluded.permanent,
       approved_by = excluded.approved_by`,
  ).run(userId, userName, approvedBy, permanent ? 1 : 0)
}

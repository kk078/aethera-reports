/**
 * Server-side staff-user store (Phase 3 chunk E: "username+password
 * (bcrypt, server-side SQLite users table, seeded via CLI command)").
 *
 * Deliberately a separate `users.db` from the desktop's `meta.db` schema
 * (`src/main/db/meta.ts`) rather than a new table bolted onto it — user
 * accounts are a server-only concept (a standalone desktop install has no
 * login), so keeping them in their own file means `LocalDataService`'s
 * schema never has to know the server exists.
 */
import Database from 'better-sqlite3'
import { join } from 'node:path'

export interface UserRow {
  userId: number
  username: string
  passwordHash: string
  createdAt: string
}

interface UserRowDb {
  user_id: number
  username: string
  password_hash: string
  created_at: string
}

function mapRow(row: UserRowDb): UserRow {
  return {
    userId: row.user_id,
    username: row.username,
    passwordHash: row.password_hash,
    createdAt: row.created_at
  }
}

export function openUsersDb(dataDir: string): Database.Database {
  const db = new Database(join(dataDir, 'users.db'))
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  return db
}

export function findUserByUsername(db: Database.Database, username: string): UserRow | null {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
    UserRowDb | undefined
  return row ? mapRow(row) : null
}

export function createUser(db: Database.Database, username: string, passwordHash: string): void {
  db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(
    username,
    passwordHash
  )
}

export function updateUserPassword(
  db: Database.Database,
  username: string,
  passwordHash: string
): boolean {
  const result = db
    .prepare('UPDATE users SET password_hash = ? WHERE username = ?')
    .run(passwordHash, username)
  return result.changes > 0
}

export function deleteUser(db: Database.Database, username: string): boolean {
  const result = db.prepare('DELETE FROM users WHERE username = ?').run(username)
  return result.changes > 0
}

export function listUsers(db: Database.Database): UserRow[] {
  const rows = db.prepare('SELECT * FROM users ORDER BY username').all() as UserRowDb[]
  return rows.map(mapRow)
}

export function countUsers(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }
  return row.n
}

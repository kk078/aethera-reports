/**
 * A `better-sqlite3`-backed test double for `D1Like` (plan: "Worker
 * logic must be testable without deployment ... a better-sqlite3-backed
 * test double is fine"). D1 IS SQLite under the hood, so schema.sql's
 * plain `?`-placeholder statements run identically against either —
 * nothing in `snapshots.ts`/`tokens.ts` needs to know which one it's
 * talking to.
 *
 * Only used by tests and `scripts/e2e-portal.ts` — never imported by
 * `app.ts`/`index.ts`, which only ever see the real D1 binding in
 * production.
 */
import Database from 'better-sqlite3'
import type { D1Like, D1PreparedLike } from './db'

export function createSqliteD1Double(db: Database.Database): D1Like {
  return {
    prepare(sql: string): D1PreparedLike {
      const statement = db.prepare(sql)
      let boundArgs: unknown[] = []

      const prepared: D1PreparedLike = {
        bind(...values: unknown[]) {
          boundArgs = values
          return prepared
        },
        async run() {
          const info = statement.run(...(boundArgs as never[]))
          return { success: true, meta: { changes: info.changes } }
        },
        async all<T>() {
          const results = statement.all(...(boundArgs as never[])) as T[]
          return { results }
        },
        async first<T>() {
          const row = statement.get(...(boundArgs as never[])) as T | undefined
          return row ?? null
        }
      }
      return prepared
    }
  }
}

/** Applies schema.sql's statements to a fresh better-sqlite3 database — the test-double equivalent of `wrangler d1 migrations apply`. */
export function applyPortalSchema(db: Database.Database, schemaSql: string): void {
  db.exec(schemaSql)
}

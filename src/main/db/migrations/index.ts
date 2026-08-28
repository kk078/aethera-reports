import m001Init from './001_init.sql?raw'

export interface Migration {
  version: number
  name: string
  sql: string
}

/**
 * Ordered migration list. Add new migrations by appending here (never
 * edit a migration that has already shipped) — `migrate.ts` tracks which
 * versions have run per database in `schema_migrations`.
 */
export const migrations: Migration[] = [{ version: 1, name: '001_init', sql: m001Init }]

import m001Init from './001_init.sql?raw'
import m002X12Remittances from './002_x12_remittances.sql?raw'

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
export const migrations: Migration[] = [
  { version: 1, name: '001_init', sql: m001Init },
  { version: 2, name: '002_x12_remittances', sql: m002X12Remittances }
]

/**
 * The minimal slice of Cloudflare D1's API this Worker actually uses,
 * declared as our own interface rather than importing
 * `@cloudflare/workers-types`' `D1Database` directly — a real D1 binding
 * satisfies this structurally (it has strictly more methods), and so
 * does `db-sqlite-double.ts`'s better-sqlite3-backed test double (plan:
 * "structure handlers as pure functions over an injected D1-like
 * interface (better-sqlite3-backed test double is fine)"). Nothing in
 * `snapshots.ts`/`tokens.ts`/`app.ts` ever imports the real D1 types, so
 * they're testable under plain Node/vitest with zero Workers runtime.
 */

export interface D1RunMeta {
  changes: number
}

export interface D1PreparedLike {
  bind(...values: unknown[]): D1PreparedLike
  run(): Promise<{ success: boolean; meta: D1RunMeta }>
  all<T = unknown>(): Promise<{ results: T[] }>
  first<T = unknown>(): Promise<T | null>
}

export interface D1Like {
  prepare(sql: string): D1PreparedLike
}

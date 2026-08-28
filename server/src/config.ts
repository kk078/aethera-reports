/**
 * Server config (Phase 3 chunk E, plan's Phase 3 addendum: "Server config
 * via env/config file: data dir, bind host/port (default 127.0.0.1), JWT
 * secret (generated on first run if absent, stored in data dir)").
 *
 * Every setting is an env var so the Dockerfile/compose file can set them
 * without a mounted config file, but a config file works too — see
 * `loadConfigFileOverrides` below and `docs/server-mode.md`.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface ServerConfig {
  /** Root directory for everything the server persists: analytics.duckdb, meta.db, users.db, the JWT secret, uploaded files, and backups. */
  dataDir: string
  /** Defaults to 127.0.0.1 (plan: "bind host/port (default 127.0.0.1)") — binding to 0.0.0.0/a LAN address is an explicit opt-in, documented in docs/server-mode.md's Tailscale/LAN section. */
  host: string
  port: number
  jwtSecret: string
  /** How long an issued JWT stays valid before the desktop client must log in again (plan: "short-lived JWT"). */
  jwtExpiresIn: string
}

interface ConfigFileShape {
  dataDir?: string
  host?: string
  port?: number
  jwtExpiresIn?: string
}

/** A plain-JSON config file is optional — every field it can set also has an env var equivalent that wins if both are present, so container deployments never need a mounted file. */
function loadConfigFileOverrides(path: string | undefined): ConfigFileShape {
  if (!path || !existsSync(path)) return {}
  const raw = readFileSync(path, 'utf-8')
  return JSON.parse(raw) as ConfigFileShape
}

function loadOrCreateJwtSecret(dataDir: string): string {
  const secretPath = join(dataDir, 'jwt-secret.txt')
  if (existsSync(secretPath)) {
    const existing = readFileSync(secretPath, 'utf-8').trim()
    if (existing.length > 0) return existing
  }
  // 48 random bytes (384 bits) hex-encoded — comfortably beyond HS256's
  // useful key-size ceiling, generated once per install and never logged.
  const secret = randomBytes(48).toString('hex')
  writeFileSync(secretPath, secret, { mode: 0o600 })
  return secret
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const fileOverrides = loadConfigFileOverrides(env.AETHERA_SERVER_CONFIG_FILE)

  const dataDir = resolve(
    env.AETHERA_SERVER_DATA_DIR ?? fileOverrides.dataDir ?? join(process.cwd(), 'server-data')
  )
  mkdirSync(dataDir, { recursive: true })

  const host = env.AETHERA_SERVER_HOST ?? fileOverrides.host ?? '127.0.0.1'
  const port = Number(env.AETHERA_SERVER_PORT ?? fileOverrides.port ?? 8787)
  const jwtSecret = env.AETHERA_SERVER_JWT_SECRET ?? loadOrCreateJwtSecret(dataDir)
  const jwtExpiresIn = env.AETHERA_SERVER_JWT_EXPIRES_IN ?? fileOverrides.jwtExpiresIn ?? '30m'

  return { dataDir, host, port, jwtSecret, jwtExpiresIn }
}

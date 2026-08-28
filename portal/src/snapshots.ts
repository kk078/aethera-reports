/**
 * Snapshot publish/read/revoke (plan: "publish/replace a client+period
 * report JSON" / "revoke"). `clientReportSchema.parse()` is the actual
 * "assert/strip unknown fields on publish" mechanism the plan calls
 * for — zod's default `z.object()` behavior silently drops any key not
 * declared in the schema, so a caller can never smuggle extra fields
 * (patient-level data included) into a stored snapshot; and `.parse()`
 * throws on anything that doesn't match the expected shape at all.
 */
import { clientReportSchema, type ClientReport } from '../../src/shared/domain'
import type { D1Like } from './db'

interface SnapshotRow {
  client_code: string
  period: string
  published_at: string
  report_json: string
  revoked: number
}

export interface SnapshotSummary {
  period: string
  publishedAt: string
}

export interface PublishedSnapshot {
  report: ClientReport
  publishedAt: string
}

/** Validates+strips `rawReport` against `clientReportSchema`, then inserts or replaces the (clientCode, period) snapshot — un-revoking it if it had previously been revoked. Throws (zod's `ZodError`) if `rawReport` doesn't look like a `ClientReport` at all. */
export async function publishSnapshot(
  db: D1Like,
  clientCode: string,
  period: string,
  rawReport: unknown,
  now: Date
): Promise<ClientReport> {
  const report = clientReportSchema.parse(rawReport)
  await db
    .prepare(
      `INSERT INTO snapshots (client_code, period, published_at, report_json, revoked)
       VALUES (?, ?, ?, ?, 0)
       ON CONFLICT (client_code, period) DO UPDATE SET
         published_at = excluded.published_at, report_json = excluded.report_json, revoked = 0`
    )
    .bind(clientCode, period, now.toISOString(), JSON.stringify(report))
    .run()
  return report
}

export async function getSnapshot(
  db: D1Like,
  clientCode: string,
  period: string
): Promise<PublishedSnapshot | null> {
  const row = await db
    .prepare('SELECT * FROM snapshots WHERE client_code = ? AND period = ?')
    .bind(clientCode, period)
    .first<SnapshotRow>()
  if (!row || row.revoked) return null
  return {
    report: clientReportSchema.parse(JSON.parse(row.report_json)),
    publishedAt: row.published_at
  }
}

export async function listSnapshotsForClient(
  db: D1Like,
  clientCode: string
): Promise<SnapshotSummary[]> {
  const { results } = await db
    .prepare(
      'SELECT period, published_at FROM snapshots WHERE client_code = ? AND revoked = 0 ORDER BY period DESC'
    )
    .bind(clientCode)
    .all<{ period: string; published_at: string }>()
  return results.map((r) => ({ period: r.period, publishedAt: r.published_at }))
}

export async function revokeSnapshot(
  db: D1Like,
  clientCode: string,
  period: string
): Promise<void> {
  await db
    .prepare('UPDATE snapshots SET revoked = 1 WHERE client_code = ? AND period = ?')
    .bind(clientCode, period)
    .run()
}

export async function countSnapshots(db: D1Like): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM snapshots WHERE revoked = 0')
    .first<{ n: number }>()
  return row?.n ?? 0
}

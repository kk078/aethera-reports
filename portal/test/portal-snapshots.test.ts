/**
 * Snapshot publish/replace/strip-unknown-fields/revoke tests (plan:
 * "snapshot publish/replace/strip-unknown-fields").
 */
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1Double, applyPortalSchema } from '../src/db-sqlite-double'
import {
  countSnapshots,
  getSnapshot,
  listSnapshotsForClient,
  publishSnapshot,
  revokeSnapshot
} from '../src/snapshots'
import type { D1Like } from '../src/db'
import type { ClientReport } from '../../src/shared/domain'

const SCHEMA_SQL = readFileSync(join(__dirname, '..', 'schema.sql'), 'utf-8')

function makeReport(overrides: Partial<ClientReport> = {}): ClientReport {
  return {
    client: { code: 'ACME', name: 'Acme Health', contract: '5% of collections' },
    period: { start: '2026-01-01', end: '2026-01-31' },
    source: 'claims',
    volume: { encountersReceived: 10, claimsSubmitted: 10, denialsReceived: 2 },
    financials: {
      grossCharges: 10000,
      insuranceCollections: 6000,
      patientCollections: 1000,
      totalCollections: 7000,
      rcmFee: 350,
      netCollectionRatePct: 70
    },
    kpis: {
      daysInAr: 32.5,
      openAr: 3000,
      arOver90Pct: 5.2,
      chargeLagDaysAvg: 2.1,
      slaDaysToSubmit: 5,
      slaMetPct: 90,
      firstPassAcceptancePct: 88,
      denialRatePct: 20
    },
    arAging: { '0-30': 2000, '31-60': 500, '61-90': 300, '91-120': 100, '120+': 100 },
    kpiTrends: { series: [], latest: null, deltas: {} },
    denialsByRootCause: { CODING: 2 },
    claimsByStatus: { Paid: 8, Denied: 2 },
    payerMix: [{ payerName: 'Aetna', charges: 5000 }],
    benchmark: null,
    ...overrides
  }
}

describe('snapshots', () => {
  let sqlite: Database.Database
  let db: D1Like

  beforeEach(() => {
    sqlite = new Database(':memory:')
    applyPortalSchema(sqlite, SCHEMA_SQL)
    db = createSqliteD1Double(sqlite)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('publishes a snapshot and reads it back unchanged', async () => {
    const now = new Date('2026-02-01T00:00:00Z')
    const report = makeReport()
    await publishSnapshot(db, 'ACME', '2026-01', report, now)

    const read = await getSnapshot(db, 'ACME', '2026-01')
    expect(read).not.toBeNull()
    expect(read!.report).toEqual(report)
    expect(read!.publishedAt).toBe(now.toISOString())
  })

  it('replaces an existing snapshot for the same client+period rather than erroring', async () => {
    const now = new Date('2026-02-01T00:00:00Z')
    await publishSnapshot(db, 'ACME', '2026-01', makeReport({ source: 'claims' }), now)
    const later = new Date('2026-02-02T00:00:00Z')
    await publishSnapshot(db, 'ACME', '2026-01', makeReport({ source: 'manual' }), later)

    const read = await getSnapshot(db, 'ACME', '2026-01')
    expect(read!.report.source).toBe('manual')
    expect(read!.publishedAt).toBe(later.toISOString())
    expect(await countSnapshots(db)).toBe(1) // replaced, not duplicated
  })

  it('strips unknown fields rather than storing them (assert/strip on publish)', async () => {
    const now = new Date('2026-02-01T00:00:00Z')
    const withExtra = {
      ...makeReport(),
      patientName: 'Jane Doe', // never allowed — a stand-in for accidental patient-level data
      ssn: '123-45-6789'
    }
    await publishSnapshot(db, 'ACME', '2026-01', withExtra, now)

    const raw = sqlite
      .prepare('SELECT report_json FROM snapshots WHERE client_code = ?')
      .get('ACME') as {
      report_json: string
    }
    expect(raw.report_json).not.toContain('patientName')
    expect(raw.report_json).not.toContain('Jane Doe')
    expect(raw.report_json).not.toContain('ssn')
    expect(raw.report_json).not.toContain('123-45-6789')
  })

  it('rejects a report that does not match the ClientReport shape at all', async () => {
    await expect(
      publishSnapshot(db, 'ACME', '2026-01', { totally: 'not a report' }, new Date())
    ).rejects.toThrow()
  })

  it('revoked snapshots are excluded from getSnapshot and listSnapshotsForClient', async () => {
    const now = new Date('2026-02-01T00:00:00Z')
    await publishSnapshot(db, 'ACME', '2026-01', makeReport(), now)
    expect(await getSnapshot(db, 'ACME', '2026-01')).not.toBeNull()

    await revokeSnapshot(db, 'ACME', '2026-01')
    expect(await getSnapshot(db, 'ACME', '2026-01')).toBeNull()
    expect(await listSnapshotsForClient(db, 'ACME')).toEqual([])
  })

  it('re-publishing a revoked snapshot un-revokes it', async () => {
    const now = new Date('2026-02-01T00:00:00Z')
    await publishSnapshot(db, 'ACME', '2026-01', makeReport(), now)
    await revokeSnapshot(db, 'ACME', '2026-01')
    expect(await getSnapshot(db, 'ACME', '2026-01')).toBeNull()

    await publishSnapshot(db, 'ACME', '2026-01', makeReport(), new Date('2026-02-05T00:00:00Z'))
    expect(await getSnapshot(db, 'ACME', '2026-01')).not.toBeNull()
  })

  it('lists multiple periods for a client, newest first', async () => {
    await publishSnapshot(db, 'ACME', '2025-12', makeReport(), new Date('2026-01-01T00:00:00Z'))
    await publishSnapshot(db, 'ACME', '2026-01', makeReport(), new Date('2026-02-01T00:00:00Z'))
    const list = await listSnapshotsForClient(db, 'ACME')
    expect(list.map((s) => s.period)).toEqual(['2026-01', '2025-12'])
  })

  it('scopes snapshots per client — another client never sees them', async () => {
    await publishSnapshot(db, 'ACME', '2026-01', makeReport(), new Date())
    expect(await listSnapshotsForClient(db, 'OTHERCO')).toEqual([])
  })
})

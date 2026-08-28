/**
 * Reference & Benchmark API connector tests (the beacon paragraph, Phase
 * 2 chunk C) — a `node:http` mock server standing in for the reference
 * deployment (`/home/aethera/projects/beacon`, verified live at
 * 127.0.0.1:8110 — see this file's header note on the live smoke check),
 * exercising: health-check degradation when unreachable, CARC/CPT cache
 * population + read-back, and the benchmark block builder with and
 * without data.
 */
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openDuckDb, type DuckDbHandle } from '../src/main/db/duckdb'
import { applyMigrations } from '../src/main/db/migrate'
import { migrations } from '../src/main/db/migrations'
import {
  checkReferenceApiHealth,
  fetchCarcDescription,
  fetchCptDescription,
  fetchCommercialBenchmark,
  refreshCarcCache,
  refreshCptCache,
  getCachedCarcDescriptions,
  buildBenchmarkBlock
} from '../src/main/beacon'

/** Shapes verified against the live reference deployment at 127.0.0.1:8110 on 2026-08-28 (see this repo's session notes) — `/denial/{carc}`, `/lookup/{codeset}/{code}`, `/price/commercial/{code}`. */
function createMockReferenceApiServer(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    res.setHeader('Content-Type', 'application/json')

    if (url.pathname === '/health') {
      res.writeHead(200)
      res.end(JSON.stringify({ ok: true, tables: 169, db_mb: 1248 }))
      return
    }

    const denialMatch = url.pathname.match(/^\/denial\/(.+)$/)
    if (denialMatch) {
      const code = decodeURIComponent(denialMatch[1])
      if (code === '45') {
        res.writeHead(200)
        res.end(
          JSON.stringify({
            code: '45',
            description:
              'CHARGE EXCEEDS FEE SCHEDULE/MAXIMUM ALLOWABLE OR CONTRACTED/LEGISLATED FEE ARRANGMENT.',
            patterns: []
          })
        )
        return
      }
      res.writeHead(404)
      res.end(JSON.stringify({ detail: `CARC ${code} not found` }))
      return
    }

    const cptMatch = url.pathname.match(/^\/lookup\/cpt\/(.+)$/)
    if (cptMatch) {
      const code = decodeURIComponent(cptMatch[1])
      if (code === '99213') {
        res.writeHead(200)
        res.end(
          JSON.stringify({
            code: '99213',
            short_desc: null,
            long_desc: 'Office o/p est low 20 min'
          })
        )
        return
      }
      res.writeHead(404)
      res.end(JSON.stringify({ detail: 'not found' }))
      return
    }

    const priceMatch = url.pathname.match(/^\/price\/commercial\/(.+)$/)
    if (priceMatch) {
      const code = decodeURIComponent(priceMatch[1])
      const state = url.searchParams.get('state')
      res.writeHead(200)
      res.end(
        JSON.stringify({
          code,
          code_type: 'cpt',
          scope: state,
          count: 2,
          benchmarks: [
            {
              code_type: 'cpt',
              code,
              state,
              payer_group: 'Other',
              payer_type: 'Other',
              n: 40275,
              avg_rate: 537.24,
              p10: 56.01,
              p25: 70.6,
              median_rate: 168.75,
              p75: 231.0,
              p90: 560.04
            },
            {
              code_type: 'cpt',
              code,
              state,
              payer_group: 'BCBS',
              payer_type: 'Commercial',
              n: 8144,
              median_rate: 231.0
            }
          ]
        })
      )
      return
    }

    res.writeHead(404)
    res.end(JSON.stringify({ detail: 'not found' }))
  })
}

describe('Reference & Benchmark API connector', () => {
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    server = createMockReferenceApiServer()
    server.listen(0)
    await once(server, 'listening')
    const address = server.address()
    if (typeof address !== 'object' || address === null) throw new Error('server did not bind')
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(() => {
    server.close()
  })

  describe('health + graceful degradation', () => {
    it('reports healthy when the reference API responds ok:true', async () => {
      expect(await checkReferenceApiHealth(baseUrl)).toBe(true)
    })

    it('reports unhealthy (never throws) when unreachable', async () => {
      expect(await checkReferenceApiHealth('http://127.0.0.1:1', 500)).toBe(false)
    })

    it('degrades a CARC lookup to null (never throws) for an unknown code', async () => {
      expect(await fetchCarcDescription(baseUrl, '999999')).toBeNull()
    })

    it('degrades a CARC lookup to null against an unreachable host', async () => {
      expect(await fetchCarcDescription('http://127.0.0.1:1', '45', 500)).toBeNull()
    })
  })

  describe('reference-api-client wire shapes (verified against the live deployment)', () => {
    it('fetches a real CARC description', async () => {
      const result = await fetchCarcDescription(baseUrl, '45')
      expect(result?.description).toContain('CHARGE EXCEEDS FEE SCHEDULE')
    })

    it('fetches a real CPT description (long_desc preferred)', async () => {
      const result = await fetchCptDescription(baseUrl, '99213')
      expect(result?.description).toBe('Office o/p est low 20 min')
    })

    it('picks the "Other" payer_group row as the overall state benchmark', async () => {
      const result = await fetchCommercialBenchmark(baseUrl, '99213', 'NY')
      expect(result?.medianRate).toBe(168.75)
      expect(result?.sampleCount).toBe(40275)
    })
  })

  describe('cache.ts (ref_carc/ref_cpt population)', () => {
    let dir: string
    let db: DuckDbHandle
    let clientId: number

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), 'aethera-reference-api-cache-test-'))
      db = await openDuckDb(join(dir, 'analytics.duckdb'))
      await applyMigrations(db.connection, migrations)
      const client = await db.connection.runAndReadAll(
        `INSERT INTO clients (code, name, active) VALUES ('REFCACHE', 'Ref Cache Co', true) RETURNING client_id`
      )
      clientId = Number(client.getRowObjectsJS()[0].client_id)
    })

    afterEach(() => {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    })

    it('caches CARC descriptions only for codes that appear in denials, skipping ones already cached', async () => {
      const claim = await db.connection.runAndReadAll(
        `INSERT INTO claims (client_id, patient_key, claim_number, dos, created_at, source, natural_key)
         VALUES (?, 'ph-1', 'CLM-1', '2026-04-01', '2026-04-01T00:00:00Z', 'manual', 'refcache-nk-1')
         RETURNING claim_id`,
        [clientId]
      )
      const claimId = Number(claim.getRowObjectsJS()[0].claim_id)
      await db.connection.run(`INSERT INTO denials (claim_id, carc_code) VALUES (?, '45')`, [
        claimId
      ])
      await db.connection.run(`INSERT INTO denials (claim_id, carc_code) VALUES (?, '999999')`, [
        claimId
      ])
      // Already cached — refreshCarcCache should not re-fetch it (it's excluded from the "uncached" query).
      await db.connection.run(
        `INSERT INTO ref_carc (carc_code, description) VALUES ('999999', 'pre-existing')`
      )

      const result = await refreshCarcCache(db.connection, baseUrl)
      expect(result.cached).toBe(1) // only '45' was uncached and found
      expect(result.notFound).toBe(0) // '999999' was already cached, never queried

      const cached = await getCachedCarcDescriptions(db.connection, ['45', '999999'])
      expect(cached.get('45')).toContain('CHARGE EXCEEDS FEE SCHEDULE')
      expect(cached.get('999999')).toBe('pre-existing')
    })

    it('caches CPT descriptions only for codes that appear in claim_lines', async () => {
      const claim = await db.connection.runAndReadAll(
        `INSERT INTO claims (client_id, patient_key, claim_number, dos, created_at, source, natural_key)
         VALUES (?, 'ph-2', 'CLM-2', '2026-04-02', '2026-04-02T00:00:00Z', 'manual', 'refcache-nk-2')
         RETURNING claim_id`,
        [clientId]
      )
      const claimId = Number(claim.getRowObjectsJS()[0].claim_id)
      await db.connection.run(
        `INSERT INTO claim_lines (claim_id, line_number, cpt_code, charge_amount) VALUES (?, 1, '99213', 100)`,
        [claimId]
      )

      const result = await refreshCptCache(db.connection, baseUrl)
      expect(result.cached).toBe(1)

      const cptRow = await db.connection.runAndReadAll(
        `SELECT description FROM ref_cpt WHERE cpt_code = '99213'`
      )
      expect(cptRow.getRowObjectsJS()[0].description).toBe('Office o/p est low 20 min')
    })

    it('never throws when the reference API is unreachable — just caches nothing', async () => {
      await db.connection.run(
        `INSERT INTO claims (client_id, patient_key, claim_number, dos, created_at, source, natural_key)
         VALUES (?, 'ph-3', 'CLM-3', '2026-04-03', '2026-04-03T00:00:00Z', 'manual', 'refcache-nk-3')`,
        [clientId]
      )
      const result = await refreshCarcCache(db.connection, 'http://127.0.0.1:1')
      expect(result.cached).toBe(0)
    })
  })

  describe('benchmark.ts (buildBenchmarkBlock)', () => {
    let dir: string
    let db: DuckDbHandle
    let clientId: number

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), 'aethera-benchmark-test-'))
      db = await openDuckDb(join(dir, 'analytics.duckdb'))
      await applyMigrations(db.connection, migrations)
      const client = await db.connection.runAndReadAll(
        `INSERT INTO clients (code, name, state, active) VALUES ('BENCHCO', 'Benchmark Co', 'NY', true) RETURNING client_id`
      )
      clientId = Number(client.getRowObjectsJS()[0].client_id)
      const claim = await db.connection.runAndReadAll(
        `INSERT INTO claims (client_id, patient_key, claim_number, dos, created_at, source, natural_key)
         VALUES (?, 'ph-b', 'CLM-B', '2026-04-01', '2026-04-01T00:00:00Z', 'manual', 'bench-nk-1')
         RETURNING claim_id`,
        [clientId]
      )
      const claimId = Number(claim.getRowObjectsJS()[0].claim_id)
      await db.connection.run(
        `INSERT INTO claim_lines (claim_id, line_number, cpt_code, charge_amount, allowed_amount) VALUES (?, 1, '99213', 150, 120)`,
        [claimId]
      )
    })

    afterEach(() => {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    })

    it('builds a benchmark block with state percentiles for the top CPT codes', async () => {
      const block = await buildBenchmarkBlock(
        db.connection,
        baseUrl,
        'NY',
        clientId,
        '2026-04',
        true
      )
      expect(block).not.toBeNull()
      expect(block?.state).toBe('NY')
      expect(block?.cpts).toHaveLength(1)
      expect(block?.cpts[0].cptCode).toBe('99213')
      expect(block?.cpts[0].avgAllowed).toBe(120)
      expect(block?.cpts[0].stateMedian).toBe(168.75)
      expect(block?.cpts[0].description).toBe('Office o/p est low 20 min')
    })

    it('returns null when the client has no state configured', async () => {
      const block = await buildBenchmarkBlock(
        db.connection,
        baseUrl,
        null,
        clientId,
        '2026-04',
        true
      )
      expect(block).toBeNull()
    })

    it('returns null when the reference API is not healthy (cached-health gate)', async () => {
      const block = await buildBenchmarkBlock(
        db.connection,
        baseUrl,
        'NY',
        clientId,
        '2026-04',
        false
      )
      expect(block).toBeNull()
    })

    it('returns null when the client has no CPT volume in the period', async () => {
      const block = await buildBenchmarkBlock(
        db.connection,
        baseUrl,
        'NY',
        clientId,
        '2020-01',
        true
      )
      expect(block).toBeNull()
    })
  })
})

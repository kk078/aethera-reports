/**
 * End-to-end check for a full RCM Platform connector sync cycle (plan §3
 * bullet 3, Phase 2 chunk C): spins up a `node:http` mock server standing
 * in for the reference implementation, runs `LocalDataService.runConnectorSync`
 * against it, and prints/verifies that `monthly_summaries`/`kpi_snapshots`
 * were updated and that the resulting `ClientReport.source` reads
 * `"synced"`. Unlike `scripts/e2e-generate-check.ts` (PDF/PPTX need a
 * real offscreen Electron `BrowserWindow`), this whole path is
 * Electron-free — `vite-node` is enough, no `--generate`/subprocess
 * needed.
 *
 * Run with: npm run e2e:connector-sync
 */
import { createServer, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { LocalDataService } from '../src/main/services/local-data-service'

const USERNAME = 'manager'
const PASSWORD = 'e2e-sync-check-password'
const PERIOD_MONTH = '2026-07'

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function main(): Promise<void> {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')

      if (req.method === 'POST' && url.pathname === '/api/auth/token') {
        let body = ''
        for await (const chunk of req) body += String(chunk)
        const params = new URLSearchParams(body)
        if (params.get('username') !== USERNAME || params.get('password') !== PASSWORD) {
          sendJson(res, 401, { detail: 'bad credentials' })
          return
        }
        sendJson(res, 200, { access_token: 'e2e-token', token_type: 'bearer' })
        return
      }

      if (req.headers.authorization !== 'Bearer e2e-token') {
        sendJson(res, 401, { detail: 'not authenticated' })
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/reports/clients') {
        sendJson(res, 200, {
          period: { start: url.searchParams.get('start'), end: url.searchParams.get('end') },
          clients: [{ client: 'E2ESYNC', name: 'E2E Sync Client', encounters: 10, charges: 8000 }]
        })
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/reports/client/E2ESYNC') {
        sendJson(res, 200, {
          client: { code: 'E2ESYNC', name: 'E2E Sync Client', contract: 'no contract on file' },
          period: { start: '2026-07-01', end: '2026-07-31' },
          volume: { encounters_received: 10, claims_submitted: 9, denials_received: 2 },
          financials: {
            gross_charges: 8000,
            insurance_collections: 5500,
            patient_collections: 300,
            total_collections: 5800,
            rcm_fee: 290,
            net_collection_rate_pct: 72.5
          },
          kpis: {
            days_in_ar: 19.5,
            open_ar: 2200,
            ar_over_90_pct: 5,
            charge_lag_days_avg: 1.8,
            sla_days_to_submit: 3,
            sla_met_pct: 95,
            first_pass_acceptance_pct: 87,
            denial_rate_pct: 22.2
          },
          ar_aging: { '0-30': 1200, '31-60': 700, '61-90': 300, '91-120': 0, '120+': 0 },
          denials_by_root_cause: { CODING: 2 },
          claims_by_status: { Paid: 7, Denied: 2 }
        })
        return
      }

      sendJson(res, 404, { detail: 'not found' })
    })()
  })
  server.listen(0)
  await once(server, 'listening')
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('mock server did not bind')
  const baseUrl = `http://127.0.0.1:${address.port}`
  console.log(`[e2e-connector-sync] mock RCM platform listening at ${baseUrl}`)

  const dir = mkdtempSync(join(tmpdir(), 'aethera-e2e-connector-sync-'))
  const service = await LocalDataService.create({
    duckdbPath: join(dir, 'analytics.duckdb'),
    metaDbPath: join(dir, 'meta.db'),
    backupsDir: join(dir, 'backups')
  })

  try {
    console.log(`[e2e-connector-sync] running sync for period ${PERIOD_MONTH}...`)
    const result = await service.runConnectorSync(baseUrl, USERNAME, PASSWORD, PERIOD_MONTH)
    console.log('  result:', JSON.stringify(result, null, 2))

    if (!result.results.every((r) => r.ok)) {
      throw new Error('one or more clients failed to sync')
    }

    const clients = await service.listClients()
    const client = clients.find((c) => c.code === 'E2ESYNC')
    if (!client) throw new Error('E2ESYNC client was not created by the sync')
    console.log(`[e2e-connector-sync] client created: ${client.code} (id ${client.clientId})`)

    const summary = await service.getMonthlySummary(client.clientId, '2026-07-01')
    if (!summary) throw new Error('monthly_summaries row was not written')
    console.log('[e2e-connector-sync] monthly_summaries row:', {
      source: summary.source,
      charges: summary.charges,
      openAr: summary.openAr
    })
    if (summary.source !== 'synced')
      throw new Error(`expected source=synced, got ${summary.source}`)
    if (summary.charges !== 8000) throw new Error(`expected charges=8000, got ${summary.charges}`)

    const report = await service.buildClientReport(client.clientId, PERIOD_MONTH)
    console.log('[e2e-connector-sync] ClientReport.source:', report.source)
    if (report.source !== 'synced') {
      throw new Error(`expected ClientReport.source=synced, got ${report.source}`)
    }

    console.log('\n[e2e-connector-sync] re-running the sync (idempotency check)...')
    const second = await service.runConnectorSync(baseUrl, USERNAME, PASSWORD, PERIOD_MONTH)
    if (!second.results.every((r) => r.ok) || second.results.some((r) => r.created)) {
      throw new Error('second sync should succeed with no newly-created clients')
    }
    const clientsAfter = await service.listClients()
    if (clientsAfter.filter((c) => c.code === 'E2ESYNC').length !== 1) {
      throw new Error('re-sync duplicated the client')
    }
    console.log('[e2e-connector-sync] idempotent: no duplicate client, no new "created" flag.')

    const status = await service.listConnectorSyncStatus()
    console.log('[e2e-connector-sync] sync status:', status)

    console.log('\n[e2e-connector-sync] all checks passed')
  } finally {
    service.close()
    rmSync(dir, { recursive: true, force: true })
    server.close()
  }
}

main().catch((error: unknown) => {
  console.error('[e2e-connector-sync] FAILED:', error)
  process.exitCode = 1
})

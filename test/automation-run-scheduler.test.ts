/**
 * Report scheduler + email delivery orchestration tests (plan §11, Phase
 * 2 chunk D) — `run-scheduler.ts` is the one automation module that
 * legitimately needs Electron (it calls `credentials.ts` to decrypt the
 * SMTP password, and its export path goes through `exporters/paths.ts`'s
 * `app.getPath('documents')`), so this file mocks just enough of the
 * `electron` module — `app.getPath`, a no-op `BrowserWindow` class (only
 * imported, never instantiated, by the xlsx-only formats these tests
 * use), and a `safeStorage` that reports encryption unavailable (the
 * same plaintext-fallback path `credentials.ts` already takes on a real
 * machine with no OS keyring) — to exercise the real code end to end
 * against a real `LocalDataService`, with no real SMTP network calls.
 */
import { join } from 'node:path'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronMock = vi.hoisted(() => ({ documentsDir: '' }))

// `exporters/report.ts` statically imports the pdf/pptx exporters too
// (even though these tests only use the `xlsx` format), which pull in
// `electron`'s `BrowserWindow`/`ipcMain` and, via `window-target.ts`,
// `@electron-toolkit/utils`'s `is` — mock both wholesale so Vite's
// CJS-named-export analysis never has to touch the real (non-Electron-
// runtime) `electron` package, which resolves to a plain path string.
vi.mock('electron', () => ({
  app: { getPath: (key: string) => (key === 'documents' ? electronMock.documentsDir : '') },
  BrowserWindow: class {},
  ipcMain: { handle: () => undefined, on: () => undefined },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}))

vi.mock('@electron-toolkit/utils', () => ({
  is: { dev: false },
  electronApp: {},
  optimizer: {}
}))

const { LocalDataService } = await import('../src/main/services/local-data-service')
const { dryRunRule, runOneRule, runSchedulerTick, sendReportPackNow } =
  await import('../src/main/automation/run-scheduler')
const { priorMonthPeriod } = await import('../src/main/automation/scheduler')

function ruleInput(overrides: Record<string, unknown> = {}): {
  name: string
  dayOfMonth: number
  clients: 'all' | string[]
  formats: Array<'pdf' | 'pptx' | 'xlsx'>
  deliver: 'none' | 'email'
  enabled: boolean
} {
  return {
    name: 'Monthly pack',
    dayOfMonth: 3,
    clients: 'all',
    formats: ['xlsx'],
    deliver: 'none',
    enabled: true,
    ...overrides
  }
}

describe('run-scheduler', () => {
  let dbDir: string
  let service: Awaited<ReturnType<typeof LocalDataService.create>>

  beforeEach(async () => {
    dbDir = mkdtempSync(join(tmpdir(), 'aethera-run-scheduler-'))
    electronMock.documentsDir = mkdtempSync(join(tmpdir(), 'aethera-run-scheduler-docs-'))
    service = await LocalDataService.create({
      duckdbPath: join(dbDir, 'analytics.duckdb'),
      metaDbPath: join(dbDir, 'meta.db'),
      backupsDir: join(dbDir, 'backups')
    })
  })

  afterEach(() => {
    service.close()
    rmSync(dbDir, { recursive: true, force: true })
    rmSync(electronMock.documentsDir, { recursive: true, force: true })
  })

  describe('runOneRule', () => {
    it('exports every active target client and records the run as ok', async () => {
      await service.createClient({ code: 'ALPHA', name: 'Alpha Health' })
      await service.createClient({ code: 'BETA', name: 'Beta Practice' })
      const rule = await service.saveAutomationRule(ruleInput())

      const logs: string[] = []
      await runOneRule(service, rule, '2026-05', (line) => logs.push(line))

      const rules = await service.listAutomationRules()
      const updated = rules.find((r) => r.ruleId === rule.ruleId)!
      expect(updated.lastRunPeriod).toBe('2026-05')
      expect(updated.lastRunStatus).toBe('ok')

      const jobs = await service.listExportAuditLog()
      expect(jobs.filter((j) => j.periodMonth === '2026-05')).toHaveLength(2)
    })

    it('queues the email instead of sending when SMTP is not configured, without failing the run', async () => {
      const client = await service.createClient({
        code: 'GAMMA',
        name: 'Gamma Clinic',
        reportRecipients: ['billing@gamma.example']
      })
      const rule = await service.saveAutomationRule(ruleInput({ deliver: 'email' }))

      const logs: string[] = []
      await runOneRule(service, rule, '2026-05', (line) => logs.push(line))

      const queue = await service.listEmailSendQueue()
      expect(queue).toHaveLength(1)
      expect(queue[0].clientCode).toBe(client.code)
      expect(queue[0].status).toBe('pending')
      expect(logs.some((l) => l.includes('SMTP is not configured'))).toBe(true)

      const rules = await service.listAutomationRules()
      // Exports still succeeded, so the rule run itself is "ok" even though delivery was only queued.
      expect(rules.find((r) => r.ruleId === rule.ruleId)!.lastRunStatus).toBe('ok')
    })

    it("isolates one client's delivery failure from the rest of the batch", async () => {
      await service.createClient({
        code: 'DELTA',
        name: 'Delta Clinic',
        reportRecipients: ['billing@delta.example']
      })
      await service.createClient({
        code: 'EPSILON',
        name: 'Epsilon Clinic',
        reportRecipients: ['billing@epsilon.example']
      })
      const rule = await service.saveAutomationRule(ruleInput({ deliver: 'email' }))

      // Wrap the real service so exactly one client's enqueue throws — a stand-in for an
      // unexpected per-client delivery failure (plan §11: "SMTP failures must never crash a batch").
      const flaky = new Proxy(service, {
        get(target, prop, receiver) {
          if (prop === 'enqueueEmailSend') {
            return async (entry: Parameters<typeof service.enqueueEmailSend>[0]) => {
              if (entry.clientCode === 'DELTA') throw new Error('simulated queue failure for DELTA')
              return service.enqueueEmailSend(entry)
            }
          }
          return Reflect.get(target, prop, receiver)
        }
      }) as typeof service

      const logs: string[] = []
      await runOneRule(flaky, rule, '2026-05', (line) => logs.push(line))

      expect(logs.some((l) => l.includes('DELTA') && l.includes('simulated queue failure'))).toBe(
        true
      )
      const queue = await service.listEmailSendQueue()
      expect(queue.map((q) => q.clientCode)).toEqual(['EPSILON']) // EPSILON still got through

      const rules = await service.listAutomationRules()
      // The export itself succeeded for both clients — one client's delivery blow-up
      // doesn't get recorded as an export failure for the whole rule.
      expect(rules.find((r) => r.ruleId === rule.ruleId)!.lastRunStatus).toBe('ok')
    })

    it('skips gracefully and records an error when no active client matches the rule', async () => {
      const rule = await service.saveAutomationRule(ruleInput({ clients: ['NOBODY'] }))
      await runOneRule(service, rule, '2026-05', () => undefined)
      const rules = await service.listAutomationRules()
      expect(rules.find((r) => r.ruleId === rule.ruleId)!.lastRunStatus).toBe('error')
    })
  })

  describe('runSchedulerTick', () => {
    it('runs a due rule once, then leaves it alone on a later tick for the same period (once-per-period)', async () => {
      await service.createClient({ code: 'ZETA', name: 'Zeta Health' })
      const rule = await service.saveAutomationRule(ruleInput({ dayOfMonth: 1 }))
      const findRule = async (): Promise<typeof rule> => {
        const rules = await service.listAutomationRules()
        return rules.find((r) => r.ruleId === rule.ruleId)!
      }

      const firstTick = new Date(Date.UTC(2026, 5, 15)) // June 15 -> due, generates for May
      await runSchedulerTick(service, firstTick)
      expect((await findRule()).lastRunPeriod).toBe(priorMonthPeriod(firstTick))
      const auditAfterFirst = await service.listExportAuditLog()

      // A later tick the same day (or any day still in June) must not re-run it.
      await runSchedulerTick(service, new Date(Date.UTC(2026, 5, 20)))
      expect((await findRule()).lastRunPeriod).toBe(priorMonthPeriod(firstTick)) // unchanged
      const auditAfterSecond = await service.listExportAuditLog()
      expect(auditAfterSecond.length).toBe(auditAfterFirst.length) // no new exports ran

      // Once July arrives, May's guard no longer applies — June becomes due.
      await runSchedulerTick(service, new Date(Date.UTC(2026, 6, 5)))
      expect((await findRule()).lastRunPeriod).toBe('2026-06')
    })

    it('retries a queued failed send and leaves it failed (fast connection-refused, no real network)', async () => {
      const client = await service.createClient({
        code: 'ETA',
        name: 'Eta Health',
        reportRecipients: ['billing@eta.example']
      })
      await service.enqueueEmailSend({
        clientCode: client.code,
        periodMonth: '2026-05',
        filePaths: [],
        recipients: client.reportRecipients,
        subject: 'Your report',
        body: 'Attached.'
      })

      // Port 1 on loopback refuses immediately — proves the retry path runs
      // end-to-end (settings -> transport -> sendMail -> markEmailSendResult)
      // without waiting out a real SMTP timeout.
      await service.saveEmailSettings({
        host: '127.0.0.1',
        port: 1,
        secure: false,
        username: null,
        fromAddress: 'reports@example.com',
        subjectTemplate: 'Your {client} report — {period}',
        bodyTemplate: 'Attached.'
      })

      await runSchedulerTick(service, new Date(Date.UTC(2026, 5, 1)))

      const queue = await service.listEmailSendQueue()
      expect(queue).toHaveLength(1)
      expect(queue[0].status).toBe('failed')
      expect(queue[0].attempts).toBe(1)
      expect(queue[0].lastError).toBeTruthy()
    }, 10000)

    it('leaves the send queue untouched when SMTP is still not configured', async () => {
      const client = await service.createClient({ code: 'THETA', name: 'Theta Health' })
      await service.enqueueEmailSend({
        clientCode: client.code,
        periodMonth: '2026-05',
        filePaths: [],
        recipients: ['billing@theta.example'],
        subject: 'Your report',
        body: 'Attached.'
      })

      await runSchedulerTick(service, new Date(Date.UTC(2026, 5, 1)))

      const queue = await service.listEmailSendQueue()
      expect(queue[0].status).toBe('pending')
      expect(queue[0].attempts).toBe(0)
    })
  })

  describe('dryRunRule', () => {
    it('previews clients/recipients/period without exporting or sending anything', async () => {
      await service.createClient({
        code: 'IOTA',
        name: 'Iota Health',
        reportRecipients: ['ops@iota.example']
      })
      const rule = await service.saveAutomationRule(ruleInput({ deliver: 'email' }))

      const preview = await dryRunRule(service, rule, new Date(Date.UTC(2026, 5, 15)))

      expect(preview.periodMonth).toBe('2026-05')
      expect(preview.clientCodes).toEqual(['IOTA'])
      expect(preview.wouldDeliverEmail).toBe(true)
      expect(preview.recipientsByClient.IOTA).toEqual(['ops@iota.example'])

      expect(await service.listExportAuditLog()).toHaveLength(0)
      expect(await service.listEmailSendQueue()).toHaveLength(0)
    })
  })

  describe('sendReportPackNow', () => {
    it('exports fresh files then queues delivery immediately (SMTP unconfigured)', async () => {
      const client = await service.createClient({
        code: 'KAPPA',
        name: 'Kappa Health',
        reportRecipients: ['ops@kappa.example']
      })

      const result = await sendReportPackNow(service, client.clientId, '2026-05', ['xlsx'])

      expect(result.clientCode).toBe('KAPPA')
      expect(result.ok).toBe(false)
      expect(result.queued).toBe(true)

      const queue = await service.listEmailSendQueue()
      expect(queue).toHaveLength(1)
      expect(queue[0].filePaths[0]).toMatch(/KAPPA.*\.xlsx$/)
      expect(readFileSync(queue[0].filePaths[0]).length).toBeGreaterThan(0)
    })

    it('reports a clean error for an unknown client id rather than throwing', async () => {
      const result = await sendReportPackNow(service, 999999, '2026-05', ['xlsx'])
      expect(result.ok).toBe(false)
      expect(result.queued).toBe(false)
      expect(result.error).toMatch(/not found/i)
    })
  })
})

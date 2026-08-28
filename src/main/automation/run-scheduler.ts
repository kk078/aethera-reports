/**
 * Report scheduler + email-delivery orchestration (plan §11). Ties
 * `scheduler.ts`'s pure due-logic to the actual work: exporting (reusing
 * `exporters/report.ts`'s per-client-multi-format path — exactly what
 * the CLI's `--generate` already calls, so a scheduled run and a manual
 * `--generate` invocation share one code path) and, for `deliver:
 * 'email'` rules, sending/queuing the generated files per client.
 *
 * This file (unlike `scheduler.ts`) is intentionally NOT required to be
 * Electron-free — it imports `credentials.ts` to decrypt the SMTP
 * password — but it lives under `src/main/automation/`, outside the
 * `no-restricted-imports` guard (`services/`/`importers/`/`kpi/`), so
 * that's allowed.
 */
import { basename } from 'node:path'
import { exportClientReportBatch } from '../exporters/batch'
import { exportClientReport } from '../exporters/report'
import { decryptCredential } from '../credentials'
import { createSmtpTransport, sendReportPack, renderTemplate, type SendResult } from './email'
import { selectDueRules, resolveRuleClientCodes, priorMonthPeriod } from './scheduler'
import type { IDataService } from '../services/data-service'
import type {
  AutomationRule,
  Client,
  DryRunResult,
  ExportFormat,
  ExportResult,
  SendReportPackResult
} from '../../shared/domain'

export type SchedulerLogger = (line: string) => void

interface ResolvedSmtp {
  transport: ReturnType<typeof createSmtpTransport>
  fromAddress: string
}

/** `null` when SMTP isn't configured yet — callers queue instead of sending. */
async function resolveSmtpTransport(dataService: IDataService): Promise<ResolvedSmtp | null> {
  const settings = await dataService.getEmailSettings()
  if (!settings.host || !settings.port || !settings.fromAddress) return null
  const secret = await dataService.getEncryptedEmailPassword()
  const password = secret ? decryptCredential(secret) : null
  return {
    transport: createSmtpTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      username: settings.username,
      password
    }),
    fromAddress: settings.fromAddress
  }
}

async function deliverOrQueue(
  dataService: IDataService,
  smtp: ResolvedSmtp | null,
  client: Client,
  periodMonth: string,
  successfulResults: ExportResult[]
): Promise<{ ok: boolean; error: string | null; queued: boolean }> {
  if (client.reportRecipients.length === 0 || successfulResults.length === 0) {
    return { ok: true, error: null, queued: false } // nothing to send — not a failure
  }
  const emailSettings = await dataService.getEmailSettings()
  const vars = { client: client.name, period: periodMonth }
  const subject = renderTemplate(emailSettings.subjectTemplate, vars)
  const body = renderTemplate(emailSettings.bodyTemplate, vars)
  const attachments = successfulResults
    .filter((r): r is ExportResult & { filePath: string } => r.filePath !== null)
    .map((r) => ({ filename: basename(r.filePath), path: r.filePath }))

  if (!smtp) {
    await dataService.enqueueEmailSend({
      clientCode: client.code,
      periodMonth,
      filePaths: attachments.map((a) => a.path),
      recipients: client.reportRecipients,
      subject,
      body
    })
    return { ok: false, error: 'SMTP is not configured — queued for later delivery.', queued: true }
  }

  let result: SendResult
  try {
    result = await sendReportPack(smtp.transport, {
      from: smtp.fromAddress,
      to: client.reportRecipients,
      subject,
      body,
      attachments
    })
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  if (result.ok) {
    dataService.recordExport({
      action: 'email_sent',
      clientCode: client.code,
      periodMonth,
      filePath: attachments[0]?.path ?? null
    })
    return { ok: true, error: null, queued: false }
  }

  await dataService.enqueueEmailSend({
    clientCode: client.code,
    periodMonth,
    filePaths: attachments.map((a) => a.path),
    recipients: client.reportRecipients,
    subject,
    body
  })
  return { ok: false, error: result.error, queued: true }
}

/** Runs one rule right now for a given period, regardless of due-ness — the Automation screen's "Run now" button and `runSchedulerTick`'s due-rule loop both call this. */
export async function runOneRule(
  dataService: IDataService,
  rule: AutomationRule,
  periodMonth: string,
  log: SchedulerLogger
): Promise<void> {
  const clients = await dataService.listClients()
  const activeCodes = clients.filter((c) => c.active).map((c) => c.code)
  const targetCodes = new Set(resolveRuleClientCodes(rule, activeCodes))
  const targetClients = clients.filter((c) => targetCodes.has(c.code))

  if (targetClients.length === 0) {
    log(`[scheduler] rule "${rule.name}": no matching active clients — skipping.`)
    await dataService.recordRuleRun(rule.ruleId, periodMonth, 'error')
    return
  }

  try {
    const results = await exportClientReportBatch(
      dataService,
      targetClients.map((c) => c.clientId),
      periodMonth,
      rule.formats
    )

    if (rule.deliver === 'email') {
      const smtp = await resolveSmtpTransport(dataService)
      for (const client of targetClients) {
        const successfulResults = results.filter(
          (r) => r.clientCode === client.code && r.error === null
        )
        try {
          const outcome = await deliverOrQueue(
            dataService,
            smtp,
            client,
            periodMonth,
            successfulResults
          )
          if (!outcome.ok) log(`[scheduler] ${client.code}: ${outcome.error}`)
        } catch (error) {
          // Per-client isolation for email, exactly like exports — one
          // client's SMTP failure never aborts the rest of the rule.
          log(
            `[scheduler] ${client.code}: email delivery threw — ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    }

    const anyExportFailed = results.some((r) => r.error !== null)
    await dataService.recordRuleRun(rule.ruleId, periodMonth, anyExportFailed ? 'error' : 'ok')
    log(`[scheduler] rule "${rule.name}" ran for ${periodMonth}: ${results.length} export(s).`)
  } catch (error) {
    await dataService.recordRuleRun(rule.ruleId, periodMonth, 'error')
    log(
      `[scheduler] rule "${rule.name}" FAILED: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

async function retryFailedEmailSends(
  dataService: IDataService,
  log: SchedulerLogger
): Promise<void> {
  const queue = await dataService.listEmailSendQueue()
  const pending = queue.filter((q) => q.status === 'pending' || q.status === 'failed')
  if (pending.length === 0) return

  const smtp = await resolveSmtpTransport(dataService)
  if (!smtp) return // still not configured — nothing to retry with yet

  for (const item of pending) {
    let result: SendResult
    try {
      result = await sendReportPack(smtp.transport, {
        from: smtp.fromAddress,
        to: item.recipients,
        subject: item.subject,
        body: item.body,
        attachments: item.filePaths.map((p) => ({ filename: basename(p), path: p }))
      })
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    await dataService.markEmailSendResult(item.queueId, result.ok, result.error)
    if (result.ok) {
      dataService.recordExport({
        action: 'email_sent',
        clientCode: item.clientCode,
        periodMonth: item.periodMonth,
        filePath: item.filePaths[0] ?? null
      })
      log(`[scheduler] retried send to ${item.clientCode} for ${item.periodMonth}: sent.`)
    } else {
      log(
        `[scheduler] retried send to ${item.clientCode} for ${item.periodMonth}: still failing — ${result.error}`
      )
    }
  }
}

/**
 * One scheduler "tick" — call on app launch (missed-run catch-up) and
 * periodically while the app stays open (plan §11: "runs while the app
 * is open at/after the scheduled time"). Retries queued failed sends
 * first, then runs any currently-due rules.
 */
export async function runSchedulerTick(
  dataService: IDataService,
  now: Date,
  log: SchedulerLogger = (): void => undefined
): Promise<void> {
  await retryFailedEmailSends(dataService, log)

  const rules = await dataService.listAutomationRules()
  const due = selectDueRules(rules, now)
  for (const { rule, periodMonth } of due) {
    await runOneRule(dataService, rule, periodMonth, log)
  }
}

/** Automation screen's dry-run button — previews what a rule WOULD do right now, without exporting or sending anything. */
export async function dryRunRule(
  dataService: IDataService,
  rule: AutomationRule,
  now: Date
): Promise<DryRunResult> {
  const periodMonth = priorMonthPeriod(now)
  const clients = await dataService.listClients()
  const activeCodes = clients.filter((c) => c.active).map((c) => c.code)
  const clientCodes = resolveRuleClientCodes(rule, activeCodes)
  const recipientsByClient: Record<string, string[]> = {}
  for (const code of clientCodes) {
    const client = clients.find((c) => c.code === code)
    if (client) recipientsByClient[code] = client.reportRecipients
  }
  return {
    ruleId: rule.ruleId,
    periodMonth,
    clientCodes,
    formats: rule.formats,
    wouldDeliverEmail: rule.deliver === 'email',
    recipientsByClient
  }
}

/** ClientDetail's manual "Send pack" action (plan §11) — exports fresh files for one client + period, then sends/queues immediately. */
export async function sendReportPackNow(
  dataService: IDataService,
  clientId: number,
  periodMonth: string,
  formats: ExportFormat[]
): Promise<SendReportPackResult> {
  const clients = await dataService.listClients()
  const client = clients.find((c) => c.clientId === clientId)
  if (!client)
    return { clientCode: `#${clientId}`, ok: false, error: 'Client not found', queued: false }

  const results = await exportClientReport(dataService, clientId, periodMonth, formats)
  const successfulResults = results.filter((r) => r.error === null)
  const smtp = await resolveSmtpTransport(dataService)
  const outcome = await deliverOrQueue(dataService, smtp, client, periodMonth, successfulResults)
  return { clientCode: client.code, ...outcome }
}

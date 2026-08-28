/**
 * "Publish to portal" orchestration (plan's Phase 3 addendum, chunk F).
 * Shared by `ipc/portal.ts` (ClientDetail's manual "Publish to portal"
 * button) and `run-scheduler.ts` (a rule with `deliver: 'portal'`) so
 * the publish-then-mint-then-email sequence can't drift between the two
 * call sites.
 *
 * Like `email.ts`, this module takes its SMTP transport and portal admin
 * token already resolved (decrypted) — it never touches
 * `safeStorage`/`credentials.ts` itself, so it stays testable with
 * nodemailer's JSON transport and a mock portal HTTP server, no real
 * network or Electron dependency required.
 */
import type { Transporter } from 'nodemailer'
import { renderTemplate, sendReportPack } from './email'
import { publishSnapshot, mintLink, type PortalConfig } from './portal-client'
import type { IDataService } from '../services/data-service'
import type { Client, PublishToPortalResult } from '../../shared/domain'

export interface ResolvedSmtpLike {
  transport: Transporter
  fromAddress: string
}

async function sendPortalLinkToRecipient(
  dataService: IDataService,
  smtp: ResolvedSmtpLike | null,
  client: Client,
  periodMonth: string,
  recipientEmail: string,
  linkUrl: string,
  expiresAt: string
): Promise<{ ok: boolean; error: string | null }> {
  const emailSettings = await dataService.getEmailSettings()
  const vars = { client: client.name, period: periodMonth }
  const subject = renderTemplate(emailSettings.subjectTemplate, vars)
  const expiresLabel = new Date(expiresAt).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })
  const body = `${renderTemplate(emailSettings.bodyTemplate, vars)}\n\nView it online: ${linkUrl}\n\nThis link expires on ${expiresLabel} and only works for you — please don't forward it.`

  if (!smtp) {
    await dataService.enqueueEmailSend({
      clientCode: client.code,
      periodMonth,
      filePaths: [],
      recipients: [recipientEmail],
      subject,
      body
    })
    return { ok: false, error: 'SMTP is not configured — queued for later delivery.' }
  }

  const result = await sendReportPack(smtp.transport, {
    from: smtp.fromAddress,
    to: [recipientEmail],
    subject,
    body,
    attachments: []
  }).catch((error: unknown) => ({
    ok: false as const,
    error: error instanceof Error ? error.message : String(error)
  }))

  if (result.ok) {
    dataService.recordExport({
      action: 'portal_link_sent',
      clientCode: client.code,
      periodMonth,
      filePath: null
    })
    return { ok: true, error: null }
  }

  await dataService.enqueueEmailSend({
    clientCode: client.code,
    periodMonth,
    filePaths: [],
    recipients: [recipientEmail],
    subject,
    body
  })
  return { ok: false, error: result.error }
}

/**
 * Publishes one client+period's report to the portal, then — unless
 * `sendLinks` is false or the client has no `report_recipients` — mints
 * one magic link per recipient (never one shared link for everyone) and
 * emails each recipient theirs. A per-client failure isolates cleanly:
 * the caller gets `{ ok: false, error }` back instead of a thrown
 * exception, exactly like the rest of the automation suite's per-client
 * isolation (plan §11).
 */
export async function publishClientToPortal(
  dataService: IDataService,
  portalConfig: PortalConfig,
  smtp: ResolvedSmtpLike | null,
  client: Client,
  periodMonth: string,
  sendLinks: boolean
): Promise<PublishToPortalResult> {
  let report
  try {
    report = await dataService.buildClientReport(client.clientId, periodMonth)
    await publishSnapshot(portalConfig, client.code, periodMonth, report)
  } catch (error) {
    return {
      clientCode: client.code,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      linksSent: []
    }
  }

  dataService.recordExport({
    action: 'portal_publish',
    clientCode: client.code,
    periodMonth,
    filePath: null
  })

  if (!sendLinks || client.reportRecipients.length === 0) {
    return { clientCode: client.code, ok: true, error: null, linksSent: [] }
  }

  const linksSent: Array<{ email: string; ok: boolean; error: string | null }> = []
  for (const email of client.reportRecipients) {
    try {
      const { url, expiresAt } = await mintLink(portalConfig, client.code, email)
      const outcome = await sendPortalLinkToRecipient(
        dataService,
        smtp,
        client,
        periodMonth,
        email,
        url,
        expiresAt
      )
      linksSent.push({ email, ok: outcome.ok, error: outcome.error })
    } catch (error) {
      linksSent.push({
        email,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return { clientCode: client.code, ok: true, error: null, linksSent }
}

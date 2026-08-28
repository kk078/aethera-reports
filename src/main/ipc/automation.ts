/**
 * IPC handlers for `automation:*` (plan §11, Phase 2 chunk D): watch-
 * folder settings + on-demand scan, report-scheduler rules (incl.
 * dry-run/run-now/Task-Scheduler-command), SMTP settings + send queue,
 * and the Automation screen's run history. Like `ipc/rcm-connector.ts`,
 * this is where SMTP password encryption happens — `LocalDataService`
 * only ever sees the opaque encrypted blob.
 */
import { ipcMain } from 'electron'
import { basename } from 'node:path'
import { parseIpcRequest, parseIpcResponse } from '../../shared/ipc-contract'
import { encryptCredential, decryptCredential } from '../credentials'
import { scanInboxOnce } from '../automation/watch-folder'
import { dryRunRule, runOneRule, sendReportPackNow } from '../automation/run-scheduler'
import { createSmtpTransport, sendReportPack } from '../automation/email'
import type { IDataService } from '../services/data-service'

export function registerAutomationHandlers(dataService: IDataService): void {
  // --- Watch-folder ---

  ipcMain.handle('automation:getInboxSettings', async (_event, rawPayload: unknown) => {
    parseIpcRequest('automation:getInboxSettings', rawPayload)
    const settings = await dataService.getAutomationInboxSettings()
    return parseIpcResponse('automation:getInboxSettings', settings)
  })

  ipcMain.handle('automation:setInboxRoot', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('automation:setInboxRoot', rawPayload)
    await dataService.setAutomationInboxRoot(request.inboxRoot)
    const settings = await dataService.getAutomationInboxSettings()
    return parseIpcResponse('automation:setInboxRoot', settings)
  })

  ipcMain.handle('automation:setFolderTemplatePin', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('automation:setFolderTemplatePin', rawPayload)
    await dataService.setFolderTemplatePin(request.clientCode, request.templateId)
    const settings = await dataService.getAutomationInboxSettings()
    return parseIpcResponse('automation:setFolderTemplatePin', settings)
  })

  ipcMain.handle('automation:scanInboxNow', async (_event, rawPayload: unknown) => {
    parseIpcRequest('automation:scanInboxNow', rawPayload)
    const settings = await dataService.getAutomationInboxSettings()
    if (!settings.inboxRoot) {
      return parseIpcResponse('automation:scanInboxNow', { processed: 0, failed: 0, results: [] })
    }
    const result = await scanInboxOnce(settings.inboxRoot, {
      dataService,
      getPinnedTemplateId: (code) => dataService.getPinnedTemplateId(code)
    })
    return parseIpcResponse('automation:scanInboxNow', result)
  })

  // --- Report scheduler ---

  ipcMain.handle('automation:listRules', async (_event, rawPayload: unknown) => {
    parseIpcRequest('automation:listRules', rawPayload)
    const rules = await dataService.listAutomationRules()
    return parseIpcResponse('automation:listRules', { rules })
  })

  ipcMain.handle('automation:saveRule', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('automation:saveRule', rawPayload)
    const rule = await dataService.saveAutomationRule(request)
    return parseIpcResponse('automation:saveRule', rule)
  })

  ipcMain.handle('automation:deleteRule', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('automation:deleteRule', rawPayload)
    await dataService.deleteAutomationRule(request.ruleId)
    return parseIpcResponse('automation:deleteRule', { ok: true })
  })

  ipcMain.handle('automation:dryRunRule', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('automation:dryRunRule', rawPayload)
    const rules = await dataService.listAutomationRules()
    const rule = rules.find((r) => r.ruleId === request.ruleId)
    if (!rule) throw new Error(`Unknown automation rule: ${request.ruleId}`)
    const result = await dryRunRule(dataService, rule, new Date())
    return parseIpcResponse('automation:dryRunRule', result)
  })

  ipcMain.handle('automation:runRuleNow', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('automation:runRuleNow', rawPayload)
    const rules = await dataService.listAutomationRules()
    const rule = rules.find((r) => r.ruleId === request.ruleId)
    if (!rule) throw new Error(`Unknown automation rule: ${request.ruleId}`)
    const periodMonth = new Date()
    const prior = new Date(Date.UTC(periodMonth.getUTCFullYear(), periodMonth.getUTCMonth() - 1, 1))
    const period = `${prior.getUTCFullYear()}-${String(prior.getUTCMonth() + 1).padStart(2, '0')}`
    const messages: string[] = []
    await runOneRule(dataService, rule, period, (line) => messages.push(line))
    return parseIpcResponse('automation:runRuleNow', {
      ok: !messages.some((m) => m.includes('FAILED')),
      message: messages.join(' | ') || `Ran "${rule.name}" for ${period}.`
    })
  })

  ipcMain.handle('automation:copyTaskSchedulerCommand', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('automation:copyTaskSchedulerCommand', rawPayload)
    const rules = await dataService.listAutomationRules()
    const rule = rules.find((r) => r.ruleId === request.ruleId)
    if (!rule) throw new Error(`Unknown automation rule: ${request.ruleId}`)
    const now = new Date()
    const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
    const clients = rule.clients === 'all' ? 'all' : rule.clients.join(',')
    const exeLine = `"C:\\Program Files\\Aethera Reports\\Aethera Reports.exe" --generate --period ${period} --clients ${clients} --formats ${rule.formats.join(',')}`
    const command =
      `schtasks /create /tn "Aethera Reports - ${rule.name}" ^\n` +
      `  /tr "${exeLine.replace(/"/g, '\\"')}" ^\n` +
      `  /sc monthly /d ${rule.dayOfMonth} /st 06:00`
    return parseIpcResponse('automation:copyTaskSchedulerCommand', { command })
  })

  // --- Email delivery ---

  ipcMain.handle('automation:getEmailSettings', async (_event, rawPayload: unknown) => {
    parseIpcRequest('automation:getEmailSettings', rawPayload)
    const settings = await dataService.getEmailSettings()
    return parseIpcResponse('automation:getEmailSettings', settings)
  })

  ipcMain.handle('automation:saveEmailSettings', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('automation:saveEmailSettings', rawPayload)
    const settings = await dataService.saveEmailSettings({
      host: request.host,
      port: request.port,
      secure: request.secure,
      username: request.username ?? null,
      fromAddress: request.fromAddress,
      subjectTemplate: request.subjectTemplate,
      bodyTemplate: request.bodyTemplate,
      encryptedPassword: request.password ? encryptCredential(request.password) : undefined
    })
    return parseIpcResponse('automation:saveEmailSettings', settings)
  })

  ipcMain.handle('automation:testEmailConnection', async (_event, rawPayload: unknown) => {
    parseIpcRequest('automation:testEmailConnection', rawPayload)
    const settings = await dataService.getEmailSettings()
    if (!settings.host || !settings.port) {
      return parseIpcResponse('automation:testEmailConnection', {
        ok: false,
        message: 'SMTP is not configured yet — set the host and port first.'
      })
    }
    try {
      const secret = await dataService.getEncryptedEmailPassword()
      const password = secret ? decryptCredential(secret) : null
      const transport = createSmtpTransport({
        host: settings.host,
        port: settings.port,
        secure: settings.secure,
        username: settings.username,
        password
      })
      await transport.verify()
      return parseIpcResponse('automation:testEmailConnection', {
        ok: true,
        message: 'Connected to the SMTP server successfully.'
      })
    } catch (error) {
      return parseIpcResponse('automation:testEmailConnection', {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  })

  ipcMain.handle('automation:listSendQueue', async (_event, rawPayload: unknown) => {
    parseIpcRequest('automation:listSendQueue', rawPayload)
    const rows = await dataService.listEmailSendQueue()
    return parseIpcResponse('automation:listSendQueue', { rows })
  })

  ipcMain.handle('automation:retrySend', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('automation:retrySend', rawPayload)
    const queue = await dataService.listEmailSendQueue()
    const item = queue.find((q) => q.queueId === request.queueId)
    if (!item) throw new Error(`Unknown queued send: ${request.queueId}`)

    const settings = await dataService.getEmailSettings()
    if (!settings.host || !settings.port || !settings.fromAddress) {
      return parseIpcResponse('automation:retrySend', {
        ok: false,
        error: 'SMTP is not configured yet.'
      })
    }
    const secret = await dataService.getEncryptedEmailPassword()
    const password = secret ? decryptCredential(secret) : null
    const transport = createSmtpTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      username: settings.username,
      password
    })
    const result = await sendReportPack(transport, {
      from: settings.fromAddress,
      to: item.recipients,
      subject: item.subject,
      body: item.body,
      attachments: item.filePaths.map((p) => ({ filename: basename(p), path: p }))
    })
    await dataService.markEmailSendResult(item.queueId, result.ok, result.error)
    return parseIpcResponse('automation:retrySend', { ok: result.ok, error: result.error })
  })

  ipcMain.handle('automation:sendReportPackNow', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('automation:sendReportPackNow', rawPayload)
    const result = await sendReportPackNow(
      dataService,
      request.clientId,
      request.periodMonth,
      request.formats
    )
    return parseIpcResponse('automation:sendReportPackNow', result)
  })

  // --- Run history ---

  ipcMain.handle('automation:listExportAuditLog', async (_event, rawPayload: unknown) => {
    parseIpcRequest('automation:listExportAuditLog', rawPayload)
    const rows = await dataService.listExportAuditLog()
    return parseIpcResponse('automation:listExportAuditLog', { rows })
  })
}

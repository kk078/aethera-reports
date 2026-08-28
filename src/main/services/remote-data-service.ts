/**
 * `RemoteDataService` (Phase 3 chunk E, plan's Phase 3 addendum) —
 * implements `IDataService` over HTTP against `server/`'s Fastify API,
 * so the exact same renderer/exporter/automation code that runs against
 * `LocalDataService` runs unmodified in "Data mode: Server" (Settings).
 *
 * Design notes:
 * - Every method (except the two below) is a thin wrapper: pack this
 *   method's positional args into the exact request shape
 *   `../../shared/rpc-contract.ts` declares for it, `POST
 *   /api/rpc/<methodName>`, unpack the response. That file is the single
 *   source of truth for those shapes — nothing here re-derives them, so
 *   a change there can never silently drift out of sync with what this
 *   file sends.
 * - `runCsvImport`/`runX12Import` are the one real exception: their
 *   `filePath` is a path on the DESKTOP machine, which the remote server
 *   process cannot read directly. Both instead read the file locally and
 *   `POST /api/import/upload` as multipart — the file-upload endpoint
 *   this chunk added specifically to make that possible.
 * - `detectImportFileKind`/`previewX12Import` are pure, local,
 *   read-the-file-and-sniff-it operations (mirroring
 *   `LocalDataService`'s own implementation) — deliberately NOT sent
 *   over the network. A CSV/XLSX/X12 mapping-wizard preview should never
 *   have to wait on a round trip (or fail outright when the server is
 *   briefly unreachable) just to tell the user what a file looks like
 *   before they've even decided to import it.
 * - `setBrandingLogoPath` has no server-side counterpart (plan's scope
 *   for this chunk: "PDF/PPTX/XLSX generation... stays desktop-side";
 *   the logo-picker's local-file-copy flow is the same kind of
 *   desktop-only concern) — it throws a clear, actionable error instead
 *   of silently no-op'ing.
 * - Every network call surfaces a clear, non-generic error message
 *   (can't-reach-the-server vs. the server's own JSON `{ error }` body)
 *   rather than letting a raw `fetch` `TypeError` bubble up to the UI.
 * - A 401 (expired/invalid token) triggers exactly one re-login-and-retry
 *   before giving up — the "token refresh on 401" behavior the plan
 *   calls for. There is no proactive refresh-before-expiry; the token's
 *   lifetime is short (server default 30m) specifically so an app left
 *   open overnight just re-logs-in transparently on its next call.
 */
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { detectCsvXlsxFile } from '../importers/csv-xlsx'
import { detectX12File, detectX12Kind } from '../importers/x12'
import { parse835 } from '../importers/x12/parse835'
import { parse837 } from '../importers/x12/parse837'
import { importJobSchema, x12ParseSummarySchema } from '../../shared/domain'
import type {
  ArAgingByClientRow,
  AutomationInboxSettings,
  AutomationRule,
  AutomationRuleInput,
  BackupStatus,
  Branding,
  BrandingInput,
  Client,
  ClientPatch,
  ClientReport,
  ConnectorSettings,
  ConnectorSyncResult,
  ConnectorSyncStatusRow,
  ConnectorTestResult,
  DaysInArTrendPoint,
  DenialListRow,
  EmailSendQueueRow,
  EmailSettings,
  ExportAuditLogRow,
  ImportFileKind,
  ImportJob,
  MappingTemplate,
  MonthlyRateTrendPoint,
  MonthlySummary,
  MonthlySummaryInput,
  NewClientInput,
  NewMappingTemplateInput,
  PayerAnalysisRow,
  PayerMixTrendPoint,
  PayerVsPatientSplit,
  PortalSettings,
  QuarantineRow,
  ReferenceApiCacheRefreshResult,
  ReferenceApiSettings,
  ReferenceApiSettingsInput,
  RunCsvImportInput,
  RunX12ImportInput,
  TopAgedClaimRow,
  X12ParseSummary
} from '../../shared/domain'
import type { RpcMethodName, RpcRequest, RpcResponse } from '../../shared/rpc-contract'
import type { IDataService, EncryptedSecretInput } from './data-service'

export interface RemoteDataServiceOptions {
  baseUrl: string
  username: string
  password: string
}

/** Thrown for every failure mode — unreachable server, a non-2xx response, or a 401 that survives one re-login retry — so callers can show a clean message instead of a raw `fetch`/`TypeError`. */
export class RemoteDataServiceError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number
  ) {
    super(message)
    this.name = 'RemoteDataServiceError'
  }
}

interface ErrorResponseBody {
  error?: string
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as ErrorResponseBody
    return body.error ?? fallback
  } catch {
    return fallback
  }
}

/** Connectivity/auth probe for Settings' "Test connection" button — logs in and discards the token, reporting a clean ok/message pair either way (never throws). */
export async function testRemoteConnection(
  options: RemoteDataServiceOptions
): Promise<ConnectorTestResult> {
  try {
    const service = new RemoteDataService(options)
    await service.login()
    return { ok: true, message: `Connected to ${options.baseUrl} as "${options.username}".` }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

export class RemoteDataService implements IDataService {
  private readonly baseUrl: string
  private readonly username: string
  private readonly password: string
  private token: string | null = null

  constructor(options: RemoteDataServiceOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.username = options.username
    this.password = options.password
  }

  /** Exposed (not `private`) only so `testRemoteConnection` can drive it directly without duplicating the login flow. */
  async login(): Promise<void> {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: this.username, password: this.password })
      })
    } catch (error) {
      throw new RemoteDataServiceError(
        `Could not reach the server at ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    if (!response.ok) {
      throw new RemoteDataServiceError(
        await readErrorMessage(response, `Login failed (HTTP ${response.status}).`),
        response.status
      )
    }
    const body = (await response.json()) as { token: string }
    this.token = body.token
  }

  private async fetchJson(path: string, payload: unknown): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
        },
        body: JSON.stringify(payload)
      })
    } catch (error) {
      throw new RemoteDataServiceError(
        `Could not reach the server at ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /** The one generic entry point every `IDataService` method (bar the three noted in the module doc) funnels through. */
  private async callRpc<M extends RpcMethodName>(
    method: M,
    req: RpcRequest<M>
  ): Promise<RpcResponse<M>> {
    if (!this.token) await this.login()

    let response = await this.fetchJson(`/api/rpc/${method}`, req)
    if (response.status === 401) {
      await this.login() // token refresh on 401 (plan: "token refresh on 401")
      response = await this.fetchJson(`/api/rpc/${method}`, req)
    }
    if (!response.ok) {
      throw new RemoteDataServiceError(
        await readErrorMessage(
          response,
          `Server request "${method}" failed (HTTP ${response.status}).`
        ),
        response.status
      )
    }
    return (await response.json()) as RpcResponse<M>
  }

  private async uploadImport(
    filePath: string,
    clientCode: string,
    templateId?: string
  ): Promise<ImportJob> {
    if (!this.token) await this.login()

    const attempt = async (): Promise<Response> => {
      const fileBuffer = await readFile(filePath)
      const form = new FormData()
      form.append('clientCode', clientCode)
      if (templateId) form.append('templateId', templateId)
      form.append('file', new Blob([new Uint8Array(fileBuffer)]), basename(filePath))
      try {
        return await fetch(`${this.baseUrl}/api/import/upload`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.token}` },
          body: form
        })
      } catch (error) {
        throw new RemoteDataServiceError(
          `Could not reach the server at ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }

    let response = await attempt()
    if (response.status === 401) {
      await this.login()
      response = await attempt()
    }
    if (!response.ok) {
      throw new RemoteDataServiceError(
        await readErrorMessage(response, `Upload import failed (HTTP ${response.status}).`),
        response.status
      )
    }
    const body = (await response.json()) as { job: ImportJob }
    return importJobSchema.parse(body.job)
  }

  // -------------------------------------------------------------------
  // Clients
  // -------------------------------------------------------------------
  async listClients(): Promise<Client[]> {
    return (await this.callRpc('listClients', {})).clients
  }
  async getClientByCode(code: string): Promise<Client | null> {
    return (await this.callRpc('getClientByCode', { code })).client
  }
  async createClient(input: NewClientInput): Promise<Client> {
    return this.callRpc('createClient', input)
  }
  async updateClient(clientId: number, patch: ClientPatch): Promise<Client> {
    return this.callRpc('updateClient', { clientId, patch })
  }
  async deactivateClient(clientId: number): Promise<Client> {
    return this.callRpc('deactivateClient', { clientId })
  }

  // -------------------------------------------------------------------
  // Mapping templates
  // -------------------------------------------------------------------
  async listMappingTemplates(): Promise<MappingTemplate[]> {
    return (await this.callRpc('listMappingTemplates', {})).templates
  }
  async getMappingTemplate(templateId: string): Promise<MappingTemplate | null> {
    return (await this.callRpc('getMappingTemplate', { templateId })).template
  }
  async saveMappingTemplate(input: NewMappingTemplateInput): Promise<MappingTemplate> {
    return this.callRpc('saveMappingTemplate', input)
  }
  async exportMappingTemplate(templateId: string): Promise<string> {
    return (await this.callRpc('exportMappingTemplate', { templateId })).templateJson
  }
  async importMappingTemplate(templateJson: string): Promise<MappingTemplate> {
    return this.callRpc('importMappingTemplate', { templateJson })
  }

  // -------------------------------------------------------------------
  // Imports
  // -------------------------------------------------------------------
  async listImportJobs(): Promise<ImportJob[]> {
    return (await this.callRpc('listImportJobs', {})).jobs
  }
  async getImportJob(jobId: number): Promise<ImportJob | null> {
    return (await this.callRpc('getImportJob', { jobId })).job
  }
  async runCsvImport(input: RunCsvImportInput): Promise<ImportJob> {
    return this.uploadImport(input.filePath, input.clientCode, input.templateId)
  }
  async listQuarantineRows(jobId: number): Promise<QuarantineRow[]> {
    return (await this.callRpc('listQuarantineRows', { jobId })).rows
  }

  // -------------------------------------------------------------------
  // X12 835/837 — local sniff/parse, never sent over the network (see
  // module doc); `runX12Import` still uploads, same as CSV/XLSX.
  // -------------------------------------------------------------------
  async detectImportFileKind(filePath: string): Promise<ImportFileKind> {
    if (detectCsvXlsxFile(filePath)) {
      return extname(filePath).toLowerCase() === '.csv' ? 'csv' : 'xlsx'
    }
    const x12Kind = await detectX12File(filePath)
    if (x12Kind === '835') return 'x12-835'
    if (x12Kind === '837') return 'x12-837'
    return 'unknown'
  }
  async previewX12Import(filePath: string): Promise<X12ParseSummary> {
    const content = await readFile(filePath, 'utf-8')
    const kind = detectX12Kind(content)
    if (!kind) {
      throw new Error(`"${filePath}" does not look like a recognizable X12 835 or 837 file.`)
    }
    if (kind === '835') {
      const remit = parse835(content)
      const lineCount = remit.claims.reduce((sum, claim) => sum + claim.serviceLines.length, 0)
      const adjustmentCount = remit.claims.reduce(
        (sum, claim) =>
          sum +
          claim.claimAdjustments.length +
          claim.serviceLines.reduce((lineSum, line) => lineSum + line.adjustments.length, 0),
        0
      )
      return x12ParseSummarySchema.parse({
        kind,
        claimsCount: remit.claims.length,
        lineCount,
        adjustmentCount,
        totalPaymentAmount: remit.paymentAmount,
        warnings: remit.warnings
      })
    }
    const parsed = parse837(content)
    const parsedLineCount = parsed.claims.reduce((sum, claim) => sum + claim.serviceLines.length, 0)
    return x12ParseSummarySchema.parse({
      kind,
      claimsCount: parsed.claims.length,
      lineCount: parsedLineCount,
      adjustmentCount: 0,
      totalPaymentAmount: null,
      warnings: parsed.warnings
    })
  }
  async runX12Import(input: RunX12ImportInput): Promise<ImportJob> {
    return this.uploadImport(input.filePath, input.clientCode)
  }

  // -------------------------------------------------------------------
  // Manual entry
  // -------------------------------------------------------------------
  async upsertMonthlySummary(input: MonthlySummaryInput): Promise<MonthlySummary> {
    return this.callRpc('upsertMonthlySummary', input)
  }
  async getMonthlySummary(clientId: number, periodMonth: string): Promise<MonthlySummary | null> {
    return (await this.callRpc('getMonthlySummary', { clientId, periodMonth })).summary
  }

  // -------------------------------------------------------------------
  // Denials / A/R / Payers analytics
  // -------------------------------------------------------------------
  async listDenials(clientId: number | null, periodMonth: string): Promise<DenialListRow[]> {
    return (await this.callRpc('listDenials', { clientId, periodMonth })).rows
  }
  async getDenialRateTrend(
    clientId: number | null,
    endPeriodMonth: string,
    monthsBack?: number
  ): Promise<MonthlyRateTrendPoint[]> {
    return (await this.callRpc('getDenialRateTrend', { clientId, endPeriodMonth, monthsBack }))
      .points
  }
  async getArAgingByClient(): Promise<ArAgingByClientRow[]> {
    return (await this.callRpc('getArAgingByClient', {})).rows
  }
  async getArPayerVsPatientSplit(clientId: number | null): Promise<PayerVsPatientSplit> {
    return this.callRpc('getArPayerVsPatientSplit', { clientId })
  }
  async getTopAgedClaims(clientId: number | null, limit?: number): Promise<TopAgedClaimRow[]> {
    return (await this.callRpc('getTopAgedClaims', { clientId, limit })).rows
  }
  async getDaysInArTrend(
    clientId: number | null,
    endPeriodMonth: string,
    monthsBack?: number
  ): Promise<DaysInArTrendPoint[]> {
    return (await this.callRpc('getDaysInArTrend', { clientId, endPeriodMonth, monthsBack })).points
  }
  async getPayerAnalysis(
    clientId: number | null,
    periodMonth: string
  ): Promise<PayerAnalysisRow[]> {
    return (await this.callRpc('getPayerAnalysis', { clientId, periodMonth })).rows
  }
  async getPayerMixTrend(
    clientId: number | null,
    endPeriodMonth: string,
    monthsBack?: number
  ): Promise<PayerMixTrendPoint[]> {
    return (await this.callRpc('getPayerMixTrend', { clientId, endPeriodMonth, monthsBack })).points
  }

  // -------------------------------------------------------------------
  // Generic RCM Platform REST connector
  // -------------------------------------------------------------------
  async getConnectorSettings(): Promise<ConnectorSettings> {
    return this.callRpc('getConnectorSettings', {})
  }
  async saveConnectorSettings(input: {
    baseUrl: string
    username: string
    enabled: boolean
    syncClaimLevel: boolean
    encryptedPassword?: EncryptedSecretInput
  }): Promise<ConnectorSettings> {
    return this.callRpc('saveConnectorSettings', input)
  }
  async getEncryptedConnectorPassword(): Promise<EncryptedSecretInput | null> {
    return (await this.callRpc('getEncryptedConnectorPassword', {})).secret
  }
  async testConnectorConnection(
    baseUrl: string,
    username: string,
    password: string
  ): Promise<ConnectorTestResult> {
    return this.callRpc('testConnectorConnection', { baseUrl, username, password })
  }
  async runConnectorSync(
    baseUrl: string,
    username: string,
    password: string,
    periodMonth: string
  ): Promise<ConnectorSyncResult> {
    return this.callRpc('runConnectorSync', { baseUrl, username, password, periodMonth })
  }
  async listConnectorSyncStatus(): Promise<ConnectorSyncStatusRow[]> {
    return (await this.callRpc('listConnectorSyncStatus', {})).rows
  }

  // -------------------------------------------------------------------
  // Reference & Benchmark API connector
  // -------------------------------------------------------------------
  async getReferenceApiSettings(): Promise<ReferenceApiSettings> {
    return this.callRpc('getReferenceApiSettings', {})
  }
  async saveReferenceApiSettings(input: ReferenceApiSettingsInput): Promise<ReferenceApiSettings> {
    return this.callRpc('saveReferenceApiSettings', input)
  }
  async testReferenceApiConnection(): Promise<ConnectorTestResult> {
    return this.callRpc('testReferenceApiConnection', {})
  }
  async refreshReferenceApiCache(): Promise<ReferenceApiCacheRefreshResult> {
    return this.callRpc('refreshReferenceApiCache', {})
  }
  async getCarcDescriptions(codes: string[]): Promise<Record<string, string>> {
    return (await this.callRpc('getCarcDescriptions', { codes })).descriptions
  }

  // -------------------------------------------------------------------
  // Watch-folder automation
  // -------------------------------------------------------------------
  async getAutomationInboxSettings(): Promise<AutomationInboxSettings> {
    return this.callRpc('getAutomationInboxSettings', {})
  }
  async setAutomationInboxRoot(inboxRoot: string | null): Promise<void> {
    await this.callRpc('setAutomationInboxRoot', { inboxRoot })
  }
  async setFolderTemplatePin(clientCode: string, templateId: string | null): Promise<void> {
    await this.callRpc('setFolderTemplatePin', { clientCode, templateId })
  }
  async getPinnedTemplateId(clientCode: string): Promise<string | null> {
    return (await this.callRpc('getPinnedTemplateId', { clientCode })).templateId
  }

  // -------------------------------------------------------------------
  // Report scheduler
  // -------------------------------------------------------------------
  async listAutomationRules(): Promise<AutomationRule[]> {
    return (await this.callRpc('listAutomationRules', {})).rules
  }
  async saveAutomationRule(input: AutomationRuleInput): Promise<AutomationRule> {
    return this.callRpc('saveAutomationRule', input)
  }
  async deleteAutomationRule(ruleId: string): Promise<void> {
    await this.callRpc('deleteAutomationRule', { ruleId })
  }
  async recordRuleRun(ruleId: string, periodMonth: string, status: 'ok' | 'error'): Promise<void> {
    await this.callRpc('recordRuleRun', { ruleId, periodMonth, status })
  }

  // -------------------------------------------------------------------
  // Email delivery
  // -------------------------------------------------------------------
  async getEmailSettings(): Promise<EmailSettings> {
    return this.callRpc('getEmailSettings', {})
  }
  async saveEmailSettings(input: {
    host: string
    port: number
    secure: boolean
    username: string | null
    fromAddress: string
    subjectTemplate: string
    bodyTemplate: string
    encryptedPassword?: EncryptedSecretInput
  }): Promise<EmailSettings> {
    return this.callRpc('saveEmailSettings', input)
  }
  async getEncryptedEmailPassword(): Promise<EncryptedSecretInput | null> {
    return (await this.callRpc('getEncryptedEmailPassword', {})).secret
  }
  async enqueueEmailSend(entry: {
    clientCode: string
    periodMonth: string
    filePaths: string[]
    recipients: string[]
    subject: string
    body: string
  }): Promise<number> {
    return (await this.callRpc('enqueueEmailSend', entry)).queueId
  }
  async listEmailSendQueue(): Promise<EmailSendQueueRow[]> {
    return (await this.callRpc('listEmailSendQueue', {})).rows
  }
  async markEmailSendResult(queueId: number, ok: boolean, error: string | null): Promise<void> {
    await this.callRpc('markEmailSendResult', { queueId, ok, error })
  }
  async listExportAuditLog(limit?: number): Promise<ExportAuditLogRow[]> {
    return (await this.callRpc('listExportAuditLog', { limit })).rows
  }

  // -------------------------------------------------------------------
  // Hosted client portal
  // -------------------------------------------------------------------
  async getPortalSettings(): Promise<PortalSettings> {
    return this.callRpc('getPortalSettings', {})
  }
  async savePortalSettings(input: {
    baseUrl: string
    encryptedAdminToken?: EncryptedSecretInput
  }): Promise<PortalSettings> {
    return this.callRpc('savePortalSettings', input)
  }
  async getEncryptedPortalAdminToken(): Promise<EncryptedSecretInput | null> {
    return (await this.callRpc('getEncryptedPortalAdminToken', {})).secret
  }

  // -------------------------------------------------------------------
  // KPI engine / reports
  // -------------------------------------------------------------------
  async buildClientReport(clientId: number, periodMonth: string): Promise<ClientReport> {
    return this.callRpc('buildClientReport', { clientId, periodMonth })
  }
  async listClientReportsForPeriod(periodMonth: string): Promise<ClientReport[]> {
    return (await this.callRpc('listClientReportsForPeriod', { periodMonth })).reports
  }
  async getClientFinancialTrend(
    clientId: number,
    endPeriodMonth: string,
    monthsBack?: number
  ): Promise<Array<{ month: string; grossCharges: number; totalCollections: number }>> {
    return (await this.callRpc('getClientFinancialTrend', { clientId, endPeriodMonth, monthsBack }))
      .points
  }

  // -------------------------------------------------------------------
  // Branding
  // -------------------------------------------------------------------
  async getBranding(): Promise<Branding> {
    return this.callRpc('getBranding', {})
  }
  async updateBranding(input: BrandingInput): Promise<Branding> {
    return this.callRpc('updateBranding', input)
  }
  async setBrandingLogoPath(): Promise<Branding> {
    // No server-side counterpart in this chunk — see the module doc.
    throw new RemoteDataServiceError(
      'Changing the branding logo is only available in Local data mode for now — switch to Local, update the logo, then switch back to Server.'
    )
  }

  // -------------------------------------------------------------------
  // Export audit log
  // -------------------------------------------------------------------
  recordExport(entry: {
    action: string
    clientCode: string | null
    periodMonth: string | null
    filePath: string | null
  }): void {
    // Fire-and-forget: `IDataService.recordExport` is synchronous
    // (`LocalDataService`'s is a plain SQLite insert), but an HTTP call
    // inherently isn't — losing one audit-log row to a transient network
    // blip is an acceptable trade against making every export wait on
    // (or fail because of) this bookkeeping call.
    this.callRpc('recordExport', entry).catch((error: unknown) => {
      console.error(
        '[RemoteDataService] recordExport failed — this export will be missing from the audit log:',
        error
      )
    })
  }

  // -------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------
  async getBackupStatus(): Promise<BackupStatus> {
    return this.callRpc('getBackupStatus', {})
  }
  async runBackupNow(): Promise<BackupStatus> {
    return this.callRpc('runBackupNow', {})
  }
  async restoreLatestBackup(): Promise<{ restoredFrom: string }> {
    return this.callRpc('restoreLatestBackup', {})
  }

  close(): void {
    this.token = null
  }
}

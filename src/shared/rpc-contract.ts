/**
 * The shared server's HTTP RPC contract (Phase 3 chunk E, plan's Phase 3
 * design addendum): "one contract, three transports: IPC, HTTP, future."
 *
 * Where `ipc-contract.ts` is keyed by UI-facing IPC *channel* name (one
 * layer above `IDataService` — e.g. `connector:saveSettings` still
 * carries a plaintext password, which the IPC handler encrypts before
 * ever calling into `IDataService`), this file is keyed by the exact
 * `IDataService` *method* name and matches its real TS signature
 * one-for-one. `server/src/rpc-route.ts` registers a single
 * `POST /api/rpc/:method` Fastify route that looks a method up in
 * `rpcContract`, validates the body against `.request`, calls
 * `.invoke(dataService, body)`, validates the result against
 * `.response`, and returns it — so adding a new server-exposed method is
 * "add one entry here," never "write a new route handler."
 *
 * Every schema here is either imported straight from `domain.ts` (the
 * same objects `ipc-contract.ts` imports — the actual "one source of
 * truth, no drift" mechanism: both files build their maps out of the
 * same shared schema objects rather than two independently-typed inline
 * copies) or, where the `IDataService` method's real argument shape has
 * no IPC-channel equivalent (most visibly: the connector/email methods
 * that take an already-decrypted password or an already-encrypted
 * `EncryptedSecretInput` blob, which only exist at this exact layer),
 * defined locally in this file.
 *
 * Scope: every `IDataService` method except `close()` (process lifecycle,
 * not remotely meaningful) and `setBrandingLogoPath()` (ties a resolved
 * local file path to a value the desktop's file-picker + userData-copy
 * step produced — out of scope for this chunk's file-upload endpoint,
 * which only covers CSV/XLSX/X12 import). PDF/PPTX/XLSX generation isn't
 * on `IDataService` at all — exports stay desktop-side (plan's Phase 3
 * addendum: "they need Electron rendering; they just read remote data").
 */
import { z } from 'zod'
import {
  analyticsScopeInputSchema,
  analyticsTrendInputSchema,
  arAgingByClientRowSchema,
  automationInboxSettingsSchema,
  automationRuleInputSchema,
  automationRuleSchema,
  backupStatusSchema,
  brandingInputSchema,
  brandingSchema,
  buildClientReportInputSchema,
  clientIdRequestSchema,
  clientPatchSchema,
  clientReportSchema,
  clientSchema,
  clientTrendInputSchema,
  connectorSettingsSchema,
  connectorSyncResultSchema,
  connectorSyncStatusRowSchema,
  connectorTestResultSchema,
  daysInArTrendPointSchema,
  denialListRowSchema,
  emailSendQueueRowSchema,
  emailSettingsSchema,
  emptyRequestSchema,
  encryptedSecretInputSchema,
  exportAuditLogRowSchema,
  filePathRequestSchema,
  financialTrendPointSchema,
  getMonthlySummaryInputSchema,
  importFileKindSchema,
  importJobSchema,
  jobIdRequestSchema,
  listDenialsInputSchema,
  mappingTemplateSchema,
  monthlyRateTrendPointSchema,
  monthlySummaryInputSchema,
  monthlySummarySchema,
  newClientInputSchema,
  newMappingTemplateInputSchema,
  payerAnalysisRowSchema,
  payerMixTrendPointSchema,
  payerVsPatientSplitSchema,
  quarantineRowSchema,
  referenceApiCacheRefreshResultSchema,
  referenceApiSettingsInputSchema,
  referenceApiSettingsSchema,
  runCsvImportInputSchema,
  runX12ImportInputSchema,
  templateIdRequestSchema,
  topAgedClaimRowSchema,
  x12ParseSummarySchema
} from './domain'
import type { IDataService, EncryptedSecretInput } from '../main/services/data-service'

/** `EncryptedSecretInput | null` on the wire — the server never decrypts these itself, only stores/returns the opaque blob (see the module doc). */
const optionalEncryptedSecretSchema = encryptedSecretInputSchema.nullable()

interface RpcMethodDef<Req, Res> {
  request: z.ZodType<Req>
  response: z.ZodType<Res>
  invoke: (dataService: IDataService, req: Req) => Promise<Res>
}

function defineMethod<Req, Res>(def: RpcMethodDef<Req, Res>): RpcMethodDef<Req, Res> {
  return def
}

const periodMonthRequestSchema = z.object({
  periodMonth: z.string().regex(/^\d{4}-\d{2}$/)
})

export const rpcContract = {
  // --- Clients ---
  listClients: defineMethod({
    request: emptyRequestSchema,
    response: z.object({ clients: z.array(clientSchema) }),
    invoke: async (ds) => ({ clients: await ds.listClients() })
  }),
  getClientByCode: defineMethod({
    request: z.object({ code: z.string().min(1) }),
    response: z.object({ client: clientSchema.nullable() }),
    invoke: async (ds, req) => ({ client: await ds.getClientByCode(req.code) })
  }),
  createClient: defineMethod({
    request: newClientInputSchema,
    response: clientSchema,
    invoke: (ds, req) => ds.createClient(req)
  }),
  updateClient: defineMethod({
    request: clientIdRequestSchema.extend({ patch: clientPatchSchema }),
    response: clientSchema,
    invoke: (ds, req) => ds.updateClient(req.clientId, req.patch)
  }),
  deactivateClient: defineMethod({
    request: clientIdRequestSchema,
    response: clientSchema,
    invoke: (ds, req) => ds.deactivateClient(req.clientId)
  }),

  // --- Mapping templates ---
  listMappingTemplates: defineMethod({
    request: emptyRequestSchema,
    response: z.object({ templates: z.array(mappingTemplateSchema) }),
    invoke: async (ds) => ({ templates: await ds.listMappingTemplates() })
  }),
  getMappingTemplate: defineMethod({
    request: templateIdRequestSchema,
    response: z.object({ template: mappingTemplateSchema.nullable() }),
    invoke: async (ds, req) => ({ template: await ds.getMappingTemplate(req.templateId) })
  }),
  saveMappingTemplate: defineMethod({
    request: newMappingTemplateInputSchema,
    response: mappingTemplateSchema,
    invoke: (ds, req) => ds.saveMappingTemplate(req)
  }),
  exportMappingTemplate: defineMethod({
    request: templateIdRequestSchema,
    response: z.object({ templateJson: z.string() }),
    invoke: async (ds, req) => ({ templateJson: await ds.exportMappingTemplate(req.templateId) })
  }),
  importMappingTemplate: defineMethod({
    request: z.object({ templateJson: z.string().min(1) }),
    response: mappingTemplateSchema,
    invoke: (ds, req) => ds.importMappingTemplate(req.templateJson)
  }),

  // --- Imports ---
  listImportJobs: defineMethod({
    request: emptyRequestSchema,
    response: z.object({ jobs: z.array(importJobSchema) }),
    invoke: async (ds) => ({ jobs: await ds.listImportJobs() })
  }),
  getImportJob: defineMethod({
    request: jobIdRequestSchema,
    response: z.object({ job: importJobSchema.nullable() }),
    invoke: async (ds, req) => ({ job: await ds.getImportJob(req.jobId) })
  }),
  runCsvImport: defineMethod({
    request: runCsvImportInputSchema,
    response: importJobSchema,
    invoke: (ds, req) => ds.runCsvImport(req)
  }),
  listQuarantineRows: defineMethod({
    request: jobIdRequestSchema,
    response: z.object({ rows: z.array(quarantineRowSchema) }),
    invoke: async (ds, req) => ({ rows: await ds.listQuarantineRows(req.jobId) })
  }),

  // --- X12 835/837 ---
  detectImportFileKind: defineMethod({
    request: filePathRequestSchema,
    response: z.object({ kind: importFileKindSchema }),
    invoke: async (ds, req) => ({ kind: await ds.detectImportFileKind(req.filePath) })
  }),
  previewX12Import: defineMethod({
    request: filePathRequestSchema,
    response: z.object({ summary: x12ParseSummarySchema }),
    invoke: async (ds, req) => ({ summary: await ds.previewX12Import(req.filePath) })
  }),
  runX12Import: defineMethod({
    request: runX12ImportInputSchema,
    response: importJobSchema,
    invoke: (ds, req) => ds.runX12Import(req)
  }),

  // --- Manual entry ---
  upsertMonthlySummary: defineMethod({
    request: monthlySummaryInputSchema,
    response: monthlySummarySchema,
    invoke: (ds, req) => ds.upsertMonthlySummary(req)
  }),
  getMonthlySummary: defineMethod({
    request: getMonthlySummaryInputSchema,
    response: z.object({ summary: monthlySummarySchema.nullable() }),
    invoke: async (ds, req) => ({
      summary: await ds.getMonthlySummary(req.clientId, req.periodMonth)
    })
  }),

  // --- Denials / A/R / Payers analytics ---
  listDenials: defineMethod({
    request: listDenialsInputSchema,
    response: z.object({ rows: z.array(denialListRowSchema) }),
    invoke: async (ds, req) => ({ rows: await ds.listDenials(req.clientId, req.periodMonth) })
  }),
  getDenialRateTrend: defineMethod({
    request: analyticsTrendInputSchema,
    response: z.object({ points: z.array(monthlyRateTrendPointSchema) }),
    invoke: async (ds, req) => ({
      points: await ds.getDenialRateTrend(req.clientId, req.endPeriodMonth, req.monthsBack)
    })
  }),
  getArAgingByClient: defineMethod({
    request: emptyRequestSchema,
    response: z.object({ rows: z.array(arAgingByClientRowSchema) }),
    invoke: async (ds) => ({ rows: await ds.getArAgingByClient() })
  }),
  getArPayerVsPatientSplit: defineMethod({
    request: z.object({ clientId: z.number().int().positive().nullable() }),
    response: payerVsPatientSplitSchema,
    invoke: (ds, req) => ds.getArPayerVsPatientSplit(req.clientId)
  }),
  getTopAgedClaims: defineMethod({
    request: z.object({
      clientId: z.number().int().positive().nullable(),
      limit: z.number().int().positive().max(200).optional()
    }),
    response: z.object({ rows: z.array(topAgedClaimRowSchema) }),
    invoke: async (ds, req) => ({ rows: await ds.getTopAgedClaims(req.clientId, req.limit) })
  }),
  getDaysInArTrend: defineMethod({
    request: analyticsTrendInputSchema,
    response: z.object({ points: z.array(daysInArTrendPointSchema) }),
    invoke: async (ds, req) => ({
      points: await ds.getDaysInArTrend(req.clientId, req.endPeriodMonth, req.monthsBack)
    })
  }),
  getPayerAnalysis: defineMethod({
    request: analyticsScopeInputSchema,
    response: z.object({ rows: z.array(payerAnalysisRowSchema) }),
    invoke: async (ds, req) => ({ rows: await ds.getPayerAnalysis(req.clientId, req.periodMonth) })
  }),
  getPayerMixTrend: defineMethod({
    request: analyticsTrendInputSchema,
    response: z.object({ points: z.array(payerMixTrendPointSchema) }),
    invoke: async (ds, req) => ({
      points: await ds.getPayerMixTrend(req.clientId, req.endPeriodMonth, req.monthsBack)
    })
  }),

  // --- Generic RCM Platform REST connector ---
  getConnectorSettings: defineMethod({
    request: emptyRequestSchema,
    response: connectorSettingsSchema,
    invoke: (ds) => ds.getConnectorSettings()
  }),
  saveConnectorSettings: defineMethod({
    request: z.object({
      baseUrl: z.string().min(1),
      username: z.string().min(1),
      enabled: z.boolean(),
      /** Already-encrypted by the caller (desktop `credentials.ts`, or omitted to keep the currently stored password) — see the module doc. */
      encryptedPassword: encryptedSecretInputSchema.optional()
    }),
    response: connectorSettingsSchema,
    invoke: (ds, req) => ds.saveConnectorSettings(req)
  }),
  getEncryptedConnectorPassword: defineMethod({
    request: emptyRequestSchema,
    response: z.object({ secret: optionalEncryptedSecretSchema }),
    invoke: async (ds) => ({ secret: await ds.getEncryptedConnectorPassword() })
  }),
  testConnectorConnection: defineMethod({
    request: z.object({
      baseUrl: z.string().min(1),
      username: z.string().min(1),
      /** Already decrypted by the caller — travels over the wire once per call, so this endpoint should only ever be reached over TLS/a private network (see docs/server-mode.md). */
      password: z.string().min(1)
    }),
    response: connectorTestResultSchema,
    invoke: (ds, req) => ds.testConnectorConnection(req.baseUrl, req.username, req.password)
  }),
  runConnectorSync: defineMethod({
    request: z.object({
      baseUrl: z.string().min(1),
      username: z.string().min(1),
      password: z.string().min(1),
      periodMonth: z.string().regex(/^\d{4}-\d{2}$/)
    }),
    response: connectorSyncResultSchema,
    invoke: (ds, req) =>
      ds.runConnectorSync(req.baseUrl, req.username, req.password, req.periodMonth)
  }),
  listConnectorSyncStatus: defineMethod({
    request: emptyRequestSchema,
    response: z.object({ rows: z.array(connectorSyncStatusRowSchema) }),
    invoke: async (ds) => ({ rows: await ds.listConnectorSyncStatus() })
  }),

  // --- Reference & Benchmark API connector ---
  getReferenceApiSettings: defineMethod({
    request: emptyRequestSchema,
    response: referenceApiSettingsSchema,
    invoke: (ds) => ds.getReferenceApiSettings()
  }),
  saveReferenceApiSettings: defineMethod({
    request: referenceApiSettingsInputSchema,
    response: referenceApiSettingsSchema,
    invoke: (ds, req) => ds.saveReferenceApiSettings(req)
  }),
  testReferenceApiConnection: defineMethod({
    request: emptyRequestSchema,
    response: connectorTestResultSchema,
    invoke: (ds) => ds.testReferenceApiConnection()
  }),
  refreshReferenceApiCache: defineMethod({
    request: emptyRequestSchema,
    response: referenceApiCacheRefreshResultSchema,
    invoke: (ds) => ds.refreshReferenceApiCache()
  }),
  getCarcDescriptions: defineMethod({
    request: z.object({ codes: z.array(z.string()) }),
    response: z.object({ descriptions: z.record(z.string(), z.string()) }),
    invoke: async (ds, req) => ({ descriptions: await ds.getCarcDescriptions(req.codes) })
  }),

  // --- Watch-folder automation ---
  getAutomationInboxSettings: defineMethod({
    request: emptyRequestSchema,
    response: automationInboxSettingsSchema,
    invoke: (ds) => ds.getAutomationInboxSettings()
  }),
  setAutomationInboxRoot: defineMethod({
    request: z.object({ inboxRoot: z.string().nullable() }),
    response: z.object({ ok: z.literal(true) }),
    invoke: async (ds, req) => {
      await ds.setAutomationInboxRoot(req.inboxRoot)
      return { ok: true as const }
    }
  }),
  setFolderTemplatePin: defineMethod({
    request: z.object({ clientCode: z.string().min(1), templateId: z.string().nullable() }),
    response: z.object({ ok: z.literal(true) }),
    invoke: async (ds, req) => {
      await ds.setFolderTemplatePin(req.clientCode, req.templateId)
      return { ok: true as const }
    }
  }),
  getPinnedTemplateId: defineMethod({
    request: z.object({ clientCode: z.string().min(1) }),
    response: z.object({ templateId: z.string().nullable() }),
    invoke: async (ds, req) => ({ templateId: await ds.getPinnedTemplateId(req.clientCode) })
  }),

  // --- Report scheduler ---
  listAutomationRules: defineMethod({
    request: emptyRequestSchema,
    response: z.object({ rules: z.array(automationRuleSchema) }),
    invoke: async (ds) => ({ rules: await ds.listAutomationRules() })
  }),
  saveAutomationRule: defineMethod({
    request: automationRuleInputSchema,
    response: automationRuleSchema,
    invoke: (ds, req) => ds.saveAutomationRule(req)
  }),
  deleteAutomationRule: defineMethod({
    request: z.object({ ruleId: z.string().min(1) }),
    response: z.object({ ok: z.literal(true) }),
    invoke: async (ds, req) => {
      await ds.deleteAutomationRule(req.ruleId)
      return { ok: true as const }
    }
  }),
  recordRuleRun: defineMethod({
    request: z.object({
      ruleId: z.string().min(1),
      periodMonth: z.string(),
      status: z.enum(['ok', 'error'])
    }),
    response: z.object({ ok: z.literal(true) }),
    invoke: async (ds, req) => {
      await ds.recordRuleRun(req.ruleId, req.periodMonth, req.status)
      return { ok: true as const }
    }
  }),

  // --- Email delivery ---
  getEmailSettings: defineMethod({
    request: emptyRequestSchema,
    response: emailSettingsSchema,
    invoke: (ds) => ds.getEmailSettings()
  }),
  saveEmailSettings: defineMethod({
    request: z.object({
      host: z.string().min(1),
      port: z.number().int().positive(),
      secure: z.boolean(),
      username: z.string().nullable(),
      fromAddress: z.string().email(),
      subjectTemplate: z.string().min(1),
      bodyTemplate: z.string().min(1),
      encryptedPassword: encryptedSecretInputSchema.optional()
    }),
    response: emailSettingsSchema,
    invoke: (ds, req) => ds.saveEmailSettings(req)
  }),
  getEncryptedEmailPassword: defineMethod({
    request: emptyRequestSchema,
    response: z.object({ secret: optionalEncryptedSecretSchema }),
    invoke: async (ds) => ({ secret: await ds.getEncryptedEmailPassword() })
  }),
  enqueueEmailSend: defineMethod({
    request: z.object({
      clientCode: z.string().min(1),
      periodMonth: z.string(),
      filePaths: z.array(z.string()),
      recipients: z.array(z.string()),
      subject: z.string(),
      body: z.string()
    }),
    response: z.object({ queueId: z.number().int().positive() }),
    invoke: async (ds, req) => ({ queueId: await ds.enqueueEmailSend(req) })
  }),
  listEmailSendQueue: defineMethod({
    request: emptyRequestSchema,
    response: z.object({ rows: z.array(emailSendQueueRowSchema) }),
    invoke: async (ds) => ({ rows: await ds.listEmailSendQueue() })
  }),
  markEmailSendResult: defineMethod({
    request: z.object({
      queueId: z.number().int().positive(),
      ok: z.boolean(),
      error: z.string().nullable()
    }),
    response: z.object({ ok: z.literal(true) }),
    invoke: async (ds, req) => {
      await ds.markEmailSendResult(req.queueId, req.ok, req.error)
      return { ok: true as const }
    }
  }),
  listExportAuditLog: defineMethod({
    request: z.object({ limit: z.number().int().positive().max(1000).optional() }),
    response: z.object({ rows: z.array(exportAuditLogRowSchema) }),
    invoke: async (ds, req) => ({ rows: await ds.listExportAuditLog(req.limit) })
  }),

  // --- KPI engine / reports ---
  buildClientReport: defineMethod({
    request: buildClientReportInputSchema,
    response: clientReportSchema,
    invoke: (ds, req) => ds.buildClientReport(req.clientId, req.periodMonth)
  }),
  listClientReportsForPeriod: defineMethod({
    request: periodMonthRequestSchema,
    response: z.object({ reports: z.array(clientReportSchema) }),
    invoke: async (ds, req) => ({
      reports: await ds.listClientReportsForPeriod(req.periodMonth)
    })
  }),
  getClientFinancialTrend: defineMethod({
    request: clientTrendInputSchema,
    response: z.object({ points: z.array(financialTrendPointSchema) }),
    invoke: async (ds, req) => ({
      points: await ds.getClientFinancialTrend(req.clientId, req.endPeriodMonth, req.monthsBack)
    })
  }),

  // --- Branding (logo upload/pick stays desktop-only — see module doc) ---
  getBranding: defineMethod({
    request: emptyRequestSchema,
    response: brandingSchema,
    invoke: (ds) => ds.getBranding()
  }),
  updateBranding: defineMethod({
    request: brandingInputSchema,
    response: brandingSchema,
    invoke: (ds, req) => ds.updateBranding(req)
  }),

  // --- Export audit log ---
  recordExport: defineMethod({
    request: z.object({
      action: z.string(),
      clientCode: z.string().nullable(),
      periodMonth: z.string().nullable(),
      filePath: z.string().nullable()
    }),
    response: z.object({ ok: z.literal(true) }),
    invoke: async (ds, req) => {
      ds.recordExport(req)
      return { ok: true as const }
    }
  }),

  // --- Maintenance ---
  getBackupStatus: defineMethod({
    request: emptyRequestSchema,
    response: backupStatusSchema,
    invoke: (ds) => ds.getBackupStatus()
  }),
  runBackupNow: defineMethod({
    request: emptyRequestSchema,
    response: backupStatusSchema,
    invoke: (ds) => ds.runBackupNow()
  }),
  restoreLatestBackup: defineMethod({
    request: emptyRequestSchema,
    response: z.object({ restoredFrom: z.string() }),
    invoke: (ds) => ds.restoreLatestBackup()
  })
} as const

export type RpcContract = typeof rpcContract
export type RpcMethodName = keyof RpcContract
export type RpcRequest<M extends RpcMethodName> = z.infer<RpcContract[M]['request']>
export type RpcResponse<M extends RpcMethodName> = z.infer<RpcContract[M]['response']>

/** Runtime guard — `method` arrives as a URL path segment (`POST /api/rpc/:method`), so it's `string`, not yet known to be a valid key. */
export function isRpcMethodName(method: string): method is RpcMethodName {
  return Object.prototype.hasOwnProperty.call(rpcContract, method)
}

/**
 * Validates `rawRequest` against `method`'s schema, calls its `invoke`,
 * validates the result, and returns it — the one generic entry point
 * `server/src/rpc-route.ts` needs, kept here rather than at the call site
 * because dispatching across a heterogeneous map of `{Req, Res}` pairs by
 * a runtime-only key needs exactly one contained, well-understood escape
 * hatch from TS's per-entry typing (each `rpcContract[name]` entry above
 * is still fully type-checked on its own — this function is the only
 * place that erases that back down to `unknown`, and only internally).
 */
export async function invokeRpcMethod(
  dataService: IDataService,
  method: RpcMethodName,
  rawRequest: unknown
): Promise<unknown> {
  const def = rpcContract[method] as unknown as RpcMethodDef<unknown, unknown>
  const req = def.request.parse(rawRequest)
  const result = await def.invoke(dataService, req)
  return def.response.parse(result)
}

export type { EncryptedSecretInput }

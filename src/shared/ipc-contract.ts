/**
 * The single source of truth for every IPC channel between the renderer
 * and the main process. This file is compiled into both processes.
 *
 * Security model (plan §7): the renderer never gets raw `ipcRenderer`
 * access — the preload bridge exposes exactly one function,
 * `invoke(channel, payload)`, typed against `IpcChannelMap` below. The
 * main process re-validates every payload against the matching request
 * schema before doing anything with it (never trust the renderer, even
 * though it's our own code — contextIsolation + a compromised renderer
 * is exactly the threat this defends against). Response payloads are
 * validated too, so a bug in a handler can't silently leak a malformed
 * shape to the UI.
 */
import { z } from 'zod'
import {
  analyticsScopeInputSchema,
  analyticsTrendInputSchema,
  arAgingByClientRowSchema,
  backupStatusSchema,
  batchExportInputSchema,
  batchExportResultSchema,
  brandingInputSchema,
  brandingSchema,
  buildClientReportInputSchema,
  clientPatchSchema,
  clientReportSchema,
  clientSchema,
  connectorSettingsInputSchema,
  connectorSettingsSchema,
  connectorSyncResultSchema,
  connectorSyncStatusRowSchema,
  connectorTestResultSchema,
  daysInArTrendPointSchema,
  denialListRowSchema,
  exportClientReportInputSchema,
  exportReportResultSchema,
  getMonthlySummaryInputSchema,
  importFileKindSchema,
  importJobSchema,
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
  runConnectorSyncInputSchema,
  runCsvImportInputSchema,
  runX12ImportInputSchema,
  topAgedClaimRowSchema,
  x12ParseSummarySchema
} from './domain'

/**
 * `ping` — the walking-skeleton / hardened-shell smoke channel (plan
 * Phase 1 step 3). Exercises the full preload -> zod -> main -> zod ->
 * renderer round trip without touching the database.
 */
const pingRequestSchema = z.object({
  message: z.string().min(1).max(200)
})

const pingResponseSchema = z.object({
  message: z.string(),
  /** ISO-8601 UTC timestamp set by the main process. */
  echoedAt: z.string().datetime(),
  /** Main process PID, useful for confirming the round trip left the renderer. */
  pid: z.number().int().positive()
})

const emptyRequestSchema = z.object({})

const clientIdRequestSchema = z.object({ clientId: z.number().int().positive() })
const templateIdRequestSchema = z.object({ templateId: z.string().min(1) })
const jobIdRequestSchema = z.object({ jobId: z.number().int().positive() })

const fuzzyMatchSuggestionSchema = z.object({
  sourceHeader: z.string(),
  suggestedField: z.string().nullable(),
  confidence: z.number()
})

/**
 * Every IPC channel the app exposes, keyed by channel name. Adding a new
 * channel means adding an entry here — `request`/`response` are zod
 * schemas, so both processes get compile-time types (via `z.infer`) and
 * runtime validation for free.
 */
export const ipcContract = {
  ping: {
    request: pingRequestSchema,
    response: pingResponseSchema
  },

  // --- Clients (plan Phase 1 step 4) ---
  'clients:list': {
    request: emptyRequestSchema,
    response: z.object({ clients: z.array(clientSchema) })
  },
  'clients:create': {
    request: newClientInputSchema,
    response: clientSchema
  },
  'clients:update': {
    request: clientIdRequestSchema.extend({ patch: clientPatchSchema }),
    response: clientSchema
  },
  'clients:deactivate': {
    request: clientIdRequestSchema,
    response: clientSchema
  },

  // --- Mapping templates (plan §3, Phase 1 step 5) ---
  'mappingTemplates:list': {
    request: emptyRequestSchema,
    response: z.object({ templates: z.array(mappingTemplateSchema) })
  },
  'mappingTemplates:get': {
    request: templateIdRequestSchema,
    response: z.object({ template: mappingTemplateSchema.nullable() })
  },
  'mappingTemplates:save': {
    request: newMappingTemplateInputSchema,
    response: mappingTemplateSchema
  },
  'mappingTemplates:exportToFile': {
    request: templateIdRequestSchema,
    response: z.object({ filePath: z.string().nullable() })
  },
  'mappingTemplates:importFromFile': {
    request: emptyRequestSchema,
    response: z.object({ template: mappingTemplateSchema.nullable() })
  },

  // --- Imports (plan §3, Phase 1 step 5) ---
  'importJobs:list': {
    request: emptyRequestSchema,
    response: z.object({ jobs: z.array(importJobSchema) })
  },
  'importJobs:get': {
    request: jobIdRequestSchema,
    response: z.object({ job: importJobSchema.nullable() })
  },
  'importJobs:runCsv': {
    request: runCsvImportInputSchema,
    response: importJobSchema
  },
  'importJobs:listQuarantine': {
    request: jobIdRequestSchema,
    response: z.object({ rows: z.array(quarantineRowSchema) })
  },
  'importJobs:pickFile': {
    request: emptyRequestSchema,
    response: z.object({ filePath: z.string().nullable() })
  },
  'importJobs:peekHeaders': {
    request: z.object({ filePath: z.string().min(1) }),
    response: z.object({ headers: z.array(z.string()) })
  },
  'importJobs:suggestMapping': {
    request: z.object({ headers: z.array(z.string()) }),
    response: z.object({ suggestions: z.array(fuzzyMatchSuggestionSchema) })
  },
  'importJobs:previewMapping': {
    // Accepts a draft mapping (not yet saved) so the wizard can preview
    // before "save template → run" (plan §3) — not a templateId lookup.
    request: z.object({ filePath: z.string().min(1), mapping: newMappingTemplateInputSchema }),
    response: z.object({
      rows: z.array(
        z.object({
          rowNumber: z.number().int().positive(),
          valid: z.boolean(),
          errors: z.array(z.string()),
          preview: z.record(z.string(), z.unknown())
        })
      )
    })
  },

  // --- X12 835/837 (plan §3 bullet 2, Phase 2) ---
  'importJobs:detectFileKind': {
    request: z.object({ filePath: z.string().min(1) }),
    response: z.object({ kind: importFileKindSchema })
  },
  'importJobs:previewX12': {
    request: z.object({ filePath: z.string().min(1) }),
    response: z.object({ summary: x12ParseSummarySchema })
  },
  'importJobs:runX12': {
    request: runX12ImportInputSchema,
    response: importJobSchema
  },

  // --- Manual entry (plan §3, Phase 1 step 6) ---
  'manualEntry:upsert': {
    request: monthlySummaryInputSchema,
    response: monthlySummarySchema
  },
  'manualEntry:get': {
    request: getMonthlySummaryInputSchema,
    response: z.object({ summary: monthlySummarySchema.nullable() })
  },

  // --- KPI engine / reports (plan §4) ---
  'reports:client': {
    request: buildClientReportInputSchema,
    response: clientReportSchema
  },
  'reports:portfolio': {
    request: z.object({ periodMonth: z.string().regex(/^\d{4}-\d{2}$/) }),
    response: z.object({ reports: z.array(clientReportSchema) })
  },
  'reports:trend': {
    request: z.object({
      clientId: z.number().int().positive(),
      endPeriodMonth: z.string().regex(/^\d{4}-\d{2}$/),
      monthsBack: z.number().int().positive().max(24).optional()
    }),
    response: z.object({
      points: z.array(
        z.object({ month: z.string(), grossCharges: z.number(), totalCollections: z.number() })
      )
    })
  },

  // --- Backups / integrity (Risk 5, restore added step 9) ---
  'backups:status': {
    request: emptyRequestSchema,
    response: backupStatusSchema
  },
  'backups:runNow': {
    request: emptyRequestSchema,
    response: backupStatusSchema
  },
  'backups:restoreLatest': {
    request: emptyRequestSchema,
    response: z.object({ restoredFrom: z.string() })
  },

  // --- Branding (plan §6) ---
  'branding:get': {
    request: emptyRequestSchema,
    response: brandingSchema
  },
  'branding:update': {
    request: brandingInputSchema,
    response: brandingSchema
  },
  'branding:pickAndSetLogo': {
    request: emptyRequestSchema,
    response: brandingSchema
  },

  // --- Denials / A/R / Payers analytics screens (plan §5, Phase 2 chunk B) ---
  'analytics:listDenials': {
    request: listDenialsInputSchema,
    response: z.object({ rows: z.array(denialListRowSchema) })
  },
  'analytics:denialRateTrend': {
    request: analyticsTrendInputSchema,
    response: z.object({ points: z.array(monthlyRateTrendPointSchema) })
  },
  'analytics:arAgingByClient': {
    request: emptyRequestSchema,
    response: z.object({ rows: z.array(arAgingByClientRowSchema) })
  },
  'analytics:arPayerVsPatientSplit': {
    request: z.object({ clientId: z.number().int().positive().nullable() }),
    response: payerVsPatientSplitSchema
  },
  'analytics:topAgedClaims': {
    request: z.object({
      clientId: z.number().int().positive().nullable(),
      limit: z.number().int().positive().max(200).optional()
    }),
    response: z.object({ rows: z.array(topAgedClaimRowSchema) })
  },
  'analytics:daysInArTrend': {
    request: analyticsTrendInputSchema,
    response: z.object({ points: z.array(daysInArTrendPointSchema) })
  },
  'analytics:payerAnalysis': {
    request: analyticsScopeInputSchema,
    response: z.object({ rows: z.array(payerAnalysisRowSchema) })
  },
  'analytics:payerMixTrend': {
    request: analyticsTrendInputSchema,
    response: z.object({ points: z.array(payerMixTrendPointSchema) })
  },

  // --- Export engine: PDF/PPTX/XLSX, single + batch (plan §6, Phase 2 chunk B) ---
  'reports:printReady': {
    // The print route sends back each chart's captured PNG (data URI),
    // keyed by chart name, once ECharts has painted (plan §6) — the PDF
    // path ignores this payload (printToPDF screenshots the whole page),
    // the PPTX exporter uses it to place chart images on slides.
    request: z.object({ chartImages: z.record(z.string(), z.string()).default({}) }),
    response: z.object({ ok: z.boolean() })
  },
  'exports:generateReport': {
    request: exportClientReportInputSchema,
    response: exportReportResultSchema
  },
  'exports:generateBatch': {
    request: batchExportInputSchema,
    response: batchExportResultSchema
  },

  // --- Generic RCM Platform REST connector (plan §3 bullet 3, Phase 2 chunk C) ---
  'connector:getSettings': {
    request: emptyRequestSchema,
    response: connectorSettingsSchema
  },
  'connector:saveSettings': {
    // Carries the plaintext password (once, at save time only) — the
    // main-process handler encrypts it via `credentials.ts` before
    // anything touches disk; `LocalDataService` only ever sees the
    // already-encrypted blob (plan §7: "Credentials via Electron
    // safeStorage").
    request: connectorSettingsInputSchema,
    response: connectorSettingsSchema
  },
  'connector:testConnection': {
    request: emptyRequestSchema,
    response: connectorTestResultSchema
  },
  'connector:syncNow': {
    request: runConnectorSyncInputSchema,
    response: connectorSyncResultSchema
  },
  'connector:syncStatus': {
    request: emptyRequestSchema,
    response: z.object({ rows: z.array(connectorSyncStatusRowSchema) })
  },

  // --- Reference & Benchmark API connector (beacon paragraph, Phase 2 chunk C) ---
  'referenceApi:getSettings': {
    request: emptyRequestSchema,
    response: referenceApiSettingsSchema
  },
  'referenceApi:saveSettings': {
    request: referenceApiSettingsInputSchema,
    response: referenceApiSettingsSchema
  },
  'referenceApi:testConnection': {
    request: emptyRequestSchema,
    response: connectorTestResultSchema
  },
  'referenceApi:refreshCache': {
    request: emptyRequestSchema,
    response: referenceApiCacheRefreshResultSchema
  },
  'referenceApi:getCarcDescriptions': {
    request: z.object({ codes: z.array(z.string()) }),
    response: z.object({ descriptions: z.record(z.string(), z.string()) })
  }
} as const

export type IpcChannelMap = typeof ipcContract

/** The set of valid channel names — the only strings `invoke()` accepts. */
export type IpcChannel = keyof IpcChannelMap

export type IpcRequest<C extends IpcChannel> = z.infer<IpcChannelMap[C]['request']>
export type IpcResponse<C extends IpcChannel> = z.infer<IpcChannelMap[C]['response']>

/**
 * Validates a payload against a channel's request schema. Main-process
 * IPC handlers must call this on every incoming message before acting on
 * it — see `src/main/ipc/ping.ts` for the reference implementation.
 */
export function parseIpcRequest<C extends IpcChannel>(channel: C, payload: unknown): IpcRequest<C> {
  return ipcContract[channel].request.parse(payload) as IpcRequest<C>
}

/**
 * Validates a handler's return value against a channel's response schema
 * before it crosses back into the renderer.
 */
export function parseIpcResponse<C extends IpcChannel>(
  channel: C,
  payload: unknown
): IpcResponse<C> {
  return ipcContract[channel].response.parse(payload) as IpcResponse<C>
}

/**
 * Domain types shared between main and renderer, expressed as zod
 * schemas so every shape gets both a compile-time type (via `z.infer`)
 * and a runtime validator for free — used directly as IPC payload
 * schemas in `ipc-contract.ts`. Field names mirror rcm-prototype's
 * models (`/home/aethera/rcm-prototype/app/models.py`) per plan §2,
 * translated to camelCase for the TS/JSON boundary (the DuckDB columns
 * underneath stay snake_case, matching rcm-prototype exactly).
 */
import { z } from 'zod'

// ---------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------

export const clientSchema = z.object({
  clientId: z.number().int().positive(),
  code: z.string().min(1),
  name: z.string().min(1),
  contractType: z.string().nullable(),
  contractRate: z.number().nullable(),
  slaDaysToSubmit: z.number().int().nullable(),
  reportRecipients: z.array(z.string().email()),
  /** Two-letter US state — scopes the Reference & Benchmark connector's `/price/commercial` lookup (plan chunk C); null skips the benchmark block. */
  state: z.string().length(2).nullable(),
  active: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string()
})
export type Client = z.infer<typeof clientSchema>

export const newClientInputSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[A-Za-z0-9_-]+$/, 'code must be alphanumeric (with - or _)'),
  name: z.string().min(1).max(200),
  contractType: z.string().max(100).nullable().optional(),
  contractRate: z.number().min(0).max(1).nullable().optional(),
  slaDaysToSubmit: z.number().int().positive().nullable().optional(),
  reportRecipients: z.array(z.string().email()).optional(),
  state: z.string().length(2).nullable().optional()
})
export type NewClientInput = z.infer<typeof newClientInputSchema>

export const clientPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  contractType: z.string().max(100).nullable().optional(),
  contractRate: z.number().min(0).max(1).nullable().optional(),
  slaDaysToSubmit: z.number().int().positive().nullable().optional(),
  reportRecipients: z.array(z.string().email()).optional(),
  state: z.string().length(2).nullable().optional(),
  active: z.boolean().optional()
})
export type ClientPatch = z.infer<typeof clientPatchSchema>

// ---------------------------------------------------------------------
// CSV/XLSX mapping templates (plan §3) — stored in meta.db, versioned,
// exportable/importable as JSON.
// ---------------------------------------------------------------------

export const targetEntitySchema = z.enum(['claims', 'claim_lines', 'payments', 'denials'])
export type TargetEntity = z.infer<typeof targetEntitySchema>

export const importGrainSchema = z.enum(['claim', 'line', 'payment'])
export type ImportGrain = z.infer<typeof importGrainSchema>

export const columnTransformSchema = z.enum(['none', 'date_fmt', 'money', 'enum_map', 'concat'])
export type ColumnTransform = z.infer<typeof columnTransformSchema>

export const mappingColumnSchema = z.object({
  sourceHeader: z.string().min(1),
  targetField: z.string().min(1),
  transform: columnTransformSchema.default('none'),
  /** Transform-specific options (e.g. `{ format: 'MM/DD/YYYY' }` for date_fmt, `{ map: {...} }` for enum_map). */
  transformOptions: z.record(z.string(), z.unknown()).optional()
})
export type MappingColumn = z.infer<typeof mappingColumnSchema>

export const mappingTemplateSchema = z.object({
  templateId: z.string().min(1),
  name: z.string().min(1),
  pmSystem: z.string().min(1),
  targetEntity: targetEntitySchema,
  grain: importGrainSchema,
  columns: z.array(mappingColumnSchema).min(1),
  keyFields: z.array(z.string().min(1)).min(1),
  version: z.number().int().positive(),
  builtIn: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string()
})
export type MappingTemplate = z.infer<typeof mappingTemplateSchema>

export const newMappingTemplateInputSchema = mappingTemplateSchema
  .omit({ templateId: true, version: true, builtIn: true, createdAt: true, updatedAt: true })
  .extend({ templateId: z.string().min(1).optional() })
export type NewMappingTemplateInput = z.infer<typeof newMappingTemplateInputSchema>

// ---------------------------------------------------------------------
// Import jobs / quarantine (plan §2, Risk 3)
// ---------------------------------------------------------------------

export const importStatusSchema = z.enum([
  'running',
  'succeeded',
  'succeeded_with_warnings',
  'failed'
])
export type ImportStatus = z.infer<typeof importStatusSchema>

export const importJobSchema = z.object({
  jobId: z.number().int().positive(),
  sourceType: z.string(),
  fileName: z.string().nullable(),
  fileSha256: z.string().nullable(),
  mappingTemplateId: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  status: importStatusSchema,
  rowsRead: z.number().int().nonnegative(),
  rowsLoaded: z.number().int().nonnegative(),
  rowsSkipped: z.number().int().nonnegative(),
  error: z.unknown().nullable()
})
export type ImportJob = z.infer<typeof importJobSchema>

export const quarantineRowSchema = z.object({
  quarantineId: z.number().int().positive(),
  importJobId: z.number().int().positive(),
  sourceRowNum: z.number().int().nonnegative(),
  targetEntity: z.string(),
  payload: z.unknown(),
  reasons: z.array(z.string()),
  createdAt: z.string()
})
export type QuarantineRow = z.infer<typeof quarantineRowSchema>

export const runCsvImportInputSchema = z.object({
  filePath: z.string().min(1),
  templateId: z.string().min(1),
  clientCode: z.string().min(1)
})
export type RunCsvImportInput = z.infer<typeof runCsvImportInputSchema>

// ---------------------------------------------------------------------
// X12 835/837 import (plan §3 bullet 2, Phase 2). The wizard skips the
// column-mapping steps entirely for these files (bullet 5) and shows a
// parse-summary preview — counts + warnings — before running the import.
// ---------------------------------------------------------------------

export const x12KindSchema = z.enum(['835', '837'])
export type X12Kind = z.infer<typeof x12KindSchema>

export const importFileKindSchema = z.enum(['csv', 'xlsx', 'x12-835', 'x12-837', 'unknown'])
export type ImportFileKind = z.infer<typeof importFileKindSchema>

export const x12ParseSummarySchema = z.object({
  kind: x12KindSchema,
  claimsCount: z.number().int().nonnegative(),
  lineCount: z.number().int().nonnegative(),
  adjustmentCount: z.number().int().nonnegative(),
  /** BPR02 total payment amount — 835 only, null for an 837 preview. */
  totalPaymentAmount: z.number().nullable(),
  warnings: z.array(z.string())
})
export type X12ParseSummary = z.infer<typeof x12ParseSummarySchema>

export const runX12ImportInputSchema = z.object({
  filePath: z.string().min(1),
  clientCode: z.string().min(1)
})
export type RunX12ImportInput = z.infer<typeof runX12ImportInputSchema>

// ---------------------------------------------------------------------
// Manual entry (plan §3 / Phase 1 step 6)
// ---------------------------------------------------------------------

const yyyyMmFirstOfMonth = z
  .string()
  .regex(/^\d{4}-\d{2}-01$/, 'periodMonth must be an ISO date on the 1st of the month (YYYY-MM-01)')

export const monthlySummaryInputSchema = z.object({
  clientId: z.number().int().positive(),
  periodMonth: yyyyMmFirstOfMonth,
  charges: z.number().nullable().optional(),
  insCollections: z.number().nullable().optional(),
  ptCollections: z.number().nullable().optional(),
  adjustments: z.number().nullable().optional(),
  openAr: z.number().nullable().optional(),
  arAging0To30: z.number().nullable().optional(),
  arAging31To60: z.number().nullable().optional(),
  arAging61To90: z.number().nullable().optional(),
  arAging91To120: z.number().nullable().optional(),
  arAging120Plus: z.number().nullable().optional(),
  claimsSubmitted: z.number().int().nullable().optional(),
  denialsCount: z.number().int().nullable().optional(),
  notes: z.string().max(2000).nullable().optional()
})
export type MonthlySummaryInput = z.infer<typeof monthlySummaryInputSchema>

export const monthlySummarySchema = monthlySummaryInputSchema.extend({
  updatedAt: z.string(),
  priorValues: z.unknown().nullable(),
  /** 'synced' = written by the RCM Platform connector (plan §3 bullet 3); 'manual' = the Manual Entry screen — including overwriting a previously-synced row. */
  source: z.enum(['manual', 'synced'])
})
export type MonthlySummary = z.infer<typeof monthlySummarySchema>

export const getMonthlySummaryInputSchema = z.object({
  clientId: z.number().int().positive(),
  periodMonth: yyyyMmFirstOfMonth
})
export type GetMonthlySummaryInput = z.infer<typeof getMonthlySummaryInputSchema>

// ---------------------------------------------------------------------
// Canonical claim-line import row — the flattened shape a mapped CSV row
// must resolve to before upsert (plan §3, `target_entity: 'claims'`,
// `grain: 'line'`: one CSV row = one claim line, aggregated up into its
// parent claim). patientKey here is the RAW source identifier — the
// importer hashes it before it ever reaches the DB (plan §7 PHI
// minimization); it never appears in `claims.patient_key`.
// ---------------------------------------------------------------------

export const canonicalClaimLineRowSchema = z
  .object({
    claimNumber: z.string().min(1).optional(),
    externalRef: z.string().min(1).optional(),
    patientKey: z.string().min(1),
    dos: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'dos must be an ISO date (YYYY-MM-DD)'),
    payerName: z.string().optional(),
    providerNpi: z.string().optional(),
    status: z.string().optional(),
    chargeAmount: z.number().nonnegative(),
    allowedAmount: z.number().nonnegative().optional(),
    paidAmount: z.number().nonnegative().optional(),
    patientResponsibility: z.number().nonnegative().optional(),
    patientPaid: z.number().nonnegative().optional(),
    adjustmentAmount: z.number().optional(),
    cptCode: z.string().optional(),
    units: z.number().positive().optional(),
    carcCode: z.string().optional(),
    denialDescription: z.string().optional()
  })
  .refine((row) => Boolean(row.claimNumber || row.externalRef), {
    message: 'either claimNumber or externalRef is required',
    path: ['claimNumber']
  })
export type CanonicalClaimLineRow = z.infer<typeof canonicalClaimLineRowSchema>

// ---------------------------------------------------------------------
// Backups / integrity (Risk 5)
// ---------------------------------------------------------------------

export const backupStatusSchema = z.object({
  lastBackupAt: z.string().nullable(),
  backupCount: z.number().int().nonnegative(),
  duckdbIntegrityOk: z.boolean().nullable(),
  sqliteIntegrityOk: z.boolean().nullable()
})
export type BackupStatus = z.infer<typeof backupStatusSchema>

// ---------------------------------------------------------------------
// Client report (plan §4, Phase 1 step 7) — the KPI engine's output
// shape, deliberately mirroring rcm-prototype's `client_report()`
// (`app/services/production.py` lines 152-211) so golden tests and
// `scripts/crosscheck-rcm.ts` can diff the two directly on shared keys.
// ---------------------------------------------------------------------

/** Provenance of a report's numbers (plan §4 fallback ladder). */
export const clientReportSourceSchema = z.enum(['claims', 'manual', 'synced'])
export type ClientReportSource = z.infer<typeof clientReportSourceSchema>

export const arAgingBucketsSchema = z.object({
  '0-30': z.number(),
  '31-60': z.number(),
  '61-90': z.number(),
  '91-120': z.number(),
  '120+': z.number()
})
export type ArAgingBuckets = z.infer<typeof arAgingBucketsSchema>

export const kpiSnapshotRowSchema = z.object({
  date: z.string(),
  denialRate: z.number().nullable(),
  firstPassRate: z.number().nullable(),
  cleanClaimRate: z.number().nullable(),
  daysToCash: z.number().nullable(),
  openAr: z.number().nullable(),
  arOver90Pct: z.number().nullable(),
  netCollectionRate: z.number().nullable()
})
export type KpiSnapshotRow = z.infer<typeof kpiSnapshotRowSchema>

export const kpiTrendsSchema = z.object({
  series: z.array(kpiSnapshotRowSchema),
  latest: kpiSnapshotRowSchema.nullable(),
  deltas: z.record(
    z.string(),
    z.object({
      baselineDate: z.string(),
      denialRate: z.number().nullable(),
      firstPassRate: z.number().nullable(),
      cleanClaimRate: z.number().nullable(),
      daysToCash: z.number().nullable(),
      openAr: z.number().nullable(),
      arOver90Pct: z.number().nullable()
    })
  )
})
export type KpiTrends = z.infer<typeof kpiTrendsSchema>

// ---------------------------------------------------------------------
// Benchmark block (plan's beacon paragraph, Phase 2 chunk C) — avg
// allowed on the client's top CPT codes vs. the Reference & Benchmark
// API's state percentile data. Assembled outside `buildClientReport`
// (see kpi/client-report.ts's `options.benchmark`) and excluded from the
// rcm-prototype parity crosscheck — documented in docs/kpi-parity.md,
// since rcm-prototype has no equivalent field.
// ---------------------------------------------------------------------

export const benchmarkCptRowSchema = z.object({
  cptCode: z.string(),
  description: z.string().nullable(),
  avgAllowed: z.number(),
  claimsCount: z.number().int().nonnegative(),
  /** NULL when the reference API had no benchmark data for this code/state — never a fabricated figure. */
  stateMedian: z.number().nullable(),
  statePercentile25: z.number().nullable(),
  statePercentile75: z.number().nullable()
})
export type BenchmarkCptRow = z.infer<typeof benchmarkCptRowSchema>

export const benchmarkBlockSchema = z.object({
  state: z.string(),
  asOf: z.string(),
  cpts: z.array(benchmarkCptRowSchema)
})
export type BenchmarkBlock = z.infer<typeof benchmarkBlockSchema>

export const clientReportSchema = z.object({
  client: z.object({ code: z.string(), name: z.string(), contract: z.string() }),
  period: z.object({ start: z.string(), end: z.string() }),
  /** Fallback ladder provenance: claim-level data -> monthly_summaries -> empty. */
  source: clientReportSourceSchema,
  volume: z.object({
    encountersReceived: z.number().int().nonnegative(),
    claimsSubmitted: z.number().int().nonnegative(),
    denialsReceived: z.number().int().nonnegative()
  }),
  financials: z.object({
    grossCharges: z.number(),
    insuranceCollections: z.number(),
    patientCollections: z.number(),
    totalCollections: z.number(),
    rcmFee: z.number(),
    netCollectionRatePct: z.number().nullable()
  }),
  kpis: z.object({
    daysInAr: z.number().nullable(),
    openAr: z.number(),
    /** Verbatim quirk from production.py line 199: 0 (not null) when openAr is 0. */
    arOver90Pct: z.number(),
    chargeLagDaysAvg: z.number().nullable(),
    slaDaysToSubmit: z.number().int().nullable(),
    slaMetPct: z.number().nullable(),
    firstPassAcceptancePct: z.number().nullable(),
    denialRatePct: z.number().nullable()
  }),
  arAging: arAgingBucketsSchema,
  kpiTrends: kpiTrendsSchema,
  denialsByRootCause: z.record(z.string(), z.number()),
  claimsByStatus: z.record(z.string(), z.number()),
  /** Not part of rcm-prototype's shape (see docs/kpi-parity.md) — added for the dashboard's payer-mix chart. */
  payerMix: z.array(z.object({ payerName: z.string(), charges: z.number() })),
  /** Not part of rcm-prototype's shape (see docs/kpi-parity.md) — null unless the Reference & Benchmark connector is enabled, the client has a state configured, and it returned data. */
  benchmark: benchmarkBlockSchema.nullable()
})
export type ClientReport = z.infer<typeof clientReportSchema>

export const buildClientReportInputSchema = z.object({
  clientId: z.number().int().positive(),
  periodMonth: z.string().regex(/^\d{4}-\d{2}$/, 'periodMonth must be "YYYY-MM"')
})
export type BuildClientReportInput = z.infer<typeof buildClientReportInputSchema>

// ---------------------------------------------------------------------
// Denials / A/R / Payers analytics screens (plan §5, Phase 2 chunk B).
// Every query behind these types is scoped by a NULLABLE clientId —
// `null` means "all active clients", the default these screens open
// with — unlike `buildClientReportInputSchema` above, which is always
// exactly one client.
// ---------------------------------------------------------------------

const nullableClientIdSchema = z.number().int().positive().nullable()

export const analyticsScopeInputSchema = z.object({
  clientId: nullableClientIdSchema,
  periodMonth: z.string().regex(/^\d{4}-\d{2}$/)
})
export type AnalyticsScopeInput = z.infer<typeof analyticsScopeInputSchema>

export const analyticsTrendInputSchema = z.object({
  clientId: nullableClientIdSchema,
  endPeriodMonth: z.string().regex(/^\d{4}-\d{2}$/),
  monthsBack: z.number().int().positive().max(24).optional()
})
export type AnalyticsTrendInput = z.infer<typeof analyticsTrendInputSchema>

export const denialListRowSchema = z.object({
  denialId: z.number().int().positive(),
  clientCode: z.string(),
  claimNumber: z.string().nullable(),
  externalRef: z.string().nullable(),
  dos: z.string().nullable(),
  payerName: z.string(),
  carcCode: z.string().nullable(),
  rarcCode: z.string().nullable(),
  category: z.string(),
  rootCauseStage: z.string().nullable(),
  description: z.string().nullable(),
  recoveredAmount: z.number().nullable(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable()
})
export type DenialListRow = z.infer<typeof denialListRowSchema>

export const monthlyRateTrendPointSchema = z.object({
  month: z.string(),
  /** NULL-not-zero: no submitted claims that month, not "0% denied". */
  ratePct: z.number().nullable()
})
export type MonthlyRateTrendPoint = z.infer<typeof monthlyRateTrendPointSchema>

export const arAgingByClientRowSchema = z.object({
  clientCode: z.string(),
  aging: arAgingBucketsSchema
})
export type ArAgingByClientRow = z.infer<typeof arAgingByClientRowSchema>

export const payerVsPatientSplitSchema = z.object({
  insurancePortion: z.number(),
  patientPortion: z.number()
})
export type PayerVsPatientSplit = z.infer<typeof payerVsPatientSplitSchema>

export const topAgedClaimRowSchema = z.object({
  clientCode: z.string(),
  claimNumber: z.string().nullable(),
  externalRef: z.string().nullable(),
  payerName: z.string(),
  dos: z.string().nullable(),
  amount: z.number(),
  daysOpen: z.number()
})
export type TopAgedClaimRow = z.infer<typeof topAgedClaimRowSchema>

export const daysInArTrendPointSchema = z.object({
  month: z.string(),
  daysInAr: z.number().nullable()
})
export type DaysInArTrendPoint = z.infer<typeof daysInArTrendPointSchema>

export const payerAnalysisRowSchema = z.object({
  payerName: z.string(),
  claimsCount: z.number().int().nonnegative(),
  totalCharge: z.number(),
  totalAllowed: z.number(),
  avgCharge: z.number(),
  avgAllowed: z.number(),
  denialCount: z.number().int().nonnegative(),
  denialRatePct: z.number().nullable(),
  /** NULL when this payer has zero remittances in scope — "insufficient data", never a fabricated lag. */
  avgLagDays: z.number().nullable(),
  lagSampleCount: z.number().int().nonnegative()
})
export type PayerAnalysisRow = z.infer<typeof payerAnalysisRowSchema>

export const payerMixTrendPointSchema = z.object({
  month: z.string(),
  payerName: z.string(),
  charges: z.number()
})
export type PayerMixTrendPoint = z.infer<typeof payerMixTrendPointSchema>

export const listDenialsInputSchema = analyticsScopeInputSchema
export type ListDenialsInput = AnalyticsScopeInput

// ---------------------------------------------------------------------
// Branding (plan §6) — committed defaults are neutral; a firm's real
// branding lives in local, uncommitted config (SECURITY.md / CONTRIBUTING.md).
// ---------------------------------------------------------------------

export const brandingSchema = z.object({
  firmName: z.string().min(1),
  logoPath: z.string().nullable(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  secondaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  footerDisclaimer: z.string().nullable(),
  updatedAt: z.string()
})
export type Branding = z.infer<typeof brandingSchema>

export const brandingInputSchema = z.object({
  firmName: z.string().min(1).max(200).optional(),
  primaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  secondaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  footerDisclaimer: z.string().max(500).nullable().optional()
})
export type BrandingInput = z.infer<typeof brandingInputSchema>

// ---------------------------------------------------------------------
// Export engine — PDF/PPTX/XLSX, single + batch (plan §6, Phase 2 chunk B)
// ---------------------------------------------------------------------

export const exportFormatSchema = z.enum(['pdf', 'pptx', 'xlsx'])
export type ExportFormat = z.infer<typeof exportFormatSchema>

export const exportResultSchema = z.object({
  clientCode: z.string(),
  periodMonth: z.string(),
  format: exportFormatSchema,
  filePath: z.string().nullable(),
  error: z.string().nullable()
})
export type ExportResult = z.infer<typeof exportResultSchema>

export const exportClientReportInputSchema = z.object({
  clientId: z.number().int().positive(),
  periodMonth: z.string().regex(/^\d{4}-\d{2}$/),
  formats: z.array(exportFormatSchema).min(1)
})
export type ExportClientReportInput = z.infer<typeof exportClientReportInputSchema>

export const exportReportResultSchema = z.object({ results: z.array(exportResultSchema) })
export type ExportReportResult = z.infer<typeof exportReportResultSchema>

export const batchExportInputSchema = z.object({
  clientIds: z.array(z.number().int().positive()).min(1),
  periodMonth: z.string().regex(/^\d{4}-\d{2}$/),
  formats: z.array(exportFormatSchema).min(1)
})
export type BatchExportInput = z.infer<typeof batchExportInputSchema>

export const batchExportResultSchema = z.object({
  results: z.array(exportResultSchema)
})
export type BatchExportResult = z.infer<typeof batchExportResultSchema>

// ---------------------------------------------------------------------
// Generic RCM Platform REST connector (plan §3 bullet 3, Phase 2 chunk
// C). "Open-source requirements": documented and implemented as a
// generic connector (configurable base URL + OAuth2 password/JWT) —
// rcm-prototype's `/api/reports` surface is the documented *reference
// implementation* (docs/connectors.md), never a hardcoded dependency.
// ---------------------------------------------------------------------

export const connectorSettingsSchema = z.object({
  baseUrl: z.string().nullable(),
  username: z.string().nullable(),
  hasPassword: z.boolean(),
  enabled: z.boolean(),
  /** Whether the stored password used the OS-level `safeStorage` encryption or the documented plaintext fallback — Settings surfaces a warning for the latter. */
  passwordEncoding: z.enum(['safeStorage', 'plaintext']).nullable()
})
export type ConnectorSettings = z.infer<typeof connectorSettingsSchema>

export const connectorSettingsInputSchema = z.object({
  baseUrl: z.string().min(1),
  username: z.string().min(1),
  /** Omit to keep the currently stored password unchanged (e.g. editing the base URL only). */
  password: z.string().min(1).optional(),
  enabled: z.boolean()
})
export type ConnectorSettingsInput = z.infer<typeof connectorSettingsInputSchema>

export const connectorTestResultSchema = z.object({
  ok: z.boolean(),
  message: z.string()
})
export type ConnectorTestResult = z.infer<typeof connectorTestResultSchema>

export const connectorSyncClientResultSchema = z.object({
  clientCode: z.string(),
  ok: z.boolean(),
  created: z.boolean(),
  error: z.string().nullable()
})
export type ConnectorSyncClientResult = z.infer<typeof connectorSyncClientResultSchema>

export const connectorSyncResultSchema = z.object({
  periodMonth: z.string(),
  results: z.array(connectorSyncClientResultSchema)
})
export type ConnectorSyncResult = z.infer<typeof connectorSyncResultSchema>

export const connectorSyncStatusRowSchema = z.object({
  clientCode: z.string(),
  lastSyncedPeriod: z.string().nullable(),
  lastSyncedAt: z.string().nullable(),
  lastStatus: z.string().nullable(),
  lastError: z.string().nullable(),
  createdByConnector: z.boolean()
})
export type ConnectorSyncStatusRow = z.infer<typeof connectorSyncStatusRowSchema>

export const runConnectorSyncInputSchema = z.object({
  periodMonth: z.string().regex(/^\d{4}-\d{2}$/)
})
export type RunConnectorSyncInput = z.infer<typeof runConnectorSyncInputSchema>

// ---------------------------------------------------------------------
// Reference & Benchmark API connector (the beacon paragraph in the
// plan's "Existing assets" — generic, configurable, optional, degrades
// gracefully; `/home/aethera/projects/beacon` at 127.0.0.1:8110 is the
// reference deployment, not a hardcoded dependency).
// ---------------------------------------------------------------------

export const referenceApiSettingsSchema = z.object({
  baseUrl: z.string(),
  enabled: z.boolean(),
  lastHealthOk: z.boolean().nullable(),
  lastHealthAt: z.string().nullable()
})
export type ReferenceApiSettings = z.infer<typeof referenceApiSettingsSchema>

export const referenceApiSettingsInputSchema = z.object({
  baseUrl: z.string().min(1),
  enabled: z.boolean()
})
export type ReferenceApiSettingsInput = z.infer<typeof referenceApiSettingsInputSchema>

export const referenceApiCacheRefreshResultSchema = z.object({
  carc: z.object({ cached: z.number().int(), notFound: z.number().int() }),
  cpt: z.object({ cached: z.number().int(), notFound: z.number().int() })
})
export type ReferenceApiCacheRefreshResult = z.infer<typeof referenceApiCacheRefreshResultSchema>

// ---------------------------------------------------------------------
// Automation suite (plan §11, Phase 2 chunk D): watch-folder auto-import,
// report scheduler, email delivery, and the Automation screen.
// ---------------------------------------------------------------------

/** One `<inbox>/<CLIENT_CODE>/` folder's pinned CSV/XLSX mapping template — X12 files never need one (routed by detect()). */
export const folderTemplatePinSchema = z.object({
  clientCode: z.string(),
  templateId: z.string()
})
export type FolderTemplatePin = z.infer<typeof folderTemplatePinSchema>

export const automationInboxSettingsSchema = z.object({
  inboxRoot: z.string().nullable(),
  folderTemplatePins: z.array(folderTemplatePinSchema)
})
export type AutomationInboxSettings = z.infer<typeof automationInboxSettingsSchema>

export const scanResultSchema = z.object({
  processed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  results: z.array(
    z.object({
      filePath: z.string(),
      clientCode: z.string(),
      ok: z.boolean(),
      action: z.enum(['moved-processed', 'moved-failed']),
      reason: z.string().optional()
    })
  )
})
export type ScanResult = z.infer<typeof scanResultSchema>

/** A report-scheduler rule (plan §11's `{rule_id, name, day_of_month, period: prior_month, clients, formats, output_dir, deliver, enabled}`). */
export const automationRuleSchema = z.object({
  ruleId: z.string().min(1),
  name: z.string().min(1),
  /** 1-31; a value past a given month's day count simply never fires that month (documented — use <= 28 to guarantee monthly firing). */
  dayOfMonth: z.number().int().min(1).max(31),
  clients: z.union([z.literal('all'), z.array(z.string())]),
  formats: z.array(exportFormatSchema).min(1),
  outputDir: z.string().nullable(),
  deliver: z.enum(['none', 'email']),
  enabled: z.boolean(),
  /** "YYYY-MM" of the period this rule last successfully ran for — the once-per-period guard (plan §11). */
  lastRunPeriod: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastRunStatus: z.string().nullable()
})
export type AutomationRule = z.infer<typeof automationRuleSchema>

export const automationRuleInputSchema = z.object({
  ruleId: z.string().min(1).optional(),
  name: z.string().min(1).max(200),
  dayOfMonth: z.number().int().min(1).max(31),
  clients: z.union([z.literal('all'), z.array(z.string())]),
  formats: z.array(exportFormatSchema).min(1),
  outputDir: z.string().nullable().optional(),
  deliver: z.enum(['none', 'email']),
  enabled: z.boolean()
})
export type AutomationRuleInput = z.infer<typeof automationRuleInputSchema>

export const runRuleResultSchema = z.object({
  ruleId: z.string(),
  periodMonth: z.string(),
  clientResults: z.array(exportResultSchema),
  emailResults: z.array(
    z.object({ clientCode: z.string(), ok: z.boolean(), error: z.string().nullable() })
  )
})
export type RunRuleResult = z.infer<typeof runRuleResultSchema>

/** "What would happen" preview for a rule (Automation screen's dry-run button) — never actually exports or sends. */
export const dryRunResultSchema = z.object({
  ruleId: z.string(),
  periodMonth: z.string(),
  clientCodes: z.array(z.string()),
  formats: z.array(exportFormatSchema),
  wouldDeliverEmail: z.boolean(),
  recipientsByClient: z.record(z.string(), z.array(z.string()))
})
export type DryRunResult = z.infer<typeof dryRunResultSchema>

export const emailSettingsSchema = z.object({
  host: z.string().nullable(),
  port: z.number().int().nullable(),
  secure: z.boolean(),
  username: z.string().nullable(),
  hasPassword: z.boolean(),
  passwordEncoding: z.enum(['safeStorage', 'plaintext']).nullable(),
  fromAddress: z.string().nullable(),
  subjectTemplate: z.string(),
  bodyTemplate: z.string()
})
export type EmailSettings = z.infer<typeof emailSettingsSchema>

export const emailSettingsInputSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive(),
  secure: z.boolean(),
  username: z.string().nullable().optional(),
  /** Omit to keep the currently stored password unchanged. */
  password: z.string().min(1).optional(),
  fromAddress: z.string().email(),
  subjectTemplate: z.string().min(1),
  bodyTemplate: z.string().min(1)
})
export type EmailSettingsInput = z.infer<typeof emailSettingsInputSchema>

export const emailSendQueueRowSchema = z.object({
  queueId: z.number().int().positive(),
  clientCode: z.string(),
  periodMonth: z.string(),
  filePaths: z.array(z.string()),
  recipients: z.array(z.string()),
  subject: z.string(),
  body: z.string(),
  status: z.enum(['pending', 'sent', 'failed']),
  attempts: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  lastAttemptAt: z.string().nullable()
})
export type EmailSendQueueRow = z.infer<typeof emailSendQueueRowSchema>

export const sendReportPackInputSchema = z.object({
  clientId: z.number().int().positive(),
  periodMonth: z.string().regex(/^\d{4}-\d{2}$/),
  formats: z.array(exportFormatSchema).min(1)
})
export type SendReportPackInput = z.infer<typeof sendReportPackInputSchema>

export const sendReportPackResultSchema = z.object({
  clientCode: z.string(),
  ok: z.boolean(),
  error: z.string().nullable(),
  queued: z.boolean()
})
export type SendReportPackResult = z.infer<typeof sendReportPackResultSchema>

/** One row from the export audit log (plan §6) — read back for the Automation screen's run history (plan §11). */
export const exportAuditLogRowSchema = z.object({
  auditId: z.number().int().positive(),
  action: z.string(),
  clientCode: z.string().nullable(),
  periodMonth: z.string().nullable(),
  filePath: z.string().nullable(),
  performedAt: z.string(),
  performedBy: z.string().nullable()
})
export type ExportAuditLogRow = z.infer<typeof exportAuditLogRowSchema>

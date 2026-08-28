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
  reportRecipients: z.array(z.string().email()).optional()
})
export type NewClientInput = z.infer<typeof newClientInputSchema>

export const clientPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  contractType: z.string().max(100).nullable().optional(),
  contractRate: z.number().min(0).max(1).nullable().optional(),
  slaDaysToSubmit: z.number().int().positive().nullable().optional(),
  reportRecipients: z.array(z.string().email()).optional(),
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
  priorValues: z.unknown().nullable()
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
  payerMix: z.array(z.object({ payerName: z.string(), charges: z.number() }))
})
export type ClientReport = z.infer<typeof clientReportSchema>

export const buildClientReportInputSchema = z.object({
  clientId: z.number().int().positive(),
  periodMonth: z.string().regex(/^\d{4}-\d{2}$/, 'periodMonth must be "YYYY-MM"')
})
export type BuildClientReportInput = z.infer<typeof buildClientReportInputSchema>

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
// PDF export / batch export (plan §6)
// ---------------------------------------------------------------------

export const exportClientPdfInputSchema = z.object({
  clientId: z.number().int().positive(),
  periodMonth: z.string().regex(/^\d{4}-\d{2}$/)
})
export type ExportClientPdfInput = z.infer<typeof exportClientPdfInputSchema>

export const exportResultSchema = z.object({
  clientCode: z.string(),
  periodMonth: z.string(),
  filePath: z.string().nullable(),
  error: z.string().nullable()
})
export type ExportResult = z.infer<typeof exportResultSchema>

export const batchExportInputSchema = z.object({
  clientIds: z.array(z.number().int().positive()).min(1),
  periodMonth: z.string().regex(/^\d{4}-\d{2}$/)
})
export type BatchExportInput = z.infer<typeof batchExportInputSchema>

export const batchExportResultSchema = z.object({
  results: z.array(exportResultSchema)
})
export type BatchExportResult = z.infer<typeof batchExportResultSchema>

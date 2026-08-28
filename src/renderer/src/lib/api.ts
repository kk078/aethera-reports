/**
 * Thin typed wrapper over `window.aethera.invoke` (plan §5). Screens and
 * data hooks call functions from here, never `window.aethera` directly —
 * that keeps the IPC channel names in exactly one place.
 */
import type {
  Branding,
  BrandingInput,
  Client,
  ClientPatch,
  ClientReport,
  ExportResult,
  ImportFileKind,
  ImportJob,
  MappingTemplate,
  MonthlySummary,
  MonthlySummaryInput,
  NewClientInput,
  NewMappingTemplateInput,
  QuarantineRow,
  RunCsvImportInput,
  RunX12ImportInput,
  X12ParseSummary,
  BackupStatus
} from '../../../shared/domain'
import type { IpcRequest, IpcResponse } from '../../../shared/ipc-contract'

export function ping(message: string): Promise<IpcResponse<'ping'>> {
  const payload: IpcRequest<'ping'> = { message }
  return window.aethera.invoke('ping', payload)
}

// --- Clients ---

export async function listClients(): Promise<Client[]> {
  const { clients } = await window.aethera.invoke('clients:list', {})
  return clients
}

export function createClient(input: NewClientInput): Promise<Client> {
  return window.aethera.invoke('clients:create', input)
}

export function updateClient(clientId: number, patch: ClientPatch): Promise<Client> {
  return window.aethera.invoke('clients:update', { clientId, patch })
}

export function deactivateClient(clientId: number): Promise<Client> {
  return window.aethera.invoke('clients:deactivate', { clientId })
}

// --- Mapping templates ---

export async function listMappingTemplates(): Promise<MappingTemplate[]> {
  const { templates } = await window.aethera.invoke('mappingTemplates:list', {})
  return templates
}

export function saveMappingTemplate(input: NewMappingTemplateInput): Promise<MappingTemplate> {
  return window.aethera.invoke('mappingTemplates:save', input)
}

export async function exportMappingTemplateToFile(templateId: string): Promise<string | null> {
  const { filePath } = await window.aethera.invoke('mappingTemplates:exportToFile', { templateId })
  return filePath
}

export async function importMappingTemplateFromFile(): Promise<MappingTemplate | null> {
  const { template } = await window.aethera.invoke('mappingTemplates:importFromFile', {})
  return template
}

// --- Imports ---

export async function listImportJobs(): Promise<ImportJob[]> {
  const { jobs } = await window.aethera.invoke('importJobs:list', {})
  return jobs
}

export async function getImportJob(jobId: number): Promise<ImportJob | null> {
  const { job } = await window.aethera.invoke('importJobs:get', { jobId })
  return job
}

export function runCsvImport(input: RunCsvImportInput): Promise<ImportJob> {
  return window.aethera.invoke('importJobs:runCsv', input)
}

export async function listQuarantineRows(jobId: number): Promise<QuarantineRow[]> {
  const { rows } = await window.aethera.invoke('importJobs:listQuarantine', { jobId })
  return rows
}

export async function pickImportFile(): Promise<string | null> {
  const { filePath } = await window.aethera.invoke('importJobs:pickFile', {})
  return filePath
}

export async function peekFileHeaders(filePath: string): Promise<string[]> {
  const { headers } = await window.aethera.invoke('importJobs:peekHeaders', { filePath })
  return headers
}

export async function suggestMapping(
  headers: string[]
): Promise<IpcResponse<'importJobs:suggestMapping'>['suggestions']> {
  const { suggestions } = await window.aethera.invoke('importJobs:suggestMapping', { headers })
  return suggestions
}

export async function previewMapping(
  filePath: string,
  mapping: NewMappingTemplateInput
): Promise<IpcResponse<'importJobs:previewMapping'>['rows']> {
  const { rows } = await window.aethera.invoke('importJobs:previewMapping', { filePath, mapping })
  return rows
}

// --- X12 835/837 ---

export async function detectImportFileKind(filePath: string): Promise<ImportFileKind> {
  const { kind } = await window.aethera.invoke('importJobs:detectFileKind', { filePath })
  return kind
}

export async function previewX12Import(filePath: string): Promise<X12ParseSummary> {
  const { summary } = await window.aethera.invoke('importJobs:previewX12', { filePath })
  return summary
}

export function runX12Import(input: RunX12ImportInput): Promise<ImportJob> {
  return window.aethera.invoke('importJobs:runX12', input)
}

// --- Manual entry ---

export function upsertMonthlySummary(input: MonthlySummaryInput): Promise<MonthlySummary> {
  return window.aethera.invoke('manualEntry:upsert', input)
}

export async function getMonthlySummary(
  clientId: number,
  periodMonth: string
): Promise<MonthlySummary | null> {
  const { summary } = await window.aethera.invoke('manualEntry:get', { clientId, periodMonth })
  return summary
}

// --- Reports (KPI engine) ---

export function getClientReport(clientId: number, periodMonth: string): Promise<ClientReport> {
  return window.aethera.invoke('reports:client', { clientId, periodMonth })
}

export async function getPortfolioReports(periodMonth: string): Promise<ClientReport[]> {
  const { reports } = await window.aethera.invoke('reports:portfolio', { periodMonth })
  return reports
}

export async function getClientFinancialTrend(
  clientId: number,
  endPeriodMonth: string,
  monthsBack?: number
): Promise<Array<{ month: string; grossCharges: number; totalCollections: number }>> {
  const { points } = await window.aethera.invoke('reports:trend', {
    clientId,
    endPeriodMonth,
    monthsBack
  })
  return points
}

// --- Backups ---

export function getBackupStatus(): Promise<BackupStatus> {
  return window.aethera.invoke('backups:status', {})
}

export function runBackupNow(): Promise<BackupStatus> {
  return window.aethera.invoke('backups:runNow', {})
}

export function restoreLatestBackup(): Promise<{ restoredFrom: string }> {
  return window.aethera.invoke('backups:restoreLatest', {})
}

// --- Branding ---

export function getBranding(): Promise<Branding> {
  return window.aethera.invoke('branding:get', {})
}

export function updateBranding(input: BrandingInput): Promise<Branding> {
  return window.aethera.invoke('branding:update', input)
}

export function pickAndSetBrandingLogo(): Promise<Branding> {
  return window.aethera.invoke('branding:pickAndSetLogo', {})
}

// --- PDF export ---

export function generateClientReportPdf(
  clientId: number,
  periodMonth: string
): Promise<ExportResult> {
  return window.aethera.invoke('exports:generatePdf', { clientId, periodMonth })
}

export async function generateClientReportPdfBatch(
  clientIds: number[],
  periodMonth: string
): Promise<ExportResult[]> {
  const { results } = await window.aethera.invoke('exports:generateBatch', {
    clientIds,
    periodMonth
  })
  return results
}

// --- Print route internal signal ---

export function signalPrintReady(): Promise<{ ok: boolean }> {
  return window.aethera.invoke('reports:printReady', {})
}

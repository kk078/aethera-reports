/**
 * XLSX export (plan §6): a Summary sheet (KPI scorecard + financials)
 * plus per-section sheets — A/R aging, denials (with CARC codes), payer
 * mix, claims-by-status, monthly trend — each with real Excel formulas
 * for totals where natural, and a branding header row on every sheet.
 */
import ExcelJS from 'exceljs'
import { writeFile } from 'node:fs/promises'
import type { IDataService } from '../services/data-service'
import type { Branding, ClientReport, ExportResult } from '../../shared/domain'
import { reportXlsxPath } from './paths'

const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF1A1A19' }
}
const LABEL_FONT: Partial<ExcelJS.Font> = { bold: true }

function argbFromHex(hexColor: string): string {
  return `FF${hexColor.replace('#', '').toUpperCase()}`
}

/** Firm-name + client/period header on row 1-2 of a sheet (plan §6 branding). */
function addBrandingHeader(
  sheet: ExcelJS.Worksheet,
  branding: Branding,
  report: ClientReport,
  lastCol: number
): void {
  sheet.mergeCells(1, 1, 1, Math.max(2, lastCol))
  const firmCell = sheet.getCell(1, 1)
  firmCell.value = branding.firmName
  firmCell.font = { bold: true, size: 14, color: { argb: argbFromHex(branding.primaryColor) } }

  sheet.mergeCells(2, 1, 2, Math.max(2, lastCol))
  const clientCell = sheet.getCell(2, 1)
  clientCell.value = `${report.client.name} (${report.client.code}) — ${report.period.start} to ${report.period.end}`
  clientCell.font = { italic: true, size: 10 }

  sheet.getRow(1).height = 20
}

function fmtPctValue(value: number | null): string | number {
  return value === null ? 'no data' : value / 100
}

function addLabelValueRows(
  sheet: ExcelJS.Worksheet,
  startRow: number,
  rows: Array<[string, ExcelJS.CellValue, string?]>
): number {
  let row = startRow
  for (const [label, value, numFmt] of rows) {
    sheet.getCell(row, 1).value = label
    sheet.getCell(row, 1).font = LABEL_FONT
    const cell = sheet.getCell(row, 2)
    cell.value = value
    if (numFmt) cell.numFmt = numFmt
    row += 1
  }
  return row
}

function buildSummarySheet(
  workbook: ExcelJS.Workbook,
  branding: Branding,
  report: ClientReport
): void {
  const sheet = workbook.addWorksheet('Summary')
  sheet.columns = [{ width: 28 }, { width: 22 }]
  addBrandingHeader(sheet, branding, report, 2)

  let row = 4
  sheet.getCell(row, 1).value = 'Financials'
  sheet.getCell(row, 1).font = { bold: true, size: 12 }
  row += 1

  // Real formulas for the totals where they're a natural sum of rows
  // already on the sheet, per plan §6.
  const insRow = row
  sheet.getCell(insRow, 1).value = 'Insurance collections'
  sheet.getCell(insRow, 1).font = LABEL_FONT
  sheet.getCell(insRow, 2).value = report.financials.insuranceCollections
  sheet.getCell(insRow, 2).numFmt = '$#,##0.00'
  const ptRow = insRow + 1
  sheet.getCell(ptRow, 1).value = 'Patient collections'
  sheet.getCell(ptRow, 1).font = LABEL_FONT
  sheet.getCell(ptRow, 2).value = report.financials.patientCollections
  sheet.getCell(ptRow, 2).numFmt = '$#,##0.00'
  const totalRow = ptRow + 1
  sheet.getCell(totalRow, 1).value = 'Total collections'
  sheet.getCell(totalRow, 1).font = LABEL_FONT
  sheet.getCell(totalRow, 2).value = { formula: `B${insRow}+B${ptRow}` }
  sheet.getCell(totalRow, 2).numFmt = '$#,##0.00'
  row = totalRow + 1

  row = addLabelValueRows(sheet, row, [
    ['Gross charges', report.financials.grossCharges, '$#,##0.00'],
    ['RCM fee', report.financials.rcmFee, '$#,##0.00'],
    ['Net collection rate', fmtPctValue(report.financials.netCollectionRatePct), '0.0%']
  ])

  row += 1
  sheet.getCell(row, 1).value = 'KPIs'
  sheet.getCell(row, 1).font = { bold: true, size: 12 }
  row += 1
  addLabelValueRows(sheet, row, [
    ['Days in A/R', report.kpis.daysInAr ?? 'no data'],
    ['Open A/R', report.kpis.openAr, '$#,##0.00'],
    ['A/R over 90 days', report.kpis.arOver90Pct / 100, '0.0%'],
    ['Charge lag (days, avg)', report.kpis.chargeLagDaysAvg ?? 'no data'],
    ['SLA days to submit', report.kpis.slaDaysToSubmit ?? 'no data'],
    ['SLA met %', fmtPctValue(report.kpis.slaMetPct), '0.0%'],
    ['First-pass acceptance', fmtPctValue(report.kpis.firstPassAcceptancePct), '0.0%'],
    ['Denial rate', fmtPctValue(report.kpis.denialRatePct), '0.0%']
  ])
}

function buildArAgingSheet(
  workbook: ExcelJS.Workbook,
  branding: Branding,
  report: ClientReport
): void {
  const sheet = workbook.addWorksheet('AR Aging')
  sheet.columns = [{ width: 16 }, { width: 18 }]
  addBrandingHeader(sheet, branding, report, 2)

  const headerRow = 4
  sheet.getRow(headerRow).values = ['Bucket', 'Amount']
  sheet.getRow(headerRow).font = { bold: true }
  sheet.getRow(headerRow).fill = HEADER_FILL
  sheet.getRow(headerRow).font = { bold: true, color: { argb: 'FFFFFFFF' } }

  const buckets = Object.entries(report.arAging)
  let row = headerRow + 1
  for (const [bucket, amount] of buckets) {
    sheet.getCell(row, 1).value = bucket
    sheet.getCell(row, 2).value = amount
    sheet.getCell(row, 2).numFmt = '$#,##0.00'
    row += 1
  }
  const firstDataRow = headerRow + 1
  const lastDataRow = row - 1
  sheet.getCell(row, 1).value = 'Total'
  sheet.getCell(row, 1).font = LABEL_FONT
  sheet.getCell(row, 2).value = { formula: `SUM(B${firstDataRow}:B${lastDataRow})` }
  sheet.getCell(row, 2).numFmt = '$#,##0.00'
}

function buildDenialsSheet(
  workbook: ExcelJS.Workbook,
  branding: Branding,
  report: ClientReport,
  denials: Awaited<ReturnType<IDataService['listDenials']>>,
  carcDescriptions: Record<string, string>
): void {
  const sheet = workbook.addWorksheet('Denials')
  sheet.columns = [
    { width: 16 }, // claim number
    { width: 12 }, // dos
    { width: 20 }, // payer
    { width: 10 }, // carc
    { width: 22 }, // category
    { width: 18 }, // root cause
    { width: 30 }, // description
    { width: 16 }, // recovered amount
    { width: 20 } // created at
  ]
  addBrandingHeader(sheet, branding, report, 9)

  const headerRow = 4
  sheet.getRow(headerRow).values = [
    'Claim Number',
    'DOS',
    'Payer',
    'CARC Code',
    'Category',
    'Root Cause',
    'Description',
    'Recovered Amount',
    'Created At'
  ]
  sheet.getRow(headerRow).font = { bold: true, color: { argb: 'FFFFFFFF' } }
  sheet.getRow(headerRow).fill = HEADER_FILL

  let row = headerRow + 1
  if (denials.length === 0) {
    sheet.getCell(row, 1).value = 'No denials in this period.'
  } else {
    for (const denial of denials) {
      sheet.getCell(row, 1).value = denial.claimNumber ?? denial.externalRef ?? ''
      sheet.getCell(row, 2).value = denial.dos ?? ''
      sheet.getCell(row, 3).value = denial.payerName
      sheet.getCell(row, 4).value = denial.carcCode ?? ''
      sheet.getCell(row, 5).value = denial.category
      sheet.getCell(row, 6).value = denial.rootCauseStage ?? ''
      // Cached Reference & Benchmark API description (plan chunk C) fills
      // in when the denial row itself has none (our importers don't
      // populate `denials.description`).
      sheet.getCell(row, 7).value =
        denial.description ?? (denial.carcCode ? (carcDescriptions[denial.carcCode] ?? '') : '')
      if (denial.recoveredAmount !== null) {
        sheet.getCell(row, 8).value = denial.recoveredAmount
        sheet.getCell(row, 8).numFmt = '$#,##0.00'
      }
      sheet.getCell(row, 9).value = denial.createdAt
      row += 1
    }
  }
}

function buildPayerMixSheet(
  workbook: ExcelJS.Workbook,
  branding: Branding,
  report: ClientReport
): void {
  const sheet = workbook.addWorksheet('Payer Mix')
  sheet.columns = [{ width: 26 }, { width: 18 }]
  addBrandingHeader(sheet, branding, report, 2)

  const headerRow = 4
  sheet.getRow(headerRow).values = ['Payer', 'Charges']
  sheet.getRow(headerRow).font = { bold: true, color: { argb: 'FFFFFFFF' } }
  sheet.getRow(headerRow).fill = HEADER_FILL

  let row = headerRow + 1
  if (report.payerMix.length === 0) {
    sheet.getCell(row, 1).value = 'No claims in this period.'
    return
  }
  for (const payer of report.payerMix) {
    sheet.getCell(row, 1).value = payer.payerName
    sheet.getCell(row, 2).value = payer.charges
    sheet.getCell(row, 2).numFmt = '$#,##0.00'
    row += 1
  }
  const firstDataRow = headerRow + 1
  const lastDataRow = row - 1
  sheet.getCell(row, 1).value = 'Total'
  sheet.getCell(row, 1).font = LABEL_FONT
  sheet.getCell(row, 2).value = { formula: `SUM(B${firstDataRow}:B${lastDataRow})` }
  sheet.getCell(row, 2).numFmt = '$#,##0.00'
}

function buildClaimsByStatusSheet(
  workbook: ExcelJS.Workbook,
  branding: Branding,
  report: ClientReport
): void {
  const sheet = workbook.addWorksheet('Claims by Status')
  sheet.columns = [{ width: 20 }, { width: 12 }]
  addBrandingHeader(sheet, branding, report, 2)

  const headerRow = 4
  sheet.getRow(headerRow).values = ['Status', 'Count']
  sheet.getRow(headerRow).font = { bold: true, color: { argb: 'FFFFFFFF' } }
  sheet.getRow(headerRow).fill = HEADER_FILL

  const entries = Object.entries(report.claimsByStatus)
  let row = headerRow + 1
  if (entries.length === 0) {
    sheet.getCell(row, 1).value = 'No claims yet.'
    return
  }
  for (const [status, count] of entries) {
    sheet.getCell(row, 1).value = status
    sheet.getCell(row, 2).value = count
    row += 1
  }
  const firstDataRow = headerRow + 1
  const lastDataRow = row - 1
  sheet.getCell(row, 1).value = 'Total'
  sheet.getCell(row, 1).font = LABEL_FONT
  sheet.getCell(row, 2).value = { formula: `SUM(B${firstDataRow}:B${lastDataRow})` }
}

function buildMonthlyTrendSheet(
  workbook: ExcelJS.Workbook,
  branding: Branding,
  report: ClientReport,
  trend: Array<{ month: string; grossCharges: number; totalCollections: number }>
): void {
  const sheet = workbook.addWorksheet('Monthly Trend')
  sheet.columns = [{ width: 12 }, { width: 18 }, { width: 18 }, { width: 22 }]
  addBrandingHeader(sheet, branding, report, 4)

  const headerRow = 4
  sheet.getRow(headerRow).values = [
    'Month',
    'Gross Charges',
    'Total Collections',
    'Collections % of Charges'
  ]
  sheet.getRow(headerRow).font = { bold: true, color: { argb: 'FFFFFFFF' } }
  sheet.getRow(headerRow).fill = HEADER_FILL

  let row = headerRow + 1
  if (trend.length === 0) {
    sheet.getCell(row, 1).value = 'Not enough history yet.'
    return
  }
  for (const point of trend) {
    sheet.getCell(row, 1).value = point.month
    sheet.getCell(row, 2).value = point.grossCharges
    sheet.getCell(row, 2).numFmt = '$#,##0.00'
    sheet.getCell(row, 3).value = point.totalCollections
    sheet.getCell(row, 3).numFmt = '$#,##0.00'
    // Guard divide-by-zero with a formula rather than a TS-computed
    // value, so the sheet stays a live spreadsheet if someone edits the
    // charge figures afterward.
    sheet.getCell(row, 4).value = { formula: `IF(B${row}=0,"",C${row}/B${row})` }
    sheet.getCell(row, 4).numFmt = '0.0%'
    row += 1
  }
}

export async function renderClientReportXlsxBuffer(
  dataService: IDataService,
  clientId: number,
  periodMonth: string
): Promise<Buffer> {
  const [report, branding, trend, denials] = await Promise.all([
    dataService.buildClientReport(clientId, periodMonth),
    dataService.getBranding(),
    dataService.getClientFinancialTrend(clientId, periodMonth),
    dataService.listDenials(clientId, periodMonth)
  ])
  const carcCodes = Array.from(
    new Set(denials.map((d) => d.carcCode).filter((c): c is string => !!c))
  )
  const carcDescriptions =
    carcCodes.length > 0 ? await dataService.getCarcDescriptions(carcCodes) : {}

  const workbook = new ExcelJS.Workbook()
  workbook.creator = branding.firmName
  workbook.created = new Date()

  buildSummarySheet(workbook, branding, report)
  buildArAgingSheet(workbook, branding, report)
  buildDenialsSheet(workbook, branding, report, denials, carcDescriptions)
  buildPayerMixSheet(workbook, branding, report)
  buildClaimsByStatusSheet(workbook, branding, report)
  buildMonthlyTrendSheet(workbook, branding, report, trend)

  const buffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(buffer)
}

export async function exportClientReportXlsx(
  dataService: IDataService,
  clientId: number,
  periodMonth: string
): Promise<ExportResult> {
  const client = (await dataService.listClients()).find((c) => c.clientId === clientId) ?? null
  if (!client) {
    return {
      clientCode: `#${clientId}`,
      periodMonth,
      format: 'xlsx',
      filePath: null,
      error: 'Client not found'
    }
  }

  try {
    const buffer = await renderClientReportXlsxBuffer(dataService, clientId, periodMonth)
    const filePath = reportXlsxPath(periodMonth, client.code)
    await writeFile(filePath, buffer)
    dataService.recordExport({
      action: 'export_xlsx',
      clientCode: client.code,
      periodMonth,
      filePath
    })
    return { clientCode: client.code, periodMonth, format: 'xlsx', filePath, error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { clientCode: client.code, periodMonth, format: 'xlsx', filePath: null, error: message }
  }
}

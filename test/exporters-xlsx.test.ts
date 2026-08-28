/**
 * XLSX exporter tests (plan §6, Phase 2 chunk B). `renderClientReportXlsxBuffer`
 * has no Electron dependency (unlike the PDF/PPTX paths, which need a
 * live offscreen `BrowserWindow` to capture charts) — it only calls
 * `IDataService` methods, so it's fully testable against a real
 * `LocalDataService` seeded with fixture data, reading the result back
 * with `exceljs` exactly like a user opening the file would.
 */
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import ExcelJS from 'exceljs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDataService } from '../src/main/services/local-data-service'
import { renderClientReportXlsxBuffer } from '../src/main/exporters/xlsx'

/**
 * `exceljs`'s bundled `@types/node` resolves to a different (structurally
 * incompatible) `Buffer` generic than this project's own — a pure
 * type-level skew, not a real value mismatch — so `workbook.xlsx.load`
 * needs an escape-hatch cast at the boundary.
 */
async function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0])
  return workbook
}

describe('renderClientReportXlsxBuffer', () => {
  let dir: string
  let service: LocalDataService
  let clientId: number

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aethera-xlsx-export-test-'))
    service = await LocalDataService.create({
      duckdbPath: join(dir, 'analytics.duckdb'),
      metaDbPath: join(dir, 'meta.db'),
      backupsDir: join(dir, 'backups')
    })

    const client = await service.createClient({
      code: 'XLSXCO',
      name: 'XLSX Export Co',
      contractType: 'PERCENT_OF_COLLECTIONS',
      contractRate: 0.05
    })
    clientId = client.clientId

    // Reach into the DuckDB connection directly (same pattern as the
    // other kpi/importer tests) to seed a claim + a denial with a CARC
    // code, so the Denials sheet has something real to render.
    const conn = (
      service as unknown as { duckdb: { connection: import('@duckdb/node-api').DuckDBConnection } }
    ).duckdb.connection
    const claim = await conn.runAndReadAll(
      `INSERT INTO claims (client_id, patient_key, claim_number, dos, created_at, first_submitted_at,
         status, total_charge, total_allowed, total_paid, patient_responsibility, patient_paid, balance, source, natural_key)
       VALUES (?, 'ph-x', 'XLSX-CLM-1', '2026-02-01', '2026-02-01T00:00:00Z', '2026-02-02T00:00:00Z',
         'Open', 1000, 800, 600, 100, 50, 400, 'manual', 'xlsx-nk-1')
       RETURNING claim_id`,
      [clientId]
    )
    const claimId = Number(claim.getRowObjectsJS()[0].claim_id)
    await conn.run(
      `INSERT INTO denials (claim_id, carc_code, category, root_cause_stage, created_at) VALUES (?, 'CO-97', 'contractual_obligation', 'BUNDLING', '2026-02-05T00:00:00Z')`,
      [claimId]
    )
  })

  afterEach(() => {
    service.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('builds a workbook with every expected sheet, branding header, and CARC-level denial row', async () => {
    const buffer = await renderClientReportXlsxBuffer(service, clientId, '2026-02')
    expect(buffer.length).toBeGreaterThan(0)

    const workbook = await loadWorkbook(buffer)

    const sheetNames = workbook.worksheets.map((s) => s.name)
    expect(sheetNames).toEqual([
      'Summary',
      'AR Aging',
      'Denials',
      'Payer Mix',
      'Claims by Status',
      'Monthly Trend'
    ])

    // Branding header row 1 on every sheet (plan §6).
    for (const sheet of workbook.worksheets) {
      // Neutral committed default (plan §6 branding — a firm's real branding lives in local config).
      expect(String(sheet.getCell(1, 1).value)).toContain('Aethera Reports')
    }

    const summary = workbook.getWorksheet('Summary')!
    const summaryValues: string[] = []
    summary.eachRow((row) => {
      const label = row.getCell(1).value
      if (typeof label === 'string') summaryValues.push(label)
    })
    expect(summaryValues).toContain('Gross charges')
    expect(summaryValues).toContain('Days in A/R')

    const denials = workbook.getWorksheet('Denials')!
    // Header row 4, first data row 5 (see xlsx.ts's addBrandingHeader + headerRow=4 convention).
    expect(denials.getCell(4, 1).value).toBe('Claim Number')
    expect(denials.getCell(5, 1).value).toBe('XLSX-CLM-1')
    expect(denials.getCell(5, 4).value).toBe('CO-97') // CARC code column
    expect(denials.getCell(5, 5).value).toBe('contractual_obligation')
  })

  it('writes a real SUM formula for the A/R Aging total row, not a pre-computed constant', async () => {
    const buffer = await renderClientReportXlsxBuffer(service, clientId, '2026-02')
    const workbook = await loadWorkbook(buffer)

    const aging = workbook.getWorksheet('AR Aging')!
    // header row 4, 5 bucket rows (5-9), total row 10.
    const totalCell = aging.getCell(10, 2)
    const value = totalCell.value as ExcelJS.CellFormulaValue
    expect(value.formula).toBe('SUM(B5:B9)')
  })

  it('writes a divide-by-zero-guarded formula on the Monthly Trend sheet', async () => {
    const buffer = await renderClientReportXlsxBuffer(service, clientId, '2026-02')
    const workbook = await loadWorkbook(buffer)

    const trend = workbook.getWorksheet('Monthly Trend')!
    const firstDataRowCell = trend.getCell(5, 4).value as ExcelJS.CellFormulaValue
    expect(firstDataRowCell.formula).toContain('IF(B5=0')
  })

  it('renders "no denials" gracefully for a client-period with none (never crashes on empty data)', async () => {
    const other = await service.createClient({ code: 'XLSXEMPTY', name: 'Empty Co' })
    const buffer = await renderClientReportXlsxBuffer(service, other.clientId, '2026-02')
    const workbook = await loadWorkbook(buffer)
    const denials = workbook.getWorksheet('Denials')!
    expect(denials.getCell(5, 1).value).toBe('No denials in this period.')
  })
})

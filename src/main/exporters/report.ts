/**
 * Single entry point for "export this client's report in these formats"
 * (plan §6) — used by the `exports:generateReport` IPC handler, the
 * batch queue, and the headless CLI's `--formats pdf,pptx,xlsx`, so all
 * three callers exercise the exact same per-format export path.
 */
import { exportClientReportPdf } from './pdf'
import { exportClientReportPptx } from './pptx'
import { exportClientReportXlsx } from './xlsx'
import type { IDataService } from '../services/data-service'
import type { ExportFormat, ExportResult } from '../../shared/domain'

/** One client, one period, N formats — run sequentially per client (each format opens its own offscreen window). */
export async function exportClientReport(
  dataService: IDataService,
  clientId: number,
  periodMonth: string,
  formats: ExportFormat[]
): Promise<ExportResult[]> {
  const results: ExportResult[] = []
  for (const format of formats) {
    switch (format) {
      case 'pdf':
        results.push(await exportClientReportPdf(dataService, clientId, periodMonth))
        break
      case 'pptx':
        results.push(await exportClientReportPptx(dataService, clientId, periodMonth))
        break
      case 'xlsx':
        results.push(await exportClientReportXlsx(dataService, clientId, periodMonth))
        break
    }
  }
  return results
}

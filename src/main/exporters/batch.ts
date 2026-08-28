/**
 * Batch export queue (plan §6): multiple clients × one period, at most 2
 * concurrent PDF renders, per-client failure isolation (one client's
 * export failing never aborts the others). A tiny inline concurrency
 * limiter — the whole job is "run at most N of these promises at once,"
 * which doesn't need a dependency.
 */
import { exportClientReportPdf } from './pdf'
import type { IDataService } from '../services/data-service'
import type { ExportResult } from '../../shared/domain'

const BATCH_CONCURRENCY = 2

async function runWithConcurrencyLimit<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let index = 0
  async function next(): Promise<void> {
    const current = index++
    if (current >= items.length) return
    await worker(items[current])
    await next()
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => next()))
}

export async function exportClientReportPdfBatch(
  dataService: IDataService,
  clientIds: number[],
  periodMonth: string,
  onProgress?: (completed: number, total: number, result: ExportResult) => void
): Promise<ExportResult[]> {
  const results: ExportResult[] = []
  let completed = 0

  await runWithConcurrencyLimit(clientIds, BATCH_CONCURRENCY, async (clientId) => {
    // Per-client failure isolation: exportClientReportPdf already
    // catches its own errors and returns them in the result rather than
    // throwing, so one bad client can't take down the batch.
    const result = await exportClientReportPdf(dataService, clientId, periodMonth)
    results.push(result)
    completed += 1
    onProgress?.(completed, clientIds.length, result)
  })

  return results
}

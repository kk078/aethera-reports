/**
 * Batch export queue (plan §6): multiple clients × one period × one or
 * more formats, at most 2 clients rendering concurrently, per-client
 * (and per-format) failure isolation — one client's export failing, or
 * one format failing for an otherwise-fine client, never aborts the
 * rest. A tiny inline concurrency limiter — the whole job is "run at
 * most N of these promises at once," which doesn't need a dependency.
 */
import { exportClientReport } from './report'
import type { IDataService } from '../services/data-service'
import type { ExportFormat, ExportResult } from '../../shared/domain'

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

export async function exportClientReportBatch(
  dataService: IDataService,
  clientIds: number[],
  periodMonth: string,
  formats: ExportFormat[],
  onProgress?: (completed: number, total: number, results: ExportResult[]) => void
): Promise<ExportResult[]> {
  const results: ExportResult[] = []
  let completed = 0

  await runWithConcurrencyLimit(clientIds, BATCH_CONCURRENCY, async (clientId) => {
    // Per-client failure isolation: each per-format exporter already
    // catches its own errors and returns them in the result rather than
    // throwing, so one bad client/format can't take down the batch.
    const clientResults = await exportClientReport(dataService, clientId, periodMonth, formats)
    results.push(...clientResults)
    completed += 1
    onProgress?.(completed, clientIds.length, clientResults)
  })

  return results
}

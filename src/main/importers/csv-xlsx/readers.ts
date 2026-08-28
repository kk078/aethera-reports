/**
 * Streaming CSV (papaparse) and XLSX (exceljs) row readers (plan §3).
 * Both expose the same per-row callback shape so the import pipeline
 * doesn't care which format it's reading — and both stream rather than
 * materializing the whole file, since a 75-client rollout means some of
 * these files won't be small.
 */
import { createReadStream } from 'node:fs'
import { extname } from 'node:path'
import Papa from 'papaparse'
import ExcelJS from 'exceljs'
import type { RawRow } from './transform'

export type FileKind = 'csv' | 'xlsx'

export function detectFileKind(filePath: string): FileKind | null {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.csv') return 'csv'
  if (ext === '.xlsx' || ext === '.xls') return 'xlsx'
  return null
}

export interface RowReaderResult {
  headers: string[]
  rowCount: number
}

export type RowCallback = (row: RawRow, rowNumber: number) => Promise<void> | void

/**
 * Reads only the header row — used by the wizard's "auto-detect headers"
 * step before the user has picked/confirmed a mapping template.
 */
export async function peekHeaders(filePath: string): Promise<string[]> {
  const kind = detectFileKind(filePath)
  if (kind === 'csv') return peekCsvHeaders(filePath)
  if (kind === 'xlsx') return peekXlsxHeaders(filePath)
  throw new Error(`Unsupported file type: ${filePath}`)
}

function peekCsvHeaders(filePath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath)
    Papa.parse<Record<string, string>>(stream, {
      header: true,
      skipEmptyLines: true,
      step: (results, parser) => {
        resolve(Object.keys(results.data))
        parser.abort()
        stream.destroy()
      },
      complete: () => resolve([]),
      error: (error) => reject(error)
    })
  })
}

async function peekXlsxHeaders(filePath: string): Promise<string[]> {
  const workbookReader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {})
  for await (const worksheet of workbookReader) {
    for await (const row of worksheet) {
      return rowToHeaders(row)
    }
  }
  return []
}

function rowToHeaders(row: ExcelJS.Row): string[] {
  const headers: string[] = []
  row.eachCell({ includeEmpty: false }, (cell) => {
    headers.push(String(cell.value ?? '').trim())
  })
  return headers
}

export interface ReadRowsOptions {
  /** Stop after this many data rows (used by the wizard's preview step). */
  limit?: number
}

/** Reads every data row (or up to `options.limit`), invoking `onRow` for each one, in file order. */
export async function readRows(
  filePath: string,
  onRow: RowCallback,
  options: ReadRowsOptions = {}
): Promise<RowReaderResult> {
  const kind = detectFileKind(filePath)
  if (kind === 'csv') return readCsvRows(filePath, onRow, options)
  if (kind === 'xlsx') return readXlsxRows(filePath, onRow, options)
  throw new Error(`Unsupported file type: ${filePath}`)
}

function readCsvRows(
  filePath: string,
  onRow: RowCallback,
  options: ReadRowsOptions
): Promise<RowReaderResult> {
  return new Promise((resolve, reject) => {
    let headers: string[] = []
    let rowCount = 0
    let pendingWork: Promise<void> = Promise.resolve()
    const stream = createReadStream(filePath)

    Papa.parse<Record<string, string>>(stream, {
      header: true,
      skipEmptyLines: true,
      step: (results, parser) => {
        if (headers.length === 0) headers = results.meta.fields ?? Object.keys(results.data)
        rowCount += 1
        const rowNumber = rowCount
        const row = results.data

        // Serialize async row handling (DB writes) so we never race two
        // inserts for the same import job; pause/resume backpressures
        // the underlying stream while we wait.
        parser.pause()
        pendingWork = pendingWork
          .then(() => onRow(row, rowNumber))
          .then(() => {
            if (options.limit && rowCount >= options.limit) {
              parser.abort()
              stream.destroy()
              resolve({ headers, rowCount })
              return
            }
            parser.resume()
          })
          .catch((error: unknown) => {
            parser.abort()
            reject(error instanceof Error ? error : new Error(String(error)))
          })
      },
      complete: () => {
        pendingWork.then(() => resolve({ headers, rowCount })).catch(reject)
      },
      error: (error) => reject(error)
    })
  })
}

async function readXlsxRows(
  filePath: string,
  onRow: RowCallback,
  options: ReadRowsOptions
): Promise<RowReaderResult> {
  const workbookReader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {})
  let headers: string[] = []
  let rowCount = 0

  outer: for await (const worksheet of workbookReader) {
    for await (const row of worksheet) {
      if (headers.length === 0) {
        headers = rowToHeaders(row)
        continue
      }
      rowCount += 1
      const record: RawRow = {}
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        const header = headers[colNumber - 1]
        if (header) record[header] = cell.value == null ? '' : String(cell.value)
      })
      await onRow(record, rowCount)
      if (options.limit && rowCount >= options.limit) break outer
    }
    break // one worksheet per file for CSV-style claim exports
  }

  return { headers, rowCount }
}

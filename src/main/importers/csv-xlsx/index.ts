/**
 * Public surface of the CSV/XLSX importer module (plan §3's `Importer`
 * concept). `detect` matches by extension; `run` is `runCsvImport` — a
 * plain async function rather than the plan's `AsyncIterable<Progress>`
 * shape (see README/PR notes: progress is surfaced by polling
 * `importJobs:get`, which this function keeps up to date as it works,
 * rather than a push-streamed generator — consistent with the hardened
 * shell's single-`invoke` IPC model established in Phase 1 step 3).
 */
import { detectFileKind } from './readers'
import { CLAIM_LINE_TARGET_FIELDS } from '../../../shared/claim-fields'

export { runCsvImport, type RunCsvImportInput, type RunCsvImportResult } from './run-csv-import'
export { buildCanonicalRow, applyMoney, applyDateFmt } from './transform'
export {
  suggestColumnMappings,
  type FuzzyMatchSuggestion,
  type TargetFieldSpec
} from './fuzzy-match'
export { peekHeaders, readRows } from './readers'
export { hashPatientKey, computeNaturalKey } from './hashing'
export { tebraClaimExportTemplate } from './presets/tebra'
export { previewMapping, DEFAULT_PREVIEW_LIMIT, type PreviewRow } from './preview'
export { CLAIM_LINE_TARGET_FIELDS }

export function detectCsvXlsxFile(filePath: string): boolean {
  return detectFileKind(filePath) !== null
}

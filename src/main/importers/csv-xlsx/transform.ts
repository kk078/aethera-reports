/**
 * Column transforms + row assembly for the CSV/XLSX mapping engine (plan
 * §3). `buildCanonicalRow` maps one raw source row through a mapping
 * template's columns into the flattened `CanonicalClaimLineRow` shape,
 * applying each column's declared transform, then validates the result
 * with zod — callers quarantine the row (never fail the job) when
 * validation fails (Risk 3).
 */
import {
  canonicalClaimLineRowSchema,
  type MappingColumn,
  type MappingTemplate
} from '../../../shared/domain'
import type { CanonicalClaimLineRow } from '../../../shared/domain'

export type RawRow = Record<string, string>

export interface BuildRowResult {
  row: CanonicalClaimLineRow | null
  errors: string[]
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** Strips currency symbols/commas/whitespace and parses to a number. */
export function applyMoney(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1') // "(12.50)" => "-12.50"
  if (cleaned === '') return null
  const value = Number(cleaned)
  return Number.isFinite(value) ? value : null
}

const DATE_PATTERNS: Array<{ regex: RegExp; toIso: (m: RegExpMatchArray) => string }> = [
  // YYYY-MM-DD (already ISO)
  { regex: /^(\d{4})-(\d{2})-(\d{2})$/, toIso: (m) => `${m[1]}-${m[2]}-${m[3]}` },
  // MM/DD/YYYY or M/D/YYYY
  {
    regex: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
    toIso: (m) => `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  },
  // MM-DD-YYYY
  {
    regex: /^(\d{1,2})-(\d{1,2})-(\d{4})$/,
    toIso: (m) => `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  },
  // MM/DD/YY (assume 20YY)
  {
    regex: /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/,
    toIso: (m) => `20${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  }
]

/** Parses common PM-export date formats into ISO `YYYY-MM-DD`. */
export function applyDateFmt(raw: string): string | null {
  const trimmed = raw.trim()
  for (const pattern of DATE_PATTERNS) {
    const match = trimmed.match(pattern.regex)
    if (match) return pattern.toIso(match)
  }
  return null
}

function applyEnumMap(raw: string, transformOptions: Record<string, unknown> | undefined): string {
  const map = transformOptions?.map
  if (map && typeof map === 'object') {
    const value = (map as Record<string, unknown>)[raw]
    if (typeof value === 'string') return value
  }
  return raw
}

/**
 * Resolves the raw value(s) for one target field. Most fields map from a
 * single source column; `concat` lets multiple columns combine into one
 * target field (e.g. two date-part columns), joined in declaration order.
 */
function resolveFieldValue(
  rawRow: RawRow,
  columns: MappingColumn[]
): { raw: string; transform: MappingColumn['transform']; options?: Record<string, unknown> } {
  if (columns.length === 1) {
    const col = columns[0]
    return {
      raw: asString(rawRow[col.sourceHeader]).trim(),
      transform: col.transform,
      options: col.transformOptions
    }
  }

  // Multiple columns targeting the same field: concat mode.
  const separator = (columns[0].transformOptions?.separator as string | undefined) ?? ' '
  const raw = columns
    .map((col) => asString(rawRow[col.sourceHeader]).trim())
    .filter((value) => value !== '')
    .join(separator)
  return { raw, transform: 'concat' }
}

function transformValue(
  raw: string,
  transform: MappingColumn['transform'],
  options: Record<string, unknown> | undefined,
  errors: string[],
  targetField: string
): string | number | null {
  switch (transform) {
    case 'money': {
      const value = applyMoney(raw)
      if (value === null && raw !== '')
        errors.push(`${targetField}: "${raw}" is not a valid amount`)
      return value
    }
    case 'date_fmt': {
      const value = applyDateFmt(raw)
      if (value === null && raw !== '')
        errors.push(`${targetField}: "${raw}" is not a recognized date`)
      return value
    }
    case 'enum_map':
      return applyEnumMap(raw, options)
    case 'concat':
    case 'none':
    default:
      return raw === '' ? null : raw
  }
}

/**
 * Groups a template's columns by target field (supporting `concat`
 * across multiple source columns), applies each field's transform, and
 * validates the assembled object against `canonicalClaimLineRowSchema`.
 */
export function buildCanonicalRow(rawRow: RawRow, template: MappingTemplate): BuildRowResult {
  const errors: string[] = []
  const byField = new Map<string, MappingColumn[]>()
  for (const column of template.columns) {
    const list = byField.get(column.targetField) ?? []
    list.push(column)
    byField.set(column.targetField, list)
  }

  const assembled: Record<string, unknown> = {}
  for (const [targetField, columns] of byField) {
    const { raw, transform, options } = resolveFieldValue(rawRow, columns)
    if (raw === '') continue
    assembled[targetField] = transformValue(raw, transform, options, errors, targetField)
  }

  if (errors.length > 0) {
    return { row: null, errors }
  }

  const parsed = canonicalClaimLineRowSchema.safeParse(assembled)
  if (!parsed.success) {
    return {
      row: null,
      errors: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    }
  }

  return { row: parsed.data, errors: [] }
}

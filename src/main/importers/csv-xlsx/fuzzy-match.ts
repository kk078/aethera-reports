/**
 * Fuzzy header-to-field matching for the mapping wizard (plan §3:
 * "auto-detect headers → fuzzy-match suggested mapping"). Pure string
 * matching — normalized exact match first, then Levenshtein distance
 * against the target field name and any declared synonyms.
 */

export interface TargetFieldSpec {
  field: string
  /** Alternate header spellings PM systems commonly use for this field. */
  synonyms: string[]
}

export interface FuzzyMatchSuggestion {
  sourceHeader: string
  suggestedField: string | null
  /** 0 (no match) to 1 (exact normalized match). */
  confidence: number
}

/** Below this confidence, we'd rather leave a column unmapped than guess wrong. */
export const SUGGESTION_CONFIDENCE_THRESHOLD = 0.6

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/** Classic Wagner–Fischer edit distance. */
function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1
  const cols = b.length + 1
  const dist: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0))

  for (let i = 0; i < rows; i++) dist[i][0] = i
  for (let j = 0; j < cols; j++) dist[0][j] = j

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dist[i][j] = Math.min(dist[i - 1][j] + 1, dist[i][j - 1] + 1, dist[i - 1][j - 1] + cost)
    }
  }

  return dist[rows - 1][cols - 1]
}

function similarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1
  return 1 - levenshteinDistance(a, b) / maxLen
}

/**
 * For each source header, finds the best-matching target field (its
 * canonical name or one of its synonyms) and returns a suggestion. The
 * wizard shows `suggestedField` pre-selected when confidence clears
 * `SUGGESTION_CONFIDENCE_THRESHOLD`, and lets the user override it either way.
 */
export function suggestColumnMappings(
  sourceHeaders: string[],
  targets: TargetFieldSpec[]
): FuzzyMatchSuggestion[] {
  return sourceHeaders.map((sourceHeader) => {
    const normalizedHeader = normalize(sourceHeader)
    let best: { field: string; score: number } | null = null

    for (const target of targets) {
      const candidates = [target.field, ...target.synonyms]
      for (const candidate of candidates) {
        const score = similarity(normalizedHeader, normalize(candidate))
        if (!best || score > best.score) {
          best = { field: target.field, score }
        }
      }
    }

    return {
      sourceHeader,
      suggestedField: best && best.score >= SUGGESTION_CONFIDENCE_THRESHOLD ? best.field : null,
      confidence: best?.score ?? 0
    }
  })
}

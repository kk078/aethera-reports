/**
 * X12 envelope tokenizer (plan §3 bullet 2). Reads the element/component
 * separators, the repetition separator, and the segment terminator
 * directly from the ISA segment itself (X12 files are not guaranteed to
 * use `*`/`~`/`:` — those are just the most common convention), then
 * splits the rest of the interchange into a flat segment stream with
 * 1-based positions for error messages.
 *
 * No Electron/Node-API imports here beyond none at all — pure string
 * processing, safe under the `importers/` no-Electron-imports guard
 * (`eslint.config.mjs`) and trivially unit-testable.
 *
 * Failure modes (missing/short ISA, unknown delimiters, truncated
 * envelope) always surface as a typed `X12TokenizeError` with a message
 * that names what was expected — callers (the run-x12-import job
 * bookkeeping) catch it and fail the job cleanly rather than letting an
 * unrelated `TypeError` (e.g. reading `.slice` of `undefined`) crash the
 * import. Tokenizing never throws anything else.
 */

export interface X12Delimiters {
  /** Separates elements within a segment (commonly `*`). */
  element: string
  /** Separates sub-elements within a composite element (commonly `:`). */
  component: string
  /** Separates repeated values within a single element (commonly `^`). ISA11 in 5010. */
  repetition: string
  /** Terminates a segment (commonly `~`). Optional trailing CR/LF is stripped, not part of this. */
  segmentTerminator: string
}

export interface X12Segment {
  /** Segment tag, e.g. "ISA", "CLP", "SVC". */
  tag: string
  /** Data elements after the tag — `elements[0]` is what X12 documentation calls element 01. */
  elements: string[]
  /** 1-based position of this segment in the interchange, for error messages. */
  position: number
}

export interface TokenizeResult {
  delimiters: X12Delimiters
  segments: X12Segment[]
}

export class X12TokenizeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'X12TokenizeError'
  }
}

/** Cheap sniff used by `detect()` before committing to a full tokenize. */
export function looksLikeX12(content: string): boolean {
  return content.trimStart().slice(0, 3) === 'ISA'
}

/** Reads one 1-based element from a segment, defaulting to `''` when absent (many X12 elements are situational/optional). */
export function el(segment: X12Segment, index1Based: number): string {
  return segment.elements[index1Based - 1] ?? ''
}

/** Splits a composite element (e.g. SVC01 `"HC:99213:25"`) on the component separator. A plain element comes back as a single-item array. */
export function splitComponents(rawElement: string, delimiters: X12Delimiters): string[] {
  return rawElement.split(delimiters.component)
}

const ISA_DATA_ELEMENT_SEPARATORS_BEFORE_ISA16 = 15

/**
 * Reads the ISA segment's delimiters and splits the whole interchange
 * into a segment stream. The element separator is parsed positionally
 * (it's the character immediately after the literal `ISA`); the
 * component separator and segment terminator are recovered by counting
 * element-separator occurrences up to ISA16 rather than assuming fixed
 * column widths, since real-world generators don't always space-pad ISA
 * fields to the TR3's nominal widths.
 */
export function tokenize(content: string): TokenizeResult {
  if (content.length === 0) {
    throw new X12TokenizeError('File is empty.')
  }
  const trimmed = content.slice(0, 3) === 'ISA' ? content : content.trimStart()
  if (trimmed.slice(0, 3) !== 'ISA') {
    throw new X12TokenizeError('File does not start with an ISA segment.')
  }
  if (trimmed.length < 6) {
    throw new X12TokenizeError('File is too short to contain a valid ISA segment.')
  }

  const element = trimmed[3]

  // Find the 15 element-separator occurrences that delimit ISA01..ISA15
  // (the separator right after "ISA" itself, at index 3, delimits the
  // "ISA" tag from ISA01 and is not counted again here).
  const separatorPositions: number[] = [3]
  for (let i = 0; i < ISA_DATA_ELEMENT_SEPARATORS_BEFORE_ISA16; i++) {
    const previous = separatorPositions[separatorPositions.length - 1]
    const next = trimmed.indexOf(element, previous + 1)
    if (next === -1) {
      throw new X12TokenizeError(
        `Truncated ISA segment: expected 16 elements separated by "${element}", ran out after ISA${String(i + 1).padStart(2, '0')}.`
      )
    }
    separatorPositions.push(next)
  }

  const isaFields: string[] = []
  for (let i = 0; i < separatorPositions.length - 1; i++) {
    isaFields.push(trimmed.slice(separatorPositions[i] + 1, separatorPositions[i + 1]))
  }
  // isaFields[0..14] = ISA01..ISA15. ISA16 (component separator) is the
  // single character right after the last separator we found; the
  // segment terminator is the character right after that.
  const isa16Position = separatorPositions[separatorPositions.length - 1] + 1
  const component = trimmed[isa16Position]
  if (!component) {
    throw new X12TokenizeError(
      'Truncated ISA segment: missing ISA16 (the component element separator).'
    )
  }
  const segmentTerminator = trimmed[isa16Position + 1]
  if (!segmentTerminator) {
    throw new X12TokenizeError('Truncated ISA segment: missing the segment terminator after ISA16.')
  }

  const repetition = isaFields[10] || '^' // ISA11, 0-indexed field 10

  const delimiters: X12Delimiters = { element, component, repetition, segmentTerminator }

  // Segment terminators are sometimes followed by a CR/LF for human
  // readability, and a producer may omit the terminator on the final
  // segment entirely (a truncated file, or simply EOF right after SE/GE/
  // IEA) — `split` handles a missing trailing terminator on its own, so
  // we only need to strip stray CR/LF around each piece and drop empties.
  const rawSegments = trimmed
    .split(delimiters.segmentTerminator)
    .map((raw) => raw.replace(/^[\r\n]+/, '').replace(/[\r\n]+$/, ''))
    .filter((raw) => raw.length > 0)

  const segments: X12Segment[] = rawSegments.map((raw, index) => {
    const parts = raw.split(delimiters.element)
    return { tag: parts[0], elements: parts.slice(1), position: index + 1 }
  })

  if (segments.length === 0 || segments[0].tag !== 'ISA') {
    throw new X12TokenizeError(
      'Could not locate a parseable ISA segment after splitting on the detected segment terminator — the terminator character may be wrong.'
    )
  }

  return { delimiters, segments }
}

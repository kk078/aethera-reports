/**
 * Public surface of the X12 835/837 importer module (plan §3 bullet 2).
 * `detectX12Kind`/`detectX12File` sniff the ISA/GS/ST envelope (mirrors
 * `detectCsvXlsxFile` in the CSV/XLSX importer, which sniffs by
 * extension instead); the Imports wizard uses this to route a picked
 * file straight to the X12 parse-summary preview, skipping the
 * column-mapping steps entirely (plan §3 bullet 5).
 */
import { open } from 'node:fs/promises'
import { looksLikeX12, tokenize } from './tokenizer'

const DETECT_PREFIX_BYTES = 4096

export type X12Kind = '835' | '837'

/** Reads the ST segment's transaction-set code to tell an 835 from an 837. `null` if this isn't recognizable X12 at all. */
export function detectX12Kind(content: string): X12Kind | null {
  if (!looksLikeX12(content)) return null
  try {
    const { segments } = tokenize(content)
    const st = segments.find((segment) => segment.tag === 'ST')
    const code = st?.elements[0]
    if (code === '835' || code === '837') return code
  } catch {
    return null
  }
  return null
}

/**
 * File-level detect() for the importer registry. Only reads a small
 * prefix — the ISA/GS/ST envelope always appears in the first few
 * hundred bytes — so this stays cheap even against a multi-MB claim
 * batch.
 */
export async function detectX12File(filePath: string): Promise<X12Kind | null> {
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(DETECT_PREFIX_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, DETECT_PREFIX_BYTES, 0)
    return detectX12Kind(buffer.toString('utf-8', 0, bytesRead))
  } finally {
    await handle.close()
  }
}

export { tokenize, X12TokenizeError, looksLikeX12 } from './tokenizer'
export type { X12Delimiters, X12Segment } from './tokenizer'
export { parse835 } from './parse835'
export type {
  Remittance835,
  Remit835Claim,
  Remit835ServiceLine,
  Remit835Adjustment
} from './parse835'
export { parse837 } from './parse837'
export type { Claim837File, Claim837, Claim837ServiceLine } from './parse837'
export {
  run835Import,
  run837Import,
  type RunX12ImportInput,
  type RunX12ImportResult
} from './run-x12-import'

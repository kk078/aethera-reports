import { describe, expect, it } from 'vitest'
import {
  tokenize,
  looksLikeX12,
  splitComponents,
  X12TokenizeError
} from '../src/main/importers/x12/tokenizer'

const GOOD_ISA =
  'ISA*00*          *00*          *ZZ*SENDERID       *ZZ*RECEIVERID     *260115*0900*^*00501*000000001*0*P*:~'

describe('looksLikeX12', () => {
  it('recognizes a file starting with ISA', () => {
    expect(looksLikeX12(GOOD_ISA)).toBe(true)
  })

  it('rejects CSV-shaped content', () => {
    expect(looksLikeX12('Claim Number,Date of Service\n1001,2026-01-01\n')).toBe(false)
  })
})

describe('tokenize', () => {
  it('recovers the standard */:/^/~ delimiters from a well-formed ISA', () => {
    const { delimiters } = tokenize(GOOD_ISA + 'GS*HC*A*B*20260115*0900*1*X*005010X222A1~')
    expect(delimiters).toEqual({
      element: '*',
      component: ':',
      repetition: '^',
      segmentTerminator: '~'
    })
  })

  it('builds a flat segment stream with 1-based positions', () => {
    const { segments } = tokenize(GOOD_ISA + 'GS*HC*A*B~ST*837*0001~SE*2*0001~')
    expect(segments.map((s) => s.tag)).toEqual(['ISA', 'GS', 'ST', 'SE'])
    expect(segments[0].position).toBe(1)
    expect(segments[2].position).toBe(3)
    expect(segments[2].elements).toEqual(['837', '0001'])
  })

  it('recovers non-standard delimiters when the ISA declares them', () => {
    // element '|', component '^', repetition '&', terminator '#'
    const isa =
      'ISA|00|          |00|          |ZZ|SENDERID       |ZZ|RECEIVERID     |260115|0900|&|00501|000000001|0|P|^#'
    const { delimiters, segments } = tokenize(isa + 'GS|HC|A|B#ST|837|0001#')
    expect(delimiters).toEqual({
      element: '|',
      component: '^',
      repetition: '&',
      segmentTerminator: '#'
    })
    expect(segments.map((s) => s.tag)).toEqual(['ISA', 'GS', 'ST'])
  })

  it('tolerates a CR/LF immediately after each segment terminator', () => {
    const content = GOOD_ISA + '\r\nGS*HC*A*B~\r\nST*837*0001~\r\n'
    const { segments } = tokenize(content)
    expect(segments.map((s) => s.tag)).toEqual(['ISA', 'GS', 'ST'])
    expect(segments[2].elements).toEqual(['837', '0001'])
  })

  it('handles a missing terminator on the final segment without crashing', () => {
    const content = GOOD_ISA + 'GS*HC*A*B~ST*837*0001' // no trailing '~'
    const { segments } = tokenize(content)
    expect(segments.map((s) => s.tag)).toEqual(['ISA', 'GS', 'ST'])
    expect(segments[2].elements).toEqual(['837', '0001'])
  })

  it('throws a clean X12TokenizeError on an empty file', () => {
    expect(() => tokenize('')).toThrow(X12TokenizeError)
  })

  it('throws a clean X12TokenizeError when the file does not start with ISA', () => {
    expect(() => tokenize('GS*HC*A*B~')).toThrow(X12TokenizeError)
  })

  it('throws a clean X12TokenizeError on a truncated ISA segment (missing elements)', () => {
    expect(() => tokenize('ISA*00*          *00*')).toThrow(X12TokenizeError)
  })

  it('throws a clean X12TokenizeError when ISA16/terminator are missing entirely', () => {
    // 15 full elements present but nothing after the final separator.
    const truncated =
      'ISA*00*          *00*          *ZZ*SENDERID       *ZZ*RECEIVERID     *260115*0900*^*00501*000000001*0*P*'
    expect(() => tokenize(truncated)).toThrow(X12TokenizeError)
  })

  it('never throws anything other than X12TokenizeError for malformed input', () => {
    const inputs = [
      '',
      'not x12 at all',
      'ISA',
      'ISA*',
      'ISA*00*00*00*00*00*00*00*00*00*00*00*00*00*00*00'
    ]
    for (const input of inputs) {
      try {
        tokenize(input)
      } catch (error) {
        expect(error).toBeInstanceOf(X12TokenizeError)
      }
    }
  })
})

describe('splitComponents', () => {
  it('splits a composite element on the component separator', () => {
    const delimiters = { element: '*', component: ':', repetition: '^', segmentTerminator: '~' }
    expect(splitComponents('HC:99213:25', delimiters)).toEqual(['HC', '99213', '25'])
  })

  it('returns a single-item array for a non-composite element', () => {
    const delimiters = { element: '*', component: ':', repetition: '^', segmentTerminator: '~' }
    expect(splitComponents('99213', delimiters)).toEqual(['99213'])
  })
})

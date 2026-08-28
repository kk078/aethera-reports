import { describe, expect, it } from 'vitest'
import { parseCliArgs } from '../src/main/cli-args'

describe('parseCliArgs', () => {
  it('returns mode "none" when no CLI flags are present', () => {
    expect(parseCliArgs(['/path/to/electron', '/path/to/app'])).toEqual({ mode: 'none' })
  })

  it('parses --generate with all its options', () => {
    const result = parseCliArgs([
      'electron',
      '--generate',
      '--period',
      '2026-07',
      '--clients',
      'DEMO1,DEMO2',
      '--formats',
      'pdf,pptx',
      '--out',
      '/tmp/out'
    ])
    expect(result).toEqual({
      mode: 'generate',
      period: '2026-07',
      clients: 'DEMO1,DEMO2',
      formats: ['pdf', 'pptx'],
      out: '/tmp/out'
    })
  })

  it('defaults --clients to "all" and --formats to "pdf" when omitted', () => {
    const result = parseCliArgs(['electron', '--generate', '--period', '2026-07'])
    expect(result).toEqual({
      mode: 'generate',
      period: '2026-07',
      clients: 'all',
      formats: ['pdf'],
      out: undefined
    })
  })

  it('throws when --generate is missing --period', () => {
    expect(() => parseCliArgs(['electron', '--generate'])).toThrow(/--period/)
  })

  it('throws when --generate has a malformed period', () => {
    expect(() => parseCliArgs(['electron', '--generate', '--period', 'not-a-period'])).toThrow()
  })

  it('parses --import with --template', () => {
    const result = parseCliArgs([
      'electron',
      '--import',
      '/data/inbox',
      '--template',
      'tebra-claim-export'
    ])
    expect(result).toEqual({
      mode: 'import',
      importPath: '/data/inbox',
      template: 'tebra-claim-export'
    })
  })

  it('leaves --template undefined when omitted — --import <dir> can rely purely on folder pins (plan §11)', () => {
    const result = parseCliArgs(['electron', '--import', '/data/inbox'])
    expect(result).toEqual({ mode: 'import', importPath: '/data/inbox', template: undefined })
  })

  it("finds flags regardless of position in argv (matches --smoke's tolerant style)", () => {
    const result = parseCliArgs([
      '/usr/bin/electron',
      '/opt/app/out/main/index.js',
      '--generate',
      '--period',
      '2026-01'
    ])
    expect(result.mode).toBe('generate')
  })
})

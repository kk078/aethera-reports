import { describe, expect, it } from 'vitest'
import { isNewerVersion, parseVersion } from '../src/shared/version'

describe('update-check version compare', () => {
  it('parses tags with and without the v prefix', () => {
    expect(parseVersion('v0.3.1')).toEqual([0, 3, 1])
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3])
    expect(parseVersion('nightly')).toBeNull()
  })

  it('orders versions numerically, not lexically', () => {
    expect(isNewerVersion('v0.10.0', '0.9.9')).toBe(true)
    expect(isNewerVersion('v0.2.0', '0.2.0')).toBe(false)
    expect(isNewerVersion('v0.2.0', '0.3.0')).toBe(false)
    expect(isNewerVersion('v1.0.0', '0.9.0')).toBe(true)
  })

  it('never reports an update for unparseable tags', () => {
    expect(isNewerVersion('latest', '0.2.0')).toBe(false)
  })
})

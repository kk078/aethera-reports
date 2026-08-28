import { describe, expect, it } from 'vitest'
import { ipcContract, parseIpcRequest, parseIpcResponse } from '../src/shared/ipc-contract'

describe('ipc-contract: ping channel', () => {
  it('accepts a valid request and round-trips it into a valid response shape', () => {
    const rawRequest: unknown = { message: 'hello' }

    const request = parseIpcRequest('ping', rawRequest)
    expect(request).toEqual({ message: 'hello' })

    // Simulate what the main-process handler does: build a response from
    // the validated request and validate it before it crosses back over
    // the IPC boundary.
    const rawResponse: unknown = {
      message: request.message,
      echoedAt: new Date().toISOString(),
      pid: 1234
    }
    const response = parseIpcResponse('ping', rawResponse)

    expect(response.message).toBe('hello')
    expect(response.pid).toBe(1234)
    expect(() => new Date(response.echoedAt).toISOString()).not.toThrow()
  })

  it('rejects a request missing the required field', () => {
    const rawRequest: unknown = {}
    expect(() => parseIpcRequest('ping', rawRequest)).toThrow()
  })

  it('rejects a request with the wrong field type', () => {
    const rawRequest: unknown = { message: 42 }
    expect(() => parseIpcRequest('ping', rawRequest)).toThrow()
  })

  it('rejects an empty-string message (min length)', () => {
    const rawRequest: unknown = { message: '' }
    expect(() => parseIpcRequest('ping', rawRequest)).toThrow()
  })

  it('rejects a malformed response payload (bad pid type)', () => {
    const rawResponse: unknown = {
      message: 'hi',
      echoedAt: new Date().toISOString(),
      pid: 'not-a-number'
    }
    expect(() => parseIpcResponse('ping', rawResponse)).toThrow()
  })

  it('exposes ping as a declared channel', () => {
    expect(Object.keys(ipcContract)).toContain('ping')
  })
})

describe('ipc-contract: clients:create channel', () => {
  it('accepts a minimal valid request', () => {
    const request = parseIpcRequest('clients:create', { code: 'ACME', name: 'Acme Health' })
    expect(request.code).toBe('ACME')
  })

  it('rejects a code with invalid characters', () => {
    expect(() =>
      parseIpcRequest('clients:create', { code: 'ACME!', name: 'Acme Health' })
    ).toThrow()
  })

  it('rejects a malformed report recipient email', () => {
    expect(() =>
      parseIpcRequest('clients:create', {
        code: 'ACME',
        name: 'Acme Health',
        reportRecipients: ['not-an-email']
      })
    ).toThrow()
  })

  it('round-trips a full client response', () => {
    const response = parseIpcResponse('clients:create', {
      clientId: 1,
      code: 'ACME',
      name: 'Acme Health',
      contractType: null,
      contractRate: null,
      slaDaysToSubmit: null,
      reportRecipients: [],
      state: null,
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })
    expect(response.code).toBe('ACME')
  })
})

describe('ipc-contract: manualEntry:upsert channel', () => {
  it('accepts a valid monthly summary and enforces the YYYY-MM-01 period shape', () => {
    const request = parseIpcRequest('manualEntry:upsert', {
      clientId: 1,
      periodMonth: '2026-01-01',
      charges: 10000
    })
    expect(request.periodMonth).toBe('2026-01-01')
  })

  it('rejects a periodMonth that is not the first of the month', () => {
    expect(() =>
      parseIpcRequest('manualEntry:upsert', { clientId: 1, periodMonth: '2026-01-15' })
    ).toThrow()
  })
})

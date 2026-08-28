/**
 * Email delivery tests (plan §11, Phase 2 chunk D) — nodemailer's built-in
 * JSON transport (`createTestTransport`), never a real SMTP connection.
 */
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestTransport, renderTemplate, sendReportPack } from '../src/main/automation/email'

describe('renderTemplate', () => {
  it('substitutes every known {placeholder}', () => {
    const result = renderTemplate('Your {client} report — {period}', {
      client: 'Acme Health',
      period: '2026-06'
    })
    expect(result).toBe('Your Acme Health report — 2026-06')
  })

  it('leaves an unrecognized placeholder untouched rather than dropping it', () => {
    const result = renderTemplate('{client} / {mystery}', { client: 'Acme' })
    expect(result).toBe('Acme / {mystery}')
  })

  it('substitutes repeated occurrences of the same placeholder', () => {
    expect(renderTemplate('{period} then {period} again', { period: '2026-06' })).toBe(
      '2026-06 then 2026-06 again'
    )
  })
})

describe('sendReportPack', () => {
  let dir: string
  let attachmentPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aethera-email-test-'))
    attachmentPath = join(dir, 'report.pdf')
    writeFileSync(attachmentPath, 'fake pdf bytes')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports success (with a messageId) over the no-network JSON transport', async () => {
    const transport = createTestTransport()
    const result = await sendReportPack(transport, {
      from: 'reports@example.com',
      to: ['billing@acme.example'],
      subject: 'Your Acme report — 2026-06',
      body: 'Attached is the report.',
      attachments: [{ filename: 'report.pdf', path: attachmentPath }]
    })
    expect(result.ok).toBe(true)
    expect(result.error).toBeNull()
    expect(result.messageId).toBeTruthy()
  })

  it('returns ok:false with an error message instead of throwing when an attachment cannot be read', async () => {
    const transport = createTestTransport()
    const result = await sendReportPack(transport, {
      from: 'reports@example.com',
      to: ['billing@acme.example'],
      subject: 'Your Acme report — 2026-06',
      body: 'Attached is the report.',
      attachments: [{ filename: 'missing.pdf', path: join(dir, 'does-not-exist.pdf') }]
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })
})

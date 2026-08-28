/**
 * Email delivery (plan §11) — a thin `nodemailer` wrapper. SMTP
 * credentials arrive here already resolved (host/port/secure/user +
 * decrypted password), the same pattern as the RCM connector's client:
 * this module never touches `safeStorage`/`credentials.ts` itself, so
 * it's fully testable with nodemailer's built-in JSON transport (no real
 * network — see `test/automation-email.test.ts`).
 */
import nodemailer, { type Transporter } from 'nodemailer'

export interface SmtpConfig {
  host: string
  port: number
  secure: boolean
  username: string | null
  password: string | null
}

export interface SendReportPackInput {
  from: string
  to: string[]
  subject: string
  body: string
  attachments: Array<{ filename: string; path: string }>
}

export interface SendResult {
  ok: boolean
  error: string | null
  messageId?: string
}

/** Real SMTP transport for production use. */
export function createSmtpTransport(config: SmtpConfig): Transporter {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.username ? { user: config.username, pass: config.password ?? '' } : undefined
  })
}

/** JSON transport (nodemailer's built-in no-network test transport) — messages are captured, never sent. */
export function createTestTransport(): Transporter {
  return nodemailer.createTransport({ jsonTransport: true })
}

export async function sendReportPack(
  transport: Transporter,
  input: SendReportPackInput
): Promise<SendResult> {
  try {
    const info = await transport.sendMail({
      from: input.from,
      to: input.to.join(', '),
      subject: input.subject,
      text: input.body,
      attachments: input.attachments
    })
    return { ok: true, error: null, messageId: info.messageId }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** `{client}`/`{period}` placeholder interpolation (plan §11) — an unknown `{placeholder}` is left as-is rather than silently dropped. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match)
}

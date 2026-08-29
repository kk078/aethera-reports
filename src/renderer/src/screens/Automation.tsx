import { useEffect, useState } from 'react'
import type {
  AutomationRule,
  DryRunResult,
  EmailSendQueueRow,
  ExportAuditLogRow,
  ExportFormat,
  ImportJob
} from '../../../shared/domain'
import {
  copyTaskSchedulerCommand,
  deleteAutomationRule,
  dryRunAutomationRule,
  listAutomationRules,
  listEmailSendQueue,
  listExportAuditLog,
  listImportJobs,
  retryEmailSend,
  runAutomationRuleNow,
  saveAutomationRule
} from '../lib/api'

const ALL_FORMATS: ExportFormat[] = ['pdf', 'pptx', 'xlsx']

interface RuleFormState {
  ruleId?: string
  name: string
  dayOfMonth: string
  clientsAll: boolean
  clientCodes: string
  formats: Set<ExportFormat>
  deliver: 'none' | 'email' | 'portal'
  outputDir: string
  enabled: boolean
}

const emptyForm: RuleFormState = {
  name: '',
  dayOfMonth: '3',
  clientsAll: true,
  clientCodes: '',
  formats: new Set(['pdf']),
  deliver: 'none',
  outputDir: '',
  enabled: true
}

function ruleToForm(rule: AutomationRule): RuleFormState {
  return {
    ruleId: rule.ruleId,
    name: rule.name,
    dayOfMonth: String(rule.dayOfMonth),
    clientsAll: rule.clients === 'all',
    clientCodes: rule.clients === 'all' ? '' : rule.clients.join(','),
    formats: new Set(rule.formats),
    deliver: rule.deliver,
    outputDir: rule.outputDir ?? '',
    enabled: rule.enabled
  }
}

/**
 * Automation screen (plan §11): scheduler rules CRUD, dry-run/run-now,
 * a "copy Task Scheduler command" button for fully-unattended use, and
 * run history (import jobs, export audit log, email send queue incl.
 * retry).
 */
function Automation(): React.JSX.Element {
  const [rules, setRules] = useState<AutomationRule[]>([])
  const [form, setForm] = useState<RuleFormState>(emptyForm)
  const [busyRuleId, setBusyRuleId] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [dryRun, setDryRun] = useState<DryRunResult | null>(null)

  const [historyTab, setHistoryTab] = useState<'imports' | 'exports' | 'emails'>('imports')
  const [importJobs, setImportJobs] = useState<ImportJob[]>([])
  const [auditLog, setAuditLog] = useState<ExportAuditLogRow[]>([])
  const [sendQueue, setSendQueue] = useState<EmailSendQueueRow[]>([])

  function refreshRules(): void {
    void listAutomationRules().then(setRules)
  }

  function refreshHistory(): void {
    void listImportJobs().then(setImportJobs)
    void listExportAuditLog().then(setAuditLog)
    void listEmailSendQueue().then(setSendQueue)
  }

  useEffect(() => {
    refreshRules()
    refreshHistory()
  }, [])

  function toggleFormat(format: ExportFormat): void {
    setForm((prev) => {
      const next = new Set(prev.formats)
      if (next.has(format)) next.delete(format)
      else next.add(format)
      return { ...prev, formats: next }
    })
  }

  async function handleSaveRule(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setMessage(null)
    try {
      await saveAutomationRule({
        ruleId: form.ruleId,
        name: form.name.trim(),
        dayOfMonth: Number(form.dayOfMonth),
        clients: form.clientsAll
          ? 'all'
          : form.clientCodes
              .split(',')
              .map((c) => c.trim().toUpperCase())
              .filter(Boolean),
        formats: Array.from(form.formats),
        outputDir: form.outputDir.trim() || undefined,
        deliver: form.deliver,
        enabled: form.enabled
      })
      setForm(emptyForm)
      refreshRules()
      setMessage('Rule saved.')
    } catch (error) {
      setMessage(String(error))
    }
  }

  async function handleDelete(ruleId: string): Promise<void> {
    if (!confirm('Delete this automation rule?')) return
    await deleteAutomationRule(ruleId)
    refreshRules()
  }

  async function handleDryRun(ruleId: string): Promise<void> {
    setBusyRuleId(ruleId)
    setMessage(null)
    try {
      setDryRun(await dryRunAutomationRule(ruleId))
    } catch (error) {
      setMessage(String(error))
    } finally {
      setBusyRuleId(null)
    }
  }

  async function handleRunNow(ruleId: string): Promise<void> {
    if (!confirm('Run this rule right now? This actually generates (and may send) report packs.')) {
      return
    }
    setBusyRuleId(ruleId)
    setMessage(null)
    try {
      const result = await runAutomationRuleNow(ruleId)
      setMessage(result.message)
      refreshRules()
      refreshHistory()
    } catch (error) {
      setMessage(String(error))
    } finally {
      setBusyRuleId(null)
    }
  }

  async function handleCopyCommand(ruleId: string): Promise<void> {
    const { command } = await copyTaskSchedulerCommand(ruleId)
    try {
      await navigator.clipboard.writeText(command)
      setMessage('Task Scheduler command copied to clipboard.')
    } catch {
      setMessage(command) // clipboard API unavailable — show it inline instead
    }
  }

  async function handleRetrySend(queueId: number): Promise<void> {
    const result = await retryEmailSend(queueId)
    setMessage(result.ok ? 'Resent successfully.' : `Retry failed: ${result.error}`)
    refreshHistory()
  }

  return (
    <section className="screen-shell">
      <h1>Automation</h1>
      <p>
        Report scheduler rules, run history, and email send-queue status (plan §11). The headless
        CLI (<code>--generate</code>) and the &quot;copy Task Scheduler command&quot; button below
        cover fully-unattended use when the app isn&apos;t left open — see the README.
      </p>

      {message && <p>{message}</p>}

      <h2>{form.ruleId ? 'Edit rule' : 'New rule'}</h2>
      <form className="client-form" onSubmit={(e) => void handleSaveRule(e)}>
        <label>
          Name
          <input
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label>
          Day of month (generates the prior month&apos;s report — use ≤ 28 to fire every month)
          <input
            type="number"
            min={1}
            max={31}
            value={form.dayOfMonth}
            onChange={(e) => setForm({ ...form, dayOfMonth: e.target.value })}
          />
        </label>
        <label>
          All active clients
          <input
            type="checkbox"
            checked={form.clientsAll}
            onChange={(e) => setForm({ ...form, clientsAll: e.target.checked })}
          />
        </label>
        {!form.clientsAll && (
          <label>
            Client codes (comma-separated)
            <input
              value={form.clientCodes}
              onChange={(e) => setForm({ ...form, clientCodes: e.target.value })}
              placeholder="ACME,BETA"
            />
          </label>
        )}
        <span className="format-checkboxes">
          {ALL_FORMATS.map((format) => (
            <label key={format}>
              <input
                type="checkbox"
                checked={form.formats.has(format)}
                onChange={() => toggleFormat(format)}
              />
              {format.toUpperCase()}
            </label>
          ))}
        </span>
        <label>
          Delivery
          <select
            value={form.deliver}
            onChange={(e) =>
              setForm({ ...form, deliver: e.target.value as 'none' | 'email' | 'portal' })
            }
          >
            <option value="none">None (files only)</option>
            <option value="email">Email report_recipients</option>
            <option value="portal">Publish to portal + email links</option>
          </select>
        </label>
        <label>
          Enabled
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />
        </label>
        <button type="submit" disabled={!form.name || form.formats.size === 0}>
          {form.ruleId ? 'Save changes' : 'Add rule'}
        </button>
        {form.ruleId && (
          <button type="button" onClick={() => setForm(emptyForm)}>
            Cancel edit
          </button>
        )}
      </form>

      <h2>Rules</h2>
      {rules.length === 0 ? (
        <p>No automation rules yet.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Day</th>
              <th>Clients</th>
              <th>Formats</th>
              <th>Deliver</th>
              <th>Enabled</th>
              <th>Last run</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => (
              <tr key={rule.ruleId}>
                <td>{rule.name}</td>
                <td>{rule.dayOfMonth}</td>
                <td>{rule.clients === 'all' ? 'all' : rule.clients.join(', ')}</td>
                <td>{rule.formats.join(', ')}</td>
                <td>{rule.deliver}</td>
                <td>{rule.enabled ? 'yes' : 'no'}</td>
                <td>
                  {rule.lastRunPeriod
                    ? `${rule.lastRunPeriod} (${rule.lastRunStatus ?? '—'})`
                    : 'never'}
                </td>
                <td>
                  <button type="button" onClick={() => setForm(ruleToForm(rule))}>
                    Edit
                  </button>
                  <button
                    type="button"
                    disabled={busyRuleId === rule.ruleId}
                    onClick={() => void handleDryRun(rule.ruleId)}
                  >
                    Dry run
                  </button>
                  <button
                    type="button"
                    disabled={busyRuleId === rule.ruleId}
                    onClick={() => void handleRunNow(rule.ruleId)}
                  >
                    Run now
                  </button>
                  <button type="button" onClick={() => void handleCopyCommand(rule.ruleId)}>
                    Copy Task Scheduler command
                  </button>
                  <button type="button" onClick={() => void handleDelete(rule.ruleId)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {dryRun && (
        <div className="report-doc-section">
          <h3>Dry run — {dryRun.periodMonth}</h3>
          <p>Would generate for: {dryRun.clientCodes.join(', ') || '(no matching clients)'}</p>
          <p>Formats: {dryRun.formats.join(', ')}</p>
          <p>
            {dryRun.wouldPublishToPortal
              ? 'Would publish to portal and email links to: '
              : 'Would deliver by email: '}
            {dryRun.wouldDeliverEmail || dryRun.wouldPublishToPortal
              ? Object.entries(dryRun.recipientsByClient)
                  .map(
                    ([code, recipients]) =>
                      `${code} → ${recipients.join(', ') || '(no recipients)'}`
                  )
                  .join('; ')
              : 'no'}
          </p>
        </div>
      )}

      <h2>Run history</h2>
      <div className="manual-entry-controls">
        <button type="button" onClick={() => setHistoryTab('imports')}>
          Import jobs
        </button>
        <button type="button" onClick={() => setHistoryTab('exports')}>
          Export audit log
        </button>
        <button type="button" onClick={() => setHistoryTab('emails')}>
          Email send queue
        </button>
      </div>

      {historyTab === 'imports' && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Job</th>
              <th>File</th>
              <th>Status</th>
              <th>Loaded</th>
              <th>Quarantined</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            {importJobs.map((job) => (
              <tr key={job.jobId}>
                <td>#{job.jobId}</td>
                <td>{job.fileName ?? '—'}</td>
                <td>{job.status}</td>
                <td>{job.rowsLoaded}</td>
                <td>{job.rowsSkipped}</td>
                <td>{new Date(job.startedAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {historyTab === 'exports' && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Action</th>
              <th>Client</th>
              <th>Period</th>
              <th>File</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {auditLog.map((row) => (
              <tr key={row.auditId}>
                <td>{row.action}</td>
                <td>{row.clientCode ?? '—'}</td>
                <td>{row.periodMonth ?? '—'}</td>
                <td>{row.filePath ?? '—'}</td>
                <td>{new Date(row.performedAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {historyTab === 'emails' && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Client</th>
              <th>Period</th>
              <th>Recipients</th>
              <th>Status</th>
              <th>Attempts</th>
              <th>Last error</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sendQueue.map((row) => (
              <tr key={row.queueId}>
                <td>{row.clientCode}</td>
                <td>{row.periodMonth}</td>
                <td>{row.recipients.join(', ')}</td>
                <td>{row.status}</td>
                <td>{row.attempts}</td>
                <td>{row.lastError ?? '—'}</td>
                <td>
                  {row.status !== 'sent' && (
                    <button type="button" onClick={() => void handleRetrySend(row.queueId)}>
                      Retry
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

export default Automation

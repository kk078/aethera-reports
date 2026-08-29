import { useEffect, useState } from 'react'
import type { Client, MonthlySummary } from '../../../shared/domain'
import { getMonthlySummary, listClients, upsertMonthlySummary } from '../lib/api'

interface FormState {
  charges: string
  insCollections: string
  ptCollections: string
  adjustments: string
  openAr: string
  arAging0To30: string
  arAging31To60: string
  arAging61To90: string
  arAging91To120: string
  arAging120Plus: string
  claimsSubmitted: string
  denialsCount: string
  notes: string
}

const emptyForm: FormState = {
  charges: '',
  insCollections: '',
  ptCollections: '',
  adjustments: '',
  openAr: '',
  arAging0To30: '',
  arAging31To60: '',
  arAging61To90: '',
  arAging91To120: '',
  arAging120Plus: '',
  claimsSubmitted: '',
  denialsCount: '',
  notes: ''
}

function toFormState(summary: MonthlySummary | null): FormState {
  if (!summary) return emptyForm
  return {
    charges: summary.charges?.toString() ?? '',
    insCollections: summary.insCollections?.toString() ?? '',
    ptCollections: summary.ptCollections?.toString() ?? '',
    adjustments: summary.adjustments?.toString() ?? '',
    openAr: summary.openAr?.toString() ?? '',
    arAging0To30: summary.arAging0To30?.toString() ?? '',
    arAging31To60: summary.arAging31To60?.toString() ?? '',
    arAging61To90: summary.arAging61To90?.toString() ?? '',
    arAging91To120: summary.arAging91To120?.toString() ?? '',
    arAging120Plus: summary.arAging120Plus?.toString() ?? '',
    claimsSubmitted: summary.claimsSubmitted?.toString() ?? '',
    denialsCount: summary.denialsCount?.toString() ?? '',
    notes: summary.notes ?? ''
  }
}

function numberOrUndefined(value: string): number | undefined {
  return value.trim() === '' ? undefined : Number(value)
}

function currentMonthValue(): string {
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

function ManualEntry(): React.JSX.Element {
  const [clients, setClients] = useState<Client[]>([])
  const [clientId, setClientId] = useState<number | ''>('')
  const [month, setMonth] = useState(currentMonthValue()) // <input type="month"> value: YYYY-MM
  const [form, setForm] = useState<FormState>(emptyForm)
  const [existing, setExisting] = useState<MonthlySummary | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedMessage, setSavedMessage] = useState<string | null>(null)

  useEffect(() => {
    listClients().then(setClients)
  }, [])

  const periodMonth = `${month}-01`

  useEffect(() => {
    if (!clientId) {
      setForm(emptyForm)
      setExisting(null)
      return
    }
    getMonthlySummary(clientId, periodMonth).then((summary) => {
      setExisting(summary)
      setForm(toFormState(summary))
    })
  }, [clientId, periodMonth])

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (!clientId) return
    setSaving(true)
    setError(null)
    setSavedMessage(null)
    try {
      const saved = await upsertMonthlySummary({
        clientId,
        periodMonth,
        charges: numberOrUndefined(form.charges),
        insCollections: numberOrUndefined(form.insCollections),
        ptCollections: numberOrUndefined(form.ptCollections),
        adjustments: numberOrUndefined(form.adjustments),
        openAr: numberOrUndefined(form.openAr),
        arAging0To30: numberOrUndefined(form.arAging0To30),
        arAging31To60: numberOrUndefined(form.arAging31To60),
        arAging61To90: numberOrUndefined(form.arAging61To90),
        arAging91To120: numberOrUndefined(form.arAging91To120),
        arAging120Plus: numberOrUndefined(form.arAging120Plus),
        claimsSubmitted: numberOrUndefined(form.claimsSubmitted),
        denialsCount: numberOrUndefined(form.denialsCount),
        notes: form.notes.trim() === '' ? undefined : form.notes
      })
      setExisting(saved)
      setSavedMessage(
        saved.priorValues ? 'Saved — previous values were recorded in the audit trail.' : 'Saved.'
      )
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="screen-shell">
      <h1>Manual Entry</h1>
      <p>
        Monthly summary fallback — authoritative for a client-month when claim-level data has not
        been imported yet.
      </p>

      <div className="manual-entry-controls">
        <label>
          Client
          <select
            value={clientId}
            onChange={(e) => setClientId(e.target.value ? Number(e.target.value) : '')}
          >
            <option value="">Select a client…</option>
            {clients.map((c) => (
              <option key={c.clientId} value={c.clientId}>
                {c.code} — {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Period
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </label>
      </div>

      {clientId && (
        <form className="client-form" onSubmit={(e) => void handleSubmit(e)}>
          {error && <p className="form-error">{error}</p>}
          {savedMessage && <p className="form-success">{savedMessage}</p>}
          {existing?.updatedAt && (
            <p>Last updated: {new Date(existing.updatedAt).toLocaleString()}</p>
          )}

          <label>
            Charges
            <input
              type="number"
              step="0.01"
              value={form.charges}
              onChange={(e) => setForm({ ...form, charges: e.target.value })}
            />
          </label>
          <label>
            Insurance collections
            <input
              type="number"
              step="0.01"
              value={form.insCollections}
              onChange={(e) => setForm({ ...form, insCollections: e.target.value })}
            />
          </label>
          <label>
            Patient collections
            <input
              type="number"
              step="0.01"
              value={form.ptCollections}
              onChange={(e) => setForm({ ...form, ptCollections: e.target.value })}
            />
          </label>
          <label>
            Adjustments
            <input
              type="number"
              step="0.01"
              value={form.adjustments}
              onChange={(e) => setForm({ ...form, adjustments: e.target.value })}
            />
          </label>
          <label>
            Open A/R
            <input
              type="number"
              step="0.01"
              value={form.openAr}
              onChange={(e) => setForm({ ...form, openAr: e.target.value })}
            />
          </label>
          <fieldset>
            <legend>A/R aging</legend>
            <label>
              0–30
              <input
                type="number"
                step="0.01"
                value={form.arAging0To30}
                onChange={(e) => setForm({ ...form, arAging0To30: e.target.value })}
              />
            </label>
            <label>
              31–60
              <input
                type="number"
                step="0.01"
                value={form.arAging31To60}
                onChange={(e) => setForm({ ...form, arAging31To60: e.target.value })}
              />
            </label>
            <label>
              61–90
              <input
                type="number"
                step="0.01"
                value={form.arAging61To90}
                onChange={(e) => setForm({ ...form, arAging61To90: e.target.value })}
              />
            </label>
            <label>
              91–120
              <input
                type="number"
                step="0.01"
                value={form.arAging91To120}
                onChange={(e) => setForm({ ...form, arAging91To120: e.target.value })}
              />
            </label>
            <label>
              120+
              <input
                type="number"
                step="0.01"
                value={form.arAging120Plus}
                onChange={(e) => setForm({ ...form, arAging120Plus: e.target.value })}
              />
            </label>
          </fieldset>
          <label>
            Claims submitted
            <input
              type="number"
              value={form.claimsSubmitted}
              onChange={(e) => setForm({ ...form, claimsSubmitted: e.target.value })}
            />
          </label>
          <label>
            Denials count
            <input
              type="number"
              value={form.denialsCount}
              onChange={(e) => setForm({ ...form, denialsCount: e.target.value })}
            />
          </label>
          <label>
            Notes
            <textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </label>

          <button type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save month'}
          </button>
        </form>
      )}
    </section>
  )
}

export default ManualEntry

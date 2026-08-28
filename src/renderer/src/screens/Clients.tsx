import { useEffect, useState } from 'react'
import type { Client } from '../../../shared/domain'
import { createClient, deactivateClient, listClients, updateClient } from '../lib/api'

interface NewClientFormState {
  code: string
  name: string
  contractRate: string
  slaDaysToSubmit: string
  reportRecipients: string
  state: string
}

const emptyForm: NewClientFormState = {
  code: '',
  name: '',
  contractRate: '',
  slaDaysToSubmit: '',
  reportRecipients: '',
  state: ''
}

function parseRecipients(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function Clients(): React.JSX.Element {
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<NewClientFormState>(emptyForm)
  const [submitting, setSubmitting] = useState(false)

  async function refresh(): Promise<void> {
    setLoading(true)
    try {
      setClients(await listClients())
      setError(null)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function handleCreate(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setSubmitting(true)
    try {
      await createClient({
        code: form.code.trim(),
        name: form.name.trim(),
        contractRate: form.contractRate ? Number(form.contractRate) : undefined,
        slaDaysToSubmit: form.slaDaysToSubmit ? Number(form.slaDaysToSubmit) : undefined,
        reportRecipients: parseRecipients(form.reportRecipients),
        state: form.state.trim() ? form.state.trim().toUpperCase() : undefined
      })
      setForm(emptyForm)
      await refresh()
    } catch (err) {
      setError(String(err))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleToggleActive(client: Client): Promise<void> {
    try {
      if (client.active) {
        await deactivateClient(client.clientId)
      } else {
        await updateClient(client.clientId, { active: true })
      }
      await refresh()
    } catch (err) {
      setError(String(err))
    }
  }

  return (
    <section className="screen-placeholder">
      <h1>Clients</h1>
      <p>The 75+ practices this install bills for — client-level contract terms live here.</p>

      {error && <p className="form-error">{error}</p>}

      <h2>Add a client</h2>
      <form className="client-form" onSubmit={(e) => void handleCreate(e)}>
        <label>
          Code
          <input
            required
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
            placeholder="ACME"
          />
        </label>
        <label>
          Name
          <input
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Acme Health Group"
          />
        </label>
        <label>
          Contract rate (0–1)
          <input
            type="number"
            step="0.001"
            min="0"
            max="1"
            value={form.contractRate}
            onChange={(e) => setForm({ ...form, contractRate: e.target.value })}
            placeholder="0.06"
          />
        </label>
        <label>
          SLA days to submit
          <input
            type="number"
            min="1"
            value={form.slaDaysToSubmit}
            onChange={(e) => setForm({ ...form, slaDaysToSubmit: e.target.value })}
            placeholder="3"
          />
        </label>
        <label>
          Report recipients (comma-separated emails)
          <input
            value={form.reportRecipients}
            onChange={(e) => setForm({ ...form, reportRecipients: e.target.value })}
            placeholder="billing@acme.example, ops@acme.example"
          />
        </label>
        <label>
          State (2-letter, optional — enables the Reference &amp; Benchmark connector&apos;s
          callout)
          <input
            maxLength={2}
            value={form.state}
            onChange={(e) => setForm({ ...form, state: e.target.value.toUpperCase() })}
            placeholder="NY"
          />
        </label>
        <button type="submit" disabled={submitting}>
          {submitting ? 'Adding…' : 'Add client'}
        </button>
      </form>

      <h2>All clients</h2>
      {loading ? (
        <p>Loading…</p>
      ) : clients.length === 0 ? (
        <p>No clients yet — add one above.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Contract rate</th>
              <th>SLA (days)</th>
              <th>State</th>
              <th>Recipients</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {clients.map((client) => (
              <tr key={client.clientId}>
                <td>{client.code}</td>
                <td>{client.name}</td>
                <td>
                  {client.contractRate != null ? `${(client.contractRate * 100).toFixed(1)}%` : '—'}
                </td>
                <td>{client.slaDaysToSubmit ?? '—'}</td>
                <td>{client.state ?? '—'}</td>
                <td>{client.reportRecipients.join(', ') || '—'}</td>
                <td>{client.active ? 'Active' : 'Inactive'}</td>
                <td>
                  <button type="button" onClick={() => void handleToggleActive(client)}>
                    {client.active ? 'Deactivate' : 'Reactivate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

export default Clients

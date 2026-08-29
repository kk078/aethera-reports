import { useEffect, useState } from 'react'
import type { Client } from '../../../shared/domain'
import { createClient, deactivateClient, listClients, updateClient } from '../lib/api'
import SideSheet from '../components/SideSheet'

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

interface EditFormState {
  name: string
  contractRate: string
  slaDaysToSubmit: string
  reportRecipients: string
  state: string
}

function parseRecipients(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function toEditForm(client: Client): EditFormState {
  return {
    name: client.name,
    contractRate: client.contractRate != null ? String(client.contractRate) : '',
    slaDaysToSubmit: client.slaDaysToSubmit != null ? String(client.slaDaysToSubmit) : '',
    reportRecipients: client.reportRecipients.join(', '),
    state: client.state ?? ''
  }
}

function Clients(): React.JSX.Element {
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<NewClientFormState>(emptyForm)
  const [submitting, setSubmitting] = useState(false)

  // Edit form — a right side-sheet (M3 spec pattern showcase) rather than
  // the inline "edit this one cell" affordance the ledger-ink design used.
  const emptyEditForm: EditFormState = {
    name: '',
    contractRate: '',
    slaDaysToSubmit: '',
    reportRecipients: '',
    state: ''
  }
  const [editingClient, setEditingClient] = useState<Client | null>(null)
  const [editForm, setEditForm] = useState<EditFormState>(emptyEditForm)
  const [savingEdit, setSavingEdit] = useState(false)

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

  function openEdit(client: Client): void {
    setEditingClient(client)
    setEditForm(toEditForm(client))
  }

  async function handleSaveEdit(): Promise<void> {
    if (!editingClient) return
    setSavingEdit(true)
    try {
      await updateClient(editingClient.clientId, {
        name: editForm.name.trim(),
        contractRate: editForm.contractRate ? Number(editForm.contractRate) : null,
        slaDaysToSubmit: editForm.slaDaysToSubmit ? Number(editForm.slaDaysToSubmit) : null,
        reportRecipients: parseRecipients(editForm.reportRecipients),
        state: editForm.state.trim() ? editForm.state.trim().toUpperCase() : null
      })
      setEditingClient(null)
      await refresh()
    } catch (err) {
      setError(String(err))
    } finally {
      setSavingEdit(false)
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
                <td className="data-table-actions">
                  <button type="button" onClick={() => openEdit(client)}>
                    Edit
                  </button>
                  <button type="button" onClick={() => void handleToggleActive(client)}>
                    {client.active ? 'Deactivate' : 'Reactivate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <SideSheet
        open={editingClient !== null}
        onClose={() => setEditingClient(null)}
        title="Edit client"
        subtitle={editingClient?.code}
        footer={
          <>
            <button type="button" onClick={() => setEditingClient(null)}>
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSaveEdit()}
              disabled={savingEdit}
              className="side-sheet-primary-action"
            >
              {savingEdit ? 'Saving…' : 'Save changes'}
            </button>
          </>
        }
      >
        <form className="client-form" onSubmit={(e) => e.preventDefault()}>
          <label>
            Name
            <input
              value={editForm.name}
              onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
            />
          </label>
          <label>
            Contract rate (0–1)
            <input
              type="number"
              step="0.001"
              min="0"
              max="1"
              value={editForm.contractRate}
              onChange={(e) => setEditForm({ ...editForm, contractRate: e.target.value })}
            />
          </label>
          <label>
            SLA days to submit
            <input
              type="number"
              min="1"
              value={editForm.slaDaysToSubmit}
              onChange={(e) => setEditForm({ ...editForm, slaDaysToSubmit: e.target.value })}
            />
          </label>
          <label>
            Report recipients (comma-separated emails)
            <input
              value={editForm.reportRecipients}
              onChange={(e) => setEditForm({ ...editForm, reportRecipients: e.target.value })}
            />
          </label>
          <label>
            State (2-letter)
            <input
              maxLength={2}
              value={editForm.state}
              onChange={(e) => setEditForm({ ...editForm, state: e.target.value.toUpperCase() })}
            />
          </label>
        </form>
      </SideSheet>
    </section>
  )
}

export default Clients

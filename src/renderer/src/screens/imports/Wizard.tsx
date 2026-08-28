import { useState } from 'react'
import type {
  Client,
  ImportJob,
  MappingColumn,
  MappingTemplate,
  NewMappingTemplateInput
} from '../../../../shared/domain'
import {
  peekFileHeaders,
  pickImportFile,
  previewMapping,
  runCsvImport,
  saveMappingTemplate,
  suggestMapping
} from '../../lib/api'
import { CLAIM_LINE_TARGET_FIELDS } from '../../../../shared/claim-fields'

type WizardStep = 'setup' | 'mapping' | 'preview' | 'result'

interface DraftColumn {
  sourceHeader: string
  targetField: string // '' means "ignore this column"
}

interface WizardProps {
  clients: Client[]
  templates: MappingTemplate[]
  onImportComplete: () => void
}

const NEW_TEMPLATE_VALUE = '__new__'

function Wizard({ clients, templates, onImportComplete }: WizardProps): React.JSX.Element {
  const [step, setStep] = useState<WizardStep>('setup')
  const [clientCode, setClientCode] = useState('')
  const [filePath, setFilePath] = useState<string | null>(null)
  const [headers, setHeaders] = useState<string[]>([])
  const [templateChoice, setTemplateChoice] = useState<string>('')
  const [draftColumns, setDraftColumns] = useState<DraftColumn[]>([])
  const [draftName, setDraftName] = useState('')
  const [draftPmSystem, setDraftPmSystem] = useState('')
  const [previewRows, setPreviewRows] = useState<
    { rowNumber: number; valid: boolean; errors: string[] }[]
  >([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ImportJob | null>(null)

  function reset(): void {
    setStep('setup')
    setFilePath(null)
    setHeaders([])
    setTemplateChoice('')
    setDraftColumns([])
    setPreviewRows([])
    setResult(null)
    setError(null)
  }

  async function handlePickFile(): Promise<void> {
    setError(null)
    try {
      const picked = await pickImportFile()
      if (!picked) return
      setFilePath(picked)
      const detectedHeaders = await peekFileHeaders(picked)
      setHeaders(detectedHeaders)
      setStep('mapping')
    } catch (err) {
      setError(String(err))
    }
  }

  async function handleChooseTemplate(templateId: string): Promise<void> {
    setTemplateChoice(templateId)
    if (templateId === NEW_TEMPLATE_VALUE) {
      const suggestions = await suggestMapping(headers)
      setDraftColumns(
        suggestions.map((s) => ({
          sourceHeader: s.sourceHeader,
          targetField: s.suggestedField ?? ''
        }))
      )
      setDraftName('')
      setDraftPmSystem('')
    }
  }

  function currentMappingInput(): NewMappingTemplateInput | null {
    if (templateChoice && templateChoice !== NEW_TEMPLATE_VALUE) {
      const existing = templates.find((t) => t.templateId === templateChoice)
      if (!existing) return null
      return { ...existing }
    }
    const columns: MappingColumn[] = draftColumns
      .filter((c) => c.targetField !== '')
      .map((c) => ({ sourceHeader: c.sourceHeader, targetField: c.targetField, transform: 'none' }))
    if (columns.length === 0 || !draftName || !draftPmSystem) return null
    return {
      name: draftName,
      pmSystem: draftPmSystem,
      targetEntity: 'claims',
      grain: 'line',
      columns,
      keyFields: columns.slice(0, 1).map((c) => c.sourceHeader)
    }
  }

  async function handlePreview(): Promise<void> {
    const mapping = currentMappingInput()
    if (!mapping || !filePath) {
      setError(
        'Pick a target field for at least one column, and name the mapping, before previewing.'
      )
      return
    }
    setBusy(true)
    setError(null)
    try {
      const rows = await previewMapping(filePath, mapping)
      setPreviewRows(rows)
      setStep('preview')
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleRun(): Promise<void> {
    const mapping = currentMappingInput()
    if (!mapping || !filePath || !clientCode) return
    setBusy(true)
    setError(null)
    try {
      let templateId = templateChoice
      if (templateChoice === NEW_TEMPLATE_VALUE || !templateChoice) {
        const saved = await saveMappingTemplate(mapping)
        templateId = saved.templateId
      }
      const job = await runCsvImport({ filePath, templateId, clientCode })
      setResult(job)
      setStep('result')
      onImportComplete()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  const invalidCount = previewRows.filter((r) => !r.valid).length

  return (
    <div className="wizard">
      {error && <p className="form-error">{error}</p>}

      {step === 'setup' && (
        <div className="wizard-step">
          <label>
            Client
            <select value={clientCode} onChange={(e) => setClientCode(e.target.value)}>
              <option value="">Select a client…</option>
              {clients.map((c) => (
                <option key={c.clientId} value={c.code}>
                  {c.code} — {c.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" disabled={!clientCode} onClick={() => void handlePickFile()}>
            Choose file…
          </button>
        </div>
      )}

      {step === 'mapping' && (
        <div className="wizard-step">
          <p>
            File: <code>{filePath}</code> ({headers.length} columns detected)
          </p>
          <label>
            Mapping template
            <select
              value={templateChoice}
              onChange={(e) => void handleChooseTemplate(e.target.value)}
            >
              <option value="">Select…</option>
              {templates.map((t) => (
                <option key={t.templateId} value={t.templateId}>
                  {t.name} {t.builtIn ? '(built-in)' : `(v${t.version})`}
                </option>
              ))}
              <option value={NEW_TEMPLATE_VALUE}>+ Create new mapping</option>
            </select>
          </label>

          {templateChoice === NEW_TEMPLATE_VALUE && (
            <div className="mapping-builder">
              <label>
                Template name
                <input value={draftName} onChange={(e) => setDraftName(e.target.value)} />
              </label>
              <label>
                PM system
                <input value={draftPmSystem} onChange={(e) => setDraftPmSystem(e.target.value)} />
              </label>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Source column</th>
                    <th>Maps to</th>
                  </tr>
                </thead>
                <tbody>
                  {draftColumns.map((col, index) => (
                    <tr key={col.sourceHeader}>
                      <td>{col.sourceHeader}</td>
                      <td>
                        <select
                          value={col.targetField}
                          onChange={(e) => {
                            const next = [...draftColumns]
                            next[index] = { ...col, targetField: e.target.value }
                            setDraftColumns(next)
                          }}
                        >
                          <option value="">— ignore —</option>
                          {CLAIM_LINE_TARGET_FIELDS.map((f) => (
                            <option key={f.field} value={f.field}>
                              {f.field}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <button
            type="button"
            disabled={busy || !templateChoice}
            onClick={() => void handlePreview()}
          >
            Preview
          </button>
        </div>
      )}

      {step === 'preview' && (
        <div className="wizard-step">
          <p>
            {previewRows.length} rows previewed — <strong>{invalidCount}</strong> would be
            quarantined.
          </p>
          <table className="data-table">
            <thead>
              <tr>
                <th>Row</th>
                <th>Valid?</th>
                <th>Errors</th>
              </tr>
            </thead>
            <tbody>
              {previewRows.slice(0, 10).map((row) => (
                <tr key={row.rowNumber}>
                  <td>{row.rowNumber}</td>
                  <td>{row.valid ? 'OK' : 'Quarantine'}</td>
                  <td>{row.errors.join('; ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {previewRows.length > 10 && <p>Showing the first 10 of {previewRows.length} rows.</p>}
          <button type="button" onClick={() => setStep('mapping')}>
            Back
          </button>
          <button type="button" disabled={busy} onClick={() => void handleRun()}>
            {busy ? 'Running…' : 'Save template & run import'}
          </button>
        </div>
      )}

      {step === 'result' && result && (
        <div className="wizard-step">
          <p>
            Job #{result.jobId}: <strong>{result.status}</strong> — {result.rowsLoaded} loaded,{' '}
            {result.rowsSkipped} quarantined, {result.rowsRead} read.
          </p>
          <button type="button" onClick={reset}>
            Import another file
          </button>
        </div>
      )}
    </div>
  )
}

export default Wizard

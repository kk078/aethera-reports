import { useEffect, useState } from 'react'
import type { Branding, BackupStatus } from '../../../shared/domain'
import {
  getBackupStatus,
  getBranding,
  pickAndSetBrandingLogo,
  ping,
  restoreLatestBackup,
  runBackupNow,
  updateBranding
} from '../lib/api'

function BrandingSection(): React.JSX.Element {
  const [branding, setBranding] = useState<Branding | null>(null)
  const [firmName, setFirmName] = useState('')
  const [primaryColor, setPrimaryColor] = useState('#2a78d6')
  const [secondaryColor, setSecondaryColor] = useState('#222222')
  const [footerDisclaimer, setFooterDisclaimer] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  function applyToForm(b: Branding): void {
    setBranding(b)
    setFirmName(b.firmName)
    setPrimaryColor(b.primaryColor)
    setSecondaryColor(b.secondaryColor)
    setFooterDisclaimer(b.footerDisclaimer ?? '')
  }

  useEffect(() => {
    getBranding().then(applyToForm)
  }, [])

  async function handleSave(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setSaving(true)
    setMessage(null)
    try {
      const updated = await updateBranding({
        firmName,
        primaryColor,
        secondaryColor,
        footerDisclaimer: footerDisclaimer.trim() === '' ? null : footerDisclaimer
      })
      applyToForm(updated)
      setMessage('Saved.')
    } catch (error) {
      setMessage(String(error))
    } finally {
      setSaving(false)
    }
  }

  async function handlePickLogo(): Promise<void> {
    try {
      const updated = await pickAndSetBrandingLogo()
      applyToForm(updated)
    } catch (error) {
      setMessage(String(error))
    }
  }

  return (
    <>
      <h2>Branding</h2>
      <p>
        Applied to the report document header, footer, and chart accents. Neutral defaults ship in
        the repo.
      </p>
      {branding && (
        <form className="client-form" onSubmit={(e) => void handleSave(e)}>
          {message && <p>{message}</p>}
          <label>
            Firm name
            <input value={firmName} onChange={(e) => setFirmName(e.target.value)} />
          </label>
          <label>
            Primary color
            <input
              type="color"
              value={primaryColor}
              onChange={(e) => setPrimaryColor(e.target.value)}
            />
          </label>
          <label>
            Secondary color
            <input
              type="color"
              value={secondaryColor}
              onChange={(e) => setSecondaryColor(e.target.value)}
            />
          </label>
          <label>
            Footer disclaimer
            <textarea
              value={footerDisclaimer}
              onChange={(e) => setFooterDisclaimer(e.target.value)}
            />
          </label>
          <label>
            Logo
            {branding.logoPath ? (
              <img
                src={branding.logoPath}
                alt="Current logo"
                style={{ maxHeight: 40, marginTop: 4 }}
              />
            ) : (
              <span style={{ color: 'var(--ev-c-text-2)' }}>No logo set</span>
            )}
          </label>
          <button type="button" onClick={() => void handlePickLogo()}>
            Choose logo…
          </button>
          <button type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save branding'}
          </button>
        </form>
      )}
    </>
  )
}

function BackupsSection(): React.JSX.Element {
  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  function refresh(): void {
    getBackupStatus().then(setStatus)
  }

  useEffect(refresh, [])

  async function handleBackupNow(): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      setStatus(await runBackupNow())
      setMessage('Backup created.')
    } catch (error) {
      setMessage(String(error))
    } finally {
      setBusy(false)
    }
  }

  async function handleRestore(): Promise<void> {
    if (
      !confirm(
        'Restore the most recent backup? The app will close and needs to be reopened afterward. Any changes since that backup are lost.'
      )
    ) {
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      const result = await restoreLatestBackup()
      setMessage(`Restored from ${result.restoredFrom}. The app is restarting…`)
    } catch (error) {
      setMessage(String(error))
      setBusy(false)
    }
  }

  return (
    <>
      <h2>Backups (Risk 5)</h2>
      {status && (
        <ul>
          <li>
            Last backup:{' '}
            {status.lastBackupAt ? new Date(status.lastBackupAt).toLocaleString() : 'never'}
          </li>
          <li>Backups retained: {status.backupCount}</li>
          <li>
            DuckDB integrity:{' '}
            {status.duckdbIntegrityOk === null
              ? 'unknown'
              : status.duckdbIntegrityOk
                ? 'OK'
                : 'FAILED'}
          </li>
          <li>
            SQLite integrity:{' '}
            {status.sqliteIntegrityOk === null
              ? 'unknown'
              : status.sqliteIntegrityOk
                ? 'OK'
                : 'FAILED'}
          </li>
        </ul>
      )}
      {message && <p>{message}</p>}
      <button type="button" disabled={busy} onClick={() => void handleBackupNow()}>
        Back up now
      </button>
      <button
        type="button"
        disabled={busy || !status?.backupCount}
        onClick={() => void handleRestore()}
      >
        Restore latest backup…
      </button>
    </>
  )
}

/**
 * Settings: branding (plan §6), backup status + restore (Risk 5,
 * deferred from step 4), and the IPC round-trip diagnostic from step 3.
 * Connector credentials / beacon URL land in Phase 2.
 */
function Settings(): React.JSX.Element {
  const [pingResult, setPingResult] = useState<string>('')

  async function handlePing(): Promise<void> {
    try {
      const response = await ping('hello from renderer')
      setPingResult(
        `pong: "${response.message}" at ${response.echoedAt} (main pid ${response.pid})`
      )
    } catch (error) {
      setPingResult(`ping failed: ${String(error)}`)
    }
  }

  return (
    <section className="screen-placeholder">
      <h1>Settings</h1>

      <BrandingSection />
      <BackupsSection />

      <h2>Diagnostics</h2>
      <p>Verifies the preload → zod IPC → main round trip.</p>
      <button type="button" onClick={() => void handlePing()}>
        Ping main process
      </button>
      {pingResult && <p data-testid="ping-result">{pingResult}</p>}
    </section>
  )
}

export default Settings

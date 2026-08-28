import { useEffect, useState } from 'react'
import type {
  Branding,
  BackupStatus,
  ConnectorSyncStatusRow,
  ReferenceApiCacheRefreshResult
} from '../../../shared/domain'
import {
  getBackupStatus,
  getBranding,
  getConnectorSettings,
  getConnectorSyncStatus,
  getReferenceApiSettings,
  pickAndSetBrandingLogo,
  ping,
  refreshReferenceApiCache,
  restoreLatestBackup,
  runBackupNow,
  saveConnectorSettings,
  saveReferenceApiSettings,
  syncConnectorNow,
  testConnectorConnection,
  testReferenceApiConnection,
  updateBranding
} from '../lib/api'

function currentMonthValue(): string {
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * Generic RCM Platform REST connector settings (plan §3 bullet 3):
 * connection config, "Test connection", per-client sync status, "Sync
 * now". Errors surface inline — this screen never blocks app startup,
 * the connector is entirely optional/off by default.
 */
function ConnectorSection(): React.JSX.Element {
  const [baseUrl, setBaseUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [hasPassword, setHasPassword] = useState(false)
  const [passwordEncoding, setPasswordEncoding] = useState<'safeStorage' | 'plaintext' | null>(null)
  const [period, setPeriod] = useState(currentMonthValue())
  const [syncStatus, setSyncStatus] = useState<ConnectorSyncStatusRow[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  function refreshStatus(): void {
    void getConnectorSyncStatus().then(setSyncStatus)
  }

  useEffect(() => {
    getConnectorSettings().then((s) => {
      setBaseUrl(s.baseUrl ?? '')
      setUsername(s.username ?? '')
      setEnabled(s.enabled)
      setHasPassword(s.hasPassword)
      setPasswordEncoding(s.passwordEncoding)
    })
    refreshStatus()
  }, [])

  async function handleSave(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      const saved = await saveConnectorSettings({
        baseUrl: baseUrl.trim(),
        username: username.trim(),
        password: password.trim() ? password.trim() : undefined,
        enabled
      })
      setHasPassword(saved.hasPassword)
      setPasswordEncoding(saved.passwordEncoding)
      setPassword('')
      setMessage('Saved.')
    } catch (error) {
      setMessage(String(error))
    } finally {
      setBusy(false)
    }
  }

  async function handleTest(): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      const result = await testConnectorConnection()
      setMessage(result.ok ? `✓ ${result.message}` : `✗ ${result.message}`)
    } catch (error) {
      setMessage(String(error))
    } finally {
      setBusy(false)
    }
  }

  async function handleSyncNow(): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      const result = await syncConnectorNow(period)
      const failures = result.results.filter((r) => !r.ok)
      setMessage(
        `Synced ${result.results.length} client(s) for ${result.periodMonth} — ${failures.length} failure(s).`
      )
      refreshStatus()
    } catch (error) {
      setMessage(String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h2>RCM Platform connector</h2>
      <p>
        Generic REST connector (configurable base URL + OAuth2 password/JWT) — syncs each
        client&apos;s computed monthly report into <code>monthly_summaries</code>/
        <code>kpi_snapshots</code> with provenance <code>synced</code>. See{' '}
        <code>docs/connectors.md</code> for the API contract; rcm-prototype is the documented
        reference implementation, not a hardcoded dependency.
      </p>
      <form className="client-form" onSubmit={(e) => void handleSave(e)}>
        {message && <p>{message}</p>}
        <label>
          Enabled
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        </label>
        <label>
          Base URL
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="http://127.0.0.1:8000"
          />
        </label>
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label>
          Password {hasPassword && !password && '(saved — leave blank to keep it)'}
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={hasPassword ? '••••••••' : ''}
          />
        </label>
        {hasPassword && passwordEncoding === 'plaintext' && (
          <p className="form-error">
            Warning: OS-level credential encryption is unavailable on this machine — the password is
            stored in plaintext in meta.db. Re-enter it after fixing the OS keyring/DPAPI to upgrade
            to encrypted storage.
          </p>
        )}
        <button type="submit" disabled={busy}>
          Save
        </button>
        <button type="button" disabled={busy || !hasPassword} onClick={() => void handleTest()}>
          Test connection
        </button>
      </form>

      <h3>Sync</h3>
      <div className="manual-entry-controls">
        <label>
          Period
          <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
        </label>
        <button type="button" disabled={busy || !hasPassword} onClick={() => void handleSyncNow()}>
          {busy ? 'Working…' : 'Sync now'}
        </button>
      </div>

      <h3>Per-client sync status</h3>
      {syncStatus.length === 0 ? (
        <p>No syncs recorded yet.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Client</th>
              <th>Last period</th>
              <th>Last synced</th>
              <th>Status</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {syncStatus.map((row) => (
              <tr key={row.clientCode}>
                <td>
                  {row.clientCode}
                  {row.createdByConnector && ' (created by connector)'}
                </td>
                <td>{row.lastSyncedPeriod ?? '—'}</td>
                <td>{row.lastSyncedAt ? new Date(row.lastSyncedAt).toLocaleString() : '—'}</td>
                <td>{row.lastStatus ?? '—'}</td>
                <td>{row.lastError ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

/**
 * Reference & Benchmark API connector settings (the beacon paragraph) —
 * optional, degrades gracefully. "Refresh cache" also runs automatically
 * (fire-and-forget) after every CSV/X12 import.
 */
function ReferenceApiSection(): React.JSX.Element {
  const [baseUrl, setBaseUrl] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [lastHealthOk, setLastHealthOk] = useState<boolean | null>(null)
  const [lastHealthAt, setLastHealthAt] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  function refresh(): void {
    getReferenceApiSettings().then((s) => {
      setBaseUrl(s.baseUrl)
      setEnabled(s.enabled)
      setLastHealthOk(s.lastHealthOk)
      setLastHealthAt(s.lastHealthAt)
    })
  }

  useEffect(refresh, [])

  async function handleSave(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      await saveReferenceApiSettings({ baseUrl: baseUrl.trim(), enabled })
      setMessage('Saved.')
      refresh()
    } catch (error) {
      setMessage(String(error))
    } finally {
      setBusy(false)
    }
  }

  async function handleTest(): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      const result = await testReferenceApiConnection()
      setMessage(result.ok ? `✓ ${result.message}` : `✗ ${result.message}`)
      refresh()
    } catch (error) {
      setMessage(String(error))
    } finally {
      setBusy(false)
    }
  }

  async function handleRefreshCache(): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      const result: ReferenceApiCacheRefreshResult = await refreshReferenceApiCache()
      setMessage(
        `CARC: ${result.carc.cached} cached, ${result.carc.notFound} not found. CPT: ${result.cpt.cached} cached, ${result.cpt.notFound} not found.`
      )
    } catch (error) {
      setMessage(String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h2>Reference &amp; Benchmark API</h2>
      <p>
        Optional enrichment (generic, configurable base URL) — caches CARC/CPT descriptions locally
        and adds a &quot;vs. state benchmark&quot; callout to client reports when a client has a
        state set. The app degrades gracefully whenever this is unreachable; the reference
        deployment used during development is <code>http://127.0.0.1:8110</code> (not a hardcoded
        dependency).
      </p>
      <form className="client-form" onSubmit={(e) => void handleSave(e)}>
        {message && <p>{message}</p>}
        <label>
          Enabled
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        </label>
        <label>
          Base URL
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
        <p>
          Last health check:{' '}
          {lastHealthAt
            ? `${lastHealthOk ? 'reachable' : 'unreachable'} at ${new Date(lastHealthAt).toLocaleString()}`
            : 'never checked'}
        </p>
        <button type="submit" disabled={busy}>
          Save
        </button>
        <button type="button" disabled={busy} onClick={() => void handleTest()}>
          Test connection
        </button>
        <button type="button" disabled={busy} onClick={() => void handleRefreshCache()}>
          Refresh cache now
        </button>
      </form>
    </>
  )
}

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
      <ConnectorSection />
      <ReferenceApiSection />
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

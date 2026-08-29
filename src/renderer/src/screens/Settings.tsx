import { useEffect, useState } from 'react'
import type {
  Branding,
  BackupStatus,
  Client,
  ConnectorSyncStatusRow,
  DataModeStatus,
  UpdateCheckResult,
  UpdateSettingsStatus,
  EmailSettings,
  MappingTemplate,
  ReferenceApiCacheRefreshResult
} from '../../../shared/domain'
import {
  applyBrandAccentTint,
  isBrandAccentTintEnabled,
  setBrandAccentTintEnabled
} from '../lib/brand-tint'
import {
  getAutomationInboxSettings,
  getBackupStatus,
  getBranding,
  getConnectorSettings,
  getConnectorSyncStatus,
  getDataMode,
  getUpdateStatus,
  setAutoCheckUpdates,
  checkForUpdatesNow,
  getEmailSettings,
  getPortalSettings,
  getReferenceApiSettings,
  listClients,
  listMappingTemplates,
  pickAndSetBrandingLogo,
  ping,
  refreshReferenceApiCache,
  restartApp,
  restoreLatestBackup,
  runBackupNow,
  saveConnectorSettings,
  saveEmailSettings,
  savePortalSettings,
  saveReferenceApiSettings,
  scanInboxNow,
  setAutomationInboxRoot,
  setFolderTemplatePin,
  setLocalDataMode,
  setServerDataMode,
  syncConnectorNow,
  testConnectorConnection,
  testEmailConnection,
  testPortalConnection,
  testReferenceApiConnection,
  testServerDataModeConnection,
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
  const [syncClaimLevel, setSyncClaimLevel] = useState(true)
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
      setSyncClaimLevel(s.syncClaimLevel)
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
        enabled,
        syncClaimLevel
      })
      setHasPassword(saved.hasPassword)
      setPasswordEncoding(saved.passwordEncoding)
      setSyncClaimLevel(saved.syncClaimLevel)
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
      const cl = result.claimLevel
      const batchFailures = cl.batches.filter((b) => !b.ok)
      const claimLevelMsg = cl.enabled
        ? ` Claim-level: ${cl.batches.length} batch(es) (${batchFailures.length} failure(s)), ${cl.enrichment.claimsUpdated} claim(s) enriched.`
        : ' Claim-level sync is off.'
      setMessage(
        `Synced ${result.results.length} client(s) for ${result.periodMonth} — ${failures.length} failure(s).${claimLevelMsg}`
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
          Sync claim-level detail (837 batches)
          <input
            type="checkbox"
            checked={syncClaimLevel}
            onChange={(e) => setSyncClaimLevel(e.target.checked)}
          />
        </label>
        <p>
          When on (the default), each sync also pulls new submission batches as X12 837 into{' '}
          <code>claims</code>/<code>claim_lines</code> (provenance <code>api</code>) and enriches
          previously-synced claims with paid/allowed/status/denial detail — see the
          &quot;Claim-level sync&quot; section of <code>docs/connectors.md</code>.
        </p>
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
              <th>Last batch</th>
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
                <td>{row.lastBatchCursor ?? '—'}</td>
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

/**
 * Data mode (plan's Phase 3 addendum, chunk E): Local (this install's own
 * DuckDB/SQLite, the default) or Server (a shared `server/` deployment
 * over HTTP — see `docs/server-mode.md`). Switching modes changes which
 * `IDataService` the main process builds at launch, so it only takes
 * effect after a restart — this section walks the user through that
 * explicitly rather than restarting out from under them.
 */
/**
 * Hosted client portal (plan's Phase 3 addendum, chunk F) — where staff
 * point this install at a deployed `portal/` Worker so ClientDetail's
 * "Publish to portal" button and `deliver: 'portal'` scheduler rules
 * have somewhere to publish to. The admin token is write-only from here
 * (never read back) — same pattern as the RCM connector's password.
 */
function PortalSection(): React.JSX.Element {
  const [baseUrl, setBaseUrl] = useState('')
  const [adminToken, setAdminToken] = useState('')
  const [hasAdminToken, setHasAdminToken] = useState(false)
  const [tokenEncoding, setTokenEncoding] = useState<'safeStorage' | 'plaintext' | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  function refresh(): void {
    getPortalSettings().then((s) => {
      setBaseUrl(s.baseUrl ?? '')
      setHasAdminToken(s.hasAdminToken)
      setTokenEncoding(s.tokenEncoding)
    })
  }

  useEffect(refresh, [])

  async function handleSave(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      await savePortalSettings({
        baseUrl: baseUrl.trim(),
        adminToken: adminToken.trim() || undefined
      })
      setAdminToken('')
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
      const result = await testPortalConnection()
      setMessage(result.ok ? `✓ ${result.message}` : `✗ ${result.message}`)
    } catch (error) {
      setMessage(String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h2>Hosted client portal</h2>
      <p>
        Optional — publish a client&apos;s report as a read-only page a deployed{' '}
        <code>portal/</code> Worker serves, and email each recipient a private, expiring link
        instead of (or alongside) attaching files. See <code>docs/portal.md</code> for deploying the
        Worker.
      </p>
      <form className="client-form" onSubmit={(e) => void handleSave(e)}>
        {message && <p>{message}</p>}
        <label>
          Portal URL
          <input
            placeholder="https://reports.example.com"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </label>
        <label>
          Admin token
          <input
            type="password"
            placeholder={hasAdminToken ? '•••••••• (leave blank to keep)' : ''}
            value={adminToken}
            onChange={(e) => setAdminToken(e.target.value)}
          />
        </label>
        {hasAdminToken && tokenEncoding === 'plaintext' && (
          <p>
            Warning: this machine has no OS-level credential store available, so the admin token is
            stored in plaintext in the local database.
          </p>
        )}
        <button type="submit" disabled={busy}>
          Save
        </button>
        <button type="button" disabled={busy} onClick={() => void handleTest()}>
          Test connection
        </button>
      </form>
    </>
  )
}

function DataModeSection(): React.JSX.Element {
  const [status, setStatus] = useState<DataModeStatus | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [switched, setSwitched] = useState(false)

  function refresh(): void {
    getDataMode().then((s) => {
      setStatus(s)
      if (s.server) {
        setBaseUrl(s.server.baseUrl)
        setUsername(s.server.username)
      }
    })
  }

  useEffect(refresh, [])

  async function handleTest(): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      const result = await testServerDataModeConnection({
        baseUrl: baseUrl.trim(),
        username: username.trim(),
        password
      })
      setMessage(result.ok ? `✓ ${result.message}` : `✗ ${result.message}`)
    } catch (error) {
      setMessage(String(error))
    } finally {
      setBusy(false)
    }
  }

  async function handleSwitchToServer(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      const updated = await setServerDataMode({
        baseUrl: baseUrl.trim(),
        username: username.trim(),
        password
      })
      setStatus(updated)
      setPassword('')
      setSwitched(true)
      setMessage('Switched to Server mode — restart the app for it to take effect.')
    } catch (error) {
      setMessage(String(error))
    } finally {
      setBusy(false)
    }
  }

  async function handleSwitchToLocal(): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      const updated = await setLocalDataMode()
      setStatus(updated)
      setSwitched(true)
      setMessage('Switched to Local mode — restart the app for it to take effect.')
    } catch (error) {
      setMessage(String(error))
    } finally {
      setBusy(false)
    }
  }

  async function handleRestart(): Promise<void> {
    await restartApp()
  }

  if (!status) return <h2>Data mode</h2>

  return (
    <>
      <h2>Data mode</h2>
      <p>
        <strong>Local</strong> (default) keeps every client&apos;s data in this install&apos;s own
        database. <strong>Server</strong> points this install at a shared{' '}
        <code>aethera-reports</code> server (see <code>docs/server-mode.md</code>) so several staff
        machines see the same data — reports, exports, and automation all keep working exactly the
        same either way.
      </p>
      <p>
        Current mode: <strong>{status.mode === 'server' ? 'Server' : 'Local'}</strong>
        {status.server && ` (${status.server.baseUrl} as "${status.server.username}")`}
      </p>

      {message && <p>{message}</p>}

      {switched && (
        <p>
          <button type="button" onClick={() => void handleRestart()}>
            Restart now
          </button>
        </p>
      )}

      {status.mode === 'local' ? (
        <form className="client-form" onSubmit={(e) => void handleSwitchToServer(e)}>
          <label>
            Server URL
            <input
              placeholder="https://reports.example.internal:8787"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </label>
          <label>
            Username
            <input value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <button type="button" disabled={busy} onClick={() => void handleTest()}>
            Test connection
          </button>
          <button type="submit" disabled={busy || !baseUrl || !username || !password}>
            Switch to Server
          </button>
        </form>
      ) : (
        <button type="button" disabled={busy} onClick={() => void handleSwitchToLocal()}>
          Switch to Local
        </button>
      )}
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
  const [accentTintOn, setAccentTintOn] = useState(false)

  function applyToForm(b: Branding): void {
    setBranding(b)
    setFirmName(b.firmName)
    setPrimaryColor(b.primaryColor)
    setSecondaryColor(b.secondaryColor)
    setFooterDisclaimer(b.footerDisclaimer ?? '')
  }

  useEffect(() => {
    getBranding().then(applyToForm)
    setAccentTintOn(isBrandAccentTintEnabled())
  }, [])

  function handleToggleAccentTint(enabled: boolean): void {
    setAccentTintOn(enabled)
    setBrandAccentTintEnabled(enabled)
    applyBrandAccentTint(enabled ? (branding?.primaryColor ?? primaryColor) : null)
  }

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
      if (accentTintOn) applyBrandAccentTint(updated.primaryColor)
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
              <span style={{ color: 'var(--text-muted)' }}>No logo set</span>
            )}
          </label>
          <button type="button" onClick={() => void handlePickLogo()}>
            Choose logo…
          </button>
          <button type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save branding'}
          </button>
          <label className="format-checkboxes">
            <input
              type="checkbox"
              checked={accentTintOn}
              onChange={(e) => handleToggleAccentTint(e.target.checked)}
            />
            Apply brand accent to app (off by default — tints the app&apos;s accent color only;
            reports/exports already use branding fully either way)
          </label>
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
 * Watch-folder auto-import settings (plan §11): inbox root + per-client
 * folder mapping-template pins (X12 files never need one — routed by
 * detect()), and a manual "Scan now" button (the same catch-up-scan
 * `--import <dir>` and app launch use).
 */
function WatchFolderSection(): React.JSX.Element {
  const [inboxRoot, setInboxRoot] = useState('')
  const [pins, setPins] = useState<Array<{ clientCode: string; templateId: string }>>([])
  const [clients, setClients] = useState<Client[]>([])
  const [templates, setTemplates] = useState<MappingTemplate[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  function refresh(): void {
    getAutomationInboxSettings().then((s) => {
      setInboxRoot(s.inboxRoot ?? '')
      setPins(s.folderTemplatePins)
    })
    listClients().then(setClients)
    listMappingTemplates().then(setTemplates)
  }

  useEffect(refresh, [])

  async function handleSaveRoot(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      const settings = await setAutomationInboxRoot(inboxRoot.trim() || null)
      setInboxRoot(settings.inboxRoot ?? '')
      setPins(settings.folderTemplatePins)
      setMessage('Saved.')
    } catch (error) {
      setMessage(String(error))
    } finally {
      setBusy(false)
    }
  }

  async function handlePinChange(clientCode: string, templateId: string): Promise<void> {
    const settings = await setFolderTemplatePin(clientCode, templateId || null)
    setPins(settings.folderTemplatePins)
  }

  async function handleScanNow(): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      const result = await scanInboxNow()
      setMessage(`Scanned: ${result.processed} processed, ${result.failed} failed.`)
    } catch (error) {
      setMessage(String(error))
    } finally {
      setBusy(false)
    }
  }

  const pinByCode = new Map(pins.map((p) => [p.clientCode, p.templateId]))

  return (
    <>
      <h2>Watch folder</h2>
      <p>
        A configurable inbox root with one subfolder per client code (
        <code>&lt;inbox&gt;/&lt;CLIENT_CODE&gt;/</code>) — X12 835/837 files are routed
        automatically; CSV/XLSX files use the mapping template pinned to that client&apos;s folder
        below. Processed files move to <code>processed/</code>, failures to <code>failed/</code>{' '}
        with a <code>.error.txt</code> reason.
      </p>
      <form className="client-form" onSubmit={(e) => void handleSaveRoot(e)}>
        {message && <p>{message}</p>}
        <label>
          Inbox root folder
          <input
            value={inboxRoot}
            onChange={(e) => setInboxRoot(e.target.value)}
            placeholder="C:\Inbox or /home/user/inbox"
          />
        </label>
        <button type="submit" disabled={busy}>
          Save
        </button>
        <button type="button" disabled={busy || !inboxRoot} onClick={() => void handleScanNow()}>
          Scan now
        </button>
      </form>

      {clients.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Client folder</th>
              <th>Pinned mapping template</th>
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.clientId}>
                <td>{c.code}</td>
                <td>
                  <select
                    value={pinByCode.get(c.code) ?? ''}
                    onChange={(e) => void handlePinChange(c.code, e.target.value)}
                  >
                    <option value="">— none (X12 only) —</option>
                    {templates.map((t) => (
                      <option key={t.templateId} value={t.templateId}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

/** SMTP email delivery settings (plan §11) — password encrypted the same way as the RCM connector's. */
function EmailSection(): React.JSX.Element {
  const [settings, setSettings] = useState<EmailSettings | null>(null)
  const [host, setHost] = useState('')
  const [port, setPort] = useState('587')
  const [secure, setSecure] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [fromAddress, setFromAddress] = useState('')
  const [subjectTemplate, setSubjectTemplate] = useState('')
  const [bodyTemplate, setBodyTemplate] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  function applyToForm(s: EmailSettings): void {
    setSettings(s)
    setHost(s.host ?? '')
    setPort(s.port ? String(s.port) : '587')
    setSecure(s.secure)
    setUsername(s.username ?? '')
    setFromAddress(s.fromAddress ?? '')
    setSubjectTemplate(s.subjectTemplate)
    setBodyTemplate(s.bodyTemplate)
  }

  useEffect(() => {
    getEmailSettings().then(applyToForm)
  }, [])

  async function handleSave(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      const saved = await saveEmailSettings({
        host: host.trim(),
        port: Number(port),
        secure,
        username: username.trim() || undefined,
        password: password.trim() ? password.trim() : undefined,
        fromAddress: fromAddress.trim(),
        subjectTemplate,
        bodyTemplate
      })
      applyToForm(saved)
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
      const result = await testEmailConnection()
      setMessage(result.ok ? `✓ ${result.message}` : `✗ ${result.message}`)
    } catch (error) {
      setMessage(String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h2>Email delivery</h2>
      <p>
        SMTP settings for scheduled/manual report-pack delivery (plan §11) —{' '}
        <code>{'{client}'}</code> and <code>{'{period}'}</code> placeholders are available in the
        subject/body templates.
      </p>
      <form className="client-form" onSubmit={(e) => void handleSave(e)}>
        {message && <p>{message}</p>}
        <label>
          SMTP host
          <input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="smtp.example.com"
          />
        </label>
        <label>
          Port
          <input type="number" value={port} onChange={(e) => setPort(e.target.value)} />
        </label>
        <label>
          Use TLS (secure)
          <input type="checkbox" checked={secure} onChange={(e) => setSecure(e.target.checked)} />
        </label>
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label>
          Password {settings?.hasPassword && !password && '(saved — leave blank to keep it)'}
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={settings?.hasPassword ? '••••••••' : ''}
          />
        </label>
        <label>
          From address
          <input
            type="email"
            value={fromAddress}
            onChange={(e) => setFromAddress(e.target.value)}
            placeholder="reports@yourfirm.example"
          />
        </label>
        <label>
          Subject template
          <input value={subjectTemplate} onChange={(e) => setSubjectTemplate(e.target.value)} />
        </label>
        <label>
          Body template
          <textarea value={bodyTemplate} onChange={(e) => setBodyTemplate(e.target.value)} />
        </label>
        {settings?.hasPassword && settings.passwordEncoding === 'plaintext' && (
          <p className="form-error">
            Warning: OS-level credential encryption is unavailable on this machine — the password is
            stored in plaintext in meta.db.
          </p>
        )}
        <button type="submit" disabled={busy}>
          Save
        </button>
        <button type="button" disabled={busy || !settings?.host} onClick={() => void handleTest()}>
          Test connection
        </button>
      </form>
    </>
  )
}

function UpdatesSection(): React.JSX.Element {
  const [status, setStatus] = useState<UpdateSettingsStatus | null>(null)
  const [result, setResult] = useState<UpdateCheckResult | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    getUpdateStatus()
      .then((s) => {
        setStatus(s)
        if (s.startupResult) setResult(s.startupResult)
      })
      .catch(() => undefined)
  }, [])

  async function handleToggle(enabled: boolean): Promise<void> {
    try {
      setStatus(await setAutoCheckUpdates(enabled))
    } catch {
      /* leave prior state */
    }
  }

  async function handleCheckNow(): Promise<void> {
    setBusy(true)
    try {
      setResult(await checkForUpdatesNow())
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h2>Updates</h2>
      <p>
        Version {status?.currentVersion ?? '…'}. Checking contacts github.com once and only reads
        the latest release number — nothing is downloaded or installed automatically.
      </p>
      <label>
        <input
          type="checkbox"
          checked={status?.autoCheckUpdates ?? false}
          onChange={(e) => void handleToggle(e.target.checked)}
        />{' '}
        Check for updates when the app starts
      </label>
      <div>
        <button type="button" disabled={busy} onClick={() => void handleCheckNow()}>
          {busy ? 'Checking…' : 'Check now'}
        </button>
      </div>
      {result &&
        (!result.checked ? (
          <p>Could not reach the update service — try again later.</p>
        ) : result.latestVersion === null ? (
          <p>No published releases yet — you are running a pre-release build.</p>
        ) : result.updateAvailable ? (
          <p>
            Version {result.latestVersion} is available —{' '}
            <a href={result.releaseUrl} target="_blank" rel="noreferrer">
              open the release page
            </a>{' '}
            to download it.
          </p>
        ) : (
          <p>You are on the latest version.</p>
        ))}
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
      <WatchFolderSection />
      <EmailSection />
      <PortalSection />
      <BackupsSection />
      <DataModeSection />
      <UpdatesSection />

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

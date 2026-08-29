import { useEffect, useState } from 'react'
import { HashRouter, Routes, Route, Outlet } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import { getBranding, getUpdateStatus } from './lib/api'
import { applyBrandAccentTint, isBrandAccentTintEnabled } from './lib/brand-tint'
import type { UpdateCheckResult } from '../../shared/domain'
import Portfolio from './screens/Portfolio'
import Clients from './screens/Clients'
import ClientDetail from './screens/ClientDetail'
import Denials from './screens/Denials'
import AR from './screens/AR'
import Payers from './screens/Payers'
import Imports from './screens/Imports'
import ManualEntry from './screens/ManualEntry'
import Automation from './screens/Automation'
import Settings from './screens/Settings'
import PrintClientReport from './screens/print/PrintClientReport'

function AppLayout(): React.JSX.Element {
  // "Apply brand accent to app" (Settings → Branding, off by default) —
  // re-applied on every launch so the chrome stays tinted across
  // restarts without needing to revisit Settings first.
  useEffect(() => {
    if (!isBrandAccentTintEnabled()) return
    getBranding()
      .then((branding) => applyBrandAccentTint(branding.primaryColor))
      .catch(() => undefined)
  }, [])

  // Launch-time update banner: shows only when the user opted into the
  // startup check (Settings → Updates) AND it found a newer release.
  // Dismissal lasts the session; the check itself ran in main.
  const [update, setUpdate] = useState<UpdateCheckResult | null>(null)
  useEffect(() => {
    if (sessionStorage.getItem('update-banner-dismissed')) return
    getUpdateStatus()
      .then((s) => {
        if (s.startupResult?.updateAvailable) setUpdate(s.startupResult)
      })
      .catch(() => undefined)
  }, [])

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="app-content">
        {update && (
          <div className="update-banner" role="status">
            <span>
              Aethera Reports {update.latestVersion} is available —{' '}
              <a href={update.releaseUrl} target="_blank" rel="noreferrer">
                open the release page
              </a>
              .
            </span>
            <button
              type="button"
              aria-label="Dismiss update notice"
              onClick={() => {
                sessionStorage.setItem('update-banner-dismissed', '1')
                setUpdate(null)
              }}
            >
              ✕
            </button>
          </div>
        )}
        <Outlet />
      </main>
    </div>
  )
}

// Hash history is required under `file://` (plan §5) — there's no HTTP
// server serving the packaged renderer, so browser (path-based) history
// has nothing to resolve against.
function App(): React.JSX.Element {
  return (
    <HashRouter>
      <Routes>
        {/* Print route (plan §6): loaded by an offscreen BrowserWindow for
            PDF export — deliberately outside AppLayout, no sidebar/chrome. */}
        <Route path="/print/:clientId/:period" element={<PrintClientReport />} />

        <Route element={<AppLayout />}>
          <Route path="/" element={<Portfolio />} />
          <Route path="/clients" element={<Clients />} />
          <Route path="/clients/:clientId" element={<ClientDetail />} />
          <Route path="/denials" element={<Denials />} />
          <Route path="/ar" element={<AR />} />
          <Route path="/payers" element={<Payers />} />
          <Route path="/imports" element={<Imports />} />
          <Route path="/manual-entry" element={<ManualEntry />} />
          <Route path="/automation" element={<Automation />} />
          <Route path="/settings" element={<Settings />} />
        </Route>
      </Routes>
    </HashRouter>
  )
}

export default App

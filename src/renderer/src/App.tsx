import { useCallback, useEffect, useState } from 'react'
import { HashRouter, Outlet, Route, Routes } from 'react-router-dom'
import CommandPalette, { useCommandPaletteShortcut } from './components/CommandPalette'
import Sidebar from './components/Sidebar'
import ScopeBar from './components/ui/ScopeBar'
import type { UpdateCheckResult } from '../../shared/domain'
import { AppScopeProvider, useAppScope } from './lib/app-scope'
import { getBranding, getUpdateStatus } from './lib/api'
import { applyBrandAccentTint, isBrandAccentTintEnabled } from './lib/brand-tint'
import AR from './screens/AR'
import Automation from './screens/Automation'
import ClientDetail from './screens/ClientDetail'
import Clients from './screens/Clients'
import Denials from './screens/Denials'
import Imports from './screens/Imports'
import ManualEntry from './screens/ManualEntry'
import Payers from './screens/Payers'
import Portfolio from './screens/Portfolio'
import Settings from './screens/Settings'
import PrintClientReport from './screens/print/PrintClientReport'

function AppLayout(): React.JSX.Element {
  const { clients } = useAppScope()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const openPalette = useCallback(() => setPaletteOpen(true), [])
  const closePalette = useCallback(() => setPaletteOpen(false), [])
  useCommandPaletteShortcut(openPalette)

  useEffect(() => {
    if (!isBrandAccentTintEnabled()) return
    getBranding()
      .then((branding) => applyBrandAccentTint(branding.primaryColor))
      .catch(() => undefined)
  }, [])

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
        <ScopeBar onOpenSearch={openPalette} />
        <Outlet />
      </main>
      <CommandPalette open={paletteOpen} onClose={closePalette} clients={clients} />
    </div>
  )
}

// Hash history is required under `file://` — there's no HTTP server serving
// the packaged renderer, so browser (path-based) history has nothing to
// resolve against.
function App(): React.JSX.Element {
  return (
    <AppScopeProvider>
      <HashRouter>
        <Routes>
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
    </AppScopeProvider>
  )
}

export default App

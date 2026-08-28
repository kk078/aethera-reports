import { HashRouter, Routes, Route, Outlet } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import Portfolio from './screens/Portfolio'
import Clients from './screens/Clients'
import ClientDetail from './screens/ClientDetail'
import Denials from './screens/Denials'
import AR from './screens/AR'
import Payers from './screens/Payers'
import Imports from './screens/Imports'
import ManualEntry from './screens/ManualEntry'
import Settings from './screens/Settings'
import PrintClientReport from './screens/print/PrintClientReport'

function AppLayout(): React.JSX.Element {
  return (
    <div className="app-shell">
      <Sidebar />
      <main className="app-content">
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
          <Route path="/settings" element={<Settings />} />
        </Route>
      </Routes>
    </HashRouter>
  )
}

export default App

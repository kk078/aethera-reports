import { NavLink } from 'react-router-dom'
import BrandMark from './BrandMark'
import { useTheme } from '../lib/theme'

// Grouped in workflow order: see where things stand, get data in, analyze
// it, then the machinery that runs and configures the process. Individual
// client reports are reached from Portfolio/Clients rows, not the rail.
// Groups are separated by a thin rule (M3 nav-rail convention) rather than
// a text section header — there's no room for one at 72px.
const navGroups: Array<Array<{ to: string; label: string; icon: string; end?: boolean }>> = [
  [
    { to: '/', label: 'Portfolio', icon: 'dashboard', end: true },
    { to: '/clients', label: 'Clients', icon: 'group', end: true }
  ],
  [
    { to: '/imports', label: 'Imports', icon: 'upload_file' },
    { to: '/manual-entry', label: 'Manual', icon: 'edit_note' }
  ],
  [
    { to: '/denials', label: 'Denials', icon: 'report' },
    { to: '/ar', label: 'A/R', icon: 'payments' },
    { to: '/payers', label: 'Payers', icon: 'hub' }
  ],
  [
    { to: '/automation', label: 'Auto', icon: 'bolt' },
    { to: '/settings', label: 'Settings', icon: 'settings' }
  ]
]

function Sidebar(): React.JSX.Element {
  const { mode, toggle } = useTheme()

  return (
    <nav className="nav-rail" aria-label="Primary">
      <div className="nav-rail-brand">
        <BrandMark size={28} />
      </div>
      <div className="nav-rail-groups">
        {navGroups.map((group, i) => (
          <div className="nav-rail-group" key={i}>
            {group.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end} className="nav-rail-item">
                <span className="nav-rail-item-indicator">
                  <span className="material-symbols-rounded" aria-hidden="true">
                    {item.icon}
                  </span>
                </span>
                <span className="nav-rail-item-label label-mono">{item.label}</span>
              </NavLink>
            ))}
          </div>
        ))}
      </div>
      <div className="nav-rail-footer">
        <button
          type="button"
          className="nav-rail-theme-toggle"
          onClick={toggle}
          aria-label={`Switch to ${mode === 'dark' ? 'light' : 'dark'} mode`}
          title={`Switch to ${mode === 'dark' ? 'light' : 'dark'} mode`}
        >
          <span className="material-symbols-rounded" aria-hidden="true">
            {mode === 'dark' ? 'light_mode' : 'dark_mode'}
          </span>
        </button>
      </div>
    </nav>
  )
}

export default Sidebar

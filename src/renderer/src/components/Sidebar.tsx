import { NavLink } from 'react-router-dom'
import BrandMark from './BrandMark'
import { useTheme } from '../lib/theme'

// Grouped in workflow order: see where things stand, get data in, analyze
// it, then the machinery that runs and configures the process. Individual
// client reports are reached from Portfolio/Clients rows, not the nav.
const navSections: Array<{
  label: string | null
  items: Array<{ to: string; label: string; end?: boolean }>
}> = [
  {
    label: null,
    items: [
      { to: '/', label: 'Portfolio', end: true },
      { to: '/clients', label: 'Clients', end: true }
    ]
  },
  {
    label: 'Data intake',
    items: [
      { to: '/imports', label: 'Imports' },
      { to: '/manual-entry', label: 'Manual Entry' }
    ]
  },
  {
    label: 'Analytics',
    items: [
      { to: '/denials', label: 'Denials' },
      { to: '/ar', label: 'A/R' },
      { to: '/payers', label: 'Payers' }
    ]
  },
  {
    label: 'Operations',
    items: [
      { to: '/automation', label: 'Automation' },
      { to: '/settings', label: 'Settings' }
    ]
  }
]

function Sidebar(): React.JSX.Element {
  const { mode, toggle } = useTheme()

  return (
    <nav className="sidebar" aria-label="Primary">
      <div className="sidebar-brand">
        <BrandMark size={22} />
        <span className="sidebar-brand-name">Aethera Reports</span>
      </div>
      <div className="sidebar-nav">
        {navSections.map((section, i) => (
          <div className="sidebar-section" key={section.label ?? i}>
            {section.label && <div className="sidebar-section-label">{section.label}</div>}
            <ul>
              {section.items.map((item) => (
                <li key={item.to}>
                  <NavLink to={item.to} end={item.end}>
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="sidebar-footer">
        <button
          type="button"
          className="theme-toggle"
          onClick={toggle}
          aria-label={`Switch to ${mode === 'dark' ? 'light' : 'dark'} mode`}
        >
          {mode === 'dark' ? '☀ Light mode' : '☾ Dark mode'}
        </button>
      </div>
    </nav>
  )
}

export default Sidebar

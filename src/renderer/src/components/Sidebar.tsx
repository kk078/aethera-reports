import { NavLink } from 'react-router-dom'
import BrandMark from './BrandMark'
import { useTheme } from '../lib/theme'

const navItems = [
  { to: '/', label: 'Portfolio', end: true },
  { to: '/clients', label: 'Clients', end: true },
  { to: '/clients/demo', label: 'Client Detail' },
  { to: '/denials', label: 'Denials' },
  { to: '/ar', label: 'A/R' },
  { to: '/payers', label: 'Payers' },
  { to: '/imports', label: 'Imports' },
  { to: '/manual-entry', label: 'Manual Entry' },
  { to: '/automation', label: 'Automation' },
  { to: '/settings', label: 'Settings' }
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
        <ul>
          {navItems.map((item) => (
            <li key={item.to}>
              <NavLink to={item.to} end={item.end}>
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
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

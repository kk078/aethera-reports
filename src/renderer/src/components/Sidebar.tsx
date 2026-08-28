import { NavLink } from 'react-router-dom'

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
  return (
    <nav className="sidebar" aria-label="Primary">
      <div className="sidebar-brand">Aethera Reports</div>
      <ul>
        {navItems.map((item) => (
          <li key={item.to}>
            <NavLink to={item.to} end={item.end}>
              {item.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export default Sidebar

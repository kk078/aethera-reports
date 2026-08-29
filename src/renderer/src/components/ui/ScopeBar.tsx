import { useLocation } from 'react-router-dom'
import { useAppScope } from '../../lib/app-scope'

interface ScopeBarProps {
  onOpenSearch: () => void
}

const CLIENT_FILTER_ROUTES = new Set(['/denials', '/ar', '/payers'])

export default function ScopeBar({ onOpenSearch }: ScopeBarProps): React.JSX.Element {
  const { pathname } = useLocation()
  const { period, setPeriod, clientId, setClientId, clients, clientsLoading } = useAppScope()
  const showClientFilter = CLIENT_FILTER_ROUTES.has(pathname)

  return (
    <div className="scope-bar" role="region" aria-label="Report scope">
      <label className="scope-bar-field">
        <span className="scope-bar-label">Period</span>
        <input
          type="month"
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          aria-label="Reporting period"
        />
      </label>

      {showClientFilter && (
        <label className="scope-bar-field">
          <span className="scope-bar-label">Client</span>
          <select
            value={clientId ?? ''}
            onChange={(e) => setClientId(e.target.value ? Number(e.target.value) : null)}
            disabled={clientsLoading}
            aria-label="Client filter"
          >
            <option value="">All clients</option>
            {clients
              .filter((c) => c.active)
              .map((c) => (
                <option key={c.clientId} value={c.clientId}>
                  {c.code} — {c.name}
                </option>
              ))}
          </select>
        </label>
      )}

      <button type="button" className="scope-bar-search" onClick={onOpenSearch}>
        Search <kbd>⌘K</kbd>
      </button>
    </div>
  )
}

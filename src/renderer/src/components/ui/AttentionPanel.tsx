import { Link } from 'react-router-dom'

export interface AttentionItem {
  id: string
  severity: 'warning' | 'critical'
  title: string
  detail: string
  href?: string
}

interface AttentionPanelProps {
  items: AttentionItem[]
}

export default function AttentionPanel({ items }: AttentionPanelProps): React.JSX.Element | null {
  if (items.length === 0) return null

  return (
    <aside className="attention-panel" aria-label="Items needing attention">
      <h2 className="attention-panel-title">Needs attention</h2>
      <ul className="attention-list">
        {items.map((item) => (
          <li
            key={item.id}
            className={`attention-item attention-item--${item.severity}`}
          >
            {item.href ? (
              <Link to={item.href} className="attention-item-link">
                <strong>{item.title}</strong>
                <span>{item.detail}</span>
              </Link>
            ) : (
              <div className="attention-item-body">
                <strong>{item.title}</strong>
                <span>{item.detail}</span>
              </div>
            )}
          </li>
        ))}
      </ul>
    </aside>
  )
}

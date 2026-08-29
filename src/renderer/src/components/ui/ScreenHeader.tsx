import type { ReactNode } from 'react'

interface ScreenHeaderProps {
  title: string
  description?: string
  actions?: ReactNode
}

export default function ScreenHeader({
  title,
  description,
  actions
}: ScreenHeaderProps): React.JSX.Element {
  return (
    <header className="screen-header">
      <div className="screen-header-text">
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="screen-header-actions">{actions}</div>}
    </header>
  )
}

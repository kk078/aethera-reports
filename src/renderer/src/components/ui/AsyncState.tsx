import type { ReactNode } from 'react'
import EmptyState from './EmptyState'

interface AsyncStateProps {
  loading: boolean
  error: string | null
  empty?: boolean
  emptyTitle?: string
  emptyDescription?: string
  emptyAction?: ReactNode
  children: ReactNode
}

/** Loading, error, empty, and content states in one place. */
export default function AsyncState({
  loading,
  error,
  empty = false,
  emptyTitle = 'Nothing here yet',
  emptyDescription,
  emptyAction,
  children
}: AsyncStateProps): React.JSX.Element {
  if (error) {
    return <p className="form-error">{error}</p>
  }
  if (loading) {
    return (
      <div className="async-loading" aria-busy="true" aria-live="polite">
        <div className="async-loading-bar" />
        <p>Loading…</p>
      </div>
    )
  }
  if (empty) {
    return (
      <EmptyState title={emptyTitle} description={emptyDescription} action={emptyAction} />
    )
  }
  return <>{children}</>
}

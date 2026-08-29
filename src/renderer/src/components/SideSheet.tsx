import { useEffect } from 'react'
import type { ReactNode } from 'react'

export interface SideSheetProps {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: string
  children: ReactNode
  footer?: ReactNode
}

/**
 * Right-hand "Details-on-Demand" side-sheet (M3 spec: "Side-Sheet Filter
 * Trays... sliding panels from the right"). A shared component so every
 * screen that adopts the pattern gets the same slide-in, backdrop, and
 * Escape-to-close behavior for free — Imports' quarantine viewer and
 * Clients' edit form are the two showcase conversions (see engineering
 * handoff: "Side-Sheet Transitions: consistent right-aligned panel for
 * all Details-on-Demand or Edit workflows").
 */
function SideSheet({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer
}: SideSheetProps): React.JSX.Element | null {
  useEffect(() => {
    if (!open) return undefined
    function handleKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <>
      <div className="side-sheet-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="side-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="side-sheet-header">
          <div>
            <h2>{title}</h2>
            {subtitle && <p className="side-sheet-subtitle label-mono">{subtitle}</p>}
          </div>
          <button type="button" className="side-sheet-close" onClick={onClose} aria-label="Close">
            <span className="material-symbols-rounded" aria-hidden="true">
              close
            </span>
          </button>
        </div>
        <div className="side-sheet-body">{children}</div>
        {footer && <div className="side-sheet-footer">{footer}</div>}
      </aside>
    </>
  )
}

export default SideSheet

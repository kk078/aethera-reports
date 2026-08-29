const CHIP_ICON: Record<'good' | 'warning' | 'critical' | 'neutral', string> = {
  good: 'check_circle',
  warning: 'error',
  critical: 'cancel',
  neutral: 'sync'
}

/** Maps every status string this app renders to one of the M3 spec's four exception-chip variants (billing-green / exception-orange / high-emphasis-red / neutral). Unknown strings fall back to neutral rather than guessing. */
function variantFor(status: string): 'good' | 'warning' | 'critical' | 'neutral' {
  switch (status) {
    case 'succeeded':
    case 'sent':
    case 'operational':
    case 'active':
      return 'good'
    case 'succeeded_with_warnings':
    case 'pending':
    case 'queued':
      return 'warning'
    case 'failed':
    case 'rejected':
    case 'quarantined':
      return 'critical'
    default:
      return 'neutral'
  }
}

export interface StatusChipProps {
  status: string
  label?: string
}

/** High-chroma exception badge (M3 spec: "Exception Badges — high-chroma red/orange chips used within tables to highlight Rejected or Pending items"). Renders an icon + label, never color alone. */
function StatusChip({ status, label }: StatusChipProps): React.JSX.Element {
  const variant = variantFor(status)
  return (
    <span className={`status-chip status-chip--${variant}`}>
      <span className="material-symbols-rounded" aria-hidden="true">
        {CHIP_ICON[variant]}
      </span>
      {label ?? status.replace(/_/g, ' ')}
    </span>
  )
}

export default StatusChip

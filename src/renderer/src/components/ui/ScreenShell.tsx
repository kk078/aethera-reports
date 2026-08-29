import type { ReactNode } from 'react'

interface ScreenShellProps {
  children: ReactNode
  className?: string
}

/** Standard screen wrapper — replaces the old "placeholder" shell. */
export default function ScreenShell({
  children,
  className
}: ScreenShellProps): React.JSX.Element {
  return <section className={['screen-shell', className].filter(Boolean).join(' ')}>{children}</section>
}

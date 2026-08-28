import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  THEME_STORAGE_KEY,
  ThemeContext,
  readStoredThemeMode,
  type ThemeContextValue,
  type ThemeMode
} from './theme'

export function ThemeProvider({
  children,
  initialMode
}: {
  children: ReactNode
  initialMode: ThemeMode
}): React.JSX.Element {
  const [mode, setModeState] = useState<ThemeMode>(initialMode)

  useEffect(() => {
    document.documentElement.dataset.theme = mode
  }, [mode])

  useEffect(() => {
    // Once the user has picked explicitly, that choice sticks even if
    // the OS setting changes later — only follow the OS live when
    // nothing has ever been saved.
    if (readStoredThemeMode()) return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = (event: MediaQueryListEvent): void => {
      setModeState(event.matches ? 'dark' : 'light')
    }
    query.addEventListener('change', handleChange)
    return () => query.removeEventListener('change', handleChange)
  }, [])

  const value = useMemo<ThemeContextValue>(() => {
    const setMode = (next: ThemeMode): void => {
      localStorage.setItem(THEME_STORAGE_KEY, next)
      setModeState(next)
    }
    return { mode, setMode, toggle: () => setMode(mode === 'dark' ? 'light' : 'dark') }
  }, [mode])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

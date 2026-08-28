import { createContext, useContext } from 'react'

export type ThemeMode = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'aethera-theme-mode'

export function getSystemThemePreference(): ThemeMode {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function readStoredThemeMode(): ThemeMode | null {
  const stored = localStorage.getItem(THEME_STORAGE_KEY)
  return stored === 'light' || stored === 'dark' ? stored : null
}

/** The very first thing `main.tsx` calls, synchronously, before React renders anything — stamps `<html data-theme>` immediately so the first paint is already the right mode (no white/wrong-mode flash while React boots). */
export function bootstrapTheme(): ThemeMode {
  const mode = readStoredThemeMode() ?? getSystemThemePreference()
  document.documentElement.dataset.theme = mode
  return mode
}

export interface ThemeContextValue {
  mode: ThemeMode
  setMode: (mode: ThemeMode) => void
  toggle: () => void
}

export const ThemeContext = createContext<ThemeContextValue | null>(null)

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('useTheme must be used within a ThemeProvider')
  return context
}

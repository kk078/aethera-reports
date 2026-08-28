import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { bootstrapTheme } from './lib/theme'
import { ThemeProvider } from './lib/theme-context'

// Stamps `<html data-theme>` before React does anything else, so the
// very first paint already has the right mode's CSS variables in effect
// (see tokens.css's header comment) — no white/wrong-mode flash while
// the renderer boots.
const initialThemeMode = bootstrapTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider initialMode={initialThemeMode}>
      <App />
    </ThemeProvider>
  </StrictMode>
)

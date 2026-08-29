// Local font packages (no Google Fonts / CDN — this is an offline desktop
// app). Roboto 400/500/700 covers body/UI weights; JetBrains Mono 500 is
// the one weight the M3 spec's label/compact-data roles use; Material
// Symbols Rounded backs the navigation rail's iconography.
import '@fontsource/roboto/400.css'
import '@fontsource/roboto/500.css'
import '@fontsource/roboto/700.css'
import '@fontsource/jetbrains-mono/500.css'
import '@material-symbols/font-400/rounded.css'

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

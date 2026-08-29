/**
 * Chart palette (dataviz skill followed before writing/changing any
 * chart code — see the session's design notes for the two
 * `validate_palette.js` runs this file's values come from). Chart
 * colors are read LIVE from `assets/tokens.css`'s custom properties via
 * `getComputedStyle` — the single source of truth for every color in
 * the app, chrome and charts alike — rather than a separate hardcoded
 * palette, so a chart always matches the surrounding UI in whichever
 * mode is active. `useChartTheme()` re-reads on every render and
 * subscribes to the app's theme mode, so toggling dark/light updates
 * open charts immediately.
 *
 * Categorical order is fixed and never cycled independently per chart —
 * "color follows the entity, never its rank" — callers always assign
 * colors by taking the palette in this order.
 */
import { useTheme } from '../../lib/theme'

export interface ChartTheme {
  categorical: readonly string[]
  sequentialBlue: readonly string[]
  diverging: { negative: string; neutral: string; positive: string }
  status: { good: string; warning: string; serious: string; critical: string }
  surface: string
  textPrimary: string
  textSecondary: string
  gridLine: string
  axisLine: string
}

/** Single-hue sequential ramp (Healthcare Blue, light->dark step 100->700) for magnitude encodings — anchored on the M3 `primary` (#005bbf) — one static ramp per the dataviz skill's reference (not mode-branched; the lightest steps are allowed to recede toward either surface). */
const SEQUENTIAL_BLUE = [
  '#d7e6fb',
  '#c1d9f8',
  '#a9caf5',
  '#8fbaf1',
  '#73a9ec',
  '#5497e6',
  '#3283de',
  '#1770d1',
  '#0d63bd',
  '#0a54a3',
  '#084588',
  '#06376d',
  '#042a54'
] as const

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

/** Reads the current values of every chart-relevant CSS custom property from `tokens.css`. Safe to call outside React (e.g. the print route, PPTX chart-image capture) — falls back to the light-mode values if called before styles are attached. */
export function readChartTheme(): ChartTheme {
  return {
    categorical: [
      cssVar('--chart-cat-1', '#d93025'),
      cssVar('--chart-cat-2', '#005bbf'),
      cssVar('--chart-cat-3', '#f29900'),
      cssVar('--chart-cat-4', '#7c5cbf'),
      cssVar('--chart-cat-5', '#9e4300'),
      cssVar('--chart-cat-6', '#1e8e3e')
    ],
    sequentialBlue: SEQUENTIAL_BLUE,
    diverging: {
      negative: cssVar('--chart-diverging-negative', '#005bbf'),
      neutral: cssVar('--chart-diverging-neutral', '#e6e8f2'),
      positive: cssVar('--chart-diverging-positive', '#f29900')
    },
    status: {
      good: cssVar('--status-good', '#1e8e3e'),
      warning: cssVar('--status-warning', '#f29900'),
      serious: cssVar('--status-serious', '#9e4300'),
      critical: cssVar('--status-critical', '#d93025')
    },
    surface: cssVar('--chart-surface', '#ffffff'),
    textPrimary: cssVar('--chart-text', '#191c23'),
    textSecondary: cssVar('--chart-text-secondary', '#414754'),
    gridLine: cssVar('--chart-grid', '#e3e5ee'),
    axisLine: cssVar('--chart-axis', '#c4c7c5')
  }
}

/**
 * Fixed white — deliberately NOT theme-reactive. Used only as the
 * background for the print/PPTX chart-image capture (`ReportDocument`'s
 * `mode="print"` path): the print output is always a white page
 * (`report-document.css`) regardless of the app's light/dark setting,
 * so a captured chart PNG must always composite onto white too, even if
 * the offscreen print window happens to have inherited a dark
 * `data-theme` from shared localStorage.
 */
export const PRINT_CHART_SURFACE = '#ffffff'

/** The hook every chart component uses — re-reads the CSS variables whenever the app's theme mode changes, so `readChartTheme()`'s snapshot is always current for the render it's used in. */
export function useChartTheme(): ChartTheme {
  const { mode } = useTheme()
  // `mode` is read only to force a re-render/re-read on toggle — the
  // actual colors always come from the live computed styles, never from
  // branching on `mode` directly, so this stays a single code path
  // regardless of how many themes tokens.css ever grows to support.
  void mode
  return readChartTheme()
}

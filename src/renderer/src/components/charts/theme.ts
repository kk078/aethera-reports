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

/** Single-hue sequential ramp (blue, light->dark step 100->700) for magnitude encodings — one static ramp per the dataviz skill's reference (not mode-branched; the lightest steps are allowed to recede toward either surface). */
const SEQUENTIAL_BLUE = [
  '#cde2fb',
  '#b7d3f6',
  '#9ec5f4',
  '#86b6ef',
  '#6da7ec',
  '#5598e7',
  '#3987e5',
  '#2a78d6',
  '#256abf',
  '#1c5cab',
  '#184f95',
  '#104281',
  '#0d366b'
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
      cssVar('--chart-cat-1', '#2a78d6'),
      cssVar('--chart-cat-2', '#eb6834'),
      cssVar('--chart-cat-3', '#1baf7a'),
      cssVar('--chart-cat-4', '#eda100'),
      cssVar('--chart-cat-5', '#e87ba4'),
      cssVar('--chart-cat-6', '#008300'),
      cssVar('--chart-cat-7', '#4a3aa7'),
      cssVar('--chart-cat-8', '#e34948')
    ],
    sequentialBlue: SEQUENTIAL_BLUE,
    diverging: {
      negative: cssVar('--chart-diverging-negative', '#2a78d6'),
      neutral: cssVar('--chart-diverging-neutral', '#f0efec'),
      positive: cssVar('--chart-diverging-positive', '#e34948')
    },
    status: {
      good: cssVar('--status-good', '#0ca30c'),
      warning: cssVar('--status-warning', '#fab219'),
      serious: cssVar('--status-serious', '#ec835a'),
      critical: cssVar('--status-critical', '#d03b3b')
    },
    surface: cssVar('--chart-surface', '#ffffff'),
    textPrimary: cssVar('--chart-text', '#1b2320'),
    textSecondary: cssVar('--chart-text-secondary', '#5b6660'),
    gridLine: cssVar('--chart-grid', '#e1e0d9'),
    axisLine: cssVar('--chart-axis', '#c3c2b7')
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

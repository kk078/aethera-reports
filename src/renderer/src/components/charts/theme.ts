/**
 * Chart palette (plan §5 — `dataviz` skill followed before writing any
 * chart code). This app is dark-themed only (see `assets/base.css`), so
 * we use the skill's validated dark-mode steps throughout — not a
 * light/dark switch. Re-run
 * `node scripts/validate_palette.js "<hex,...>" --mode dark` (from the
 * dataviz skill directory) before changing any of these.
 *
 * Categorical order is fixed and never cycled independently per chart —
 * "color follows the entity, never its rank" — callers always assign
 * colors by taking the palette in this order.
 */
export const CATEGORICAL_PALETTE = [
  '#3987e5', // 1 blue
  '#d95926', // 2 orange
  '#199e70', // 3 aqua
  '#c98500', // 4 yellow
  '#d55181', // 5 magenta
  '#008300', // 6 green
  '#9085e9', // 7 violet
  '#e66767' // 8 red
] as const

/** Single-hue sequential ramp (blue, light->dark step 100->700) for magnitude encodings. */
export const SEQUENTIAL_BLUE = [
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

/** Diverging pair (blue <-> red) with a neutral gray midpoint, dark surface. */
export const DIVERGING = { negative: '#3987e5', neutral: '#383835', positive: '#e66767' } as const

/** Status palette — fixed, never reused as a categorical series color. */
export const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b'
} as const

export const CHART_SURFACE = '#1a1a19'
export const CHART_TEXT_PRIMARY = '#ffffff'
export const CHART_TEXT_SECONDARY = '#c3c2b7'
export const CHART_GRID_LINE = '#3a3a37'

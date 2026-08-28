/**
 * Hand-rolled inline SVG chart helpers (plan: "server-rendered inline
 * SVG charts (small hand-rolled bar/line/donut helpers — no external
 * CDNs"). Every value that could contain user-influenced text (bar/slice
 * labels) is HTML-escaped — these strings get embedded directly into the
 * report page's HTML, so this is the one place in the portal that
 * doubles as its own tiny templating layer's escaping boundary.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export interface BarDatum {
  label: string
  value: number
}

const CHART_WIDTH = 480
const BAR_HEIGHT = 22
const BAR_GAP = 10
const LABEL_WIDTH = 140

/** A horizontal bar chart — good for AR aging buckets, claims by status, denials by root cause. Bars scale to the largest value; zero/negative values render as an empty row rather than being dropped, so the label list stays complete. */
export function svgHorizontalBarChart(
  data: BarDatum[],
  opts?: { valueFormatter?: (n: number) => string }
): string {
  const format = opts?.valueFormatter ?? ((n: number): string => n.toLocaleString('en-US'))
  const maxValue = Math.max(1, ...data.map((d) => Math.max(0, d.value)))
  const barAreaWidth = CHART_WIDTH - LABEL_WIDTH - 60
  const height = data.length * (BAR_HEIGHT + BAR_GAP) + BAR_GAP

  const rows = data
    .map((d, i) => {
      const y = BAR_GAP + i * (BAR_HEIGHT + BAR_GAP)
      const barWidth = Math.max(0, (Math.max(0, d.value) / maxValue) * barAreaWidth)
      return `
        <text x="0" y="${y + BAR_HEIGHT / 2 + 4}" font-size="12" fill="#333">${escapeHtml(d.label)}</text>
        <rect x="${LABEL_WIDTH}" y="${y}" width="${barWidth.toFixed(1)}" height="${BAR_HEIGHT}" fill="#2a78d6" rx="3" />
        <text x="${LABEL_WIDTH + barWidth + 6}" y="${y + BAR_HEIGHT / 2 + 4}" font-size="12" fill="#333">${escapeHtml(format(d.value))}</text>
      `
    })
    .join('')

  return `<svg viewBox="0 0 ${CHART_WIDTH} ${height}" width="100%" height="${height}" role="img" aria-label="bar chart" xmlns="http://www.w3.org/2000/svg">${rows}</svg>`
}

const DONUT_COLORS = ['#2a78d6', '#e07b39', '#3fa34d', '#a03fd6', '#d63f5c', '#7a7a7a']

/** A donut chart for a small categorical breakdown (e.g. claims by status). Falls back to a single "No data" ring when every value is zero, rather than dividing by zero. */
export function svgDonutChart(data: BarDatum[]): string {
  const size = 160
  const center = size / 2
  const radius = 60
  const strokeWidth = 24
  const circumference = 2 * Math.PI * radius
  const total = data.reduce((sum, d) => sum + Math.max(0, d.value), 0)

  if (total <= 0) {
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="donut chart, no data" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="#e0e0e0" stroke-width="${strokeWidth}" />
      <text x="${center}" y="${center}" font-size="12" fill="#888" text-anchor="middle">No data</text>
    </svg>`
  }

  let offset = 0
  const arcs = data
    .filter((d) => d.value > 0)
    .map((d, i) => {
      const fraction = d.value / total
      const dash = fraction * circumference
      const arc = `<circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="${DONUT_COLORS[i % DONUT_COLORS.length]}" stroke-width="${strokeWidth}" stroke-dasharray="${dash.toFixed(1)} ${(circumference - dash).toFixed(1)}" stroke-dashoffset="${(-offset).toFixed(1)}" transform="rotate(-90 ${center} ${center})" />`
      offset += dash
      return arc
    })
    .join('')

  const legend = data
    .filter((d) => d.value > 0)
    .map(
      (d, i) =>
        `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:12px;font-size:12px;"><span style="width:10px;height:10px;border-radius:50%;background:${DONUT_COLORS[i % DONUT_COLORS.length]};display:inline-block;"></span>${escapeHtml(d.label)} (${d.value})</span>`
    )
    .join('')

  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="donut chart" xmlns="http://www.w3.org/2000/svg">${arcs}</svg>
    <div>${legend}</div>`
}

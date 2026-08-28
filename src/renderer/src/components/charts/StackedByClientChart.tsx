import EChart from './EChart'
import { CATEGORICAL_PALETTE, CHART_GRID_LINE, CHART_TEXT_SECONDARY } from './theme'
import type { ArAgingByClientRow, ArAgingBuckets } from '../../../../shared/domain'
import type { EChartsOption } from 'echarts'

export interface StackedByClientChartProps {
  rows: ArAgingByClientRow[]
  animation?: boolean
}

const BUCKET_ORDER: Array<keyof ArAgingBuckets> = ['0-30', '31-60', '61-90', '91-120', '120+']

/** A/R aging distribution across clients — one stacked bar per client, one color per bucket (plan §5 AR screen). */
function StackedByClientChart({
  rows,
  animation = true
}: StackedByClientChartProps): React.JSX.Element {
  if (rows.length === 0) {
    return <p style={{ color: 'var(--ev-c-text-2)', fontSize: 13 }}>No open claims.</p>
  }

  const option: EChartsOption = {
    color: [...CATEGORICAL_PALETTE],
    textStyle: { color: CHART_TEXT_SECONDARY },
    legend: { top: 0, textStyle: { color: CHART_TEXT_SECONDARY } },
    grid: { left: 64, right: 16, top: 32, bottom: 48 },
    tooltip: { trigger: 'axis', valueFormatter: (v) => `$${Number(v).toLocaleString()}` },
    xAxis: {
      type: 'category',
      data: rows.map((r) => r.clientCode),
      axisLine: { lineStyle: { color: CHART_GRID_LINE } },
      axisLabel: { color: CHART_TEXT_SECONDARY, rotate: rows.length > 8 ? 30 : 0 }
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: CHART_GRID_LINE } },
      axisLabel: {
        color: CHART_TEXT_SECONDARY,
        formatter: (v: number) => `$${(v / 1000).toFixed(0)}k`
      }
    },
    series: BUCKET_ORDER.map((bucket) => ({
      name: bucket,
      type: 'bar',
      stack: 'aging',
      data: rows.map((r) => r.aging[bucket])
    }))
  }

  return <EChart option={option} animation={animation} height={320} />
}

export default StackedByClientChart

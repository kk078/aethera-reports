import EChart from './EChart'
import { CATEGORICAL_PALETTE, CHART_GRID_LINE, CHART_TEXT_SECONDARY } from './theme'
import type { EChartsOption } from 'echarts'

export interface PayerComparisonChartProps {
  rows: Array<{ payerName: string; a: number; b: number }>
  seriesNames: [string, string]
  animation?: boolean
  emptyLabel?: string
}

/** Two-series horizontal grouped bar per payer (plan §5 Payers screen's "avg allowed vs. charge by payer"). */
function PayerComparisonChart({
  rows,
  seriesNames,
  animation = true,
  emptyLabel = 'No data for this period.'
}: PayerComparisonChartProps): React.JSX.Element {
  if (rows.length === 0) {
    return <p style={{ color: 'var(--ev-c-text-2)', fontSize: 13 }}>{emptyLabel}</p>
  }

  const option: EChartsOption = {
    color: [CATEGORICAL_PALETTE[0], CATEGORICAL_PALETTE[1]],
    textStyle: { color: CHART_TEXT_SECONDARY },
    legend: { top: 0, textStyle: { color: CHART_TEXT_SECONDARY } },
    grid: { left: 140, right: 48, top: 32, bottom: 16 },
    tooltip: { trigger: 'axis', valueFormatter: (v) => `$${Number(v).toLocaleString()}` },
    xAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: CHART_GRID_LINE } },
      axisLabel: { color: CHART_TEXT_SECONDARY, formatter: (v: number) => `$${v.toLocaleString()}` }
    },
    yAxis: {
      type: 'category',
      data: rows.map((r) => r.payerName),
      axisLine: { lineStyle: { color: CHART_GRID_LINE } },
      axisLabel: { color: CHART_TEXT_SECONDARY }
    },
    series: [
      { name: seriesNames[0], type: 'bar', data: rows.map((r) => r.a), barMaxWidth: 16 },
      { name: seriesNames[1], type: 'bar', data: rows.map((r) => r.b), barMaxWidth: 16 }
    ]
  }

  return <EChart option={option} animation={animation} height={Math.max(160, rows.length * 44)} />
}

export default PayerComparisonChart

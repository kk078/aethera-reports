import EChart from './EChart'
import { useChartTheme } from './theme'
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
  const theme = useChartTheme()
  if (rows.length === 0) {
    return <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>{emptyLabel}</p>
  }

  const option: EChartsOption = {
    color: [theme.categorical[0], theme.categorical[1]],
    textStyle: { color: theme.textSecondary },
    legend: { top: 0, textStyle: { color: theme.textSecondary } },
    grid: { left: 140, right: 48, top: 32, bottom: 16 },
    tooltip: { trigger: 'axis', valueFormatter: (v) => `$${Number(v).toLocaleString()}` },
    xAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: theme.gridLine } },
      axisLabel: { color: theme.textSecondary, formatter: (v: number) => `$${v.toLocaleString()}` }
    },
    yAxis: {
      type: 'category',
      data: rows.map((r) => r.payerName),
      axisLine: { lineStyle: { color: theme.gridLine } },
      axisLabel: { color: theme.textSecondary }
    },
    series: [
      { name: seriesNames[0], type: 'bar', data: rows.map((r) => r.a), barMaxWidth: 16 },
      { name: seriesNames[1], type: 'bar', data: rows.map((r) => r.b), barMaxWidth: 16 }
    ]
  }

  return <EChart option={option} animation={animation} height={Math.max(160, rows.length * 44)} />
}

export default PayerComparisonChart

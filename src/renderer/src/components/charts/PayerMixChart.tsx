import { forwardRef } from 'react'
import EChart, { type EChartHandle } from './EChart'
import { useChartTheme } from './theme'
import type { EChartsOption } from 'echarts'

export interface PayerMixChartProps {
  payerMix: Array<{ payerName: string; charges: number }>
  animation?: boolean
}

/** Horizontal bar of charges by payer — a comparison task, so bars rather than a pie (choosing-a-form). */
const PayerMixChart = forwardRef<EChartHandle, PayerMixChartProps>(function PayerMixChart(
  { payerMix, animation = true },
  ref
) {
  const theme = useChartTheme()
  if (payerMix.length === 0) {
    return <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No claims in this period.</p>
  }

  const sorted = [...payerMix].sort((a, b) => a.charges - b.charges) // ascending for horizontal bar top-down read

  const option: EChartsOption = {
    color: [theme.categorical[2]],
    textStyle: { color: theme.textSecondary },
    grid: { left: 140, right: 48, top: 16, bottom: 16 },
    tooltip: { trigger: 'axis', valueFormatter: (v) => `$${Number(v).toLocaleString()}` },
    xAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: theme.gridLine } },
      axisLabel: {
        color: theme.textSecondary,
        formatter: (v: number) => `$${(v / 1000).toFixed(0)}k`
      }
    },
    yAxis: {
      type: 'category',
      data: sorted.map((p) => p.payerName),
      axisLine: { lineStyle: { color: theme.gridLine } },
      axisLabel: { color: theme.textSecondary }
    },
    series: [
      {
        type: 'bar',
        data: sorted.map((p) => p.charges),
        barMaxWidth: 24,
        itemStyle: { borderRadius: [0, 4, 4, 0] },
        label: {
          show: true,
          position: 'right',
          color: theme.textSecondary,
          formatter: (p) => `$${Number(p.value).toLocaleString()}`
        }
      }
    ]
  }

  return (
    <EChart
      ref={ref}
      option={option}
      animation={animation}
      height={Math.max(160, sorted.length * 36)}
    />
  )
})

export default PayerMixChart

import EChart from './EChart'
import { CATEGORICAL_PALETTE, CHART_GRID_LINE, CHART_TEXT_SECONDARY } from './theme'
import type { EChartsOption } from 'echarts'

export interface PayerMixChartProps {
  payerMix: Array<{ payerName: string; charges: number }>
  animation?: boolean
}

/** Horizontal bar of charges by payer — a comparison task, so bars rather than a pie (choosing-a-form). */
function PayerMixChart({ payerMix, animation = true }: PayerMixChartProps): React.JSX.Element {
  if (payerMix.length === 0) {
    return <p style={{ color: 'var(--ev-c-text-2)', fontSize: 13 }}>No claims in this period.</p>
  }

  const sorted = [...payerMix].sort((a, b) => a.charges - b.charges) // ascending for horizontal bar top-down read

  const option: EChartsOption = {
    color: [CATEGORICAL_PALETTE[2]],
    textStyle: { color: CHART_TEXT_SECONDARY },
    grid: { left: 140, right: 48, top: 16, bottom: 16 },
    tooltip: { trigger: 'axis', valueFormatter: (v) => `$${Number(v).toLocaleString()}` },
    xAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: CHART_GRID_LINE } },
      axisLabel: {
        color: CHART_TEXT_SECONDARY,
        formatter: (v: number) => `$${(v / 1000).toFixed(0)}k`
      }
    },
    yAxis: {
      type: 'category',
      data: sorted.map((p) => p.payerName),
      axisLine: { lineStyle: { color: CHART_GRID_LINE } },
      axisLabel: { color: CHART_TEXT_SECONDARY }
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
          color: CHART_TEXT_SECONDARY,
          formatter: (p) => `$${Number(p.value).toLocaleString()}`
        }
      }
    ]
  }

  return <EChart option={option} animation={animation} height={Math.max(160, sorted.length * 36)} />
}

export default PayerMixChart

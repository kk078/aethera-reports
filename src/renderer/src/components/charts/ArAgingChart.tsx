import { forwardRef } from 'react'
import EChart, { type EChartHandle } from './EChart'
import { CATEGORICAL_PALETTE, CHART_GRID_LINE, CHART_TEXT_SECONDARY } from './theme'
import type { ArAgingBuckets } from '../../../../shared/domain'
import type { EChartsOption } from 'echarts'

export interface ArAgingChartProps {
  aging: ArAgingBuckets
  animation?: boolean
}

const BUCKET_ORDER: Array<keyof ArAgingBuckets> = ['0-30', '31-60', '61-90', '91-120', '120+']

/** A/R aging waterfall — single series, single axis, one bar per bucket. */
const ArAgingChart = forwardRef<EChartHandle, ArAgingChartProps>(function ArAgingChart(
  { aging, animation = true },
  ref
) {
  const option: EChartsOption = {
    color: [CATEGORICAL_PALETTE[0]],
    textStyle: { color: CHART_TEXT_SECONDARY },
    grid: { left: 64, right: 16, top: 16, bottom: 32 },
    tooltip: { trigger: 'axis', valueFormatter: (v) => `$${Number(v).toLocaleString()}` },
    xAxis: {
      type: 'category',
      data: BUCKET_ORDER,
      axisLine: { lineStyle: { color: CHART_GRID_LINE } },
      axisLabel: { color: CHART_TEXT_SECONDARY }
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: CHART_GRID_LINE } },
      axisLabel: {
        color: CHART_TEXT_SECONDARY,
        formatter: (v: number) => `$${(v / 1000).toFixed(0)}k`
      }
    },
    series: [
      {
        type: 'bar',
        data: BUCKET_ORDER.map((bucket) => aging[bucket]),
        barMaxWidth: 48,
        itemStyle: { borderRadius: [4, 4, 0, 0] },
        label: {
          show: true,
          position: 'top',
          color: CHART_TEXT_SECONDARY,
          formatter: (p) => `$${Number(p.value).toLocaleString()}`
        }
      }
    ]
  }

  return <EChart ref={ref} option={option} animation={animation} height={260} />
})

export default ArAgingChart

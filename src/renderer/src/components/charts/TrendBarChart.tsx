import { forwardRef } from 'react'
import EChart, { type EChartHandle } from './EChart'
import { CATEGORICAL_PALETTE, CHART_GRID_LINE, CHART_TEXT_SECONDARY } from './theme'
import type { EChartsOption } from 'echarts'

export interface TrendSeries {
  name: string
  values: number[]
}

export interface TrendBarChartProps {
  categories: string[]
  series: TrendSeries[]
  animation?: boolean
  valueFormatter?: (value: number) => string
}

/**
 * Single-axis grouped bar/line trend chart (charges vs. collections,
 * etc.) — one shared value axis, one series per categorical color slot
 * in the fixed palette order (dataviz skill: never a dual axis, color
 * follows the entity).
 */
const TrendBarChart = forwardRef<EChartHandle, TrendBarChartProps>(function TrendBarChart(
  { categories, series, animation = true, valueFormatter },
  ref
) {
  const option: EChartsOption = {
    color: [...CATEGORICAL_PALETTE],
    textStyle: { color: CHART_TEXT_SECONDARY },
    legend: series.length > 1 ? { top: 0, textStyle: { color: CHART_TEXT_SECONDARY } } : undefined,
    grid: { left: 48, right: 16, top: series.length > 1 ? 32 : 16, bottom: 32 },
    tooltip: { trigger: 'axis' },
    xAxis: {
      type: 'category',
      data: categories,
      axisLine: { lineStyle: { color: CHART_GRID_LINE } },
      axisLabel: { color: CHART_TEXT_SECONDARY }
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: CHART_GRID_LINE } },
      axisLabel: {
        color: CHART_TEXT_SECONDARY,
        formatter: valueFormatter ? (value: number) => valueFormatter(value) : undefined
      }
    },
    series: series.map((s) => ({
      name: s.name,
      type: 'line',
      data: s.values,
      lineStyle: { width: 2 },
      showSymbol: series.length === 1,
      symbolSize: 8
    }))
  }

  return <EChart ref={ref} option={option} animation={animation} />
})

export default TrendBarChart

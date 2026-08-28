import { forwardRef } from 'react'
import EChart, { type EChartHandle } from './EChart'
import { useChartTheme } from './theme'
import type { EChartsOption } from 'echarts'

export interface DenialsParetoChartProps {
  /** Counts grouped by whatever key the caller wants pareto'd — root cause, CARC code, etc. */
  denialsByRootCause: Record<string, number>
  animation?: boolean
}

/**
 * Denials pareto — bars (count by group, sorted descending) plus a
 * cumulative-count line, both on the SAME count axis (dataviz skill:
 * never a dual axis — a classic Pareto's second "cumulative %" axis is
 * dropped in favor of a cumulative *count* line sharing the bars' axis;
 * the tooltip still shows the running share of total denials). Generic
 * over the grouping key so both the report doc (by root cause) and the
 * Denials screen (by CARC code) reuse this one component.
 */
const DenialsParetoChart = forwardRef<EChartHandle, DenialsParetoChartProps>(
  function DenialsParetoChart({ denialsByRootCause, animation = true }, ref) {
    const theme = useChartTheme()
    const entries = Object.entries(denialsByRootCause).sort((a, b) => b[1] - a[1])
    const total = entries.reduce((sum, [, count]) => sum + count, 0)

    const cumulative = entries.reduce<number[]>((acc, [, count]) => {
      acc.push((acc.length > 0 ? acc[acc.length - 1] : 0) + count)
      return acc
    }, [])

    const option: EChartsOption = {
      color: [theme.categorical[1], theme.categorical[0]],
      textStyle: { color: theme.textSecondary },
      legend: { top: 0, textStyle: { color: theme.textSecondary } },
      grid: { left: 48, right: 16, top: 32, bottom: 48 },
      tooltip: {
        trigger: 'axis',
        formatter: (params) => {
          const list = Array.isArray(params) ? params : [params]
          const idx = list[0]?.dataIndex ?? 0
          const pct = total ? Math.round((cumulative[idx] / total) * 1000) / 10 : 0
          return `${list[0]?.axisValueLabel}<br/>Count: ${entries[idx]?.[1]}<br/>Cumulative: ${cumulative[idx]} (${pct}%)`
        }
      },
      xAxis: {
        type: 'category',
        data: entries.map(([cause]) => cause),
        axisLine: { lineStyle: { color: theme.gridLine } },
        axisLabel: { color: theme.textSecondary, rotate: entries.length > 5 ? 30 : 0 }
      },
      yAxis: {
        type: 'value',
        name: 'Denials',
        splitLine: { lineStyle: { color: theme.gridLine } },
        axisLabel: { color: theme.textSecondary }
      },
      series: [
        { name: 'Count', type: 'bar', data: entries.map(([, count]) => count), barMaxWidth: 40 },
        {
          name: 'Cumulative',
          type: 'line',
          data: cumulative,
          lineStyle: { width: 2 },
          symbolSize: 6
        }
      ]
    }

    if (entries.length === 0) {
      return <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No denials in this period.</p>
    }

    return <EChart ref={ref} option={option} animation={animation} height={280} />
  }
)

export default DenialsParetoChart

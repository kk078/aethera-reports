import { useEffect, useRef } from 'react'
import * as echarts from 'echarts/core'
import { SVGRenderer } from 'echarts/renderers'
import {
  BarChart as EBarChart,
  LineChart as ELineChart,
  PieChart as EPieChart
} from 'echarts/charts'
import {
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  DataZoomComponent
} from 'echarts/components'
import type { EChartsOption } from 'echarts'

// Register only what we use (plan §5: SVG renderer for print-crisp
// vector output; smaller bundle than the full echarts build).
echarts.use([
  SVGRenderer,
  EBarChart,
  ELineChart,
  EPieChart,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  DataZoomComponent
])

export interface EChartProps {
  option: EChartsOption
  height?: number | string
  /** false for the print route (plan §6: "ECharts SVG fixed-width, animation: false"). */
  animation?: boolean
}

/** The one thin React wrapper the plan calls for — every chart component renders through this. */
function EChart({ option, height = 320, animation = true }: EChartProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const chart = echarts.init(containerRef.current, undefined, { renderer: 'svg' })
    chartRef.current = chart

    const resizeObserver = new ResizeObserver(() => chart.resize())
    resizeObserver.observe(containerRef.current)

    return () => {
      resizeObserver.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    chartRef.current?.setOption({ animation, ...option }, { notMerge: true })
  }, [option, animation])

  return <div ref={containerRef} style={{ width: '100%', height }} />
}

export default EChart

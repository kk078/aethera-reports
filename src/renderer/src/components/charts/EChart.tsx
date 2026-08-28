import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import * as echarts from 'echarts/core'
import { SVGRenderer, CanvasRenderer } from 'echarts/renderers'
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

// Register both renderers (plan §5/§6): SVG for the on-screen/print-CSS
// crisp vector output every visible chart uses, Canvas purely so
// `getDataURL({ type: 'png' })` has a real rasterization path for the
// PPTX exporter's chart-image capture — an SVG-mode instance's own
// `getDataURL('png')` turned out NOT to reliably rasterize under a
// headless offscreen `BrowserWindow` in practice (pptxgenjs rejected the
// result: "Image `data` value lacks a base64 header"), so
// `EChartHandle.getDataURL` below renders a throwaway canvas-mode clone
// instead of asking the visible SVG instance to convert itself.
echarts.use([
  SVGRenderer,
  CanvasRenderer,
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

/** Imperative handle exposed via `ref` — the print route uses this to capture a chart as a PNG for the PPTX exporter (plan §6). */
export interface EChartHandle {
  /**
   * Renders a throwaway canvas-mode clone of the current option and
   * returns ITS `getDataURL({ type: 'png' })` — never the visible
   * SVG-mode instance's own conversion, which doesn't reliably
   * rasterize under a headless offscreen `BrowserWindow` in practice.
   * Returns `null` (never throws) if the chart isn't mounted or the
   * capture fails for any reason; callers must treat a missing image as
   * "skip this chart," not a crash.
   */
  getDataURL: (backgroundColor?: string) => string | null
}

const EXPORT_CAPTURE_WIDTH = 900
const EXPORT_CAPTURE_HEIGHT = 500

/** The one thin React wrapper the plan calls for — every chart component renders through this. */
const EChart = forwardRef<EChartHandle, EChartProps>(function EChart(
  { option, height = 320, animation = true },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)
  const optionRef = useRef<EChartsOption>(option)

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
    optionRef.current = option
    chartRef.current?.setOption({ animation, ...option }, { notMerge: true })
  }, [option, animation])

  useImperativeHandle(
    ref,
    () => ({
      getDataURL: (backgroundColor) => {
        const captureDiv = document.createElement('div')
        captureDiv.style.width = `${EXPORT_CAPTURE_WIDTH}px`
        captureDiv.style.height = `${EXPORT_CAPTURE_HEIGHT}px`
        // Off-screen but still laid out (0 size / display:none gives
        // ECharts a 0x0 canvas to rasterize) — parked at a large
        // negative offset instead.
        captureDiv.style.position = 'fixed'
        captureDiv.style.left = '-99999px'
        document.body.appendChild(captureDiv)
        let captureChart: echarts.ECharts | null = null
        try {
          captureChart = echarts.init(captureDiv, undefined, { renderer: 'canvas' })
          captureChart.setOption({ animation: false, ...optionRef.current }, { notMerge: true })
          return captureChart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor })
        } catch {
          return null
        } finally {
          captureChart?.dispose()
          captureDiv.remove()
        }
      }
    }),
    []
  )

  return <div ref={containerRef} style={{ width: '100%', height }} />
})

export default EChart

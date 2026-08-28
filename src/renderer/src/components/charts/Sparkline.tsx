import EChart from './EChart'
import { useChartTheme } from './theme'
import type { EChartsOption } from 'echarts'

export interface SparklineProps {
  values: number[]
}

/** Minimal inline trend line for a table cell — no axes, no legend, no tooltip. */
function Sparkline({ values }: SparklineProps): React.JSX.Element {
  const theme = useChartTheme()
  const option: EChartsOption = {
    grid: { left: 2, right: 2, top: 4, bottom: 4 },
    xAxis: { type: 'category', show: false, data: values.map((_, i) => i) },
    yAxis: { type: 'value', show: false, min: 'dataMin', max: 'dataMax' },
    series: [
      {
        type: 'line',
        data: values,
        showSymbol: false,
        lineStyle: { width: 2, color: theme.categorical[0] },
        areaStyle: { color: theme.categorical[0], opacity: 0.12 }
      }
    ]
  }

  return <EChart option={option} height={32} animation={false} />
}

export default Sparkline

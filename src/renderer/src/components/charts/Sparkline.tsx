import EChart from './EChart'
import { CATEGORICAL_PALETTE } from './theme'
import type { EChartsOption } from 'echarts'

export interface SparklineProps {
  values: number[]
}

/** Minimal inline trend line for a table cell — no axes, no legend, no tooltip. */
function Sparkline({ values }: SparklineProps): React.JSX.Element {
  const option: EChartsOption = {
    grid: { left: 2, right: 2, top: 4, bottom: 4 },
    xAxis: { type: 'category', show: false, data: values.map((_, i) => i) },
    yAxis: { type: 'value', show: false, min: 'dataMin', max: 'dataMax' },
    series: [
      {
        type: 'line',
        data: values,
        showSymbol: false,
        lineStyle: { width: 2, color: CATEGORICAL_PALETTE[0] },
        areaStyle: { color: CATEGORICAL_PALETTE[0], opacity: 0.12 }
      }
    ]
  }

  return <EChart option={option} height={32} animation={false} />
}

export default Sparkline

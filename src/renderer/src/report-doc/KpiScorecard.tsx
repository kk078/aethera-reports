interface KpiTileProps {
  label: string
  value: string
  sub?: string
}

function KpiTile({ label, value, sub }: KpiTileProps): React.JSX.Element {
  return (
    <div className="kpi-tile">
      <div className="kpi-tile-label">{label}</div>
      <div className="kpi-tile-value tabular-nums">{value}</div>
      {sub && <div className="kpi-tile-sub">{sub}</div>}
    </div>
  )
}

/** Renders "no data" for null — never a fabricated 0 (plan §4 NULL-not-zero). */
function fmtPct(value: number | null): string {
  return value === null ? 'no data' : `${value}%`
}
function fmtMoney(value: number): string {
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
}
function fmtDays(value: number | null): string {
  return value === null ? 'no data' : `${value} days`
}

export interface KpiScorecardProps {
  grossCharges: number
  totalCollections: number
  netCollectionRatePct: number | null
  daysInAr: number | null
  openAr: number
  arOver90Pct: number
  denialRatePct: number | null
  firstPassAcceptancePct: number | null
}

function KpiScorecard(props: KpiScorecardProps): React.JSX.Element {
  return (
    <div className="kpi-scorecard">
      <KpiTile label="Gross charges" value={fmtMoney(props.grossCharges)} />
      <KpiTile label="Total collections" value={fmtMoney(props.totalCollections)} />
      <KpiTile label="Net collection rate" value={fmtPct(props.netCollectionRatePct)} />
      <KpiTile label="Days in A/R" value={fmtDays(props.daysInAr)} />
      <KpiTile
        label="Open A/R"
        value={fmtMoney(props.openAr)}
        sub={`${props.arOver90Pct}% over 90 days`}
      />
      <KpiTile label="Denial rate" value={fmtPct(props.denialRatePct)} />
      <KpiTile label="First-pass acceptance" value={fmtPct(props.firstPassAcceptancePct)} />
    </div>
  )
}

export default KpiScorecard

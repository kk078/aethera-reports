-- Trailing KPI snapshot series for one client, for `kpi_trends`
-- (kpi.py `kpi_trends()`, lines 116-136). Phase 1 has no background
-- sweeper populating `kpi_snapshots` yet (that's future work), so this
-- will typically return no rows — `buildKpiTrends` handles the empty
-- case exactly like kpi.py does (series: [], latest: null, deltas: {}).
SELECT snapshot_date, denial_rate, first_pass_rate, clean_claim_rate, days_to_cash,
       open_ar, ar_over_90_pct, net_collection_rate
FROM kpi_snapshots
WHERE client_id = ? AND snapshot_date >= ? AND snapshot_date <= ?
ORDER BY snapshot_date

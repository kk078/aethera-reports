import { useEffect, useState } from 'react'
import type { QuarantineRow } from '../../../../shared/domain'
import { listQuarantineRows } from '../../lib/api'
import SideSheet from '../../components/SideSheet'

interface QuarantineViewerProps {
  jobId: number | null
  onClose: () => void
}

/** Job-detail/quarantine viewer, converted to a right side-sheet (M3 spec pattern showcase — see engineering handoff's "Import History: Audit trail with side-sheet validation details"). */
function QuarantineViewer({ jobId, onClose }: QuarantineViewerProps): React.JSX.Element {
  const [rows, setRows] = useState<QuarantineRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (jobId === null) return
    setLoading(true)
    listQuarantineRows(jobId)
      .then(setRows)
      .finally(() => setLoading(false))
  }, [jobId])

  return (
    <SideSheet
      open={jobId !== null}
      onClose={onClose}
      title="Quarantined rows"
      subtitle={jobId !== null ? `Job #${jobId}` : undefined}
    >
      {loading ? (
        <div className="skeleton" style={{ display: 'block', height: 160 }} />
      ) : rows.length === 0 ? (
        <p>No quarantined rows for this job.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Row</th>
              <th>Reasons</th>
              <th>Raw data</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.quarantineId}>
                <td>{row.sourceRowNum}</td>
                <td>{row.reasons.join('; ')}</td>
                <td>
                  <code>{JSON.stringify(row.payload)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SideSheet>
  )
}

export default QuarantineViewer

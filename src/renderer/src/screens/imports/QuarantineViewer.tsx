import { useEffect, useState } from 'react'
import type { QuarantineRow } from '../../../../shared/domain'
import { listQuarantineRows } from '../../lib/api'

interface QuarantineViewerProps {
  jobId: number
  onClose: () => void
}

function QuarantineViewer({ jobId, onClose }: QuarantineViewerProps): React.JSX.Element {
  const [rows, setRows] = useState<QuarantineRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    listQuarantineRows(jobId)
      .then(setRows)
      .finally(() => setLoading(false))
  }, [jobId])

  return (
    <div className="quarantine-viewer">
      <div className="jobs-list-header">
        <h2>Quarantined rows — job #{jobId}</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      {loading ? (
        <p>Loading…</p>
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
    </div>
  )
}

export default QuarantineViewer

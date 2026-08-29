import type { ImportJob } from '../../../../shared/domain'
import StatusChip from '../../components/StatusChip'

interface JobsListProps {
  jobs: ImportJob[]
  onRefresh: () => void
  onViewQuarantine: (jobId: number) => void
}

function JobsList({ jobs, onRefresh, onViewQuarantine }: JobsListProps): React.JSX.Element {
  return (
    <div>
      <div className="jobs-list-header">
        <h2>Import jobs</h2>
        <button type="button" onClick={onRefresh}>
          Refresh
        </button>
      </div>
      {jobs.length === 0 ? (
        <p>No import jobs yet.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Job</th>
              <th>File</th>
              <th>Status</th>
              <th>Read</th>
              <th>Loaded</th>
              <th>Quarantined</th>
              <th>Started</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.jobId}>
                <td>#{job.jobId}</td>
                <td>{job.fileName ?? '—'}</td>
                <td>
                  <StatusChip status={job.status} />
                </td>
                <td>{job.rowsRead}</td>
                <td>{job.rowsLoaded}</td>
                <td>{job.rowsSkipped}</td>
                <td>{new Date(job.startedAt).toLocaleString()}</td>
                <td>
                  {job.rowsSkipped > 0 && (
                    <button type="button" onClick={() => onViewQuarantine(job.jobId)}>
                      View quarantine
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export default JobsList

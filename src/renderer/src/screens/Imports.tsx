import { useEffect, useState } from 'react'
import type { Client, ImportJob, MappingTemplate } from '../../../shared/domain'
import { listClients, listImportJobs, listMappingTemplates } from '../lib/api'
import Wizard from './imports/Wizard'
import JobsList from './imports/JobsList'
import QuarantineViewer from './imports/QuarantineViewer'

function Imports(): React.JSX.Element {
  const [clients, setClients] = useState<Client[]>([])
  const [templates, setTemplates] = useState<MappingTemplate[]>([])
  const [jobs, setJobs] = useState<ImportJob[]>([])
  const [quarantineJobId, setQuarantineJobId] = useState<number | null>(null)

  async function refreshAll(): Promise<void> {
    const [c, t, j] = await Promise.all([listClients(), listMappingTemplates(), listImportJobs()])
    setClients(c)
    setTemplates(t)
    setJobs(j)
  }

  useEffect(() => {
    void refreshAll()
  }, [])

  return (
    <section className="screen-placeholder">
      <h1>Imports</h1>
      <p>CSV/XLSX claim exports: pick a file, map its columns, preview, then load it.</p>

      {clients.length === 0 ? (
        <p>Add a client on the Clients screen before importing a file.</p>
      ) : (
        <Wizard
          clients={clients}
          templates={templates}
          onImportComplete={() => void refreshAll()}
        />
      )}

      <hr />

      <JobsList
        jobs={jobs}
        onRefresh={() => void refreshAll()}
        onViewQuarantine={setQuarantineJobId}
      />

      {/* Side-sheet pattern showcase (M3 spec) — slides over the jobs
          list rather than replacing it. */}
      <QuarantineViewer jobId={quarantineJobId} onClose={() => setQuarantineJobId(null)} />
    </section>
  )
}

export default Imports

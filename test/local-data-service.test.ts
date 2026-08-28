import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDataService } from '../src/main/services/local-data-service'

describe('LocalDataService', () => {
  let dir: string
  let service: LocalDataService

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aethera-lds-test-'))
    service = await LocalDataService.create({
      duckdbPath: join(dir, 'analytics.duckdb'),
      metaDbPath: join(dir, 'meta.db'),
      backupsDir: join(dir, 'backups')
    })
  })

  afterEach(() => {
    service.close()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('clients', () => {
    it('creates, lists, updates, and deactivates a client', async () => {
      const created = await service.createClient({ code: 'ACME', name: 'Acme Health' })
      expect(created.active).toBe(true)
      expect(created.reportRecipients).toEqual([])

      const list = await service.listClients()
      expect(list.map((c) => c.code)).toContain('ACME')

      const updated = await service.updateClient(created.clientId, {
        contractRate: 0.06,
        reportRecipients: ['billing@acme.example']
      })
      expect(updated.contractRate).toBeCloseTo(0.06)
      expect(updated.reportRecipients).toEqual(['billing@acme.example'])
      expect(updated.name).toBe('Acme Health') // untouched fields preserved

      const deactivated = await service.deactivateClient(created.clientId)
      expect(deactivated.active).toBe(false)
    })

    it('finds a client by code', async () => {
      await service.createClient({ code: 'BETA', name: 'Beta Practice' })
      const found = await service.getClientByCode('BETA')
      expect(found?.name).toBe('Beta Practice')
      expect(await service.getClientByCode('NOPE')).toBeNull()
    })
  })

  describe('mapping templates', () => {
    it('seeds the built-in Tebra preset on first launch', async () => {
      const templates = await service.listMappingTemplates()
      const tebra = templates.find((t) => t.templateId === 'tebra-claim-export')
      expect(tebra).toBeDefined()
      expect(tebra?.builtIn).toBe(true)
    })

    it('saves a new custom template, versions it on update, and refuses to touch built-ins', async () => {
      const saved = await service.saveMappingTemplate({
        name: 'My Custom Mapping',
        pmSystem: 'CustomPM',
        targetEntity: 'claims',
        grain: 'line',
        keyFields: ['Claim Number'],
        columns: [{ sourceHeader: 'Claim #', targetField: 'claimNumber', transform: 'none' }]
      })
      expect(saved.version).toBe(1)
      expect(saved.builtIn).toBe(false)

      const updated = await service.saveMappingTemplate({ ...saved, templateId: saved.templateId })
      expect(updated.version).toBe(2)

      await expect(
        service.saveMappingTemplate({
          templateId: 'tebra-claim-export',
          name: 'Hacked',
          pmSystem: 'Tebra',
          targetEntity: 'claims',
          grain: 'line',
          keyFields: ['x'],
          columns: [{ sourceHeader: 'a', targetField: 'b', transform: 'none' }]
        })
      ).rejects.toThrow(/built in/i)
    })

    it('round-trips a template through export/import JSON', async () => {
      const saved = await service.saveMappingTemplate({
        name: 'Exportable',
        pmSystem: 'CustomPM',
        targetEntity: 'claims',
        grain: 'line',
        keyFields: ['Claim Number'],
        columns: [{ sourceHeader: 'Claim #', targetField: 'claimNumber', transform: 'none' }]
      })
      const json = await service.exportMappingTemplate(saved.templateId)
      const imported = await service.importMappingTemplate(json)
      expect(imported.templateId).toBe(saved.templateId)
      expect(imported.name).toBe(saved.name)
    })
  })

  describe('manual entry', () => {
    it('upserts a monthly summary and records prior_values on the second write', async () => {
      const client = await service.createClient({ code: 'GAMMA', name: 'Gamma Clinic' })

      const first = await service.upsertMonthlySummary({
        clientId: client.clientId,
        periodMonth: '2026-01-01',
        charges: 10000,
        insCollections: 7000
      })
      expect(first.priorValues).toBeNull()

      const second = await service.upsertMonthlySummary({
        clientId: client.clientId,
        periodMonth: '2026-01-01',
        charges: 10500,
        insCollections: 7200
      })
      expect(second.charges).toBe(10500)
      expect(second.priorValues).not.toBeNull()
      const prior = second.priorValues as { charges: number }
      expect(prior.charges).toBe(10000)

      const fetched = await service.getMonthlySummary(client.clientId, '2026-01-01')
      expect(fetched?.charges).toBe(10500)
    })
  })

  describe('backups', () => {
    it('reports backup status and can run a backup on demand', async () => {
      const status = await service.getBackupStatus()
      // bootstrap() already ran a first-launch daily backup.
      expect(status.backupCount).toBeGreaterThanOrEqual(1)
      expect(status.duckdbIntegrityOk).toBe(true)
      expect(status.sqliteIntegrityOk).toBe(true)

      const after = await service.runBackupNow()
      expect(after.backupCount).toBeGreaterThan(status.backupCount)
      expect(after.lastBackupAt).not.toBeNull()
    })
  })
})

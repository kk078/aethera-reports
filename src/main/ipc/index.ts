import { registerPingHandler } from './ping'
import { registerClientsHandlers } from './clients'
import { registerMappingTemplateHandlers } from './mapping-templates'
import { registerImportsHandlers } from './imports'
import { registerManualEntryHandlers } from './manual-entry'
import { registerBackupsHandlers } from './backups'
import { registerReportsHandlers } from './reports'
import { registerBrandingHandlers } from './branding'
import { registerExportsHandlers } from './exports'
import { registerAnalyticsHandlers } from './analytics'
import { registerRcmConnectorHandlers } from './rcm-connector'
import { registerReferenceApiHandlers } from './reference-api'
import { registerPrintReadyHandler } from '../exporters/print-ready'
import type { IDataService } from '../services/data-service'

export function registerIpcHandlers(dataService: IDataService): void {
  registerPingHandler()
  registerClientsHandlers(dataService)
  registerMappingTemplateHandlers(dataService)
  registerImportsHandlers(dataService)
  registerManualEntryHandlers(dataService)
  registerBackupsHandlers(dataService)
  registerReportsHandlers(dataService)
  registerBrandingHandlers(dataService)
  registerExportsHandlers(dataService)
  registerAnalyticsHandlers(dataService)
  registerRcmConnectorHandlers(dataService)
  registerReferenceApiHandlers(dataService)
  registerPrintReadyHandler()
}

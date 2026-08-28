import type { NewMappingTemplateInput } from '../../../../shared/domain'

/**
 * Shipped preset (plan §3, Phase 1 step 5): a Tebra/Kareo-style claim
 * export — one row per claim line, claim-level fields repeated on every
 * line (a common shape for this class of PM-system report). See
 * `sample-data/tebra-claim-export.csv` for a matching synthetic fixture.
 */
export const tebraClaimExportTemplate: NewMappingTemplateInput = {
  name: 'Tebra claim export',
  pmSystem: 'Tebra',
  targetEntity: 'claims',
  grain: 'line',
  keyFields: ['Claim Number', 'Date of Service'],
  columns: [
    { sourceHeader: 'Patient Account Number', targetField: 'patientKey', transform: 'none' },
    { sourceHeader: 'Claim Number', targetField: 'claimNumber', transform: 'none' },
    { sourceHeader: 'Date of Service', targetField: 'dos', transform: 'date_fmt' },
    { sourceHeader: 'Payer Name', targetField: 'payerName', transform: 'none' },
    { sourceHeader: 'Rendering Provider NPI', targetField: 'providerNpi', transform: 'none' },
    { sourceHeader: 'Claim Status', targetField: 'status', transform: 'none' },
    { sourceHeader: 'Procedure Code', targetField: 'cptCode', transform: 'none' },
    // 'money' is reused here as the general-purpose numeric-parse transform
    // (strip symbols/commas, parse float) — Units has no currency symbol so
    // it degrades to a plain number parse.
    { sourceHeader: 'Units', targetField: 'units', transform: 'money' },
    { sourceHeader: 'Charge Amount', targetField: 'chargeAmount', transform: 'money' },
    { sourceHeader: 'Allowed Amount', targetField: 'allowedAmount', transform: 'money' },
    { sourceHeader: 'Paid Amount', targetField: 'paidAmount', transform: 'money' },
    {
      sourceHeader: 'Patient Responsibility',
      targetField: 'patientResponsibility',
      transform: 'money'
    },
    { sourceHeader: 'Patient Paid', targetField: 'patientPaid', transform: 'money' },
    { sourceHeader: 'Adjustment Amount', targetField: 'adjustmentAmount', transform: 'money' },
    { sourceHeader: 'Denial Code', targetField: 'carcCode', transform: 'none' },
    { sourceHeader: 'Denial Reason', targetField: 'denialDescription', transform: 'none' }
  ]
}

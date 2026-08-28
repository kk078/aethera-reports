/**
 * Target fields for the claim-line mapping wizard (plan §3), with common
 * PM-export header synonyms for fuzzy-matching. Shared between the main
 * process (`suggestColumnMappings`) and the renderer (mapping-builder
 * dropdown) — pure data, no imports, safe in both bundles.
 */
export interface ClaimLineTargetFieldSpec {
  field: string
  synonyms: string[]
}

export const CLAIM_LINE_TARGET_FIELDS: ClaimLineTargetFieldSpec[] = [
  {
    field: 'patientKey',
    synonyms: ['Patient Account Number', 'Patient Account', 'Account Number', 'MRN']
  },
  { field: 'claimNumber', synonyms: ['Claim Number', 'Claim #', 'Claim ID'] },
  { field: 'externalRef', synonyms: ['External Reference', 'Reference Number'] },
  { field: 'dos', synonyms: ['Date of Service', 'DOS', 'Service Date'] },
  { field: 'payerName', synonyms: ['Payer Name', 'Payer', 'Insurance'] },
  { field: 'providerNpi', synonyms: ['Rendering Provider NPI', 'Provider NPI', 'NPI'] },
  { field: 'status', synonyms: ['Claim Status', 'Status'] },
  { field: 'cptCode', synonyms: ['Procedure Code', 'CPT', 'CPT Code', 'HCPCS'] },
  { field: 'units', synonyms: ['Units', 'Unit Count'] },
  { field: 'chargeAmount', synonyms: ['Charge Amount', 'Charges', 'Billed Amount'] },
  { field: 'allowedAmount', synonyms: ['Allowed Amount', 'Allowed'] },
  { field: 'paidAmount', synonyms: ['Paid Amount', 'Insurance Paid', 'Ins Paid'] },
  { field: 'patientResponsibility', synonyms: ['Patient Responsibility', 'Patient Resp'] },
  { field: 'patientPaid', synonyms: ['Patient Paid'] },
  { field: 'adjustmentAmount', synonyms: ['Adjustment Amount', 'Adjustments'] },
  { field: 'carcCode', synonyms: ['Denial Code', 'CARC', 'CARC Code'] },
  { field: 'denialDescription', synonyms: ['Denial Reason', 'Denial Description'] }
]

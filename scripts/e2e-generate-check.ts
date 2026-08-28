/**
 * Headless end-to-end check for `--generate --formats pdf,pptx,xlsx`
 * (plan §6/§11, Phase 2 chunk B): seeds a throwaway `analytics.duckdb`
 * directly (bypassing the UI), points a real packaged-mode Electron
 * process at it via `--user-data-dir`, runs the CLI's multi-format
 * export for one client, and asserts all three files exist and are
 * non-trivial — reading the XLSX back with `exceljs` and unzipping the
 * PPTX to check its slide count, exactly like the corresponding unit
 * tests do for the pure builder halves of those exporters.
 *
 * This has to actually launch Electron (not just vite-node) because the
 * PDF/PPTX paths render a real offscreen `BrowserWindow` to produce
 * their content — `renderClientReportXlsxBuffer`'s pure logic is
 * unit-tested directly in `test/exporters-xlsx.test.ts`, but the
 * PDF/PPTX offscreen-window orchestration only exists inside a live
 * Electron process, same reason `--smoke` has to run this way.
 *
 * Run with: npm run e2e:generate-check
 * (builds first — this drives the built `out/main/index.js`, not source.)
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { openDuckDb } from '../src/main/db/duckdb'
import { applyMigrations } from '../src/main/db/migrate'
import { migrations } from '../src/main/db/migrations'

const PERIOD = '2026-03'
const CLIENT_CODE = 'GENCHK'
const OUT_ROOT = __dirname + '/../out/main/index.js'

async function seedAnalyticsDb(userDataDir: string): Promise<void> {
  const db = await openDuckDb(join(userDataDir, 'analytics.duckdb'))
  try {
    await applyMigrations(db.connection, migrations)
    const client = await db.connection.runAndReadAll(
      `INSERT INTO clients (code, name, contract_type, contract_rate, sla_days_to_submit, active)
       VALUES (?, 'E2E Generate Check Client', 'PERCENT_OF_COLLECTIONS', 0.05, 5, true)
       RETURNING client_id`,
      [CLIENT_CODE]
    )
    const clientId = Number(client.getRowObjectsJS()[0].client_id)

    const payer = await db.connection.runAndReadAll(
      `INSERT INTO payers (name, payer_class) VALUES ('E2E Payer', 'Commercial') RETURNING payer_id`
    )
    const payerId = Number(payer.getRowObjectsJS()[0].payer_id)

    const claim = await db.connection.runAndReadAll(
      `INSERT INTO claims (client_id, payer_id, patient_key, claim_number, dos, created_at, first_submitted_at,
         status, total_charge, total_allowed, total_paid, patient_responsibility, patient_paid, balance, source, natural_key)
       VALUES (?, ?, 'ph-e2e', 'E2E-CLM-1', '2026-03-01', '2026-03-01T00:00:00Z', '2026-03-02T00:00:00Z',
         'Open', 2000, 1600, 1000, 200, 100, 1000, 'manual', 'e2e-generate-nk-1')
       RETURNING claim_id`,
      [clientId, payerId]
    )
    const claimId = Number(claim.getRowObjectsJS()[0].claim_id)
    await db.connection.run(
      `INSERT INTO denials (claim_id, carc_code, category, root_cause_stage, created_at) VALUES (?, 'CO-45', 'contractual_obligation', 'CODING', '2026-03-05T00:00:00Z')`,
      [claimId]
    )
  } finally {
    db.close()
  }
}

function runElectronGenerate(
  userDataDir: string
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const electronBin = join(__dirname, '..', 'node_modules', '.bin', 'electron')
    const child = spawn(
      electronBin,
      [
        OUT_ROOT,
        `--user-data-dir=${userDataDir}`,
        '--generate',
        '--period',
        PERIOD,
        '--clients',
        CLIENT_CODE,
        '--formats',
        'pdf,pptx,xlsx',
        '--no-sandbox',
        '--disable-gpu'
      ],
      { env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } }
    )
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, output }))
  })
}

async function assertXlsxNonTrivial(filePath: string): Promise<void> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(filePath)
  const sheetNames = workbook.worksheets.map((s) => s.name)
  if (!sheetNames.includes('Summary') || !sheetNames.includes('Denials')) {
    throw new Error(`XLSX missing expected sheets, got: ${sheetNames.join(', ')}`)
  }
  console.log(`  [xlsx] sheets: ${sheetNames.join(', ')}`)
}

async function assertPptxNonTrivial(filePath: string): Promise<void> {
  const { readFileSync } = await import('node:fs')
  const zip = await JSZip.loadAsync(readFileSync(filePath))
  const slideCount = Object.keys(zip.files).filter((n) =>
    /^ppt\/slides\/slide\d+\.xml$/.test(n)
  ).length
  if (slideCount < 5) throw new Error(`PPTX has suspiciously few slides: ${slideCount}`)
  console.log(`  [pptx] slide count: ${slideCount}`)
}

function assertPdfNonTrivial(filePath: string): void {
  const size = statSync(filePath).size
  if (size < 1000) throw new Error(`PDF suspiciously small: ${size} bytes`)
  console.log(`  [pdf] size: ${size} bytes`)
}

async function main(): Promise<void> {
  if (!existsSync(OUT_ROOT)) {
    throw new Error(`${OUT_ROOT} not found — run "npm run build" first.`)
  }

  const userDataDir = mkdtempSync(join(tmpdir(), 'aethera-e2e-generate-'))
  const outputDir = join(homedir(), 'Documents', 'Aethera Reports', PERIOD, CLIENT_CODE)

  try {
    console.log(`[e2e-generate] seeding ${userDataDir}/analytics.duckdb ...`)
    await seedAnalyticsDb(userDataDir)

    console.log('[e2e-generate] running: electron --generate --formats pdf,pptx,xlsx ...')
    const { code, output } = await runElectronGenerate(userDataDir)
    console.log(output)
    if (code !== 0) throw new Error(`electron --generate exited with code ${code}`)

    console.log(`[e2e-generate] checking output dir: ${outputDir}`)
    if (!existsSync(outputDir)) {
      throw new Error(`Expected output directory does not exist: ${outputDir}`)
    }
    console.log(`  contents: ${readdirSync(outputDir).join(', ')}`)

    const pdfPath = join(outputDir, `${CLIENT_CODE}-${PERIOD}.pdf`)
    const pptxPath = join(outputDir, `${CLIENT_CODE}-${PERIOD}.pptx`)
    const xlsxPath = join(outputDir, `${CLIENT_CODE}-${PERIOD}.xlsx`)

    for (const p of [pdfPath, pptxPath, xlsxPath]) {
      if (!existsSync(p)) throw new Error(`Expected file missing: ${p}`)
    }

    assertPdfNonTrivial(pdfPath)
    await assertPptxNonTrivial(pptxPath)
    await assertXlsxNonTrivial(xlsxPath)

    console.log('\n[e2e-generate] all checks passed')
  } finally {
    rmSync(userDataDir, { recursive: true, force: true })
    // Clean up the real ~/Documents output this run produced — this
    // script writes through the exact same `app.getPath('documents')`
    // path production does (plan §6's output convention), so it must
    // tidy up after itself rather than leaving verification artifacts
    // in the developer's actual Documents folder.
    if (existsSync(outputDir) && !process.env.E2E_GENERATE_SKIP_CLEANUP) {
      rmSync(outputDir, { recursive: true, force: true })
    }
  }
}

main().catch((error: unknown) => {
  console.error('[e2e-generate] FAILED:', error)
  process.exitCode = 1
})

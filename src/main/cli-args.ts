/**
 * Pure CLI argv parsing (plan §11), split out from `cli.ts` so it has
 * zero Electron dependency — `cli.ts`'s `runCli` pulls in the PDF
 * exporter (which needs `electron.BrowserWindow`), and that import graph
 * would otherwise make even `parseCliArgs` untestable under plain
 * Node/vitest (the real `electron` package only resolves to its actual
 * API surface when running inside Electron itself).
 */

export interface GenerateArgs {
  mode: 'generate'
  period: string
  clients: string
  formats: string[]
  out?: string
}

export interface ImportArgs {
  mode: 'import'
  importPath: string
  template: string
}

export interface NoCliArgs {
  mode: 'none'
}

export type ParsedCliArgs = GenerateArgs | ImportArgs | NoCliArgs

function getFlagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  if (index === -1 || index === argv.length - 1) return undefined
  return argv[index + 1]
}

/**
 * Parses the app's CLI flags out of `process.argv` (or an equivalent
 * array in tests). Deliberately tolerant of *where* in argv the flags
 * appear — Electron prepends a variable number of its own arguments
 * (the exe path, and in dev the entry script path) depending on how the
 * app was launched, exactly like the existing `--smoke` check.
 */
export function parseCliArgs(argv: string[]): ParsedCliArgs {
  if (argv.includes('--generate')) {
    const period = getFlagValue(argv, '--period')
    if (!period || !/^\d{4}-\d{2}$/.test(period)) {
      throw new Error('--generate requires --period YYYY-MM')
    }
    const clients = getFlagValue(argv, '--clients') ?? 'all'
    const formatsRaw = getFlagValue(argv, '--formats') ?? 'pdf'
    const out = getFlagValue(argv, '--out')
    return {
      mode: 'generate',
      period,
      clients,
      formats: formatsRaw
        .split(',')
        .map((f) => f.trim().toLowerCase())
        .filter(Boolean),
      out
    }
  }

  if (argv.includes('--import')) {
    const importPath = getFlagValue(argv, '--import')
    const template = getFlagValue(argv, '--template')
    if (!importPath) throw new Error('--import requires a file or directory path')
    if (!template) throw new Error('--import requires --template <name-or-id>')
    return { mode: 'import', importPath, template }
  }

  return { mode: 'none' }
}

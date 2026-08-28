/**
 * Logs every headless CLI run to `userData/logs/automation-<date>.log`
 * (plan §11), in addition to echoing to the console.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { CliLogger } from './cli'

export function createCliLogger(userDataDir: string): CliLogger {
  const logsDir = join(userDataDir, 'logs')
  mkdirSync(logsDir, { recursive: true })
  const logFile = join(logsDir, `automation-${new Date().toISOString().slice(0, 10)}.log`)

  return (line: string): void => {
    const timestamped = `${new Date().toISOString()} ${line}`
    console.log(timestamped)
    appendFileSync(logFile, `${timestamped}\n`)
  }
}

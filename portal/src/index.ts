/**
 * Worker entry point (plan's Phase 3 addendum, chunk F). `env.DB` is the
 * real Cloudflare D1 binding at runtime — it satisfies `D1Like`
 * structurally (it has strictly more methods), so `buildApp()` never
 * needs to know it isn't the test double.
 */
import { buildApp } from './app'

const app = buildApp()

export default app

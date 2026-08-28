/**
 * Migrations are authored as plain `.sql` files and pulled in as raw text
 * at build time via Vite's `?raw` import suffix — this bakes the SQL into
 * the bundled main-process JS, so there's no runtime filesystem lookup to
 * get wrong across dev vs. packaged (asar) layouts.
 */
declare module '*.sql?raw' {
  const content: string
  export default content
}

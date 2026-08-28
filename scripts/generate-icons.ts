/**
 * Regenerates every packaged app-icon format from the one committed
 * source, `build/icon.svg` (a real design pass — see the session's
 * design notes — replacing the electron-vite scaffold's default Electron
 * atom logo). Nothing here is run automatically; re-run it by hand
 * whenever `build/icon.svg` changes:
 *
 *   npm run generate:icons
 *
 * Outputs:
 *   resources/icon.png   512×512 — Linux `BrowserWindow` icon (main/index.ts)
 *   build/icon.png        512×512 — electron-builder's Linux AppImage/deb icon
 *   build/icon.ico         multi-size (16/24/32/48/64/128/256) — Windows nsis/msi
 *   build/icon.icns        macOS bundle icon (electron-builder picks this up
 *                           from `directories.buildResources` automatically,
 *                           same convention as the .ico/.png above — no
 *                           `icon:` key needed in electron-builder.yml)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import png2icons from 'png2icons'

const ROOT = join(__dirname, '..')
const SVG_PATH = join(ROOT, 'build', 'icon.svg')
const MASTER_PNG_SIZE = 1024 // rasterize once at high-res, downsample from there

async function main(): Promise<void> {
  const svg = readFileSync(SVG_PATH)

  console.log(`[generate-icons] rasterizing ${SVG_PATH} at ${MASTER_PNG_SIZE}px...`)
  const masterPng = await sharp(svg, { density: 384 })
    .resize(MASTER_PNG_SIZE, MASTER_PNG_SIZE)
    .png()
    .toBuffer()

  const png512 = await sharp(masterPng).resize(512, 512).png().toBuffer()
  writeFileSync(join(ROOT, 'resources', 'icon.png'), png512)
  console.log('[generate-icons] wrote resources/icon.png (512x512)')
  writeFileSync(join(ROOT, 'build', 'icon.png'), png512)
  console.log('[generate-icons] wrote build/icon.png (512x512)')

  // png2icons builds every size (16/24/32/48/64/128/256) an .ico/.icns
  // needs from one input buffer — BICUBIC gives cleaner downsampling
  // than nearest-neighbor for a flat-color geometric mark like this one.
  const ico = png2icons.createICO(masterPng, png2icons.BICUBIC, 0, false, true)
  if (!ico) throw new Error('png2icons failed to build the .ico')
  writeFileSync(join(ROOT, 'build', 'icon.ico'), ico)
  console.log('[generate-icons] wrote build/icon.ico (16/24/32/48/64/128/256)')

  const icns = png2icons.createICNS(masterPng, png2icons.BICUBIC, 0)
  if (!icns) throw new Error('png2icons failed to build the .icns')
  writeFileSync(join(ROOT, 'build', 'icon.icns'), icns)
  console.log('[generate-icons] wrote build/icon.icns')

  console.log('\n[generate-icons] done.')
}

main().catch((error: unknown) => {
  console.error('[generate-icons] FAILED:', error)
  process.exitCode = 1
})

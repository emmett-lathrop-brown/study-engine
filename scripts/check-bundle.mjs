// Guards the FSRS bundle-hygiene invariant (FSRS design §3/§8/§10): ts-fsrs — which
// mutates Date.prototype at import time — must live ONLY in the main bundle, never in
// the renderer. A static import chain from renderer code to a side-effectful, non
// side-effect-free dep cannot be tree-shaken, so this is checked on the built output.
//
// IMPORTANT: grep the SIDE-EFFECT markers, not our wrapper names. reviewFsrs /
// generatorParameters / createEmptyCard are renamed or tree-shaken and read 0 even
// when ts-fsrs's side-effectful top-level (Date.prototype.scheduler, FSRSValidationError)
// has shipped — that false negative is exactly what this guard exists to catch.
//
// Run after `pnpm build`: `pnpm check-bundle`.
import { promises as fs } from 'fs'
import * as path from 'path'

const ROOT = path.resolve(import.meta.dirname, '..')
const RENDERER_DIR = path.join(ROOT, 'out', 'renderer', 'assets')
const MAIN_FILE = path.join(ROOT, 'out', 'main', 'index.js')

// Tokens that appear verbatim in ts-fsrs source when its module is evaluated.
const FORBIDDEN_IN_RENDERER = ['Date.prototype.scheduler', 'FSRSValidationError', 'request_retention']

async function readIfExists(p) {
  try {
    return await fs.readFile(p, 'utf8')
  } catch {
    return null
  }
}

async function main() {
  const fails = []

  // 1. Renderer must be FSRS-free.
  let rendererFiles = []
  try {
    rendererFiles = (await fs.readdir(RENDERER_DIR)).filter((f) => f.endsWith('.js'))
  } catch {
    fails.push(`renderer assets dir not found: ${RENDERER_DIR} (run \`pnpm build\` first)`)
  }
  for (const f of rendererFiles) {
    const src = await fs.readFile(path.join(RENDERER_DIR, f), 'utf8')
    for (const marker of FORBIDDEN_IN_RENDERER) {
      if (src.includes(marker)) fails.push(`renderer bundle ${f} contains FSRS marker "${marker}" (ts-fsrs leaked into the renderer)`)
    }
  }

  // 2. Main must actually contain ts-fsrs (so FSRS works where the engine runs).
  const main = await readIfExists(MAIN_FILE)
  if (main == null) fails.push(`main bundle not found: ${MAIN_FILE} (run \`pnpm build\` first)`)
  else if (!main.includes('ts-fsrs')) fails.push('main bundle does not reference ts-fsrs (FSRS engine missing from main)')

  if (fails.length) {
    console.error('BUNDLE CHECK FAILED:')
    for (const f of fails) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log(`BUNDLE CHECK PASS (renderer FSRS-free across ${rendererFiles.length} asset(s); ts-fsrs present in main)`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

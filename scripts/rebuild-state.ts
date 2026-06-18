// rebuild-state — recompute srs/state.json from reviews.jsonl (the append-only
// source of truth). state.json is just a cache of (history × review()): after
// tuning the scheduler (ease/fuzz/caps) or migrating to FSRS, replaying history
// rebuilds that cache. Only live-recorded reviews reproduce exactly — see the
// contract on rebuildState() in src/engine/session.ts.
//
// Dry-run by default (prints a diff, writes nothing). Run with: pnpm rebuild-state
//
//   pnpm rebuild-state                  # dry-run against the configured study-log
//   pnpm rebuild-state --root <path>    # dry-run against a specific root
//   pnpm rebuild-state -v               # also list every changed / added / removed id
//   pnpm rebuild-state --write          # apply: merge rebuilt over current (keeps no-history entries)
//   pnpm rebuild-state --write --prune  # apply: state.json := exactly the history-derived map
//
// Root resolution follows the app: --root → $STUDY_LOG → the app's settings.json
// `root` (probing both the packaged productName and the dev package name userData
// dirs). The resolved source is printed so a stale/wrong root is visible before a write.
import { existsSync, promises as fs, readFileSync } from 'fs'
import { homedir } from 'os'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { diffState, rebuildState } from '../src/engine/session'
import { listReviewDomains, readReviews, writeState } from '../src/engine/store'
import type { SrsState, StateMap } from '../src/engine/types'

interface Args {
  root?: string
  write: boolean
  prune: boolean
  verbose: boolean
  help: boolean
}

const USAGE = `rebuild-state — recompute srs/state.json from reviews.jsonl

  pnpm rebuild-state                  dry-run against the configured study-log
  pnpm rebuild-state --root <path>    dry-run against a specific root
  pnpm rebuild-state -v, --verbose    also list every changed / added / removed id
  pnpm rebuild-state --write          apply: merge rebuilt over current (keeps no-history entries)
  pnpm rebuild-state --write --prune  apply: replace state.json with exactly the history-derived map
  pnpm rebuild-state -h, --help       this help

Root resolution: --root  →  $STUDY_LOG  →  the app's settings.json "root".
A --write run backs up the existing state.json to srs/state.<timestamp>.bak.json first.`

function parseArgs(argv: string[]): Args {
  const a: Args = { write: false, prune: false, verbose: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (t === '--root') a.root = argv[++i]
    else if (t === '--write') a.write = true
    else if (t === '--prune') a.prune = true
    else if (t === '-v' || t === '--verbose') a.verbose = true
    else if (t === '-h' || t === '--help') a.help = true
    else {
      console.error(`unknown argument: ${t}\n`)
      console.error(USAGE)
      process.exit(2)
    }
  }
  return a
}

function fail(msg: string): never {
  console.error(`rebuild-state: ${msg}`)
  process.exit(1)
}

/**
 * App names whose userData dir may hold settings.json. Electron derives the
 * userData dir name from the app name: a packaged build uses electron-builder's
 * productName ("Study"), `pnpm dev` uses package.json `name` ("study-engine").
 * Read both from the repo so this stays in lockstep instead of hardcoding.
 */
function appNames(): string[] {
  const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const names: string[] = []
  try {
    const m = readFileSync(path.join(repo, 'electron-builder.yml'), 'utf8').match(/^productName:\s*(.+?)\s*$/m)
    if (m) names.push(m[1].replace(/^["']|["']$/g, '')) // packaged userData dir (preferred)
  } catch {
    /* no packaged config */
  }
  try {
    const name = (JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')) as { name?: string }).name
    if (name) names.push(name) // dev userData dir
  } catch {
    /* ignore */
  }
  if (!names.length) names.push('study-engine')
  return [...new Set(names)]
}

/** Candidate settings.json paths: appName × platform userData dir. */
function settingsCandidates(): string[] {
  const out: string[] = []
  for (const app of appNames()) {
    out.push(
      path.join(homedir(), 'Library', 'Application Support', app, 'settings.json'), // macOS
      path.join(process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'), app, 'settings.json'), // Windows
      path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), app, 'settings.json') // Linux
    )
  }
  return out
}

/** Resolve the study-log root and report where it came from. */
async function resolveRoot(argRoot?: string): Promise<{ root: string; source: string }> {
  if (argRoot) {
    if (!existsSync(argRoot)) fail(`--root path does not exist: ${argRoot}`)
    return { root: argRoot, source: '--root' }
  }
  if (process.env.STUDY_LOG) {
    if (!existsSync(process.env.STUDY_LOG)) fail(`$STUDY_LOG path does not exist: ${process.env.STUDY_LOG}`)
    return { root: process.env.STUDY_LOG, source: '$STUDY_LOG' }
  }
  for (const f of settingsCandidates()) {
    try {
      const saved = JSON.parse(await fs.readFile(f, 'utf8')) as { root?: string }
      if (saved.root && existsSync(saved.root)) return { root: saved.root, source: f }
    } catch {
      /* not this platform / not configured yet */
    }
  }
  return fail('could not resolve study-log root. Pass --root <path> or set $STUDY_LOG.')
}

/**
 * Read state.json strictly: a missing file is an empty map, but a present yet
 * unparseable file is a hard error. (The engine's tolerant readState() returns
 * {} on any error, which would make a --write merge silently behave like --prune
 * and drop entries from a hand-corrupted store — exactly what this tool guards.)
 */
async function readCurrentStrict(root: string): Promise<StateMap> {
  const p = path.join(root, 'srs', 'state.json')
  if (!existsSync(p)) return {}
  let raw: string
  try {
    raw = await fs.readFile(p, 'utf8')
  } catch (e) {
    return fail(`cannot read ${p}: ${(e as Error).message}`)
  }
  try {
    return JSON.parse(raw) as StateMap
  } catch {
    return fail(
      `state.json exists but is not valid JSON: ${p}\n` +
        '  Refusing to run — a --write would treat it as empty and could drop entries. Fix or remove it.'
    )
  }
}

/** Compact "field: from → to" for the rows that actually moved. */
function changedFields(from: SrsState, to: SrsState): string {
  const keys: (keyof SrsState)[] = [
    'interval', 'ease', 'due', 'reps', 'lapses', 'last_review', 'last_grade',
    'stability', 'difficulty', 'fsrs_state', 'algo'
  ]
  // Per-field default mirrors sameState exactly so this row-level diff agrees
  // with it: algo undefined == 'sm2'; the FSRS numerics undefined == 0 (so a
  // literal fsrs_state:0 isn't reported as moved vs an undefined one); else null.
  const def = (k: keyof SrsState): unknown =>
    k === 'algo' ? 'sm2' : k === 'stability' || k === 'difficulty' || k === 'fsrs_state' ? 0 : null
  return keys
    .filter((k) => (from[k] ?? def(k)) !== (to[k] ?? def(k)))
    .map((k) => `${k} ${from[k] ?? '∅'}→${to[k] ?? '∅'}`)
    .join(', ')
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function stamp(d: Date): string {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(USAGE)
    return
  }
  const { root, source } = await resolveRoot(args.root)

  // Scan the same way rebuildState discovers history (any logs/reviews.jsonl),
  // so the reported counts match what is actually rebuilt.
  const domains = await listReviewDomains(root)
  let reviewCount = 0
  for (const d of domains) reviewCount += (await readReviews(root, d)).length

  const current = await readCurrentStrict(root)
  const rebuilt = await rebuildState(root)
  const diff = diffState(current, rebuilt)

  console.log(`study-log root : ${root}`)
  console.log(`resolved via   : ${source}`)
  console.log(`scanned        : ${domains.length} domain(s) with history, ${reviewCount} review(s)`)
  console.log(`state.json     : ${Object.keys(current).length} entries`)
  console.log(`rebuilt        : ${Object.keys(rebuilt).length} history-derived card(s)`)
  console.log('───────────────────────────────────────────')
  console.log(`  changed   : ${diff.changed.length}  (recomputed to a different state)`)
  console.log(`  unchanged : ${diff.unchanged}`)
  console.log(`  added     : ${diff.added.length}  (history exists but no current entry)`)
  console.log(`  removed   : ${diff.removed.length}  (current entry has no review history — inert default/orphan)`)

  const LIST_CAP = 40
  const listIds = (label: string, ids: string[]): void => {
    if (!ids.length) return
    console.log(`\n${label}:`)
    const show = args.verbose ? ids : ids.slice(0, LIST_CAP)
    for (const id of show) console.log(`  ${id}`)
    if (!args.verbose && ids.length > LIST_CAP) console.log(`  …and ${ids.length - LIST_CAP} more (use -v to list all)`)
  }

  if (diff.changed.length) {
    console.log('\nchanged:')
    const show = args.verbose ? diff.changed : diff.changed.slice(0, LIST_CAP)
    for (const c of show) console.log(`  ${c.id}: ${changedFields(c.from, c.to)}`)
    if (!args.verbose && diff.changed.length > LIST_CAP) {
      console.log(`  …and ${diff.changed.length - LIST_CAP} more (use -v to list all)`)
    }
  }
  listIds('added', diff.added)
  listIds('removed', diff.removed)

  if (!args.write) {
    console.log('\nDRY RUN — nothing written.')
    if (args.prune) {
      console.log('(--prune only takes effect together with --write; the "removed" rows above are what it would drop.)')
    }
    console.log('Apply with --write (merge, keeps no-history entries) or --write --prune (drop them).')
    return
  }

  // --write -----------------------------------------------------------------
  if (args.prune && Object.keys(rebuilt).length === 0) {
    fail('refusing --prune to an empty state.json — no reviews found. Check --root / $STUDY_LOG.')
  }
  // merge: keep current entries that have no history; overlay every rebuilt card.
  // prune: state.json becomes exactly the history-derived map (drops no-history rows).
  const next: StateMap = args.prune ? rebuilt : { ...current, ...rebuilt }

  const statePath = path.join(root, 'srs', 'state.json')
  if (existsSync(statePath)) {
    // Never clobber an earlier backup (e.g. a second --write run in the same second).
    const base = path.join(root, 'srs', `state.${stamp(new Date())}.bak`)
    let bak = `${base}.json`
    for (let n = 2; existsSync(bak); n++) bak = `${base}-${n}.json`
    await fs.copyFile(statePath, bak)
    console.log(`\nbacked up current state.json → ${bak}`)
  }
  await writeState(root, next)
  console.log(`wrote ${Object.keys(next).length} entries to ${statePath}`)
  if (!args.prune && diff.removed.length) {
    console.log(`(kept ${diff.removed.length} no-history entries; re-run with --prune to drop them)`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

import { promises as fs, existsSync } from 'fs'
import * as path from 'path'
import type { Question, QType, Review, StateMap } from './types'

// Storage layer over the private study-log repo:
//   <root>/<domain>/questions/*.json   one question per file (structured source of truth)
//   <root>/<domain>/logs/reviews.jsonl append-only answer history
//   <root>/srs/state.json              global SM-2 state, keyed by question id
// Human/Obsidian-facing markdown is produced on demand by the exporter, not stored here.

export function domainPrefix(domain: string): string {
  return domain.replace(/\//g, '-') + '-'
}

export function parseQuestionJson(file: string, raw: string): Question {
  const d = JSON.parse(raw) as Partial<Question>
  const source = Array.isArray(d.source) ? d.source.map(String) : d.source ? [String(d.source)] : []
  return {
    id: String(d.id ?? path.basename(file, '.json')),
    domain: String(d.domain ?? ''),
    topic: String(d.topic ?? ''),
    type: (d.type as QType) ?? 'free',
    grade_scale: Number(d.grade_scale ?? 4),
    source,
    created: String(d.created ?? ''),
    q: d.q ?? '',
    choices: Array.isArray(d.choices) ? d.choices.map(String) : undefined,
    answer: d.answer ?? '',
    explanation: d.explanation ?? '',
    hint: d.hint ?? undefined,
    speak: d.speak ?? undefined,
    file
  }
}

export async function listQuestions(root: string, domain: string): Promise<Question[]> {
  const dir = path.join(root, domain, 'questions')
  let entries: string[] = []
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }
  const out: Question[] = []
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    const file = path.join(dir, name)
    try {
      out.push(parseQuestionJson(file, await fs.readFile(file, 'utf8')))
    } catch {
      // skip malformed file
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id))
  return out
}

/** Discover domains: any <root>/<a>/<b> that contains a `questions/` dir. */
export async function listDomains(root: string): Promise<string[]> {
  const out: string[] = []
  let level1: string[] = []
  try {
    level1 = await fs.readdir(root)
  } catch {
    return []
  }
  for (const a of level1) {
    if (a.startsWith('.') || a === 'srs') continue
    const aPath = path.join(root, a)
    let level2: string[] = []
    try {
      if (!(await fs.stat(aPath)).isDirectory()) continue
      level2 = await fs.readdir(aPath)
    } catch {
      continue
    }
    for (const b of level2) {
      if (existsSync(path.join(aPath, b, 'questions'))) out.push(`${a}/${b}`)
    }
  }
  out.sort()
  return out
}

const statePath = (root: string): string => path.join(root, 'srs', 'state.json')

function sortByKey(o: StateMap): StateMap {
  const out: StateMap = {}
  for (const k of Object.keys(o).sort()) out[k] = o[k]
  return out
}

export async function readState(root: string): Promise<StateMap> {
  try {
    return JSON.parse(await fs.readFile(statePath(root), 'utf8')) as StateMap
  } catch {
    return {}
  }
}

export async function writeState(root: string, state: StateMap): Promise<void> {
  const p = statePath(root)
  await fs.mkdir(path.dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  await fs.writeFile(tmp, JSON.stringify(sortByKey(state), null, 2) + '\n', 'utf8')
  await fs.rename(tmp, p) // atomic replace
}

export async function appendReview(root: string, domain: string, r: Review): Promise<void> {
  const p = path.join(root, domain, 'logs', 'reviews.jsonl')
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.appendFile(p, JSON.stringify(r) + '\n', 'utf8')
}

export async function readReviews(root: string, domain: string): Promise<Review[]> {
  const p = path.join(root, domain, 'logs', 'reviews.jsonl')
  let raw = ''
  try {
    raw = await fs.readFile(p, 'utf8')
  } catch {
    return []
  }
  const out: Review[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as Review)
    } catch {
      // skip a malformed/partially-appended line (matches listQuestions/readState tolerance)
    }
  }
  return out
}

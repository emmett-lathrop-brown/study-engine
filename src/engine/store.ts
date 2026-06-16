import { promises as fs, existsSync } from 'fs'
import * as path from 'path'
import matter from 'gray-matter'
import type { Question, QType, Review, StateMap } from './types'

// Storage layer over the private study-log repo:
//   <root>/<domain>/questions/*.md     one question per file (frontmatter + sections)
//   <root>/<domain>/logs/reviews.jsonl append-only answer history
//   <root>/srs/state.json              global SM-2 state, keyed by question id

export function domainPrefix(domain: string): string {
  return domain.replace(/\//g, '-') + '-'
}

function parseSections(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  let cur: string | null = null
  let buf: string[] = []
  const flush = (): void => {
    if (cur) out[cur.toLowerCase()] = buf.join('\n').trim()
    buf = []
  }
  for (const ln of body.split(/\r?\n/)) {
    const m = ln.match(/^##\s+(.+?)\s*$/)
    if (m) {
      flush()
      cur = m[1].trim()
    } else if (cur) {
      buf.push(ln)
    }
  }
  flush()
  return out
}

function parseChoices(s: string | undefined): string[] | undefined {
  if (!s) return undefined
  const items = s
    .split(/\r?\n/)
    .map((l) => l.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean)
  return items.length ? items : undefined
}

export function parseQuestionFile(file: string, raw: string): Question {
  const fm = matter(raw)
  const data = fm.data as Record<string, unknown>
  const sec = parseSections(fm.content)
  const source = Array.isArray(data.source)
    ? (data.source as unknown[]).map(String)
    : data.source
      ? [String(data.source)]
      : []
  return {
    id: String(data.id ?? path.basename(file, '.md')),
    domain: String(data.domain ?? ''),
    topic: String(data.topic ?? ''),
    type: (data.type as QType) ?? 'free',
    grade_scale: Number(data.grade_scale ?? 4),
    source,
    created: String(data.created ?? ''),
    q: sec['q'] ?? '',
    choices: parseChoices(sec['choices']),
    answer: sec['a'] ?? '',
    explanation: sec['explanation'] ?? '',
    speak: data.speak ? String(data.speak) : sec['speak'] || undefined,
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
    if (!name.endsWith('.md')) continue
    const file = path.join(dir, name)
    try {
      out.push(parseQuestionFile(file, await fs.readFile(file, 'utf8')))
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
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Review)
}

import type {
  DomainInfo,
  PickedQuestion,
  SessionItem,
  SessionSummary,
  SrsState,
  StudyStats
} from './types'
import { addDays, defaultState, nowISO, review as srsReview, todayISO } from './srs'
import {
  appendReview,
  domainPrefix,
  listDomains,
  listQuestions,
  readReviews,
  readState,
  writeState
} from './store'

export interface PickOptions {
  limit?: number // total questions in the session (default 15)
  maxNew?: number // cap on brand-new questions mixed in (default 8)
  on?: string // "today" override for testing
  shuffle?: boolean // randomize order within due/new buckets (default true)
  seed?: number // PRNG seed for reproducible order (default Date.now())
}

/** Tiny seeded PRNG (mulberry32) — no deps, reproducible under a fixed seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return (): number => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fisher-Yates shuffle in place using the given random source. */
function fisherYates<T>(arr: T[], rnd: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

/** Build a session: due reviews first, then fill with new questions. */
export async function pick(
  root: string,
  domain: string,
  opts: PickOptions = {}
): Promise<PickedQuestion[]> {
  const on = opts.on ?? todayISO()
  const limit = opts.limit ?? 15
  const maxNew = opts.maxNew ?? 8

  const questions = await listQuestions(root, domain)
  const state = await readState(root)

  const withState: PickedQuestion[] = questions.map((q) => {
    const st = state[q.id] ?? defaultState(on)
    const isNew = !state[q.id] || st.reps === 0
    return { ...q, state: st, isNew }
  })

  // Shuffle WITHIN each bucket (Fisher-Yates) but keep due-before-new: spaced
  // repetition urgency must drive the session, so new cards never crowd out
  // overdue ones. Deterministic when a seed is supplied (smoke/tests).
  const shuffle = opts.shuffle ?? true
  const rnd = mulberry32(opts.seed ?? Date.now())

  const dueReview = withState.filter((x) => !x.isNew && x.state.due <= on)
  const fresh = withState.filter((x) => x.isNew)
  if (shuffle) {
    fisherYates(dueReview, rnd)
    fisherYates(fresh, rnd)
  } else {
    dueReview.sort((a, b) => a.state.due.localeCompare(b.state.due))
    fresh.sort((a, b) => a.id.localeCompare(b.id))
  }

  const picked: PickedQuestion[] = []
  for (const r of dueReview) {
    if (picked.length >= limit) break
    picked.push(r)
  }
  let newCount = 0
  for (const n of fresh) {
    if (picked.length >= limit || newCount >= maxNew) break
    picked.push(n)
    newCount++
  }
  return picked
}

export interface GradeInput {
  id: string
  grade: number
}

/** Record graded answers: append history + update SM-2 state (atomic write). */
export async function record(
  root: string,
  domain: string,
  session: string,
  grades: GradeInput[],
  on?: string
): Promise<Array<{ id: string; state: SrsState }>> {
  const day = on ?? todayISO()
  const state = await readState(root)
  const results: Array<{ id: string; state: SrsState }> = []
  for (const g of grades) {
    const prev = state[g.id] ?? defaultState(day)
    const next = srsReview(prev, g.grade, day)
    state[g.id] = next
    await appendReview(root, domain, { id: g.id, ts: nowISO(), grade: g.grade, session })
    results.push({ id: g.id, state: next })
  }
  await writeState(root, state)
  return results
}

export async function gradeOne(
  root: string,
  domain: string,
  session: string,
  id: string,
  grade: number,
  on?: string
): Promise<{ id: string; state: SrsState }> {
  const [r] = await record(root, domain, session, [{ id, grade }], on)
  return r
}

/** Dashboard counts per domain. */
export async function domainInfo(root: string): Promise<DomainInfo[]> {
  const on = todayISO()
  const state = await readState(root)
  const domains = await listDomains(root)
  const out: DomainInfo[] = []
  for (const domain of domains) {
    const qs = await listQuestions(root, domain)
    let due = 0
    let fresh = 0
    for (const q of qs) {
      const st = state[q.id]
      if (!st || st.reps === 0) fresh++
      else if (st.due <= on) due++
    }
    out.push({ domain, prefix: domainPrefix(domain), total: qs.length, due, new: fresh })
  }
  return out
}

const MATURE_DAYS = 21 // interval at/above which a card counts as "mature" (Anki convention)

/** Cross-domain study stats for the dashboard: streak, today's count, maturity. */
export async function studyStats(root: string, on?: string): Promise<StudyStats> {
  const today = on ?? todayISO()
  const state = await readState(root)
  const domains = await listDomains(root)
  const dayCounts = new Map<string, number>()
  let totalReviews = 0
  const maturity = []
  for (const domain of domains) {
    for (const r of await readReviews(root, domain)) {
      const day = r.ts.slice(0, 10) // ts carries the local offset, so this is the local date
      dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1)
      totalReviews++
    }
    const qs = await listQuestions(root, domain)
    let unseen = 0
    let learning = 0
    let mature = 0
    for (const q of qs) {
      const st = state[q.id]
      if (!st || !st.last_review) unseen++
      else if (st.interval >= MATURE_DAYS) mature++
      else learning++
    }
    maturity.push({ domain, total: qs.length, unseen, learning, mature })
  }
  // Streak: count back from today (or yesterday if today isn't done yet).
  let streak = 0
  let cursor = dayCounts.has(today) ? today : addDays(today, -1)
  while (dayCounts.has(cursor)) {
    streak++
    cursor = addDays(cursor, -1)
  }
  return {
    streak,
    reviewsToday: dayCounts.get(today) ?? 0,
    totalReviews,
    reviewedDays: dayCounts.size,
    maturity
  }
}

export async function summary(
  root: string,
  domain: string,
  session: string
): Promise<SessionSummary> {
  const reviews = (await readReviews(root, domain)).filter((r) => r.session === session)
  const questions = await listQuestions(root, domain)
  const qById = new Map(questions.map((q) => [q.id, q]))
  const byGrade: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 }
  const wrongTopic = new Map<string, number>()
  // One item per question in first-answered order; a re-grade overwrites the grade.
  const itemsById = new Map<string, SessionItem>()
  let correct = 0
  for (const r of reviews) {
    byGrade[r.grade] = (byGrade[r.grade] ?? 0) + 1
    if (r.grade >= 3) correct++
    else {
      const t = qById.get(r.id)?.topic ?? '?'
      wrongTopic.set(t, (wrongTopic.get(t) ?? 0) + 1)
    }
    const q = qById.get(r.id)
    itemsById.set(r.id, {
      id: r.id,
      topic: q?.topic ?? '?',
      q: q?.q ?? r.id,
      grade: r.grade,
      correct: r.grade >= 3
    })
  }
  const total = reviews.length
  const weakTopics = [...wrongTopic.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([t]) => t)
  return {
    session,
    domain,
    total,
    correct,
    accuracy: total ? Math.round((correct / total) * 100) : 0,
    byGrade,
    weakTopics,
    items: [...itemsById.values()]
  }
}

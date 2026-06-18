import type {
  DomainInfo,
  PickedQuestion,
  Question,
  Review,
  SessionItem,
  SessionSummary,
  SrsState,
  StateMap,
  StudyStats
} from './types'
import { addDays, defaultState, fuzzSeed, LEECH_LAPSES, nowISO, todayISO } from './srs'
import { reviewWith, defaultStateWith, type Algo } from './srs-dispatch'
import {
  appendReview,
  domainPrefix,
  listDomains,
  listQuestions,
  listReviewDomains,
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
  ids?: string[] // re-drill: build the session from exactly these question ids
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

  const toPicked = (q: Question): PickedQuestion => {
    const st = state[q.id] ?? defaultState(on)
    const isNew = !state[q.id] || st.reps === 0
    return { ...q, state: st, isNew }
  }

  // Re-drill path: build the session from exactly the given ids, in the order
  // listed, ignoring due/new selection and the limit/maxNew caps. The id set IS
  // the session — used to immediately re-test the questions just missed (which
  // record() has already pushed off to a future due date, so they would never
  // resurface today via the bucket logic below). Unknown ids (no matching file)
  // and duplicates are dropped; cards keep their real recorded state, but are
  // forced isNew=false: every id here was just answered this session, so a card
  // whose Again-grade reset reps to 0 must still read as 復習, not NEW.
  if (opts.ids) {
    const byId = new Map(questions.map((q) => [q.id, q]))
    const seen = new Set<string>()
    const out: PickedQuestion[] = []
    for (const id of opts.ids) {
      const q = byId.get(id)
      if (q && !seen.has(id)) {
        seen.add(id)
        out.push({ ...toPicked(q), isNew: false })
      }
    }
    return out
  }

  const withState: PickedQuestion[] = questions.map(toPicked)

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
  on?: string,
  algo: Algo = 'sm2'
): Promise<Array<{ id: string; state: SrsState }>> {
  // One clock read so the fuzz seed-day and the stored ts date can't disagree
  // (no midnight race): on the live path day === ts.slice(0,10), so a replay that
  // derives the day from ts reproduces the same fuzzed interval.
  const now = new Date()
  const day = on ?? todayISO(now)
  const ts = nowISO(now)
  const state = await readState(root)
  const results: Array<{ id: string; state: SrsState }> = []
  for (const g of grades) {
    const prev = state[g.id] ?? defaultStateWith(algo, day)
    // Seed fuzz from (id, day); reproducible from the review's stored ts on replay.
    // (FSRS ignores the seed — enable_fuzz:false — but shares SM-2's call signature.)
    const next = reviewWith(algo, prev, g.grade, day, fuzzSeed(g.id, day))
    state[g.id] = next
    await appendReview(root, domain, { id: g.id, ts, grade: g.grade, session })
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
  on?: string,
  algo: Algo = 'sm2'
): Promise<{ id: string; state: SrsState }> {
  const [r] = await record(root, domain, session, [{ id, grade }], on, algo)
  return r
}

/**
 * Rebuild the global SM-2 state purely from review history — the inverse of
 * record(). For each card, fold review() over its reviews in append order
 * (reviews.jsonl is the append-only source of truth) and derive both the
 * calendar day and the fuzz seed from each review's own stored ts, exactly as
 * record() did. A card whose entire history was recorded live therefore
 * reproduces its stored state bit-for-bit, including the fuzzed interval:
 * record() reads one clock for both the seed-day and the ts, so day ===
 * ts.slice(0,10) and `review(prev, grade, day, fuzzSeed(id, day))` replays
 * identically. Two cards do NOT round-trip: those graded via the `on` test
 * override (their ts is wall-clock, not `on`, so the seed-day differs), and any
 * card whose stored state was hand-injected rather than built from its reviews.
 *
 * Cards with no history get no entry — and every consumer treats a missing id
 * identically to a seeded reps=0/no-last_review default (pick() via
 * `?? defaultState()`, domainInfo/studyStats/summary via missing-or-default
 * guards), so dropping inert default entries is behaviour-preserving. History
 * is discovered via listReviewDomains() (any domain with a logs/reviews.jsonl),
 * NOT listDomains(), so a domain whose questions/ dir is absent still has its
 * state rebuilt rather than silently dropped. An id that somehow appears under
 * two domains is replayed in domain (sorted) order, not interleaved by ts —
 * unreachable on the live path (domain-prefixed ids, one domain per session).
 *
 * Pure read: returns the rebuilt map and writes nothing. Use it to recompute
 * state.json after changing the scheduler (or migrating to FSRS), or as a smoke
 * invariant that record() and review() stay in agreement.
 */
export async function rebuildState(root: string, algo: Algo = 'sm2'): Promise<StateMap> {
  const byId = new Map<string, Review[]>()
  for (const domain of await listReviewDomains(root)) {
    for (const r of await readReviews(root, domain)) {
      const arr = byId.get(r.id)
      if (arr) arr.push(r)
      else byId.set(r.id, [r])
    }
  }
  const state: StateMap = {}
  for (const [id, reviews] of byId) {
    // Seed from defaultState on the first review's day; interval/ease/reps are
    // overwritten by the first review() call, so only a sane starting `due`
    // matters here. Then replay in append order — the true event order.
    let st = defaultStateWith(algo, reviews[0].ts.slice(0, 10))
    for (const r of reviews) {
      const day = r.ts.slice(0, 10)
      st = reviewWith(algo, st, r.grade, day, fuzzSeed(r.id, day))
    }
    state[id] = st
  }
  return state
}

export interface StateDiff {
  added: string[] // ids present in rebuilt but not in current (new history)
  removed: string[] // ids present in current but not in rebuilt (no-history / orphan entries)
  changed: Array<{ id: string; from: SrsState; to: SrsState }>
  unchanged: number
}

function sameState(a: SrsState, b: SrsState): boolean {
  return (
    a.interval === b.interval &&
    a.ease === b.ease &&
    a.due === b.due &&
    a.reps === b.reps &&
    a.lapses === b.lapses &&
    (a.last_review ?? '') === (b.last_review ?? '') &&
    (a.last_grade ?? 0) === (b.last_grade ?? 0) &&
    (a.stability ?? 0) === (b.stability ?? 0) &&
    (a.difficulty ?? 0) === (b.difficulty ?? 0) &&
    (a.fsrs_state ?? 0) === (b.fsrs_state ?? 0) &&
    // include algo so a half-migrated (sm2/fsrs mixed) map shows up as changed.
    // undefined normalizes to 'sm2', so old SM-2 records compare equal to fresh ones.
    (a.algo ?? 'sm2') === (b.algo ?? 'sm2')
  )
}

/** Field-wise diff of a current state map against a rebuilt one (key-order independent). */
export function diffState(current: StateMap, rebuilt: StateMap): StateDiff {
  const added: string[] = []
  const removed: string[] = []
  const changed: Array<{ id: string; from: SrsState; to: SrsState }> = []
  let unchanged = 0
  for (const id of new Set([...Object.keys(current), ...Object.keys(rebuilt)])) {
    const a = current[id]
    const b = rebuilt[id]
    if (a && !b) removed.push(id)
    else if (!a && b) added.push(id)
    else if (sameState(a, b)) unchanged++
    else changed.push({ id, from: a, to: b })
  }
  added.sort()
  removed.sort()
  changed.sort((x, y) => x.id.localeCompare(y.id))
  return { added, removed, changed, unchanged }
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
    let leeches = 0
    for (const q of qs) {
      const st = state[q.id]
      if (!st || !st.last_review) unseen++
      else if (st.interval >= MATURE_DAYS) mature++
      else learning++
      // Leech is orthogonal to the maturity bucket: a mature card can still be a leech.
      if (st && st.lapses >= LEECH_LAPSES) leeches++
    }
    maturity.push({ domain, total: qs.length, unseen, learning, mature, leeches })
  }
  // Streak: count back from today (or yesterday if today isn't done yet).
  let streak = 0
  let cursor = dayCounts.has(today) ? today : addDays(today, -1)
  while (dayCounts.has(cursor)) {
    streak++
    cursor = addDays(cursor, -1)
  }
  // Per-day totals (only days with activity), ascending — the renderer fills the
  // empty days to draw a GitHub-style contribution grid.
  const dailyCounts = [...dayCounts.entries()]
    .map(([day, count]) => ({ day, count }))
    .sort((a, b) => a.day.localeCompare(b.day))
  return {
    streak,
    reviewsToday: dayCounts.get(today) ?? 0,
    totalReviews,
    reviewedDays: dayCounts.size,
    maturity,
    dailyCounts
  }
}

export async function summary(
  root: string,
  domain: string,
  session: string
): Promise<SessionSummary> {
  const reviews = (await readReviews(root, domain)).filter((r) => r.session === session)
  const questions = await listQuestions(root, domain)
  const state = await readState(root)
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
      correct: r.grade >= 3,
      leech: (state[r.id]?.lapses ?? 0) >= LEECH_LAPSES
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

import type {
  DomainInfo,
  PickedQuestion,
  SessionSummary,
  SrsState
} from './types'
import { defaultState, nowISO, review as srsReview, todayISO } from './srs'
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

  const dueReview = withState
    .filter((x) => !x.isNew && x.state.due <= on)
    .sort((a, b) => a.state.due.localeCompare(b.state.due))
  const fresh = withState.filter((x) => x.isNew).sort((a, b) => a.id.localeCompare(b.id))

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

export async function summary(
  root: string,
  domain: string,
  session: string
): Promise<SessionSummary> {
  const reviews = (await readReviews(root, domain)).filter((r) => r.session === session)
  const questions = await listQuestions(root, domain)
  const topicById = new Map(questions.map((q) => [q.id, q.topic]))
  const byGrade: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 }
  const wrongTopic = new Map<string, number>()
  let correct = 0
  for (const r of reviews) {
    byGrade[r.grade] = (byGrade[r.grade] ?? 0) + 1
    if (r.grade >= 3) correct++
    else {
      const t = topicById.get(r.id) ?? '?'
      wrongTopic.set(t, (wrongTopic.get(t) ?? 0) + 1)
    }
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
    weakTopics
  }
}

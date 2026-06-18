// Algorithm-independent SRS primitives shared by every scheduler (SM-2, FSRS, …).
// Nothing here imports ts-fsrs, so both `srs-sm2.ts` and `srs-fsrs.ts` can depend
// on it without pulling the FSRS library into the renderer bundle.
//   - tuning constants (ease/interval/leech)
//   - calendar helpers (todayISO / nowISO / addDays)
//   - deterministic fuzz primitives (fuzzSeed / rng01 / fuzzInterval)
//   - seeded generator + shuffle (mulberry32 / fisherYates) shared by session.ts pick() and cram.ts

export const EASE_START = 2.5
// Raised from Anki's classic 1.3: with Hard no longer cutting ease (see reviewSm2()),
// Again is the only thing that lowers ease, so a 1.5 floor keeps heavily-lapsed
// cards from collapsing into ever-tinier intervals ("ease hell"). Tunable.
export const EASE_MIN = 1.5

// Hard ceiling on a single interval (days). A small actively-maintained corpus
// never wants a card to vanish for years; prevents runaway multiplication. Tunable.
export const INTERVAL_MAX = 365

// Cards lapsed at least this many times are flagged as "leeches" (soft-flag for the
// dashboard/summary only — never auto-suspended; the learner decides what to do).
export const LEECH_LAPSES = 8

// Interval fuzz: jitter the *multiplied* (reps>=2) intervals at/above FUZZ_MIN_DAYS
// by +/-FUZZ_PCT (min +/-1 day) so cards graded on the same day don't all fall due
// together. Graduating steps (1/4/6/8) are left exact. Deterministic given a seed.
const FUZZ_MIN_DAYS = 7
const FUZZ_PCT = 0.05

export const round2 = (n: number): number => Math.round(n * 100) / 100

/** Local calendar date as YYYY-MM-DD. */
export function todayISO(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Local timestamp with timezone offset, e.g. 2026-06-16T09:12:00+09:00. */
export function nowISO(d: Date = new Date()): string {
  const tzo = -d.getTimezoneOffset()
  const sign = tzo >= 0 ? '+' : '-'
  const pad = (n: number): string => String(Math.floor(Math.abs(n))).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(tzo / 60)}:${pad(tzo % 60)}`
  )
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + days)
  return todayISO(dt)
}

/**
 * Deterministic per-review seed from (card id, calendar day). The same card on the
 * same day always yields the same fuzz, so a future rebuild-state (not yet built)
 * COULD replay reviews.jsonl and reproduce intervals exactly via
 * `review(prev, grade, day, fuzzSeed(id, day))` with `day = review.ts.slice(0,10)`.
 * FNV-1a over a non-empty `id:day` never returns 0, so the seed===0 "no fuzz"
 * sentinel in fuzzInterval stays reserved for review()'s default — safe here.
 */
export function fuzzSeed(id: string, day: string): number {
  let h = 2166136261 >>> 0 // FNV-1a over `${id}:${day}`
  const s = `${id}:${day}`
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** One mulberry32 step in [0,1) — a single deterministic draw from `seed`. */
export function rng01(seed: number): number {
  let a = (seed >>> 0) | 0
  a = (a + 0x6d2b79f5) | 0
  let t = Math.imul(a ^ (a >>> 15), 1 | a)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** Jitter `interval` by +/-FUZZ_PCT (min +/-1d) for intervals >= FUZZ_MIN_DAYS. seed 0 => no fuzz. */
export function fuzzInterval(interval: number, seed: number): number {
  if (seed === 0 || interval < FUZZ_MIN_DAYS) return interval
  const spread = Math.max(1, Math.round(interval * FUZZ_PCT))
  const delta = Math.round((rng01(seed) * 2 - 1) * spread)
  return Math.max(1, interval + delta)
}

/**
 * Tiny seeded PRNG (mulberry32) — no deps, reproducible under a fixed seed. Unlike
 * rng01 (a single draw), this returns a stateful generator for repeated draws.
 * Shared so session.ts pick() and cram.ts shuffle from one implementation. Lives in
 * srs-core (algorithm-independent, renderer-safe) so the renderer can use it too.
 */
export function mulberry32(seed: number): () => number {
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
export function fisherYates<T>(arr: T[], rnd: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

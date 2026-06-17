import type { SrsState } from './types'

// SM-2 (Anki classic) adapted to a 4-button self-grade:
//   1 = Again, 2 = Hard, 3 = Good, 4 = Easy
// Implemented as a pure function of (previous state, grade, date) so that the
// whole state map can be rebuilt from reviews.jsonl if the algorithm changes.
// (Swap this file for FSRS later without touching storage or UI.)

export const EASE_START = 2.5
// Raised from Anki's classic 1.3: with Hard no longer cutting ease (see review()),
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

const round2 = (n: number): number => Math.round(n * 100) / 100

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

export function defaultState(on: string): SrsState {
  return { interval: 0, ease: EASE_START, due: on, reps: 0, lapses: 0 }
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
function rng01(seed: number): number {
  let a = (seed >>> 0) | 0
  a = (a + 0x6d2b79f5) | 0
  let t = Math.imul(a ^ (a >>> 15), 1 | a)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** Jitter `interval` by +/-FUZZ_PCT (min +/-1d) for intervals >= FUZZ_MIN_DAYS. seed 0 => no fuzz. */
function fuzzInterval(interval: number, seed: number): number {
  if (seed === 0 || interval < FUZZ_MIN_DAYS) return interval
  const spread = Math.max(1, Math.round(interval * FUZZ_PCT))
  const delta = Math.round((rng01(seed) * 2 - 1) * spread)
  return Math.max(1, interval + delta)
}

/**
 * SM-2 step. Pure function of (prev, grade, on[, seed]).
 *  - Omit `seed` (or pass 0) for an exact, fuzz-free interval — used by unit
 *    checks and any caller that wants reproducible output without a seed.
 *  - Pass `fuzzSeed(id, on)` to spread load (interval jitter) and cap runaway
 *    intervals. Reproducible from (id, on): a replay that derives `on` from a
 *    review's stored ts reproduces the interval — which holds for reviews
 *    recorded live (record() reads one clock for both seed-day and ts). The `on`
 *    override (tests) stores a wall-clock ts, so its fuzz is not replayable.
 */
export function review(prev: SrsState, grade: number, on: string, seed = 0): SrsState {
  let { interval, ease, reps, lapses } = prev

  if (grade <= 1) {
    // Again = lapse: reset reps, shrink interval, drop ease.
    reps = 0
    lapses += 1
    ease = Math.max(EASE_MIN, round2(ease - 0.2))
    interval = 1
  } else {
    // Hard / Good / Easy = success.
    if (reps === 0) {
      interval = grade === 4 ? 4 : 1 // graduate Easy faster
    } else if (reps === 1) {
      interval = grade === 2 ? 4 : grade === 4 ? 8 : 6
    } else {
      // Hard is a "slow-grow" button (x1.2), never a shrink: with ease frozen it
      // grows the interval monotonically but always slower than Good (x ease).
      const mult = grade === 2 ? 1.2 : grade === 4 ? ease * 1.3 : ease
      // Fuzz only the multiplied intervals — graduating steps (1/4/6/8) stay exact.
      interval = fuzzInterval(Math.max(1, Math.round(interval * mult)), seed)
    }
    // Hard (2) no longer lowers ease: repeatedly pressing Hard used to spiral a
    // card into "ease hell" (ever-shrinking intervals). Only Again cuts ease now.
    const delta = grade === 4 ? 0.15 : 0
    ease = Math.max(EASE_MIN, round2(ease + delta))
    reps += 1
  }

  // Cap last so neither multiplication nor fuzz can exceed the ceiling.
  interval = Math.min(INTERVAL_MAX, interval)

  return {
    interval,
    ease,
    due: addDays(on, interval),
    reps,
    lapses,
    last_review: on,
    last_grade: grade
  }
}

import type { SrsState } from './types'
import { EASE_START, EASE_MIN, INTERVAL_MAX, addDays, round2, fuzzInterval } from './srs-core'

// SM-2 (Anki classic) adapted to a 4-button self-grade:
//   1 = Again, 2 = Hard, 3 = Good, 4 = Easy
// Implemented as a pure function of (previous state, grade, date) so that the
// whole state map can be rebuilt from reviews.jsonl if the algorithm changes.
// (FSRS lives in srs-fsrs.ts; this file stays the load-bearing default.)

export function defaultStateSm2(on: string): SrsState {
  return { interval: 0, ease: EASE_START, due: on, reps: 0, lapses: 0 }
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
export function reviewSm2(prev: SrsState, grade: number, on: string, seed = 0): SrsState {
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

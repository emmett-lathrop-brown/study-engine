import type { SrsState } from './types'
import { fsrs, generatorParameters, createEmptyCard, Rating, State, type Card, type Grade } from 'ts-fsrs'
import { EASE_START, INTERVAL_MAX, addDays } from './srs-core'

// FSRS-6 scheduler (ts-fsrs@5.4.1, pinned). The ONLY file that imports ts-fsrs.
// ts-fsrs mutates Date.prototype at import time and is NOT marked side-effect-free,
// so a static import chain from the renderer would ship that mutation into the
// renderer bundle (rollup can't drop a side-effectful module). It is kept out of the
// renderer by REACHABILITY, not tree-shaking: only srs-dispatch.ts (node/main) imports
// this file, and the renderer-facing hub srs.ts does not import srs-dispatch. Verified
// via `pnpm build` + `pnpm check-bundle` (0 Date.prototype.scheduler / FSRSValidationError
// in out/renderer; ts-fsrs present only in out/main).
//
// Run day-by-day: enable_short_term:false skips sub-day (re)learning steps, so the
// scheduler returns whole-day intervals from the first review — matching the app's
// `day = ts.slice(0,10)` clock. Consequence: a same-day re-grade (elapsed 0 days)
// is a memory no-op (stability unchanged). Determinism: enable_fuzz:false (no PRNG).

// `F` is built lazily and rebuilt by buildFsrs(retention). It is not initialized at
// module top-level so this module stays free of its OWN side effects (defense in depth
// for bundlers; the renderer is already protected by reachability — see above).
// retention is process-wide config (set at main startup / on settings change), not a
// per-call argument, so the scheduler stays a pure function of (card, now, rating) for
// a given retention (§7.1).
let F: ReturnType<typeof fsrs> | null = null
let currentRetention = 0.9

export function buildFsrs(retention: number): ReturnType<typeof fsrs> {
  currentRetention = retention
  F = fsrs(
    generatorParameters({
      request_retention: retention, // default 0.9 (configurable 0.80–0.97 in PR-4)
      maximum_interval: INTERVAL_MAX, // 365 — unified with the SM-2 cap
      enable_fuzz: false, // deterministic (no PRNG)
      enable_short_term: false // day-granular operation (no sub-day learning steps)
      // `w` is the FSRS-6 default vector, filled in by generatorParameters.
    })
  )
  return F
}

function scheduler(): ReturnType<typeof fsrs> {
  return F ?? buildFsrs(currentRetention)
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4

// UTC noon: ts-fsrs computes day diffs on UTC date components, so anchoring at
// Date.UTC(y, m-1, d, 12) makes 'YYYY-MM-DD' agree with the UTC date regardless of
// the host timezone (local noon could drift +/-1 day across the UTC boundary).
function utcNoon(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0))
}

// Normalize a grade to a ts-fsrs Grade. ts-fsrs keys its schedule by the integer
// Grades {1,2,3,4}, so round first — a fractional value would miss the key and make
// next() return undefined. Clamp stray values (0/negative -> Again, 5+ -> Easy) so an
// out-of-range grade can never throw or mis-route.
function normalizeRating(g: number): Grade {
  const r = Math.round(g)
  if (r <= 1) return Rating.Again // 1
  if (r >= 4) return Rating.Easy // 4
  return r as Grade // 2 = Hard, 3 = Good
}

// ease (centered at 2.5) -> difficulty [1,10], monotone: higher ease = lower difficulty.
function clampDifficulty(d: number): number {
  return Math.min(10, Math.max(1, d))
}
function seedDifficultyFromEase(ease: number): number {
  return clampDifficulty(11 - ((ease - 1.3) / 0.2) * 0.9)
}

// stability present but fsrs_state missing -> classify robustly from reps/last_grade
// (never silently default to New, which would reset a mature card's schedule).
function deriveState(prev: SrsState): State {
  if (prev.reps === 0) return State.New
  return (prev.last_grade ?? 3) <= 1 ? State.Relearning : State.Review
}

// Reconstruct a ts-fsrs Card from our SrsState without cold-starting a card that
// already has history (the blocker the review caught).
function cardFromState(prev: SrsState, now: Date): Card {
  if (prev.stability != null && prev.difficulty != null) {
    // A true FSRS card: restore from the persisted memory fields.
    return {
      due: prev.due ? utcNoon(prev.due) : now,
      stability: prev.stability,
      difficulty: prev.difficulty,
      scheduled_days: prev.interval,
      reps: prev.reps,
      lapses: prev.lapses,
      state: prev.fsrs_state ?? deriveState(prev),
      last_review: prev.last_review ? utcNoon(prev.last_review) : undefined,
      elapsed_days: 0,
      learning_steps: 0
    } as Card
  }
  if (prev.reps > 0) {
    // A not-yet-rebuilt SM-2 mature card: approximate a seed from interval/ease
    // instead of cold-starting (at R=0.9 interval ~= stability, so S0 := interval).
    // This is the degrade-gracefully net for "graded under FSRS before rebuild";
    // the ideal is to prevent it via the PR-4 rebuild gate.
    return {
      due: prev.due ? utcNoon(prev.due) : now,
      stability: Math.max(1, prev.interval),
      difficulty: clampDifficulty(seedDifficultyFromEase(prev.ease)),
      scheduled_days: prev.interval,
      reps: prev.reps,
      lapses: prev.lapses,
      state: State.Review,
      last_review: prev.last_review ? utcNoon(prev.last_review) : undefined,
      elapsed_days: 0,
      learning_steps: 0
    } as Card
  }
  // A genuinely new card (reps === 0, no stability).
  return createEmptyCard(now)
}

export function defaultStateFsrs(on: string): SrsState {
  // Same shape as the SM-2 seed; the first reviewFsrs overwrites stability/difficulty.
  return { interval: 0, ease: EASE_START, due: on, reps: 0, lapses: 0, algo: 'fsrs' }
}

/**
 * FSRS step. Pure function of (prev, grade, on) for a given retention. The `seed`
 * argument is accepted to match reviewSm2's signature but unused (enable_fuzz:false),
 * so record()/rebuildState() can call both schedulers through one fold loop.
 */
export function reviewFsrs(prev: SrsState, grade: number, on: string, _seed = 0): SrsState {
  const now = utcNoon(on)
  const card = cardFromState(prev, now)
  const { card: nc } = scheduler().next(card, now, normalizeRating(grade))

  const interval = Math.min(INTERVAL_MAX, Math.max(1, nc.scheduled_days))
  return {
    interval,
    ease: prev.ease ?? EASE_START, // unused placeholder for FSRS cards
    due: addDays(on, interval), // same due-string path as SM-2 (not ts-fsrs nc.due)
    reps: nc.reps,
    lapses: nc.lapses,
    last_review: on,
    last_grade: grade,
    stability: round4(nc.stability), // 4-dp round so live == disk == replay (bit-for-bit)
    difficulty: round4(nc.difficulty),
    fsrs_state: nc.state as 0 | 1 | 2 | 3,
    algo: 'fsrs'
  }
}

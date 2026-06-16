import type { SrsState } from './types'

// SM-2 (Anki classic) adapted to a 4-button self-grade:
//   1 = Again, 2 = Hard, 3 = Good, 4 = Easy
// Implemented as a pure function of (previous state, grade, date) so that the
// whole state map can be rebuilt from reviews.jsonl if the algorithm changes.
// (Swap this file for FSRS later without touching storage or UI.)

export const EASE_START = 2.5
export const EASE_MIN = 1.3

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

export function review(prev: SrsState, grade: number, on: string): SrsState {
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
      const mult = grade === 2 ? 1.2 : grade === 4 ? ease * 1.3 : ease
      interval = Math.max(1, Math.round(interval * mult))
    }
    const delta = grade === 2 ? -0.15 : grade === 4 ? 0.15 : 0
    ease = Math.max(EASE_MIN, round2(ease + delta))
    reps += 1
  }

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

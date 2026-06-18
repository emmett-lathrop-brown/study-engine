import type { SrsState } from './types'

// FSRS scheduler — STUB (wired into the dispatcher, not yet implemented).
//
// This file is the *only* place that will import `ts-fsrs` once PR-3 lands. For
// now it imports nothing external, so the renderer bundle stays FSRS-free even
// though the `reviewWith`/`defaultStateWith` dispatcher in srs.ts references it.
// Both functions throw: the dispatcher only reaches them when algo === 'fsrs',
// which cannot happen until the settings layer (PR-4) can select FSRS, and FSRS
// is gated behind PR-3 anyway. The default SM-2 path (srs-sm2.ts) is untouched.

const NOT_IMPLEMENTED = 'FSRS scheduler not implemented yet (PR-3 feat/fsrs-review)'

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function reviewFsrs(prev: SrsState, grade: number, on: string, seed = 0): SrsState {
  throw new Error(NOT_IMPLEMENTED)
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function defaultStateFsrs(on: string): SrsState {
  throw new Error(NOT_IMPLEMENTED)
}

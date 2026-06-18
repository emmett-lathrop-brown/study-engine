// SRS hub. Keeps the import path `./srs` stable for every existing consumer
// (renderer, session.ts, smoke.ts, index.ts) while the schedulers live in
// algorithm-specific files:
//   - srs-core.ts  : algorithm-independent primitives (shared)
//   - srs-sm2.ts   : the default SM-2 scheduler (load-bearing — `review`)
//   - srs-fsrs.ts  : FSRS scheduler (stub until PR-3; only file touching ts-fsrs)
//
// `review`/`defaultState` re-export the SM-2 implementations unchanged, so the
// public surface of this module (and `index.ts`'s `export * from './srs'`) is
// identical to before the split. `reviewWith`/`defaultStateWith` add a pure
// dispatcher — algo is an explicit argument, never hidden mutable state, so the
// SACRED purity/determinism contract is preserved.
import type { SrsState } from './types'
import { reviewSm2, defaultStateSm2 } from './srs-sm2'
import { reviewFsrs, defaultStateFsrs } from './srs-fsrs'

export {
  EASE_START,
  EASE_MIN,
  INTERVAL_MAX,
  LEECH_LAPSES,
  todayISO,
  nowISO,
  addDays,
  fuzzSeed
} from './srs-core'
export { reviewSm2 as review, defaultStateSm2 as defaultState } from './srs-sm2'

export type Algo = 'sm2' | 'fsrs'

/** Pure dispatcher: (algo, prev, grade, on, seed) -> SrsState. No hidden state. */
export function reviewWith(
  algo: Algo,
  prev: SrsState,
  grade: number,
  on: string,
  seed = 0
): SrsState {
  return algo === 'fsrs' ? reviewFsrs(prev, grade, on, seed) : reviewSm2(prev, grade, on, seed)
}

export function defaultStateWith(algo: Algo, on: string): SrsState {
  return algo === 'fsrs' ? defaultStateFsrs(on) : defaultStateSm2(on)
}

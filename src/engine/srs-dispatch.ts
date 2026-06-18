import type { SrsState } from './types'
import { reviewSm2, defaultStateSm2 } from './srs-sm2'
import { reviewFsrs, defaultStateFsrs } from './srs-fsrs'

// Algorithm dispatcher — node/main only. This module statically imports srs-fsrs
// (and therefore ts-fsrs, which mutates Date.prototype at import time), so it must
// NEVER be reachable from the renderer. The renderer-facing hub `srs.ts` deliberately
// does NOT import this file; only session.ts (record/rebuildState, which run in the
// main process) and the future PR-4 preview IPC import it. Keeping the dispatcher out
// of the hub is what keeps ts-fsrs out of the renderer bundle.
//
// algo is an explicit argument — no hidden mutable state — so reviewWith/
// defaultStateWith stay pure for a given retention (§7.1), preserving the SACRED
// determinism contract.

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

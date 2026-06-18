// SRS hub. Keeps the import path `./srs` stable for every existing consumer
// (renderer, session.ts, smoke.ts, index.ts) while the schedulers live in
// algorithm-specific files:
//   - srs-core.ts  : algorithm-independent primitives (shared)
//   - srs-sm2.ts   : the default SM-2 scheduler (load-bearing — `review`)
//
// This hub is RENDERER-SAFE: it re-exports only SM-2 + core, and deliberately does
// NOT import srs-fsrs.ts (which pulls in ts-fsrs and its import-time Date.prototype
// mutation). The FSRS scheduler and the algo dispatcher (reviewWith/defaultStateWith)
// live in srs-dispatch.ts, imported only by node/main code — so ts-fsrs never reaches
// the renderer bundle. `review`/`defaultState` re-export the SM-2 implementations
// unchanged, so this module's public surface is identical to before the split.
export {
  EASE_START,
  EASE_MIN,
  INTERVAL_MAX,
  LEECH_LAPSES,
  todayISO,
  nowISO,
  addDays,
  fuzzSeed,
  mulberry32,
  fisherYates
} from './srs-core'
export { reviewSm2 as review, defaultStateSm2 as defaultState } from './srs-sm2'

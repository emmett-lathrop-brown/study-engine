// Cram / Learn round-mode core — a SESSION-LOCAL "master the whole set" loop, kept
// deliberately separate from the SM-2 scheduler. These are pure functions: no I/O,
// no Date.now(), no globals; the PRNG is injected so rounds are reproducible under a
// fixed seed (smoke). The mode is fully ephemeral — it NEVER touches reviews.jsonl or
// state.json, so the SM-2 round-trip invariants stay structurally intact.
//
// This file lives engine-side (like write.ts) so smoke can import it, but it must NOT
// import ./api or ./learn and must NOT reach any history-write helper — enforced by a
// static grep guard in smoke.ts (Area 12 #8-static). The only runtime dependency is
// the shared shuffle from the SM-2-free srs hub.
//
// Model (quenti/Quizlet "Learn"): a card climbs unstudied -> familiar -> mastered.
// Recognition (MCQ) earns Familiar; free-recall (TYPED) — or, for choice-only cards,
// a streak of correct MCQs — earns Mastered. Mastered cards leave the rotation. Misses
// drop a card to the front of the queue and re-ask it within the same round.
import { fisherYates } from './srs'

// -1 missed (re-ask first) / 0 unstudied / 1 familiar (passed recognition) / 2 mastered.
export type CramCorrectness = 0 | -1 | 1 | 2
export type CramQType = 'mcq' | 'typed'

// The minimal card shape the core needs — a slice of PickedQuestion the renderer fills
// in. `mcq` is the multiple-choice leg (null when a free card couldn't be turned into
// 4 choices, in which case the card is TYPED-only). `canEscalate` says the card has a
// free-recall (TYPED) form — true for cloze/translation/free origins, false for native
// single_choice/multi (recognition only). It can't be derived from `mcq` alone: a
// native-choice card and a converted free card both have `mcq` set but differ here, so
// the renderer (which knows the source question type) must supply it.
export interface CardLike {
  id: string
  q: string
  answer: string
  choices?: string[]
  mcq?: { choices: string[]; answer: string } | null
  canEscalate: boolean
}

export interface CramCard {
  card: CardLike
  correctness: CramCorrectness
  appearedInRound: number | null // the round this card was introduced (when it was new)
  incorrectCount: number // total misses this session (drives the "redrill missed" set)
  streak: number // consecutive correct (graduates choice-only / non-escalating cards)
  canEscalate: boolean // mirrors card.canEscalate; true => a TYPED stage exists
}

export interface CramRoundItem {
  card: CramCard
  type: CramQType
}

export interface CramOpts {
  graduate: number // correct stages required to master
  reaskGap: number // rounds a Familiar card rests before it can be re-asked
  roundSize: number // cards shown per round
  escalate: boolean // promote Familiar+ escalable cards to the TYPED form
}

export const CRAM_DEFAULTS: CramOpts = { roundSize: 7, graduate: 2, reaskGap: 2, escalate: true }

/** Seed a deck: every card starts unstudied, never-seen, streak 0. */
export function initCram(cards: CardLike[]): CramCard[] {
  return cards.map((card) => ({
    card,
    correctness: 0,
    appearedInRound: null,
    incorrectCount: 0,
    streak: 0,
    canEscalate: card.canEscalate
  }))
}

/**
 * Which question form to ask a card in this round. A card with no MCQ leg is always
 * TYPED. Otherwise an escalable card that has already passed recognition (Familiar+)
 * is promoted to TYPED when `escalate` is on; everything else stays MCQ. Choice-only
 * cards (canEscalate=false) therefore always stay MCQ and graduate by streak.
 */
function roundType(c: CramCard, opts: CramOpts): CramQType {
  if (c.card.mcq == null) return 'typed'
  if (opts.escalate && c.canEscalate && c.correctness >= 1) return 'typed'
  return 'mcq'
}

/**
 * Assemble one round's timeline. Priority (quenti's pool order): missed cards first,
 * then Familiar cards that have rested `reaskGap` rounds, then unstudied, then any
 * remaining Familiar as filler. Duplicates collapse first-wins, mastered cards never
 * enter, and the slice is capped at `roundSize`. Newly-introduced cards are stamped
 * with the current round so the rest window can be measured. The timeline is shuffled
 * with the injected rng (deterministic per seed).
 */
export function buildRound(
  cards: CramCard[],
  round: number,
  rng: () => number,
  opts: CramOpts
): CramRoundItem[] {
  const rested = (c: CramCard): boolean =>
    c.correctness === 1 && c.appearedInRound !== null && round - c.appearedInRound >= opts.reaskGap
  const pool: CramCard[] = [
    ...cards.filter((c) => c.correctness === -1),
    ...cards.filter(rested),
    ...cards.filter((c) => c.correctness === 0),
    ...cards.filter((c) => c.correctness === 1)
  ]
  const seen = new Set<string>()
  const selected: CramCard[] = []
  for (const c of pool) {
    if (c.correctness === 2 || seen.has(c.card.id)) continue // mastered never re-enters
    seen.add(c.card.id)
    selected.push(c)
    if (selected.length >= opts.roundSize) break
  }
  for (const c of selected) {
    if (c.correctness === 0) c.appearedInRound = round
  }
  const timeline: CramRoundItem[] = selected.map((c) => ({ card: c, type: roundType(c, opts) }))
  fisherYates(timeline, rng)
  return timeline
}

/**
 * Apply one answer. Mutates the card in place (the same object lives in `cards` and the
 * timeline). A miss drops the card to Missed and re-queues it at the END of the current
 * round — except when it was the round's last slot, which would loop forever. A correct
 * MCQ earns Familiar (and masters a choice-only / non-escalating card once its streak
 * reaches `graduate`); a correct TYPED masters outright. Returns the (possibly grown)
 * timeline and whether the whole deck is now mastered.
 */
export function answerCram(
  cards: CramCard[],
  timeline: CramRoundItem[],
  pos: number,
  item: CramRoundItem,
  correct: boolean,
  opts: CramOpts
): { timeline: CramRoundItem[]; done: boolean } {
  const c = item.card
  if (!correct) {
    c.correctness = -1
    c.incorrectCount += 1
    c.streak = 0
    if (pos !== timeline.length - 1) timeline.push({ card: c, type: item.type })
  } else {
    c.streak += 1
    if (item.type === 'mcq') {
      c.correctness = Math.max(c.correctness, 1) as CramCorrectness
      if ((!opts.escalate || !c.canEscalate) && c.streak >= opts.graduate) c.correctness = 2
    } else {
      c.correctness = 2
    }
  }
  return { timeline, done: cramProgress(cards).done }
}

/** Mastery progress for the header bar. `done` is true once every card is mastered. */
export function cramProgress(cards: CramCard[]): { mastered: number; total: number; done: boolean } {
  const total = cards.length
  const mastered = cards.filter((c) => c.correctness === 2).length
  return { mastered, total, done: total > 0 && mastered === total }
}

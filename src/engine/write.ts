// Local fuzzy scoring for typed "write" answers (translation questions): the
// learner types their translation, and we SUGGEST a self-grade by comparing it to
// the model answer — no cloud call. The user always makes the final call (this is
// only a suggested-grade highlight, exactly like single_choice's auto-suggest).
//
// Pure functions: a renderer can import them directly (no Node APIs). Works for
// both English (token + char) and Japanese (char-level edit distance carries it,
// since CJK has no spaces to tokenise).

export interface WriteScore {
  similarity: number // 0..1 fuzzy match (max of char- and token-level similarity)
  percent: number // round(similarity * 100), for display
  grade: number // suggested self-grade: 3 Good / 2 Hard / 1 Again (never auto-Easy)
}

// Char-budget for the O(n*m) edit distance — translation answers are short; this
// only guards against someone pasting a wall of text into the input box.
const MAX_CHARS = 400

/** Fold case + width + punctuation so "Hello, World!" and "hello world" match. */
function normalize(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ') // punctuation/space runs -> single space
    .trim()
}

/** Levenshtein edit distance over code-point arrays (two-row DP). */
function levenshtein(a: readonly string[], b: readonly string[]): number {
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  let cur = new Array<number>(b.length + 1)
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, cur] = [cur, prev]
  }
  return prev[b.length]
}

/**
 * Char-level similarity in [0,1] from normalized edit distance. Operates over
 * code points ([...s]) so an astral character (emoji, CJK Ext-B kanji) counts as
 * one edit unit — not two surrogate halves, which would half-credit a wrong char.
 */
function charSim(a: string, b: string): number {
  if (!a || !b) return 0
  const x = [...a].slice(0, MAX_CHARS)
  const y = [...b].slice(0, MAX_CHARS)
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length)
}

/**
 * Token multiset Dice coefficient in [0,1] — robust to word reordering, but a
 * token only matches as many times as it occurs on both sides (a multiset, not a
 * set), so one repeated keyword can't fully match a multi-word answer.
 */
function tokenSim(a: string, b: string): number {
  const A = a.split(' ').filter(Boolean)
  const B = b.split(' ').filter(Boolean)
  if (A.length === 0 || B.length === 0) return 0
  const countA = new Map<string, number>()
  for (const t of A) countA.set(t, (countA.get(t) ?? 0) + 1)
  let inter = 0
  for (const t of B) {
    const c = countA.get(t) ?? 0
    if (c > 0) {
      inter++
      countA.set(t, c - 1)
    }
  }
  return (2 * inter) / (A.length + B.length)
}

/**
 * Score a typed answer against the model answer and suggest a self-grade.
 * similarity = max(char-level, token-level) so either a typo-tolerant char match
 * OR a reordered-words token match can vouch for the answer (lenient on purpose —
 * the learner confirms the final grade). Thresholds are tunable.
 */
export function scoreWrite(input: string, answer: string): WriteScore {
  const a = normalize(input)
  const b = normalize(answer)
  // Nothing comparable on either side (empty input, or an answer with no letters/
  // digits) is not a match — don't let two empty normalizations read as 100%.
  if (!a || !b) return { similarity: 0, percent: 0, grade: 1 }
  const similarity = Math.max(charSim(a, b), tokenSim(a, b))
  const grade = similarity >= 0.9 ? 3 : similarity >= 0.6 ? 2 : 1
  return { similarity, percent: Math.round(similarity * 100), grade }
}

// Headless smoke test for the engine. Run with: pnpm smoke
// Creates a throwaway study-log, exercises pick -> record -> summary, asserts.
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  review,
  defaultState,
  todayISO,
  addDays,
  fuzzSeed,
  mulberry32,
  EASE_MIN,
  INTERVAL_MAX,
  LEECH_LAPSES
} from './srs'
import { reviewFsrs, defaultStateFsrs } from './srs-fsrs'
import { reviewSm2 } from './srs-sm2'
import { writeState, readState, readChat, writeChat, listReviewDomains, readReviews } from './store'
import { pick, record, summary, domainInfo, studyStats, rebuildState, diffState } from './session'
import { exportMarkdown } from './export'
import { scoreWrite } from './write'
import {
  initCram,
  buildRound,
  answerCram,
  cramProgress,
  CRAM_DEFAULTS,
  type CardLike,
  type CramCard,
  type CramRoundItem
} from './cram'

let failures = 0
function ok(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok  - ${msg}`)
  else {
    failures++
    console.error(`  FAIL- ${msg}`)
  }
}

async function main(): Promise<void> {
  const today = todayISO()

  // --- SM-2 unit checks -------------------------------------------------
  let s = defaultState(today)
  s = review(s, 3, today) // Good, first time -> 1 day
  ok(s.interval === 1 && s.reps === 1, `Good#1 -> interval 1 (got ${s.interval})`)
  s = review(s, 3, today) // Good, second -> 6 days
  ok(s.interval === 6 && s.reps === 2, `Good#2 -> interval 6 (got ${s.interval})`)
  const before = s.interval
  s = review(s, 4, today) // Easy -> grows by ease*1.3, ease up
  ok(s.interval > before && s.ease > 2.5, `Easy grows interval & ease (got ${s.interval}, ease ${s.ease})`)
  const sLapse = review(s, 1, today) // Again -> reset
  ok(sLapse.reps === 0 && sLapse.lapses === 1 && sLapse.interval === 1, 'Again resets reps & lapses++')
  ok(sLapse.ease >= EASE_MIN, `ease never below floor ${EASE_MIN}`)
  ok(review(s, 3, today).due === addDays(today, review(s, 3, today).interval), 'due = today + interval')

  // --- Robustification: ease-hell fix, fuzz, cap ------------------------
  const matured = { interval: 10, ease: 2.5, due: today, reps: 3, lapses: 0 }
  ok(review(matured, 2, today).ease === 2.5, 'Hard no longer lowers ease (ease-hell fix)')
  ok(review(matured, 4, today).ease === 2.65, 'Easy still raises ease (+0.15)')
  let floored = defaultState(today)
  for (let i = 0; i < 12; i++) floored = review(floored, 1, today) // many Agains
  ok(floored.ease === EASE_MIN, `repeated Again bottoms ease at EASE_MIN ${EASE_MIN} (got ${floored.ease})`)

  const big = { interval: 100, ease: 2.5, due: today, reps: 5, lapses: 0 }
  const base = Math.round(100 * 2.5) // 250, before fuzz/cap
  ok(review(big, 3, today).interval === base, `no seed -> exact interval, no fuzz (got ${review(big, 3, today).interval})`)
  const seed = fuzzSeed('demo-set-a-0001', today)
  const f1 = review(big, 3, today, seed)
  const f2 = review(big, 3, today, seed)
  ok(f1.interval === f2.interval, `fuzz is deterministic per (id,day) seed (${f1.interval} === ${f2.interval})`)
  ok(Math.abs(f1.interval - base) <= Math.max(1, Math.round(base * 0.05)), `fuzz stays within +/-5% band (base ${base}, got ${f1.interval})`)
  const runaway = { interval: 300, ease: 2.5, due: today, reps: 5, lapses: 0 }
  ok(review(runaway, 3, today).interval === INTERVAL_MAX, `interval capped at ${INTERVAL_MAX} (got ${review(runaway, 3, today).interval})`)
  ok(fuzzSeed('a', today) === fuzzSeed('a', today) && fuzzSeed('a', today) !== fuzzSeed('b', today), 'fuzzSeed is stable per id and varies across ids')

  // Graduating steps must NOT fuzz, even with a seed (only multiplied reps>=2 intervals do).
  const grad = { interval: 6, ease: 2.5, due: today, reps: 1, lapses: 0 }
  ok(review(grad, 4, today, fuzzSeed('x', today)).interval === 8, 'graduating step (reps1 Easy=8) stays exact under fuzz')
  // Repeated Hard grows the interval and never shrinks it (ease-hell fix locked in).
  let hs = { interval: 6, ease: 2.5, due: today, reps: 3, lapses: 0 }
  let grew = true
  for (let i = 0; i < 6; i++) {
    const n = review(hs, 2, today)
    grew = grew && n.interval >= hs.interval
    hs = n
  }
  ok(grew && hs.interval > 6, `repeated Hard grows, never shrinks (6 -> ${hs.interval})`)
  // A legacy card with ease below the new floor is rescued up to EASE_MIN on success.
  ok(review({ interval: 10, ease: 1.4, due: today, reps: 3, lapses: 0 }, 3, today).ease === EASE_MIN, `legacy ease < ${EASE_MIN} rescued to floor on Good`)

  // --- write-mode fuzzy scoring (translation type-in) -------------------
  const ans = 'I have been studying English for three years.'
  ok(scoreWrite(ans, ans).grade === 3 && scoreWrite(ans, ans).similarity === 1, 'exact answer -> similarity 1, suggest Good')
  ok(scoreWrite('Hello, WORLD!', 'hello world').grade === 3, 'case + punctuation differences are ignored (normalize)')
  ok(scoreWrite('sat the cat', 'the cat sat').grade === 3, 'reordered words still score Good (token Dice rescues word order)')
  ok(scoreWrite('I have studied English for three years', ans).grade >= 2, 'a near-miss (one word off) scores Good/Hard, not Again')
  ok(scoreWrite('English is hard', ans).grade === 1, 'an unrelated answer scores Again')
  ok(scoreWrite('', ans).grade === 1, 'empty input scores Again (nothing to credit)')
  // Japanese: char-level edit distance carries it where there are no spaces to tokenise.
  ok(scoreWrite('私は猫が好きです', '私は猫が好きです').grade === 3, 'exact Japanese answer -> Good (char-level)')
  ok(scoreWrite('私は犬が好きです', '私は猫が好きです').grade === 2, 'one-character-off Japanese -> Hard, not Good/Again')
  ok(scoreWrite('全然違う文章だよ', '私は猫が好きです').grade === 1, 'unrelated Japanese -> Again')
  // Edge cases hardened in adversarial review:
  ok(scoreWrite('!!!', '???').grade === 1, 'punctuation-only input vs punctuation-only answer is NOT a 100% match')
  ok(scoreWrite('a a a a', 'a').grade === 1, 'one repeated keyword does not fully match a shorter answer (token multiset, not set)')
  const astralA = String.fromCodePoint(0x20000, 0x20001) // 𠀀𠀁 (CJK Ext-B, surrogate pairs)
  const astralB = String.fromCodePoint(0x20000, 0x20002) // 𠀀𠀂 — one of two code points differs
  ok(scoreWrite(astralA, astralB).grade === 1, 'astral CJK compared per code-point (1 of 2 differ -> Again, no surrogate half-credit)')

  // --- Full session round-trip -----------------------------------------
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'study-smoke-'))
  const setDir = path.join(root, 'subjects', 'demo', 'set') // domains live under subjects/
  const qdir = path.join(setDir, 'questions')
  await fs.mkdir(qdir, { recursive: true })
  await fs.mkdir(path.join(setDir, 'logs'), { recursive: true })

  const mk = (id: string, topic: string, ans: string): string =>
    JSON.stringify(
      {
        id,
        domain: 'demo/set',
        topic,
        type: 'single_choice',
        grade_scale: 4,
        source: [`https://example.com/${topic}`],
        created: today,
        q: `Q for ${id}?`,
        choices: ['A. one', 'B. two'],
        answer: ans,
        explanation: 'because.',
        hint: null,
        speak: null
      },
      null,
      2
    )

  await fs.writeFile(path.join(qdir, 'demo-set-a-0001.json'), mk('demo-set-a-0001', 'a', 'A'))
  await fs.writeFile(path.join(qdir, 'demo-set-a-0002.json'), mk('demo-set-a-0002', 'a', 'B'))
  await fs.writeFile(path.join(qdir, 'demo-set-b-0001.json'), mk('demo-set-b-0001', 'b', 'A'))

  // init state: all due today
  const state = await readState(root)
  for (const id of ['demo-set-a-0001', 'demo-set-a-0002', 'demo-set-b-0001']) {
    state[id] = { ...defaultState(today), due: today }
  }
  await writeState(root, state)

  const info = await domainInfo(root)
  ok(info.length === 1 && info[0].domain === 'demo/set' && info[0].total === 3, 'domainInfo finds demo/set with 3 questions')
  ok(info[0].new === 3 && info[0].due === 0, 'all 3 are "new" before any review')

  const picked = await pick(root, 'demo/set', { limit: 2, maxNew: 5, shuffle: false })
  ok(picked.length === 2, `pick respects limit (got ${picked.length})`)
  ok(picked.every((p) => p.isNew), 'fresh system -> all picked are new')

  const sess = `${today}-smoke`
  await record(root, 'demo/set', sess, [
    { id: 'demo-set-a-0001', grade: 4 },
    { id: 'demo-set-a-0002', grade: 1 }
  ])
  const after = await readState(root)
  ok(after['demo-set-a-0001'].reps === 1 && after['demo-set-a-0001'].due > today, 'recorded Easy advances due')
  ok(after['demo-set-a-0002'].lapses === 1, 'recorded Again increments lapses')

  const sum = await summary(root, 'demo/set', sess)
  ok(sum.total === 2 && sum.correct === 1 && sum.accuracy === 50, `summary: 2 answered, 1 correct, 50% (got ${sum.accuracy}%)`)
  ok(sum.weakTopics.includes('a'), 'weak topic surfaced (a)')
  ok(sum.items.length === 2, `summary.items has one entry per question (got ${sum.items.length})`)
  const easyItem = sum.items.find((i) => i.id === 'demo-set-a-0001')
  ok(
    !!easyItem && easyItem.grade === 4 && easyItem.correct && easyItem.q === 'Q for demo-set-a-0001?',
    'item carries grade + correct + question text'
  )
  const againItem = sum.items.find((i) => i.id === 'demo-set-a-0002')
  ok(!!againItem && againItem.grade === 1 && !againItem.correct, 'Again item marked incorrect')

  // --- re-drill: pick by an explicit id set -----------------------------
  // a-0001 was graded Easy so it's no longer due today; the re-drill path must
  // still return it (bypassing due/new selection), in the listed order, with its
  // real recorded state — and skip unknown ids + collapse duplicates.
  const redrill = await pick(root, 'demo/set', {
    ids: ['demo-set-a-0002', 'demo-set-a-0001', 'no-such-id', 'demo-set-a-0002']
  })
  ok(
    redrill.map((p) => p.id).join(',') === 'demo-set-a-0002,demo-set-a-0001',
    `pick(ids) returns exactly the listed ids in order, skipping unknown + duplicate (got ${redrill.map((p) => p.id).join(',')})`
  )
  const a1 = redrill.find((p) => p.id === 'demo-set-a-0001')
  ok(
    !!a1 && a1.state.due > today && a1.state.reps === 1,
    'pick(ids) re-drills a card that is no longer due, carrying its real recorded state'
  )
  // a-0002 was graded Again so its reps reset to 0; in the re-drill it must still
  // read as a review (isNew=false), not NEW — every re-drilled id was just seen.
  ok(redrill.every((p) => p.isNew === false), 'pick(ids) marks every re-drilled card as not-new (just-Again reps=0 card included)')
  ok((await pick(root, 'demo/set', { ids: [] })).length === 0, 'pick(ids:[]) yields an empty session')

  const stats = await studyStats(root)
  ok(stats.reviewsToday === 2 && stats.totalReviews === 2, `studyStats counts today's reviews (got ${stats.reviewsToday}/${stats.totalReviews})`)
  ok(stats.streak === 1 && stats.reviewedDays === 1, `studyStats streak/days (got ${stats.streak}/${stats.reviewedDays})`)
  ok(
    stats.dailyCounts.length === 1 && stats.dailyCounts[0].day === today && stats.dailyCounts[0].count === 2,
    `studyStats.dailyCounts records today's 2 reviews for the heatmap (got ${JSON.stringify(stats.dailyCounts)})`
  )
  const dm = stats.maturity.find((m) => m.domain === 'demo/set')
  ok(!!dm && dm.total === 3 && dm.unseen === 1 && dm.learning === 2, `maturity split (got ${dm?.unseen} unseen / ${dm?.learning} learning)`)

  const exported = await exportMarkdown(root)
  const ex = exported.find((e) => e.domain === 'demo/set')
  ok(!!ex && ex.count === 3, `exportMarkdown writes one md per question (got ${ex?.count})`)
  const md = await fs.readFile(path.join(setDir, 'export', 'demo-set-a-0001.md'), 'utf8')
  ok(md.startsWith('---') && md.includes('## 解答') && md.includes('tags: ['), 'exported md has frontmatter + answer section')

  // --- Leech soft-flag --------------------------------------------------
  const st2 = await readState(root)
  st2['demo-set-b-0001'] = { interval: 5, ease: EASE_MIN, due: today, reps: 3, lapses: LEECH_LAPSES, last_review: today }
  await writeState(root, st2)
  const lstats = await studyStats(root)
  const ldm = lstats.maturity.find((m) => m.domain === 'demo/set')
  ok(!!ldm && ldm.leeches === 1, `leech flagged at ${LEECH_LAPSES} lapses (got ${ldm?.leeches})`)
  const leechSess = `${today}-leech`
  await record(root, 'demo/set', leechSess, [{ id: 'demo-set-b-0001', grade: 3 }])
  const lsum = await summary(root, 'demo/set', leechSess)
  ok(lsum.items[0]?.leech === true, 'summary item carries leech flag for chronically-missed card')

  // --- per-question chat persistence + md export ------------------------
  await writeChat(root, 'demo/set', 'demo-set-a-0001', [
    { role: 'user', text: 'なぜ A が正解？', ts: `${today}T10:00:00+09:00` },
    { role: 'assistant', text: '**A** が正解です。理由は…', ts: `${today}T10:00:03+09:00` }
  ])
  const chat = await readChat(root, 'demo/set', 'demo-set-a-0001')
  ok(
    !!chat && chat.messages.length === 2 && chat.messages[0].role === 'user',
    `chat round-trips to chats/<id>.json (got ${chat?.messages.length})`
  )
  ok((await readChat(root, 'demo/set', 'no-such-id')) === null, 'missing chat -> null')
  await exportMarkdown(root) // re-export now that a chat exists
  const chatMd = await fs.readFile(path.join(setDir, 'export', 'demo-set-a-0001.md'), 'utf8')
  ok(
    chatMd.includes('## Claude チャット') && chatMd.includes('なぜ A が正解？'),
    'exported md embeds the chat transcript'
  )
  // Clearing (writing an empty thread) removes the file and drops the md section.
  await writeChat(root, 'demo/set', 'demo-set-a-0001', [])
  ok((await readChat(root, 'demo/set', 'demo-set-a-0001')) === null, 'cleared chat removes the file')
  await exportMarkdown(root)
  const clearedMd = await fs.readFile(path.join(setDir, 'export', 'demo-set-a-0001.md'), 'utf8')
  ok(!clearedMd.includes('## Claude チャット'), 'no chat -> no chat section in exported md')

  // --- rebuild-state replay: state is a pure function of (live) history -------
  // Drive a synthetic card through a multi-review LIVE history (no `on` override,
  // so each review's stored ts date == the fuzz seed-day record() used), through
  // graduating steps + a lapse + a Hard, then assert rebuildState() replays
  // reviews.jsonl back to the recorded state bit-for-bit. (This chain ends on a
  // graduating step; the dedicated fuzz card below guards seed reproduction.)
  const rsess = `${today}-replay`
  await record(root, 'demo/set', rsess, [{ id: 'replay-card-1', grade: 3 }]) // reps0 Good -> 1
  await record(root, 'demo/set', rsess, [{ id: 'replay-card-1', grade: 3 }]) // reps1 Good -> 6
  await record(root, 'demo/set', rsess, [{ id: 'replay-card-1', grade: 3 }]) // reps2 Good -> mult, fuzzed mid-chain
  await record(root, 'demo/set', rsess, [{ id: 'replay-card-1', grade: 1 }]) // Again -> lapse, ease-0.2
  await record(root, 'demo/set', rsess, [{ id: 'replay-card-1', grade: 2 }]) // Hard (reps reset) -> 1
  const live = await readState(root)
  const rebuilt = await rebuildState(root)
  const eq = (id: string): boolean => JSON.stringify(rebuilt[id]) === JSON.stringify(live[id])
  ok(eq('replay-card-1'), 'rebuildState replays a multi-review live history (graduating + lapse + Hard)')
  ok(rebuilt['replay-card-1'].reps === 1 && rebuilt['replay-card-1'].lapses === 1, 'replayed card carries reps/lapses from the full chain')
  ok(eq('demo-set-a-0001') && eq('demo-set-a-0002'), 'rebuildState reproduces every live-recorded card from history')
  // Contract boundary: b-0001's live state was hand-injected (leech setup), not
  // built from its one Good review, so replay must NOT reproduce it.
  ok(!eq('demo-set-b-0001'), 'rebuildState does NOT reproduce a hand-injected (non-history) state — documents the contract')

  // Every id here has a review row, so nothing is added/removed; b-0001 is the
  // lone `changed` entry (injected, not history-built); the other 3 round-trip.
  const diff = diffState(live, rebuilt)
  ok(
    diff.added.length === 0 && diff.removed.length === 0 && diff.unchanged === 3 &&
      diff.changed.length === 1 && diff.changed[0].id === 'demo-set-b-0001',
    `diffState isolates the one non-history id (changed ${diff.changed.length}, unchanged ${diff.unchanged})`
  )
  const self = diffState(live, live)
  ok(self.changed.length === 0 && self.added.length === 0 && self.unchanged > 0, 'diffState: identical maps report no changes')

  // PR-2 (optional FSRS state fields): sameState/diffState must account for the
  // new fields. `algo` undefined normalizes to 'sm2', so a plain SM-2 card is
  // equal to an explicit-sm2 card (no false "changed" during an algo=sm2 rebuild);
  // a populated FSRS field is a genuine change.
  const pr2Base = { interval: 10, ease: 2.5, due: today, reps: 3, lapses: 0, last_review: today, last_grade: 3 }
  const pr2Implicit = { x: { ...pr2Base } }
  const pr2Explicit = { x: { ...pr2Base, algo: 'sm2' as const } }
  const pr2Same = diffState(pr2Implicit, pr2Explicit)
  ok(pr2Same.unchanged === 1 && pr2Same.changed.length === 0,
    'diffState: algo undefined == "sm2" (a plain SM-2 card is not flagged as changed)')
  const pr2Fsrs = { x: { ...pr2Base, stability: 4.93, difficulty: 5.1, fsrs_state: 2 as const, algo: 'fsrs' as const } }
  const pr2Diff = diffState(pr2Implicit, pr2Fsrs)
  ok(pr2Diff.changed.length === 1 && pr2Diff.unchanged === 0,
    'diffState: a card with populated FSRS fields differs from a plain SM-2 card')
  // algo on its own is load-bearing in the diff (surfaces a half-migrated map).
  const pr2AlgoOnly = { x: { ...pr2Base, algo: 'fsrs' as const } }
  const pr2AlgoDiff = diffState(pr2Explicit, pr2AlgoOnly)
  ok(pr2AlgoDiff.changed.length === 1 && pr2AlgoDiff.unchanged === 0,
    'diffState: a card differing only by algo (sm2 vs fsrs) registers as changed')

  // Fuzz must survive the round-trip. Pick an id whose multiplied interval is
  // actually jittered TODAY (~2/3 of seeds move it), drive it live to exactly
  // that interval as its FINAL state, then assert the rebuilt interval equals
  // the recorded one AND differs from the bare multiple — so a rebuildState that
  // forgot to pass the seed (fuzz disabled) would fail here, not pass silently.
  const fprev = { interval: 6, ease: 2.5, due: today, reps: 2, lapses: 0 } // state just before the 3rd Good
  const exactMul = Math.round(6 * 2.5) // 15 — the UNFUZZED multiplied interval
  let fid = ''
  for (let i = 0; i < 256 && !fid; i++) {
    const cand = `replay-fuzz-${i}`
    if (review(fprev, 3, today, fuzzSeed(cand, today)).interval !== exactMul) fid = cand
  }
  ok(fid !== '', 'found an id whose multiplied interval is fuzzed today (for the fuzz round-trip guard)')
  const fsess = `${today}-replayfuzz`
  await record(root, 'demo/set', fsess, [{ id: fid, grade: 3 }]) // reps0 -> 1
  await record(root, 'demo/set', fsess, [{ id: fid, grade: 3 }]) // reps1 -> 6
  await record(root, 'demo/set', fsess, [{ id: fid, grade: 3 }]) // reps2 -> fuzz(15): final state carries the fuzz
  const live2 = await readState(root)
  const rebuilt2 = await rebuildState(root)
  ok(live2[fid].interval !== exactMul, `record() actually fuzzed the final interval (got ${live2[fid].interval}, bare ${exactMul})`)
  ok(rebuilt2[fid].interval === live2[fid].interval, 'rebuildState reproduces the fuzzed multiplied interval bit-for-bit')
  ok(rebuilt2[fid].interval !== exactMul, 'rebuilt interval is the fuzzed value, not the bare multiple (would fail if the seed were dropped)')

  // ===== FSRS block (dedicated froot; SM-2 state never shared) ==========
  // A1/A2/B/D are pure unit checks (no disk). C is the only disk round-trip and
  // uses its own froot. NOTE: like the SM-2 replay above, record()'s single-clock
  // contract makes disk history always same-day, so block C exercises only the
  // degenerate (elapsed-0) trajectory; day-gapped stability growth is covered by
  // the pure unit checks in A2. The `on` override is non-replayable under FSRS too,
  // so it is never used here.
  const EXPECTED_FIRST_GOOD = 3 // measured: FSRS-6 default-w first Good (stability w[2]≈2.3065 -> 3d)
  const EXPECTED_LAPSES_AFTER_3 = 3 // measured: 1 Good then 3 day-gapped Agains

  // A1. FSRS single step (pure, same-day)
  const fs0 = defaultStateFsrs(today)
  const fg1 = reviewFsrs(fs0, 3, today)
  ok(fg1.stability != null && fg1.difficulty != null, 'FSRS: first Good seeds stability/difficulty')
  ok(fg1.interval >= 1, 'FSRS: first interval >= 1 day (short-term off)')
  ok(fg1.interval === EXPECTED_FIRST_GOOD, `FSRS: first-Good interval pinned (got ${fg1.interval})`)
  ok(fg1.due === addDays(today, fg1.interval), 'FSRS: due === addDays(on, interval)')
  ok(fg1.algo === 'fsrs', 'FSRS: algo provenance recorded')
  const fAgain = reviewFsrs(fg1, 1, today)
  ok(fAgain.lapses === fg1.lapses + 1, 'FSRS: Again increments lapses')
  ok((fAgain.stability ?? 0) <= (fg1.stability ?? 0), 'FSRS: lapse never raises stability')
  ok(reviewFsrs(fg1, 4, today).interval >= reviewFsrs(fg1, 3, today).interval, 'FSRS: Easy >= Good interval')
  ok(
    reviewFsrs(fs0, 0, today).interval === reviewFsrs(fs0, 1, today).interval &&
      reviewFsrs(fs0, 0, today).lapses === reviewFsrs(fs0, 1, today).lapses,
    'FSRS: grade 0 == Again (clamped, no throw)'
  )
  ok(reviewFsrs(fs0, 5, today).interval === reviewFsrs(fs0, 4, today).interval, 'FSRS: grade 5 == Easy (clamped)')

  // A2. day-gapped stability evolution (pure; prev.last_review in the past so the
  // elapsed-days path runs — impossible to build on disk under the single clock)
  const fday1 = '2026-01-01'
  const fday2 = '2026-01-15' // 14-day gap
  const fa = reviewFsrs(defaultStateFsrs(fday1), 3, fday1)
  const fb = reviewFsrs(fa, 3, fday2)
  ok((fb.stability ?? 0) > (fa.stability ?? 0), 'FSRS: day-gapped Good grows stability (elapsed-days exercised)')
  ok(fb.interval > fa.interval, 'FSRS: day-gapped interval grows')
  ok(reviewFsrs(fa, 3, fday2).stability === fb.stability, 'FSRS: day-gapped deterministic')
  let fst = reviewFsrs(defaultStateFsrs(fday1), 3, fday1)
  for (let i = 0; i < 3; i++) fst = reviewFsrs(fst, 1, addDays(fday1, (i + 1) * 5))
  ok(fst.lapses === EXPECTED_LAPSES_AFTER_3, `FSRS: lapse count pinned for Again chain (got ${fst.lapses})`)

  // B. determinism (enable_fuzz:false) + interval cap
  ok(reviewFsrs(fs0, 3, today).interval === reviewFsrs(fs0, 3, today).interval, 'FSRS: deterministic (no fuzz)')
  ok(reviewFsrs(fs0, 3, today).stability === reviewFsrs(fs0, 3, today).stability, 'FSRS: stability reproducible')
  const fBig = {
    interval: 0, ease: 2.5, due: today, reps: 9, lapses: 0,
    stability: 10000, difficulty: 5, fsrs_state: 2 as const, last_review: '2020-01-01'
  }
  ok(reviewFsrs(fBig, 3, today).interval <= 365, 'FSRS: interval capped at maximum_interval')

  // C. disk round-trip (same-day degenerate trajectory; see NOTE above)
  const froot = await fs.mkdtemp(path.join(os.tmpdir(), 'study-smoke-fsrs-'))
  const fsrsSess = `${today}-fsrs`
  await record(froot, 'demo/set', fsrsSess, [{ id: 'fsrs-card-1', grade: 3 }], undefined, 'fsrs')
  await record(froot, 'demo/set', fsrsSess, [{ id: 'fsrs-card-1', grade: 3 }], undefined, 'fsrs')
  await record(froot, 'demo/set', fsrsSess, [{ id: 'fsrs-card-1', grade: 1 }], undefined, 'fsrs') // lapse
  await record(froot, 'demo/set', fsrsSess, [{ id: 'fsrs-card-1', grade: 2 }], undefined, 'fsrs') // Hard
  const liveF = await readState(froot)
  const rebuiltF = await rebuildState(froot, 'fsrs')
  ok(
    JSON.stringify(rebuiltF['fsrs-card-1']) === JSON.stringify(liveF['fsrs-card-1']),
    'FSRS: rebuildState replays a live (same-day) FSRS history bit-for-bit incl. stability/difficulty'
  )
  ok(rebuiltF['fsrs-card-1'].lapses === liveF['fsrs-card-1'].lapses, 'FSRS: replayed lapses match')
  ok(rebuiltF['fsrs-card-1'].algo === 'fsrs', 'FSRS: replayed card tagged fsrs')
  const dF = diffState(liveF, rebuiltF)
  ok(
    dF.changed.length === 0 && dF.added.length === 0 && dF.removed.length === 0,
    'FSRS: live FSRS cards round-trip on dedicated root (changed === 0)'
  )

  // D. SM-2 regression lock (algo is not global state, so nothing to restore)
  ok(review(defaultState(today), 3, today).interval === 1, 'SM-2 path intact (reps0 Good -> 1)')
  ok(reviewSm2(defaultState(today), 3, today).interval === 1, 'SM-2 direct still 1')
  await fs.rm(froot, { recursive: true, force: true })

  // ===== Area 12: Cram/Learn round mode (engine-side pure core) =========
  // MCQ data is hand-built (NOT via buildLearnQuestions), so these checks are
  // independent of learn.ts's Math.random() and fully deterministic. The shuffle
  // inside buildRound is driven by the injected rng: a constant 0.999999 yields the
  // identity permutation (so pool order is observable), mulberry32(seed) a
  // reproducible scramble. Placed before root teardown: #8 needs root's replay
  // history intact.
  const cl = (id: string, canEscalate = false): CardLike => ({
    id,
    q: `q ${id}`,
    answer: 'A',
    mcq: { choices: ['A. one', 'B. two', 'C. three', 'D. four'], answer: 'A' },
    canEscalate
  })
  const ident = (): number => 0.999999 // floor(0.999999*(i+1)) === i => no-op swaps => identity

  // #1 graduation: MCQ correct -> Familiar, TYPED correct -> Mastered
  {
    const cards = initCram([cl('g1', true)])
    const tlM: CramRoundItem[] = [{ card: cards[0], type: 'mcq' }]
    answerCram(cards, tlM, 0, tlM[0], true, CRAM_DEFAULTS)
    ok(cards[0].correctness === 1, 'cram #1: MCQ correct -> Familiar (correctness 1)')
    const tlT: CramRoundItem[] = [{ card: cards[0], type: 'typed' }]
    answerCram(cards, tlT, 0, tlT[0], true, CRAM_DEFAULTS)
    ok(cards[0].correctness === 2, 'cram #1: TYPED correct -> Mastered (correctness 2)')
  }

  // #2 a miss re-queues within the round, except in the final slot
  {
    const cards = initCram([cl('m1', true), cl('m2', true)])
    const tl: CramRoundItem[] = [
      { card: cards[0], type: 'mcq' },
      { card: cards[1], type: 'mcq' }
    ]
    const r1 = answerCram(cards, tl, 0, tl[0], false, CRAM_DEFAULTS)
    ok(
      r1.timeline.length === 3 && cards[0].correctness === -1 && cards[0].incorrectCount === 1,
      'cram #2: miss mid-round re-queues card (timeline +1, correctness -1, incorrect++)'
    )
    const lenAtFinal = r1.timeline.length
    const last = r1.timeline.length - 1
    answerCram(cards, r1.timeline, last, r1.timeline[last], false, CRAM_DEFAULTS)
    ok(r1.timeline.length === lenAtFinal, 'cram #2: miss in the final slot does NOT re-queue (no infinite loop)')
  }

  // #3 pool priority: missed > rested-familiar > new (seen through the roundSize cap)
  {
    const cards = initCram([cl('p-missed'), cl('p-rested'), cl('p-new1'), cl('p-new2')])
    cards[0].correctness = -1
    cards[1].correctness = 1
    cards[1].appearedInRound = 0 // rested by round 3 (3-0 >= reaskGap 2)
    const ids = buildRound(cards, 3, ident, { ...CRAM_DEFAULTS, roundSize: 2 }).map((i) => i.card.card.id)
    ok(
      ids.length === 2 && ids[0] === 'p-missed' && ids[1] === 'p-rested',
      `cram #3: round prioritizes missed > rested-familiar > new (got ${ids.join(',')})`
    )
  }

  // #4 mastered cards are excluded from every round
  {
    const cards = initCram([cl('mx-done'), cl('mx-live')])
    cards[0].correctness = 2
    const ids = buildRound(cards, 0, ident, CRAM_DEFAULTS).map((i) => i.card.card.id)
    ok(!ids.includes('mx-done') && ids.includes('mx-live'), 'cram #4: a mastered card never appears in a round')
  }

  // #5 progress counts mastery (not position); done when all mastered
  {
    const cards = initCram([cl('pr1'), cl('pr2')])
    ok(cramProgress(cards).mastered === 0 && cramProgress(cards).done === false, 'cram #5: progress starts at 0 mastered, not done')
    cards[0].correctness = 2
    cards[1].correctness = 2
    const p = cramProgress(cards)
    ok(p.mastered === 2 && p.total === 2 && p.done === true, 'cram #5: all mastered -> done, mastered === total')
  }

  // #6 escalation: an escalable card is MCQ while unstudied, TYPED once Familiar
  {
    const cards = initCram([cl('e1', true)])
    ok(buildRound(cards, 0, ident, CRAM_DEFAULTS)[0].type === 'mcq', 'cram #6: escalable card unstudied -> MCQ')
    cards[0].correctness = 1
    cards[0].appearedInRound = 0
    ok(buildRound(cards, 2, ident, CRAM_DEFAULTS)[0].type === 'typed', 'cram #6: escalable card at Familiar -> TYPED')
  }

  // #6b choice-only (canEscalate=false): always MCQ, graduates on a 2-correct streak
  {
    const cards = initCram([cl('co1', false)])
    const tl1 = buildRound(cards, 0, ident, CRAM_DEFAULTS)
    ok(tl1[0].type === 'mcq', 'cram #6b: choice-only card -> always MCQ (no TYPED form)')
    answerCram(cards, tl1, 0, tl1[0], true, CRAM_DEFAULTS)
    ok(cards[0].correctness === 1 && cards[0].streak === 1, 'cram #6b: first MCQ correct -> Familiar, streak 1 (not yet mastered)')
    const tl2 = buildRound(cards, 2, ident, CRAM_DEFAULTS)
    ok(tl2[0].type === 'mcq', 'cram #6b: choice-only stays MCQ on re-ask')
    answerCram(cards, tl2, 0, tl2[0], true, CRAM_DEFAULTS)
    ok(cards[0].correctness === 2 && cards[0].streak === 2, 'cram #6b: choice-only graduates by streak (2 consecutive MCQ correct)')
  }

  // #7 determinism: the same seed yields the same round order
  {
    const deck = (): CramCard[] => initCram([cl('d1'), cl('d2'), cl('d3'), cl('d4'), cl('d5')])
    const order = (rng: () => number): string =>
      buildRound(deck(), 0, rng, CRAM_DEFAULTS)
        .map((i) => i.card.card.id)
        .join(',')
    ok(order(mulberry32(12345)) === order(mulberry32(12345)), 'cram #7: same seed -> identical round order (deterministic shuffle)')
  }

  // #8 [SACRED] the cram core writes ZERO review rows and does not perturb rebuildState.
  // Compared rebuild-to-rebuild (snapshotBefore vs snapshotAfter), NOT live-vs-rebuilt,
  // so the hand-injected demo-set-b-0001 (always a live/rebuilt diff) is excluded and
  // changed:0 is meaningful. root still holds replay-card-1 / replay-fuzz-* / demo-set-*.
  const countRows = async (): Promise<number> => {
    let n = 0
    for (const d of await listReviewDomains(root)) n += (await readReviews(root, d)).length
    return n
  }
  const reviewRowsBefore = await countRows()
  const snapshotBefore = await rebuildState(root)
  {
    const cards = initCram([cl('cram-sacred-1', true), cl('cram-sacred-2', false)])
    const rng = mulberry32(2026)
    let tl = buildRound(cards, 0, rng, CRAM_DEFAULTS)
    answerCram(cards, tl, 0, tl[0], true, CRAM_DEFAULTS)
    answerCram(cards, tl, tl.length - 1, tl[tl.length - 1], false, CRAM_DEFAULTS)
    tl = buildRound(cards, 1, rng, CRAM_DEFAULTS)
    answerCram(cards, tl, 0, tl[0], true, CRAM_DEFAULTS)
    cramProgress(cards)
  }
  ok((await countRows()) === reviewRowsBefore, `cram #8: cram core writes ZERO review rows (stayed at ${reviewRowsBefore})`)
  const snapshotAfter = await rebuildState(root)
  const cramDiff = diffState(snapshotBefore, snapshotAfter)
  ok(
    cramDiff.changed.length === 0 && cramDiff.added.length === 0 && cramDiff.removed.length === 0,
    'cram #8: cram core does not perturb rebuildState output (rebuild-to-rebuild)'
  )

  // #8-static structural guard: the core can't reach a history-write path. smoke can't
  // run the renderer, so CramSession.tsx's no-write property stays a PR-B review item;
  // here we pin the engine core by source grep.
  const cramSrc = await fs.readFile('src/engine/cram.ts', 'utf8')
  ok(
    !/\b(record|gradeOne|appendReview|writeState)\b/.test(cramSrc) &&
      !/from ['"]\.\/(api|learn)['"]/.test(cramSrc),
    'cram #8-static: cram.ts references no history-write API and does not import ./api or ./learn'
  )

  await fs.rm(root, { recursive: true, force: true })

  console.log(failures === 0 ? '\nSMOKE PASS' : `\nSMOKE FAILED (${failures})`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

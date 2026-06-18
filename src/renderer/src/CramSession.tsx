import { useEffect, useMemo, useRef, useState } from 'react'
import {
  answerCram,
  buildRound,
  cramProgress,
  CRAM_DEFAULTS,
  type CramCard,
  type CramRoundItem
} from '../../engine/cram'
import { mulberry32 } from '../../engine/srs'
import { scoreWrite } from '../../engine/write'

// Cram round-study mode (PR-B2). A session-local "master the whole set" loop that is
// FULLY EPHEMERAL: it never imports the SRS grade/summary IPC and never writes review
// history (this file does not import ./api at all). The engine core (cram.ts) owns the
// round/queue logic; this component is the UI glue.
//
// B2 adds, on top of B1's MCQ loop: TYPED escalation (escalate:true → a card that has
// passed recognition is re-asked as free recall), a self-judged typed card with a
// local scoreWrite suggestion and a「正解だった」override (masters outright and drops
// any still-pending copies of that card this round), a round-checkpoint screen, and a
// final summary that lists the cards you stumbled on.
const OPTS = CRAM_DEFAULTS // { roundSize:7, graduate:2, reaskGap:2, escalate:true }

const WRITE_JUDGE: Record<number, string> = { 3: 'ほぼ正解', 2: '惜しい', 1: '要復習' }

const letterOf = (choice: string): string => {
  const m = choice.match(/^\s*([A-Za-z])[.)]/)
  return m ? m[1].toUpperCase() : ''
}
const correctLetters = (answer: string): string[] =>
  answer
    .split(/[,\s/]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)

type Phase = 'round' | 'checkpoint' | 'done'

interface Props {
  domain: string
  cards: CramCard[]
  onExit: () => void
}

export function CramSession({ domain, cards, onExit }: Props): JSX.Element {
  // cards are mutated in place by buildRound/answerCram (correctness, appearedInRound,
  // streak…). Hold a stable ref and drive re-renders off round/timeline/pos/phase;
  // every transition setTimeline()s a fresh array so React re-reads cramProgress(ref).
  const cardsRef = useRef(cards)
  const rng = useMemo(() => mulberry32((Date.now() >>> 0) || 1), [])

  const [round, setRound] = useState(0)
  const [timeline, setTimeline] = useState<CramRoundItem[]>(() =>
    buildRound(cardsRef.current, 0, rng, OPTS)
  )
  const [pos, setPos] = useState(0)
  const [selection, setSelection] = useState<string[]>([])
  const [revealed, setRevealed] = useState(false)
  const [lastCorrect, setLastCorrect] = useState<boolean | null>(null)
  const [text, setText] = useState('')
  const [roundStartMastered, setRoundStartMastered] = useState(0)
  const [phase, setPhase] = useState<Phase>(() =>
    cramProgress(cardsRef.current).done ? 'done' : 'round'
  )

  const prog = cramProgress(cardsRef.current)
  const item = timeline[pos] as CramRoundItem | undefined
  const card = item?.card.card
  const mcq = card?.mcq ?? null
  const correct = useMemo(() => (mcq ? correctLetters(mcq.answer) : []), [mcq])
  const isMulti = correct.length > 1
  // Local fuzzy score of a typed answer — a SUGGESTION only; the learner self-judges.
  const writeMatch =
    revealed && item?.type === 'typed' && card && text.trim() ? scoreWrite(text, card.answer) : null

  const resetItemUI = (): void => {
    setSelection([])
    setRevealed(false)
    setLastCorrect(null)
    setText('')
  }

  // Record one answer through the engine core; returns the (possibly grown on a miss)
  // timeline. Mutates the card in place.
  const record = (ok: boolean): CramRoundItem[] => answerCram(cardsRef.current, timeline, pos, item!, ok, OPTS).timeline

  // Move to the next item, or to the round checkpoint / final summary. `tl` is the live
  // timeline to advance within (after a record / override edit).
  const advance = (tl: CramRoundItem[]): void => {
    resetItemUI()
    const np = pos + 1
    if (np < tl.length) {
      setTimeline(tl)
      setPos(np)
      return
    }
    if (cramProgress(cardsRef.current).done) setPhase('done')
    else setPhase('checkpoint')
  }

  // MCQ: judge + record + reveal in one go (verdict shown; 次へ advances).
  const answerMcq = (sel: string[]): void => {
    if (!mcq || revealed) return
    const ok = sel.length === correct.length && correct.every((c) => sel.includes(c))
    setSelection(sel)
    setLastCorrect(ok)
    setRevealed(true)
    setTimeline([...record(ok)])
  }

  const pickChoice = (L: string): void => {
    if (revealed || !mcq) return
    if (isMulti) setSelection((s) => (s.includes(L) ? s.filter((x) => x !== L) : [...s, L]))
    else answerMcq([L])
  }

  // Typed self-judge. A miss re-queues via the core. 「正解だった」masters the card AND
  // drops any still-pending copies of it later this round (the override), so declaring
  // mastery doesn't get second-guessed by a re-queued duplicate.
  const selfJudge = (ok: boolean): void => {
    if (!item) return
    const id = item.card.card.id
    let tl = record(ok)
    if (ok) tl = tl.filter((it, i) => i <= pos || it.card.card.id !== id)
    advance(tl)
  }

  const continueRound = (): void => {
    const nr = round + 1
    const tl = buildRound(cardsRef.current, nr, rng, OPTS)
    if (tl.length === 0) {
      setPhase('done') // all mastered (buildRound is empty only when nothing is left)
      return
    }
    setRoundStartMastered(cramProgress(cardsRef.current).mastered)
    setRound(nr)
    setTimeline(tl)
    setPos(0)
    resetItemUI()
    setPhase('round')
  }

  // Re-cram only the cards you stumbled on: reset their cram state to fresh and restart
  // from round 0 over just that subset. Still ephemeral — no SRS writes. The set shrinks
  // to the misses, so the progress bar / summary reflect the redrill, and repeating it
  // drills down to a clean set.
  const redrillMissed = (): void => {
    const missed = cardsRef.current.filter((c) => c.incorrectCount > 0)
    if (missed.length === 0) return
    for (const c of missed) {
      c.correctness = 0
      c.appearedInRound = null
      c.streak = 0
      c.incorrectCount = 0
    }
    cardsRef.current = missed
    setRoundStartMastered(0)
    setRound(0)
    setTimeline(buildRound(cardsRef.current, 0, rng, OPTS))
    setPos(0)
    resetItemUI()
    setPhase('round')
  }

  // Keyboard: A–D pick a single choice; Enter reveals a typed card / advances an MCQ
  // verdict / continues a checkpoint. A revealed typed card is NEVER advanced by Enter
  // — it must be self-judged with the ✓/✗ buttons (else the answer goes unrecorded).
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement)?.tagName
      const typing = tag === 'TEXTAREA' || tag === 'INPUT'
      if (phase === 'checkpoint') {
        if (e.key === 'Enter' && !typing) {
          e.preventDefault()
          continueRound()
        }
        return
      }
      if (phase !== 'round' || !item) return
      if (revealed) {
        if (e.key === 'Enter' && !typing && item.type === 'mcq') {
          e.preventDefault()
          advance(timeline)
        }
        return
      }
      if (item.type === 'typed') {
        if (e.key === 'Enter' && (!typing || e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          setRevealed(true)
        }
        return
      }
      if (typing || isMulti) return
      const k = e.key.toUpperCase()
      if ((mcq?.choices ?? []).some((c) => letterOf(c) === k)) {
        e.preventDefault()
        pickChoice(k)
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })

  const pct = prog.total ? (prog.mastered / prog.total) * 100 : 0
  const head = (
    <header className="session-head">
      <button className="link" onClick={onExit}>
        ✕ 中断
      </button>
      <div className="progress">
        <div className="bar" style={{ width: `${pct}%` }} />
      </div>
      <span className="counter cram-counter">
        {prog.mastered} / {prog.total} マスター ・ ラウンド {round + 1}
      </span>
    </header>
  )

  if (phase === 'done') {
    const missed = cardsRef.current.filter((c) => c.incorrectCount > 0)
    return (
      <div className="session">
        {head}
        <div className="session-body">
          <div className="session-main">
            <div className="card cram-done">
              <h2>🎉 セット完了</h2>
              <p className="cram-done-stat">
                {prog.total} 問すべてマスターしました（{round + 1} ラウンド）。
              </p>
              {missed.length > 0 && (
                <div className="cram-misslist">
                  <h3>つまずいたカード（{missed.length}）</h3>
                  <ul>
                    {missed
                      .slice()
                      .sort((a, b) => b.incorrectCount - a.incorrectCount)
                      .map((c) => (
                        <li key={c.card.id}>
                          <span className="cm-q">{c.card.q}</span>
                          <span className="cm-n">{c.incorrectCount}回ミス</span>
                        </li>
                      ))}
                  </ul>
                </div>
              )}
              <p className="muted">Cram は学習履歴を変更しません（SRS の予定はそのままです）。</p>
              <div className="cram-done-actions">
                {missed.length > 0 && (
                  <button className="ghost-btn" onClick={redrillMissed}>
                    ↻ ミスだけもう一度（{missed.length}）
                  </button>
                )}
                <button className="primary" onClick={onExit}>
                  ダッシュボードへ戻る
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (phase === 'checkpoint') {
    const gained = prog.mastered - roundStartMastered
    const remaining = prog.total - prog.mastered
    return (
      <div className="session">
        {head}
        <div className="session-body">
          <div className="session-main">
            <div className="card cram-checkpoint">
              <h2>ラウンド {round + 1} 完了</h2>
              <p className="cram-done-stat">
                {prog.mastered} / {prog.total} マスター
                {gained > 0 && <span className="cm-gain"> （+{gained}）</span>}
              </p>
              <p className="muted">残り {remaining} 問。次のラウンドで続けます。</p>
              <div className="cram-checkpoint-actions">
                <button className="primary" onClick={continueRound}>
                  次のラウンドへ → <span className="key">Enter</span>
                </button>
                <button className="ghost-btn" onClick={onExit}>
                  中断して戻る
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (!item || !card) {
    // Defensive: in 'round' but nothing to show — let the user out cleanly.
    return (
      <div className="session">
        {head}
        <div className="session-body">
          <div className="session-main">
            <div className="card">
              <p className="muted">出題できるカードがありません。</p>
              <button className="primary" onClick={onExit}>
                戻る
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="session">
      {head}
      <div className="session-body">
        <div className="session-main">
          <div className="card">
            <div className="meta">
              <div className="meta-row">
                <span className="pill cram-pill">Cram</span>
                <span className="pill">{domain}</span>
                <span className="pill ghost">{item.type === 'typed' ? '記述' : '4択'}</span>
              </div>
            </div>

            <h2 className="q-body">{card.q}</h2>

            {item.type === 'mcq' && mcq ? (
              <ul className="choices">
                {mcq.choices.map((c) => {
                  const L = letterOf(c)
                  const picked = selection.includes(L)
                  const right = correct.includes(L)
                  const state = revealed ? (right ? 'right' : picked ? 'wrong' : '') : picked ? 'picked' : ''
                  return (
                    <li key={c}>
                      <button className={`choice ${state}`} onClick={() => pickChoice(L)} disabled={revealed}>
                        {c}
                        {revealed && right && ' ✓'}
                        {revealed && picked && !right && ' ✗'}
                      </button>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <textarea
                className="answer-input"
                placeholder="思い出して入力 → 答え合わせ（Cmd+Enter）。自動判定は参考、最終はあなたが評価します"
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={revealed}
              />
            )}

            {!revealed ? (
              <div className="actions">
                {item.type === 'mcq' ? (
                  isMulti ? (
                    <button className="primary" onClick={() => answerMcq(selection)} disabled={selection.length === 0}>
                      答え合わせ（複数選択）
                    </button>
                  ) : (
                    <span className="answer-hint">選択肢をクリック / A–D キーで回答</span>
                  )
                ) : (
                  <button className="primary" onClick={() => setRevealed(true)}>
                    答え合わせ (Cmd+Enter)
                  </button>
                )}
              </div>
            ) : item.type === 'mcq' ? (
              <div className="reveal">
                <div className={`verdict ${lastCorrect ? 'ok' : 'ng'}`}>
                  {lastCorrect ? '正解' : '不正解'}：
                  <b>{mcq?.choices.filter((c) => correct.includes(letterOf(c))).join(' / ') || card.answer}</b>
                </div>
                <button className="primary" onClick={() => advance(timeline)}>
                  次へ (Enter)
                </button>
              </div>
            ) : (
              <div className="reveal">
                <div className="verdict">
                  模範解答：<b>{card.answer}</b>
                </div>
                {writeMatch && (
                  <div className={`write-judge wj-${writeMatch.grade}`}>
                    <span className="wj-label">自動判定：{WRITE_JUDGE[writeMatch.grade]}</span>
                    <span className="wj-pct">一致度 {writeMatch.percent}%</span>
                    <span className="wj-note">参考・最終はあなたの自己評価で</span>
                  </div>
                )}
                <div className="cram-selfjudge">
                  <span className="grade-hint">自己評価：</span>
                  <button
                    className={`grade good ${writeMatch && writeMatch.grade >= 3 ? 'suggested' : ''}`}
                    onClick={() => selfJudge(true)}
                  >
                    ✓ 正解だった
                  </button>
                  <button
                    className={`grade again ${writeMatch && writeMatch.grade < 3 ? 'suggested' : ''}`}
                    onClick={() => selfJudge(false)}
                  >
                    ✗ 間違えた
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

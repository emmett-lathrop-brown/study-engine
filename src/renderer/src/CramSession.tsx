import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  answerCram,
  buildRound,
  cramProgress,
  CRAM_DEFAULTS,
  type CramCard,
  type CramRoundItem
} from '../../engine/cram'
import { mulberry32 } from '../../engine/srs'

// Cram round-study mode — PR-B1 (minimal). A session-local "master the whole set"
// loop that is FULLY EPHEMERAL: it never imports the SRS grade/summary IPC and never
// writes review history (note: this file does not import ./api at all). The engine
// core (cram.ts) owns the round/queue logic; this component is only the MCQ UI +
// progress + abort glue.
//
// Scope of B1: escalation is OFF, so every card graduates by a 2-correct MCQ streak
// (CRAM_DEFAULTS.graduate). A card with no MCQ leg (a free question Claude couldn't
// turn into choices) falls back to a minimal self-judged recall card so it isn't
// dropped. TYPED escalation (Familiar -> free recall), the「正解だった」override, the
// round-checkpoint screen and the rich final summary are PR-B2.
const OPTS = { ...CRAM_DEFAULTS, escalate: false }

const letterOf = (choice: string): string => {
  const m = choice.match(/^\s*([A-Za-z])[.)]/)
  return m ? m[1].toUpperCase() : ''
}
const correctLetters = (answer: string): string[] =>
  answer
    .split(/[,\s/]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)

interface Props {
  domain: string
  cards: CramCard[]
  onExit: () => void
}

export function CramSession({ domain, cards, onExit }: Props): JSX.Element {
  // cards are mutated in place by buildRound/answerCram (correctness, appearedInRound,
  // streak…). Hold a stable ref and drive re-renders off the round/timeline/pos state;
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
  const [done, setDone] = useState(() => cramProgress(cardsRef.current).done)

  const prog = cramProgress(cardsRef.current)
  const item = timeline[pos] as CramRoundItem | undefined
  const card = item?.card.card
  const mcq = card?.mcq ?? null
  const correct = useMemo(() => (mcq ? correctLetters(mcq.answer) : []), [mcq])
  const isMulti = correct.length > 1

  // Record one answer for the active item (correct/incorrect), advancing mastery in
  // the engine core. answerCram may push a re-queued copy onto `timeline`; copy the
  // result so React sees a new array.
  // Records one answer. For MCQ this is the reveal (callers guard re-entry via the
  // disabled choices); for the typed fallback the card is already revealed and the
  // self-judge buttons call this exactly once before advancing.
  const commit = useCallback(
    (ok: boolean): void => {
      if (!item) return
      setRevealed(true)
      setLastCorrect(ok)
      const r = answerCram(cardsRef.current, timeline, pos, item, ok, OPTS)
      setTimeline([...r.timeline])
    },
    [item, timeline, pos]
  )

  const judgeMcq = useCallback(
    (sel: string[]): void => {
      if (!mcq) return
      const ok = sel.length === correct.length && correct.every((c) => sel.includes(c))
      commit(ok)
    },
    [mcq, correct, commit]
  )

  // single_choice / converted-free: click commits + reveals at once. multi: toggle,
  // then 確定. (Mirrors Session's Quizlet-style instant judging.)
  const pickChoice = (L: string): void => {
    if (revealed) return
    if (isMulti) {
      setSelection((s) => (s.includes(L) ? s.filter((x) => x !== L) : [...s, L]))
    } else {
      setSelection([L])
      judgeMcq([L])
    }
  }

  const next = useCallback((): void => {
    setSelection([])
    setRevealed(false)
    setLastCorrect(null)
    setText('')
    const np = pos + 1
    if (np < timeline.length) {
      setPos(np)
      return
    }
    // Round exhausted: finish, or build the next round.
    if (cramProgress(cardsRef.current).done) {
      setDone(true)
      return
    }
    const nr = round + 1
    const tl = buildRound(cardsRef.current, nr, rng, OPTS)
    if (tl.length === 0) {
      setDone(true) // safety: nothing left to ask (shouldn't happen unless all mastered)
      return
    }
    setRound(nr)
    setTimeline(tl)
    setPos(0)
  }, [pos, timeline.length, round, rng])

  // Keyboard: A–D pick a single-choice option; Enter reveals a typed card or, once
  // answered, advances. Typed input keeps Enter for newlines (Cmd/Ctrl+Enter reveals).
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement)?.tagName
      const typing = tag === 'TEXTAREA' || tag === 'INPUT'
      if (done || !item) return
      if (revealed) {
        // MCQ is already committed at reveal time, so Enter just advances. A typed
        // recall card is committed ONLY by the ✓/✗ self-judge buttons, so Enter must
        // NOT advance it unjudged — that would skip recording the answer (the card
        // would never reach mastered and would reappear in later rounds).
        if (e.key === 'Enter' && !typing && item.type !== 'typed') {
          e.preventDefault()
          next()
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
      if (typing) return
      if (!isMulti) {
        const k = e.key.toUpperCase()
        if ((mcq?.choices ?? []).some((c) => letterOf(c) === k)) {
          e.preventDefault()
          pickChoice(k)
        }
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

  if (done) {
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
              <p className="muted">Cram は学習履歴を変更しません（SRS の予定はそのままです）。</p>
              <button className="primary" onClick={onExit}>
                ダッシュボードへ戻る
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (!item || !card) {
    // Defensive: nothing to show but not flagged done — let the user out cleanly.
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
                  const state = revealed
                    ? right
                      ? 'right'
                      : picked
                        ? 'wrong'
                        : ''
                    : picked
                      ? 'picked'
                      : ''
                  return (
                    <li key={c}>
                      <button
                        className={`choice ${state}`}
                        onClick={() => pickChoice(L)}
                        disabled={revealed}
                      >
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
                placeholder="思い出して入力 → 答え合わせ（Cmd+Enter）。自分で正誤を判断します"
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={revealed}
              />
            )}

            {!revealed ? (
              <div className="actions">
                {item.type === 'mcq' ? (
                  isMulti ? (
                    <button
                      className="primary"
                      onClick={() => judgeMcq(selection)}
                      disabled={selection.length === 0}
                    >
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
            ) : (
              <div className="reveal">
                {item.type === 'mcq' ? (
                  <>
                    <div className={`verdict ${lastCorrect ? 'ok' : 'ng'}`}>
                      {lastCorrect ? '正解' : '不正解'}：
                      <b>{mcq?.choices.filter((c) => correct.includes(letterOf(c))).join(' / ') || card.answer}</b>
                    </div>
                    <button className="primary" onClick={next}>
                      次へ (Enter)
                    </button>
                  </>
                ) : (
                  <>
                    <div className="verdict">
                      模範解答：<b>{card.answer}</b>
                    </div>
                    <div className="cram-selfjudge">
                      <span className="grade-hint">自己評価：</span>
                      <button
                        className="grade good"
                        onClick={() => {
                          commit(true)
                          next()
                        }}
                      >
                        ✓ 正解だった
                      </button>
                      <button
                        className="grade again"
                        onClick={() => {
                          commit(false)
                          next()
                        }}
                      >
                        ✗ 間違えた
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

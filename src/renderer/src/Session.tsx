import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PickedQuestion } from '../../engine/types'
import { api } from './api'

export const GRADES = [
  { g: 1, label: 'Again', jp: 'もう一度', cls: 'again' },
  { g: 2, label: 'Hard', jp: '難しい', cls: 'hard' },
  { g: 3, label: 'Good', jp: '普通', cls: 'good' },
  { g: 4, label: 'Easy', jp: '簡単', cls: 'easy' }
] as const

const gradeLabel = (g: number): string => {
  const f = GRADES.find((x) => x.g === g)
  return f ? `${f.label} / ${f.jp}` : String(g)
}

const isChoiceType = (t: string): boolean => t === 'single_choice' || t === 'multi'
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
  sessionId: string
  questions: PickedQuestion[]
  voice: string
  rate: number
  onDone: () => void
}

export function Session({ domain, sessionId, questions, voice, rate, onDone }: Props): JSX.Element {
  const [index, setIndex] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [selection, setSelection] = useState<string[]>([])
  const [text, setText] = useState('')
  const [recording, setRecording] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const q = questions[index]
  const choice = isChoiceType(q.type)
  const correct = useMemo(() => correctLetters(q.answer), [q.answer])
  const hasSpeak = Boolean(q.speak) || domain.startsWith('english')

  const isCorrect = choice
    ? selection.length === correct.length && correct.every((c) => selection.includes(c))
    : null
  const suggested = choice ? (isCorrect ? 3 : 1) : 3

  const speakNow = useCallback(() => {
    const t = q.speak || q.q
    if (t) void api.speak(t, voice, rate)
  }, [q, voice, rate])

  // reset per question; auto-speak English prompts on appearance
  useEffect(() => {
    setRevealed(false)
    setSelection([])
    setText('')
    // Auto-read only when there is an explicit English line, so the English
    // voice never tries to pronounce Japanese prompt text.
    if (q.speak) void api.speak(q.speak, voice, rate)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index])

  const reveal = useCallback(() => setRevealed(true), [])

  const onGrade = useCallback(
    async (g: number) => {
      if (recording) return
      setRecording(true)
      try {
        await api.grade(domain, sessionId, q.id, g)
      } catch (e) {
        setToast(`記録に失敗: ${String(e)}`)
      }
      setRecording(false)
      if (index + 1 >= questions.length) onDone()
      else setIndex((i) => i + 1)
    },
    [recording, domain, sessionId, q.id, index, questions.length, onDone]
  )

  // keyboard: Enter reveals; 1-4 grades after reveal
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'TEXTAREA' || tag === 'INPUT') {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !revealed) {
          e.preventDefault()
          reveal()
        }
        return
      }
      if (!revealed && e.key === 'Enter') {
        e.preventDefault()
        reveal()
      } else if (revealed && ['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault()
        void onGrade(Number(e.key))
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [revealed, reveal, onGrade])

  const toggleChoice = (letter: string): void => {
    if (revealed) return
    if (q.type === 'single_choice') setSelection([letter])
    else setSelection((s) => (s.includes(letter) ? s.filter((x) => x !== letter) : [...s, letter]))
  }

  const deepDive = async (): Promise<void> => {
    const prompt = await api.deepDivePrompt({
      id: q.id,
      file: q.file,
      domain,
      q: q.q,
      answer: q.answer,
      userAnswer: choice ? selection.join(',') : text,
      gradeLabel: revealed ? gradeLabel(suggested) : undefined
    })
    try {
      await navigator.clipboard.writeText(prompt)
      setToast('深掘りプロンプトをコピー。Claude Code チャットに貼り付けて。')
    } catch {
      setToast('コピーに失敗しました。')
    }
    setTimeout(() => setToast(null), 4000)
  }

  const canReveal = choice ? selection.length > 0 : true

  return (
    <div className="session">
      <header className="session-head">
        <button className="link" onClick={onDone}>
          ✕ 中断
        </button>
        <div className="progress">
          <div className="bar" style={{ width: `${(index / questions.length) * 100}%` }} />
        </div>
        <span className="counter">
          {index + 1} / {questions.length}
        </span>
      </header>

      <div className="card">
        <div className="meta">
          <span className="pill">{domain}</span>
          <span className="pill ghost">{q.topic}</span>
          <span className="pill ghost">{q.type}</span>
          {q.isNew ? <span className="pill new">NEW</span> : <span className="pill due">復習</span>}
          {hasSpeak && (
            <button className="icon" title="読み上げ" onClick={speakNow}>
              🔊
            </button>
          )}
        </div>

        <h2 className="q">{q.q}</h2>

        {choice ? (
          <ul className="choices">
            {(q.choices ?? []).map((c) => {
              const L = letterOf(c)
              const picked = selection.includes(L)
              const right = correct.includes(L)
              const state = revealed ? (right ? 'right' : picked ? 'wrong' : '') : picked ? 'picked' : ''
              return (
                <li key={c}>
                  <button className={`choice ${state}`} onClick={() => toggleChoice(L)} disabled={revealed}>
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
            placeholder="ここに回答を入力(自己採点用。Cmd+Enterで答え合わせ)"
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={revealed}
          />
        )}

        {!revealed ? (
          <div className="actions">
            <button className="primary" onClick={reveal} disabled={!canReveal}>
              答え合わせ (Enter)
            </button>
            <button className="ghost-btn" onClick={deepDive}>
              🤔 Claudeで深掘り
            </button>
          </div>
        ) : (
          <div className="reveal">
            <div className={`verdict ${isCorrect === null ? '' : isCorrect ? 'ok' : 'ng'}`}>
              {isCorrect === null ? '模範解答' : isCorrect ? '正解' : '不正解'}：<b>{q.answer}</b>
            </div>
            <div className="explanation">{q.explanation}</div>
            {q.source.length > 0 && (
              <div className="sources">
                出典：
                {q.source.map((s) => (
                  <button key={s} className="src" onClick={() => api.openExternal(s)}>
                    {s.replace(/^https?:\/\//, '').slice(0, 48)}
                  </button>
                ))}
              </div>
            )}
            <div className="grade-bar">
              <span className="grade-hint">自己評価：</span>
              {GRADES.map((gr) => (
                <button
                  key={gr.g}
                  className={`grade ${gr.cls} ${gr.g === suggested ? 'suggested' : ''}`}
                  onClick={() => onGrade(gr.g)}
                  disabled={recording}
                >
                  <span className="gk">{gr.g}</span>
                  {gr.label}
                  <small>{gr.jp}</small>
                </button>
              ))}
            </div>
            <div className="actions">
              <button className="ghost-btn" onClick={deepDive}>
                🤔 Claudeで深掘り
              </button>
            </div>
          </div>
        )}
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PickedQuestion } from '../../engine/types'
import { review, todayISO } from '../../engine/srs'
import { api } from './api'
import { Markdown } from './Markdown'

const intervalLabel = (days: number): string => (days <= 0 ? '今日' : `${days}日`)

const GRADES = [
  { g: 1, label: 'Again', jp: 'もう一度', cls: 'again' },
  { g: 2, label: 'Hard', jp: '難しい', cls: 'hard' },
  { g: 3, label: 'Good', jp: '普通', cls: 'good' },
  { g: 4, label: 'Easy', jp: '簡単', cls: 'easy' }
] as const

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

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

// English (cloze/translation) prompts are "<instruction>\n<sentence>"; AWS
// choice questions are a single block. Split on the first newline so the
// instruction (A) and the sentence/body (B) can be styled distinctly, and drop
// a trailing colon from the instruction (it reads as a separator otherwise).
const splitPrompt = (raw: string): { instruction: string | null; body: string } => {
  const nl = raw.indexOf('\n')
  if (nl === -1) return { instruction: null, body: raw.trim() }
  const head = raw.slice(0, nl).replace(/[:：]\s*$/, '').trim()
  const rest = raw.slice(nl + 1).trim()
  if (!rest) return { instruction: null, body: head }
  return { instruction: head || null, body: rest }
}

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
  const [hintText, setHintText] = useState<string | null>(null)
  const [hintLoading, setHintLoading] = useState(false)
  const [dive, setDive] = useState<string | null>(null)
  const [diveLoading, setDiveLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  const q = questions[index]
  const choice = isChoiceType(q.type)
  const correct = useMemo(() => correctLetters(q.answer), [q.answer])
  const prompt = useMemo(() => splitPrompt(q.q), [q.q])

  const speakInPrompt =
    Boolean(q.speak) && norm(q.speak ?? '').length > 8 && norm(q.q).includes(norm(q.speak ?? ''))
  const canSpeak = Boolean(q.speak) && (speakInPrompt || revealed)

  const isCorrect = choice
    ? selection.length === correct.length && correct.every((c) => selection.includes(c))
    : null
  const suggested = choice ? (isCorrect ? 3 : 1) : 3

  const speakNow = useCallback(() => {
    if (q.speak) void api.speak(q.speak, voice, rate)
  }, [q, voice, rate])

  useEffect(() => {
    setRevealed(false)
    setSelection([])
    setText('')
    setHintText(null)
    setHintLoading(false)
    setDive(null)
    setDiveLoading(false)
    setCopied(false)
  }, [index])

  const reveal = useCallback(() => setRevealed(true), [])

  const onGrade = useCallback(
    async (g: number) => {
      if (recording) return
      setRecording(true)
      try {
        await api.grade(domain, sessionId, q.id, g)
      } catch {
        /* recorded later */
      }
      setRecording(false)
      if (index + 1 >= questions.length) onDone()
      else setIndex((i) => i + 1)
    },
    [recording, domain, sessionId, q.id, index, questions.length, onDone]
  )

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
      if (!revealed) {
        if (q.type === 'single_choice') {
          const k = e.key.toUpperCase()
          if ((q.choices ?? []).some((c) => letterOf(c) === k)) {
            e.preventDefault()
            setSelection([k])
            setRevealed(true)
            return
          }
        }
        if (e.key === 'Enter') {
          e.preventDefault()
          reveal()
        }
      } else if (['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault()
        void onGrade(Number(e.key))
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [revealed, reveal, onGrade])

  // Quizlet-style: clicking a single_choice option commits + reveals instantly.
  // multi keeps toggle-then-確定 (you pick several first).
  const pickChoice = (letter: string): void => {
    if (revealed) return
    if (q.type === 'single_choice') {
      setSelection([letter])
      setRevealed(true)
    } else {
      setSelection((s) => (s.includes(letter) ? s.filter((x) => x !== letter) : [...s, letter]))
    }
  }

  // Hint: stored hint is instant; otherwise ask Claude (fast model), no answer.
  const onHint = async (): Promise<void> => {
    if (hintText) {
      setHintText(null)
      return
    }
    if (q.hint) {
      setHintText(q.hint)
      return
    }
    setHintLoading(true)
    const userDraft = !choice ? text.trim() : ''
    const r = await api.claudeAsk(
      [
        'あなたは学習コーチです。次の問題について、答えそのものは絶対に言わず、解くための着眼点となるヒントを1つだけ日本語で簡潔に出してください。',
        `ドメイン: ${domain}`,
        `問題: ${q.q}`,
        choice && q.choices && q.choices.length ? `選択肢:\n${q.choices.join('\n')}` : '',
        userDraft ? `学習者の途中回答: ${userDraft}\n(的外れなら、正否は言わず軌道修正の方向だけ示す)` : ''
      ]
        .filter(Boolean)
        .join('\n'),
      'haiku'
    )
    setHintLoading(false)
    setHintText(r.ok ? (r.text ?? '') : `取得失敗: ${r.error ?? ''}`)
  }

  // Deep dive: ask Claude for understanding-oriented explanation, shown in-app.
  const deepDive = async (): Promise<void> => {
    if (dive || diveLoading) {
      setDive(null)
      return
    }
    const userAns = (choice ? selection.join(',') : text).trim()
    const wrong = choice && revealed ? isCorrect === false : false
    setDiveLoading(true)
    const r = await api.claudeAsk(
      [
        'あなたは学習コーチです。次の問題を、丸暗記ではなく理解を促す方針で、日本語でわかりやすく深掘り解説してください。要点は見出しや箇条書きを使って読みやすくしてください。',
        `ドメイン: ${domain}`,
        `問題: ${q.q}`,
        choice && q.choices && q.choices.length ? `選択肢:\n${q.choices.join('\n')}` : '',
        `模範解答: ${q.answer}`,
        q.explanation ? `既存の解説(これを踏まえ、繰り返しより深掘り・補足を): ${q.explanation}` : '',
        userAns ? `学習者の回答: ${userAns}` : '',
        wrong
          ? 'この回答は不正解でした。なぜ誤りか・正解とどう違うか・つまずきの原因を具体的に指摘してください。'
          : '',
        '観点: 関連知識 / つまずきやすい点 / 覚え方。'
      ]
        .filter(Boolean)
        .join('\n'),
      'sonnet'
    )
    setDiveLoading(false)
    setDive(r.ok ? (r.text ?? '') : `取得失敗: ${r.error ?? ''}`)
  }

  // Copy a rich deep-dive prompt for a full Claude Code chat session — the
  // path that can read the file and grow learned/ (the in-app 🤔 is one-shot
  // and can't write files). See study-engine CLAUDE.md §7.
  const copyForChat = async (): Promise<void> => {
    const userAns = choice ? selection.join(',') : text
    const prompt = await api.deepDivePrompt({
      id: q.id,
      file: q.file,
      domain,
      q: q.q,
      answer: q.answer,
      userAnswer: userAns || undefined
    })
    await api.copyToClipboard(prompt)
    setCopied(true)
  }

  const canReveal = choice ? selection.length > 0 : true

  const speakControl = canSpeak && (
    <button className="icon speak-read" title="英語を読み上げ" onClick={speakNow}>
      🔊
    </button>
  )

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
          {speakControl}
        </div>

        {prompt.instruction && <p className="q-instruction">{prompt.instruction}</p>}
        <h2 className="q-body">{prompt.body}</h2>

        {choice ? (
          <ul className="choices">
            {(q.choices ?? []).map((c) => {
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
            placeholder="ここに回答を入力(自己採点用。Cmd+Enterで答え合わせ)"
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={revealed}
          />
        )}

        {(hintLoading || hintText) && (
          <div className="hint-box">
            <span className="hint-icon">💡</span>
            {hintLoading ? <span>…考え中</span> : <Markdown className="hint-md">{hintText ?? ''}</Markdown>}
          </div>
        )}

        {!revealed ? (
          <div className="actions">
            {q.type === 'single_choice' ? (
              <span className="answer-hint">選択肢をクリック / A–D キーで回答</span>
            ) : (
              <button className="primary" onClick={reveal} disabled={!canReveal}>
                答え合わせ {q.type === 'multi' ? '(複数選択→ここ)' : '(Enter)'}
              </button>
            )}
            <button className="ghost-btn" onClick={onHint} disabled={hintLoading}>
              💡 ヒント
            </button>
            <button className="ghost-btn" onClick={deepDive} disabled={diveLoading}>
              🤔 深掘り
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
                  <span className="ivl">{intervalLabel(review(q.state, gr.g, todayISO()).interval)}</span>
                </button>
              ))}
            </div>
            <div className="actions">
              <button className="ghost-btn" onClick={deepDive} disabled={diveLoading}>
                🤔 深掘り
              </button>
              <button className="ghost-btn" onClick={copyForChat} title="learned/ を育てる深掘りプロンプトをコピー">
                📋 Claude Codeへ
              </button>
              {copied && <span className="answer-hint">コピーしました(Claude Code チャットに貼り付け)</span>}
            </div>
          </div>
        )}

        {(diveLoading || dive) && (
          <div className="dive-panel">
            <div className="dive-head">🤔 深掘り{diveLoading ? ' …考え中' : ''}</div>
            {dive && <Markdown className="dive-body">{dive}</Markdown>}
          </div>
        )}
      </div>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import type { ChatMessage, PickedQuestion } from '../../engine/types'
import { api } from './api'
import { Markdown } from './Markdown'

interface Props {
  domain: string
  q: PickedQuestion
  userAnswer: string // the learner's current answer (letters or typed text), '' if none yet
  onClose: () => void
}

// Compact context block prepended to every send so Claude always knows which
// question we're discussing. We send a self-contained prompt (context + the saved
// transcript + the new question) rather than relying on the CLI's --resume: that
// makes the conversation reproducible from the persisted log alone, so it survives
// app restarts and is restored straight from <domain>/chats/<id>.json.
function contextBlock(domain: string, q: PickedQuestion, userAnswer: string): string {
  return [
    '【いま学習中の問題 — これについて会話します】',
    `ID: ${q.id}`,
    `ドメイン: ${domain} / トピック: ${q.topic}`,
    `問題: ${q.q}`,
    q.choices && q.choices.length ? `選択肢:\n${q.choices.join('\n')}` : '',
    `正解/模範解答: ${q.answer}`,
    q.explanation ? `解説: ${q.explanation}` : '',
    userAnswer ? `私の回答: ${userAnswer}` : '',
    '【方針】答えを一方的に与えるより、対話で私の理解・腹落ちを助けて。日本語で簡潔に。'
  ]
    .filter((l) => l !== '')
    .join('\n')
}

function buildPrompt(
  domain: string,
  q: PickedQuestion,
  userAnswer: string,
  prior: ChatMessage[],
  question: string
): string {
  return [
    contextBlock(domain, q, userAnswer),
    prior.length
      ? '【これまでの会話】\n' +
        prior.map((m) => `${m.role === 'user' ? '私' : 'あなた(Claude)'}: ${m.text}`).join('\n')
      : '',
    `【私の質問】\n${question}`
  ]
    .filter(Boolean)
    .join('\n\n')
}

const now = (): string => new Date().toISOString()

export function ChatPanel({ domain, q, userAnswer, onClose }: Props): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const mounted = useRef(true) // ChatPanel is keyed by q.id, so it remounts per question
  const gen = useRef(0) // bumped by clear() to invalidate an in-flight send's persist
  useEffect(() => () => void (mounted.current = false), [])

  // Load this question's saved thread on mount (keyed by q.id in Session).
  useEffect(() => {
    let alive = true
    void api.getChat(domain, q.id).then((logEntry) => {
      if (alive && logEntry) setMessages(logEntry.messages)
    })
    return () => {
      alive = false
    }
  }, [domain, q.id])

  // Keep the transcript pinned to the newest message / typing indicator.
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, loading])

  const send = async (): Promise<void> => {
    const text = input.trim()
    if (!text || loading) return
    const myGen = gen.current
    setError(null)
    setInput('')
    const prior = messages
    const optimistic: ChatMessage[] = [...prior, { role: 'user', text, ts: now() }]
    setMessages(optimistic)
    setLoading(true)
    const r = await api.claudeChat(buildPrompt(domain, q, userAnswer, prior, text), 'sonnet')
    const final: ChatMessage[] = [...optimistic, { role: 'assistant', text: r.text ?? '(空の応答)', ts: now() }]
    if (!mounted.current) {
      // Navigated away mid-request: still persist a successful turn for this question.
      if (r.ok && gen.current === myGen) void api.saveChat(domain, q.id, final)
      return
    }
    setLoading(false)
    if (gen.current !== myGen) return // cleared mid-send: clear() already persisted [] and reset the UI
    if (r.ok) {
      void api.saveChat(domain, q.id, final) // persist to <domain>/chats/<id>.json
      setMessages(final)
    } else {
      // Roll back the optimistic question and restore the input so nothing is lost.
      setMessages(prior)
      setInput(text)
      setError(r.error ?? 'エラーが発生しました')
    }
  }

  const clear = (): void => {
    gen.current++ // invalidate any in-flight send for this question
    setMessages([])
    setError(null)
    void api.saveChat(domain, q.id, []) // empty -> writeChat removes the file
  }

  return (
    <aside className="chat-panel">
      <div className="chat-head">
        <span className="chat-title">💬 Claude</span>
        <span className="chat-ctx" title={`この問題に紐づくチャット: ${q.id}`}>
          📎 {q.id}
        </span>
        <button className="chat-icon" onClick={clear} title="この問題の会話を消去" disabled={loading || !messages.length}>
          🗑
        </button>
        <button className="chat-icon" onClick={onClose} title="チャットを閉じる">
          ✕
        </button>
      </div>

      <div className="chat-log" ref={logRef}>
        {messages.length === 0 && !loading && (
          <div className="chat-empty">
            この問題について質問できます。
            <br />
            （解説の掘り下げ・つまずきの相談・関連知識など）
            <br />
            <span className="chat-empty-note">会話はこの問題に紐づいて保存されます</span>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={`${i}:${m.ts}`} className={`chat-msg ${m.role}`}>
            {m.role === 'assistant' ? <Markdown className="chat-md">{m.text}</Markdown> : m.text}
          </div>
        ))}
        {loading && <div className="chat-typing">考え中…</div>}
      </div>

      {error && <div className="chat-err">⚠ {error}</div>}

      <div className="chat-input-row">
        <textarea
          className="chat-input"
          placeholder="質問を入力（Enterで送信 / Shift+Enterで改行）"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Keep chat keystrokes out of the session's global key handler
            // (1–4 grade / A–D choice / Enter reveal).
            e.stopPropagation()
            // Never send while the IME is composing: a Japanese 変換確定 fires an
            // Enter keydown with isComposing=true (keyCode 229) — that must commit
            // the conversion, not submit. Only a committed Enter sends.
            if (e.nativeEvent.isComposing || e.keyCode === 229) return
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          disabled={loading}
        />
        <button className="chat-send" onClick={() => void send()} disabled={loading || !input.trim()}>
          送信
        </button>
      </div>
    </aside>
  )
}

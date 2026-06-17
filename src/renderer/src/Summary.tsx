import { useState } from 'react'
import type { SessionSummary } from '../../engine/types'
import { api } from './api'

interface Props {
  data: SessionSummary
  sessionId: string
  onBack: () => void
  onRetry: () => void
}

const GRADE_META: Record<number, { label: string; cls: string }> = {
  1: { label: 'Again', cls: 'g1' },
  2: { label: 'Hard', cls: 'g2' },
  3: { label: 'Good', cls: 'g3' },
  4: { label: 'Easy', cls: 'g4' }
}

export function Summary({ data, sessionId, onBack, onRetry }: Props): JSX.Element {
  const [committing, setCommitting] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [leaving, setLeaving] = useState(false) // guards the one-shot retry/back nav

  const retry = (): void => {
    if (leaving) return
    setLeaving(true)
    onRetry()
  }

  const commit = async (): Promise<void> => {
    setCommitting(true)
    setResult(null)
    const r = await api.commit(`study(${data.domain}): session ${sessionId} — ${data.total}問 / 正答率${data.accuracy}%`)
    setResult(r.out || (r.ok ? 'pushed' : 'failed'))
    setCommitting(false)
  }

  return (
    <div className="summary">
      <h1>セッション完了</h1>
      <div className="hero-score">
        <div className="hero-pct">{data.accuracy}%</div>
        <div className="hero-sub">
          {data.correct} / {data.total} 正解（Good+）・{data.domain}
        </div>
      </div>

      <div className="grade-breakdown">
        {[1, 2, 3, 4].map((g) => (
          <div key={g} className={`gb gb-${g}`}>
            <span>{GRADE_META[g].label}</span>
            <b>{data.byGrade[g] ?? 0}</b>
          </div>
        ))}
      </div>

      {data.weakTopics.length > 0 && (
        <p className="weak">
          弱点トピック：<b>{data.weakTopics.join(', ')}</b>
        </p>
      )}

      {data.items.length > 0 && (
        <div className="result-list">
          <div className="result-list-head">出題一覧</div>
          {data.items.map((it, i) => {
            const m = GRADE_META[it.grade] ?? GRADE_META[3]
            return (
              <div key={`${it.id}-${i}`} className={`result-row ${it.correct ? 'ok' : 'ng'}`}>
                <span className="rr-mark">{it.correct ? '✓' : '✗'}</span>
                <span className="rr-q" title={it.q}>
                  {it.q}
                </span>
                <span className="rr-topic">{it.topic}</span>
                <span className={`rr-grade ${m.cls}`}>{m.label}</span>
              </div>
            )
          })}
        </div>
      )}

      <div className="actions center">
        <button className="primary" onClick={retry} disabled={leaving}>
          ↻ もう一度
        </button>
        <button
          className="ghost-btn"
          onClick={commit}
          disabled={committing}
          title="study-log にコミット & プッシュ"
        >
          {committing ? 'push中…' : '💾 コミット & プッシュ'}
        </button>
        <button className="ghost-btn" onClick={onBack}>
          ダッシュボードへ
        </button>
      </div>
      {result && <pre className="commit-out">{result}</pre>}
    </div>
  )
}

import { useState } from 'react'
import type { SessionSummary } from '../../engine/types'
import { api } from './api'

interface Props {
  data: SessionSummary
  sessionId: string
  onBack: () => void
}

export function Summary({ data, sessionId, onBack }: Props): JSX.Element {
  const [committing, setCommitting] = useState(false)
  const [result, setResult] = useState<string | null>(null)

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
      <div className="stat-grid">
        <div className="stat">
          <div className="num">{data.total}</div>
          <div className="lbl">問</div>
        </div>
        <div className="stat">
          <div className="num">{data.accuracy}%</div>
          <div className="lbl">正答率 (Good+)</div>
        </div>
        <div className="stat">
          <div className="num">{data.correct}</div>
          <div className="lbl">正解</div>
        </div>
      </div>

      <div className="grade-breakdown">
        {[1, 2, 3, 4].map((g) => (
          <div key={g} className={`gb gb-${g}`}>
            <span>{['Again', 'Hard', 'Good', 'Easy'][g - 1]}</span>
            <b>{data.byGrade[g] ?? 0}</b>
          </div>
        ))}
      </div>

      {data.weakTopics.length > 0 && (
        <p className="weak">
          弱点トピック：<b>{data.weakTopics.join(', ')}</b>
        </p>
      )}

      <div className="actions center">
        <button className="primary" onClick={commit} disabled={committing}>
          {committing ? 'push中…' : '💾 コミット & プッシュ (study-log)'}
        </button>
        <button className="ghost-btn" onClick={onBack}>
          ダッシュボードへ
        </button>
      </div>
      {result && <pre className="commit-out">{result}</pre>}
    </div>
  )
}

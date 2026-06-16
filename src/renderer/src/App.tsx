import { useCallback, useEffect, useState } from 'react'
import type { DomainInfo, PickedQuestion, SessionSummary } from '../../engine/types'
import { api, Settings } from './api'
import { Session } from './Session'
import { Summary } from './Summary'

type View =
  | { k: 'loading' }
  | { k: 'needRoot' }
  | { k: 'dashboard' }
  | { k: 'session'; domain: string; sessionId: string; questions: PickedQuestion[] }
  | { k: 'summary'; domain: string; sessionId: string; data: SessionSummary }

const VOICES = ['Samantha', 'Alex', 'Daniel', 'Karen', 'Moira', 'Tessa']

function makeSessionId(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

export default function App(): JSX.Element {
  const [config, setConfig] = useState<Settings | null>(null)
  const [domains, setDomains] = useState<DomainInfo[]>([])
  const [view, setView] = useState<View>({ k: 'loading' })
  const [limit, setLimit] = useState(15)
  const [maxNew, setMaxNew] = useState(8)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const c = await api.getConfig()
    setConfig(c)
    if (!c.root) {
      setView({ k: 'needRoot' })
      return
    }
    try {
      setDomains(await api.listDomains())
      setView({ k: 'dashboard' })
    } catch (e) {
      setError(String(e))
      setView({ k: 'dashboard' })
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const pickRoot = async (): Promise<void> => {
    const c = await api.pickRoot()
    setConfig(c)
    if (c.root) await refresh()
  }

  const setVoice = async (voice: string, rate: number): Promise<void> => {
    setConfig(await api.setVoice(voice, rate))
  }

  const start = async (domain: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const qs = await api.pickSession(domain, { limit, maxNew })
      if (qs.length === 0) {
        setError('出題できる問題がありません(問題ファイルが無い、または全て先の予定)。')
      } else {
        setView({ k: 'session', domain, sessionId: makeSessionId(), questions: qs })
      }
    } catch (e) {
      setError(String(e))
    }
    setBusy(false)
  }

  const onSessionDone = async (domain: string, sessionId: string): Promise<void> => {
    const data = await api.summary(domain, sessionId)
    setView({ k: 'summary', domain, sessionId, data })
  }

  if (view.k === 'loading') return <div className="center-screen">読み込み中…</div>

  if (view.k === 'needRoot') {
    return (
      <div className="center-screen col">
        <h1>Study</h1>
        <p className="muted">学習データ(study-log)フォルダが見つかりません。</p>
        <button className="primary" onClick={pickRoot}>
          📁 study-log フォルダを選ぶ
        </button>
      </div>
    )
  }

  if (view.k === 'session') {
    return (
      <Session
        domain={view.domain}
        sessionId={view.sessionId}
        questions={view.questions}
        voice={config?.voice ?? 'Samantha'}
        rate={config?.rate ?? 165}
        onDone={() => void onSessionDone(view.domain, view.sessionId)}
      />
    )
  }

  if (view.k === 'summary') {
    return <Summary data={view.data} sessionId={view.sessionId} onBack={() => void refresh()} />
  }

  // dashboard
  return (
    <div className="dashboard">
      <header className="app-head">
        <h1>Study</h1>
        <div className="cfg">
          <label>
            声
            <select value={config?.voice} onChange={(e) => void setVoice(e.target.value, config?.rate ?? 165)}>
              {VOICES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            速度 {config?.rate}
            <input
              type="range"
              min={120}
              max={220}
              step={5}
              value={config?.rate ?? 165}
              onChange={(e) => void setVoice(config?.voice ?? 'Samantha', Number(e.target.value))}
            />
          </label>
          <button className="icon" title="テスト読み上げ" onClick={() => void api.speak('Hello, this is your study voice.', config?.voice, config?.rate)}>
            🔊
          </button>
        </div>
      </header>

      <div className="controls">
        <label>
          1セッション
          <input type="number" min={1} max={50} value={limit} onChange={(e) => setLimit(Number(e.target.value))} />問
        </label>
        <label>
          うち新規 最大
          <input type="number" min={0} max={50} value={maxNew} onChange={(e) => setMaxNew(Number(e.target.value))} />問
        </label>
      </div>

      {error && <div className="error">{error}</div>}

      {domains.length === 0 ? (
        <p className="muted">問題のあるドメインがありません。study-log に問題を追加してください。</p>
      ) : (
        <div className="domain-grid">
          {domains.map((d) => (
            <button key={d.domain} className="domain-card" onClick={() => void start(d.domain)} disabled={busy}>
              <div className="dname">{d.domain}</div>
              <div className="dcounts">
                <span className="due">復習 {d.due}</span>
                <span className="new">新規 {d.new}</span>
                <span className="total">計 {d.total}</span>
              </div>
              <div className="go">セッション開始 →</div>
            </button>
          ))}
        </div>
      )}

      <footer className="foot muted">
        データ: {config?.root}
      </footer>
    </div>
  )
}

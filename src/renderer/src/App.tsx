import { useCallback, useEffect, useState } from 'react'
import type { DomainInfo, PickedQuestion, SessionSummary } from '../../engine/types'
import { api, Settings, VOICES, ClaudeStatus } from './api'
import { Session } from './Session'
import { Summary } from './Summary'

type View =
  | { k: 'loading' }
  | { k: 'needRoot' }
  | { k: 'dashboard' }
  | { k: 'session'; domain: string; sessionId: string; questions: PickedQuestion[] }
  | { k: 'summary'; domain: string; sessionId: string; data: SessionSummary }

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
  const [claude, setClaude] = useState<ClaudeStatus | null>(null)
  const [claudeBusy, setClaudeBusy] = useState(false)

  const checkClaude = async (): Promise<void> => {
    setClaudeBusy(true)
    setClaude(await api.claudeStatus())
    setClaudeBusy(false)
  }
  const loginClaude = async (): Promise<void> => {
    setClaudeBusy(true)
    await api.claudeLogin()
    setClaude(await api.claudeStatus())
    setClaudeBusy(false)
  }

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
        // No session could be built (e.g. retried after the due queue drained).
        // Route to the dashboard, which renders `error` — otherwise the message
        // is swallowed when start() is invoked from the summary's もう一度.
        setError('出題できる問題がありません(問題ファイルが無い、または全て先の予定)。')
        setView({ k: 'dashboard' })
      } else {
        setView({ k: 'session', domain, sessionId: makeSessionId(), questions: qs })
      }
    } catch (e) {
      setError(String(e))
      setView({ k: 'dashboard' })
    }
    setBusy(false)
  }

  const onSessionDone = async (domain: string, sessionId: string): Promise<void> => {
    const data = await api.summary(domain, sessionId)
    setView({ k: 'summary', domain, sessionId, data })
  }

  // Persistent top bar (same position on every page): title + voice/speed.
  const topbar =
    config && view.k !== 'loading' && view.k !== 'needRoot' ? (
      <header className="topbar">
        <button className="brand" onClick={() => void refresh()}>
          Study
        </button>
        <div className="cfg">
          <label>
            声
            <select value={config.voice} onChange={(e) => void setVoice(e.target.value, config.rate)}>
              {VOICES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            速度 {config.rate}
            <input
              type="range"
              min={120}
              max={220}
              step={5}
              value={config.rate}
              onChange={(e) => void setVoice(config.voice, Number(e.target.value))}
            />
          </label>
          <button
            className="icon"
            title="テスト読み上げ"
            onClick={() => void api.speak('Hello, this is your study voice.', config.voice, config.rate)}
          >
            🔊
          </button>
        </div>
      </header>
    ) : null

  let content: JSX.Element
  if (view.k === 'loading') {
    content = <div className="center-screen">読み込み中…</div>
  } else if (view.k === 'needRoot') {
    content = (
      <div className="center-screen col">
        <h1>Study</h1>
        <p className="muted">学習データ(study-log)フォルダが見つかりません。</p>
        <button className="primary" onClick={pickRoot}>
          📁 study-log フォルダを選ぶ
        </button>
      </div>
    )
  } else if (view.k === 'session') {
    content = (
      <Session
        domain={view.domain}
        sessionId={view.sessionId}
        questions={view.questions}
        voice={config?.voice ?? 'Samantha'}
        rate={config?.rate ?? 165}
        onDone={() => void onSessionDone(view.domain, view.sessionId)}
      />
    )
  } else if (view.k === 'summary') {
    content = (
      <Summary
        data={view.data}
        sessionId={view.sessionId}
        onBack={() => void refresh()}
        onRetry={() => void start(view.domain)}
      />
    )
  } else {
    content = (
      <div className="dashboard">
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

        <div className="claude-bar">
          <span>Claude Code 連携:</span>
          {claudeBusy ? (
            <span>確認中…</span>
          ) : !claude ? (
            <button className="ghost-btn sm" onClick={() => void checkClaude()}>
              接続確認
            </button>
          ) : claude.connected ? (
            <>
              <span className="ok">✓ {claude.detail}</span>
              <button className="link" onClick={() => void checkClaude()}>
                再確認
              </button>
            </>
          ) : (
            <>
              <span className="ng">{claude.detail}</span>
              {claude.installed && (
                <button className="ghost-btn sm" onClick={() => void loginClaude()}>
                  URLで連携
                </button>
              )}
            </>
          )}
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

        <footer className="foot muted">データ: {config?.root}</footer>
      </div>
    )
  }

  return (
    <div className="app">
      {topbar}
      {content}
    </div>
  )
}

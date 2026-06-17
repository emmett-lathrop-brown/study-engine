import { useCallback, useEffect, useState } from 'react'
import type { DomainInfo, PickedQuestion, SessionSummary, StudyStats } from '../../engine/types'
import { api, Settings, VOICES, ClaudeStatus } from './api'
import { Session } from './Session'
import { Summary } from './Summary'
import { buildLearnQuestions } from './learn'

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
  const [stats, setStats] = useState<StudyStats | null>(null)
  const [view, setView] = useState<View>({ k: 'loading' })
  const [limit, setLimit] = useState(15)
  const [maxNew, setMaxNew] = useState(8)
  const [learnMode, setLearnMode] = useState(false)
  const [busy, setBusy] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportMsg, setExportMsg] = useState<string | null>(null)
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
    setExportMsg(null) // don't carry a stale "wrote N md" note across dashboard visits
    const c = await api.getConfig()
    setConfig(c)
    if (!c.root) {
      setView({ k: 'needRoot' })
      return
    }
    try {
      setDomains(await api.listDomains())
      setView({ k: 'dashboard' })
      try {
        setStats(await api.stats())
      } catch {
        // stats are a nice-to-have; never let them blank the domain grid.
      }
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

  const setVoice = async (voice: string, rate: number, autoSpeak?: boolean): Promise<void> => {
    setConfig(await api.setVoice(voice, rate, autoSpeak))
  }

  const setFontSize = async (fontSize: number): Promise<void> => {
    setConfig(await api.setFontSize(fontSize))
  }

  // Drive content scale off the persisted font size (used by the question body,
  // choices and answer input via the --q-size CSS variable).
  useEffect(() => {
    if (config?.fontSize) {
      document.documentElement.style.setProperty('--q-size', `${config.fontSize}px`)
    }
  }, [config?.fontSize])

  const start = async (domain: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      let qs = await api.pickSession(domain, { limit, maxNew })
      if (qs.length === 0) {
        // No session could be built (e.g. retried after the due queue drained).
        // Route to the dashboard, which renders `error` — otherwise the message
        // is swallowed when start() is invoked from the summary's もう一度.
        setError('出題できる問題がありません(問題ファイルが無い、または全て先の予定)。')
        setView({ k: 'dashboard' })
      } else {
        if (learnMode) {
          // Turn free-recall questions into 4-choice (may call Claude for distractors).
          setPreparing(true)
          qs = await buildLearnQuestions(qs)
          setPreparing(false)
        }
        setView({ k: 'session', domain, sessionId: makeSessionId(), questions: qs })
      }
    } catch (e) {
      setError(String(e))
      setView({ k: 'dashboard' })
    }
    setPreparing(false)
    setBusy(false)
  }

  const onSessionDone = async (domain: string, sessionId: string): Promise<void> => {
    const data = await api.summary(domain, sessionId)
    setView({ k: 'summary', domain, sessionId, data })
  }

  const exportMd = async (): Promise<void> => {
    setExporting(true)
    setExportMsg(null)
    try {
      const res = await api.exportMarkdown()
      const total = res.reduce((n, r) => n + r.count, 0)
      setExportMsg(`${total}問を各ドメインの export/ に Markdown 書き出ししました。`)
    } catch (e) {
      setExportMsg(`書き出し失敗: ${String(e)}`)
    }
    setExporting(false)
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
          <label className="font-ctl">
            文字 {config.fontSize}
            <button
              className="icon"
              title="文字を小さく"
              onClick={() => void setFontSize(config.fontSize - 2)}
              disabled={config.fontSize <= 16}
            >
              A−
            </button>
            <button
              className="icon"
              title="文字を大きく"
              onClick={() => void setFontSize(config.fontSize + 2)}
              disabled={config.fontSize >= 30}
            >
              A＋
            </button>
          </label>
          <label className="autospeak" title="出題・解答時に英語を自動読み上げ">
            <input
              type="checkbox"
              checked={config.autoSpeak}
              onChange={(e) => void setVoice(config.voice, config.rate, e.target.checked)}
            />
            自動読み上げ
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
        autoSpeak={config?.autoSpeak ?? true}
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
        {stats && (
          <div className="stats-strip">
            <div className="stat-pill">
              <span className="sp-num">🔥 {stats.streak}</span>
              <span className="sp-lbl">継続(日)</span>
            </div>
            <div className="stat-pill">
              <span className="sp-num">{stats.reviewsToday}</span>
              <span className="sp-lbl">今日</span>
            </div>
            <div className="stat-pill">
              <span className="sp-num">{stats.totalReviews}</span>
              <span className="sp-lbl">総レビュー</span>
            </div>
            <div className="stat-pill">
              <span className="sp-num">{stats.reviewedDays}</span>
              <span className="sp-lbl">学習日数</span>
            </div>
          </div>
        )}

        <div className="controls">
          <label>
            1セッション
            <input type="number" min={1} max={50} value={limit} onChange={(e) => setLimit(Number(e.target.value))} />問
          </label>
          <label>
            うち新規 最大
            <input type="number" min={0} max={50} value={maxNew} onChange={(e) => setMaxNew(Number(e.target.value))} />問
          </label>
          <label className="check">
            <input type="checkbox" checked={learnMode} onChange={(e) => setLearnMode(e.target.checked)} />
            速習(記述を4択に)
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
        {preparing && <div className="prep-note">速習の選択肢を生成中…</div>}

        {domains.length === 0 ? (
          <p className="muted">問題のあるドメインがありません。study-log に問題を追加してください。</p>
        ) : (
          <div className="domain-grid">
            {domains.map((d) => {
              const m = stats?.maturity.find((x) => x.domain === d.domain)
              const pct = (n: number): string => (m && m.total ? `${(n / m.total) * 100}%` : '0%')
              return (
                <button key={d.domain} className="domain-card" onClick={() => void start(d.domain)} disabled={busy}>
                  <div className="dname">{d.domain}</div>
                  <div className="dcounts">
                    <span className="due">復習 {d.due}</span>
                    <span className="new">新規 {d.new}</span>
                    <span className="total">計 {d.total}</span>
                  </div>
                  {m && m.total > 0 && (
                    <div className="maturity">
                      <div className="mat-bar">
                        <span className="mat mature" style={{ width: pct(m.mature) }} />
                        <span className="mat learning" style={{ width: pct(m.learning) }} />
                        <span className="mat unseen" style={{ width: pct(m.unseen) }} />
                      </div>
                      <div className="mat-legend">
                        習得 {m.mature} ・ 学習中 {m.learning} ・ 未 {m.unseen}
                      </div>
                    </div>
                  )}
                  <div className="go">{learnMode ? '速習で開始 →' : 'セッション開始 →'}</div>
                </button>
              )
            })}
          </div>
        )}

        <footer className="foot">
          <div className="foot-actions">
            <button className="ghost-btn sm" onClick={() => void exportMd()} disabled={exporting}>
              {exporting ? '書き出し中…' : '📤 Obsidian用に md 書き出し'}
            </button>
            {exportMsg && <span className="muted">{exportMsg}</span>}
          </div>
          <div className="muted">データ: {config?.root}</div>
        </footer>
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

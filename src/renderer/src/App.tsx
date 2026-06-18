import { useCallback, useEffect, useState } from 'react'
import type { DomainInfo, PickedQuestion, SessionSummary, StudyStats } from '../../engine/types'
import { LEECH_LAPSES } from '../../engine/srs'
import { api, Settings, VOICES, ClaudeStatus } from './api'
import { Session } from './Session'
import { Summary } from './Summary'
import { Heatmap } from './Heatmap'
import { InfoTip } from './InfoTip'
import { CramSession } from './CramSession'
import { buildLearnQuestions } from './learn'
import { initCram, type CardLike, type CramCard } from '../../engine/cram'

type Mode = 'normal' | 'learn' | 'cram'

const isFreeType = (t: string): boolean => t === 'cloze' || t === 'translation' || t === 'free'

// Map a picked question (and its buildLearnQuestions output) to the cram core's
// CardLike. canEscalate = the source was free-recall (cloze/translation/free), i.e.
// it has a TYPED form. MCQ leg: native single_choice/multi keep their own choices; a
// free card uses the converted 4-choice when Claude produced one, else null (no MCQ
// leg → cram shows it as a recall card).
function toCardLike(orig: PickedQuestion, conv?: PickedQuestion): CardLike {
  const fromFree = isFreeType(orig.type)
  let mcq: { choices: string[]; answer: string } | null = null
  if (!fromFree) {
    if (orig.choices && orig.choices.length) mcq = { choices: orig.choices, answer: orig.answer }
  } else if (conv && conv.type === 'single_choice' && conv.choices && conv.choices.length) {
    mcq = { choices: conv.choices, answer: conv.answer }
  }
  return { id: orig.id, q: orig.q, answer: orig.answer, choices: orig.choices, mcq, canEscalate: fromFree }
}

type View =
  | { k: 'loading' }
  | { k: 'needRoot' }
  | { k: 'dashboard' }
  | { k: 'session'; domain: string; sessionId: string; questions: PickedQuestion[] }
  | { k: 'cram'; domain: string; cards: CramCard[] }
  | { k: 'summary'; domain: string; sessionId: string; data: SessionSummary }

function makeSessionId(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  // Seconds + a short random suffix so a quick 「ミスをもう一度」 (or back-to-back
  // retry) launched in the same wall-clock minute can never alias the finished
  // session's id: summary() scopes purely by session string, so a collision would
  // fold both sessions' reviews into one summary (inflated total / wrong accuracy).
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`
}

export default function App(): JSX.Element {
  const [config, setConfig] = useState<Settings | null>(null)
  const [domains, setDomains] = useState<DomainInfo[]>([])
  const [stats, setStats] = useState<StudyStats | null>(null)
  const [view, setView] = useState<View>({ k: 'loading' })
  const [limit, setLimit] = useState(15)
  const [maxNew, setMaxNew] = useState(8)
  const [mode, setMode] = useState<Mode>('normal')
  const [busy, setBusy] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportMsg, setExportMsg] = useState<string | null>(null)
  const [genMsg, setGenMsg] = useState<string | null>(null)
  const [genningDomain, setGenningDomain] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [claude, setClaude] = useState<ClaudeStatus | null>(null)
  const [claudeBusy, setClaudeBusy] = useState(false)
  const [fsrsGateOpen, setFsrsGateOpen] = useState(false)

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

  const applyAlgo = async (algo: 'sm2' | 'fsrs', desiredRetention: number): Promise<void> => {
    setConfig(await api.setAlgo(algo, desiredRetention))
  }

  // Switching to FSRS while SM-2 history exists must pass the rebuild gate: those
  // cards still hold SM-2 state, so grading them as FSRS before `rebuild-state
  // --write --prune` would schedule off an un-migrated state. With no reviewed
  // cards (total === new in every domain) there's nothing to migrate — apply直.
  const onAlgoChange = (algo: 'sm2' | 'fsrs'): void => {
    if (!config) return
    if (algo === 'fsrs' && config.algo !== 'fsrs' && domains.some((d) => d.total - d.new > 0)) {
      setFsrsGateOpen(true)
      return
    }
    void applyAlgo(algo, config.desiredRetention)
  }

  // Drive content scale off the persisted font size (used by the question body,
  // choices and answer input via the --q-size CSS variable).
  useEffect(() => {
    if (config?.fontSize) {
      document.documentElement.style.setProperty('--q-size', `${config.fontSize}px`)
    }
  }, [config?.fontSize])

  // Start a session. With `redrillIds`, rebuild a session from exactly those
  // question ids (the misses just made) instead of the due/new queue — see
  // Summary's 「ミスをもう一度」. Everything else (learn mode, error routing) is
  // identical, so a re-drill behaves like もう一度 but scoped to the missed cards.
  const start = async (domain: string, redrillIds?: string[]): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      let qs = await api.pickSession(domain, redrillIds ? { ids: redrillIds } : { limit, maxNew })
      if (qs.length === 0) {
        // No session could be built (e.g. retried after the due queue drained, or
        // every missed question's file has since gone). Route to the dashboard,
        // which renders `error` — otherwise the message is swallowed when start()
        // is invoked from the summary's もう一度 / ミスをもう一度.
        setError(
          redrillIds
            ? 'ミスした問題を再出題できませんでした(問題ファイルが見つかりません)。'
            : '出題できる問題がありません(問題ファイルが無い、または全て先の予定)。'
        )
        setView({ k: 'dashboard' })
      } else if (mode === 'cram' && !redrillIds) {
        // Cram: build the 4-choice legs (free→MCQ via Claude; native choice passes
        // through), then hand CardLikes to the ephemeral round engine. The cram view
        // carries no sessionId — it never writes SRS history.
        setPreparing(true)
        const mcq = await buildLearnQuestions(qs)
        setPreparing(false)
        const byId = new Map(mcq.map((m) => [m.id, m]))
        setView({ k: 'cram', domain, cards: initCram(qs.map((qq) => toCardLike(qq, byId.get(qq.id)))) })
      } else {
        if (mode === 'learn') {
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

  // Build a question-generation prompt for this domain (CONTEXT + schema + gaps)
  // and copy it to the clipboard, to paste into a real Claude Code session — the
  // in-app chat is sandboxed and can't write files (CLAUDE.md §5/§7).
  const genQuestions = async (domain: string): Promise<void> => {
    setGenningDomain(domain)
    setGenMsg(null)
    try {
      await api.copyToClipboard(await api.genPrompt(domain))
      setGenMsg(
        `「${domain}」の生成プロンプトをコピーしました。Claude Code（study-log を開いたセッション）に貼り付けて問題を生成 → レビューしてコミットしてください。`
      )
    } catch (e) {
      setGenMsg(`生成プロンプトの取得に失敗: ${String(e)}`)
    }
    setGenningDomain(null)
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
            className="icon voice-test"
            title="現在の声で固定フレーズを試聴（回答の読み上げではありません）"
            onClick={() => void api.speak('Hello, this is your study voice.', config.voice, config.rate)}
          >
            🔊 声テスト
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
  } else if (view.k === 'cram') {
    content = <CramSession domain={view.domain} cards={view.cards} onExit={() => void refresh()} />
  } else if (view.k === 'summary') {
    content = (
      <Summary
        data={view.data}
        sessionId={view.sessionId}
        onBack={() => void refresh()}
        onRetry={() => void start(view.domain)}
        onRedrill={(ids) => void start(view.domain, ids)}
      />
    )
  } else {
    content = (
      <div className="dashboard">
        {fsrsGateOpen && config && (
          <div className="modal-backdrop" onClick={() => setFsrsGateOpen(false)}>
            <div className="modal-card" onClick={(e) => e.stopPropagation()}>
              <h3 className="modal-title">FSRS に切り替えますか？</h3>
              <p className="modal-body">
                既存の学習状態は SM-2 で計算されています。FSRS を有効にする前に、ターミナルで{' '}
                <code>pnpm rebuild-state --write --prune</code>{' '}
                を実行し、履歴から state.json を FSRS で再計算してください（自動バックアップが作られ、いつでも
                SM-2 に戻せます）。
                <br />
                未移行のまま採点しても各カードの reps / interval から近似シードで継続します（壊れません）が、移行を推奨します。
              </p>
              <div className="modal-actions">
                <button className="ghost-btn" onClick={() => setFsrsGateOpen(false)}>
                  キャンセル
                </button>
                <button
                  className="primary"
                  onClick={() => {
                    void applyAlgo('fsrs', config.desiredRetention)
                    setFsrsGateOpen(false)
                  }}
                >
                  FSRS を有効化
                </button>
              </div>
            </div>
          </div>
        )}
        {stats && (
          <>
            <div className="stats-strip">
              <div className="stat-pill">
                <span className="sp-num">🔥 {stats.streak}</span>
                <span className="sp-lbl">
                  継続(日)
                  <InfoTip term="ストリーク（継続日数）">
                    1日でも学習した日が、何日連続で続いているか。毎日続けるほど伸びます。
                  </InfoTip>
                </span>
              </div>
              <div className="stat-pill">
                <span className="sp-num">{stats.reviewsToday}</span>
                <span className="sp-lbl">今日</span>
              </div>
              <div className="stat-pill">
                <span className="sp-num">{stats.totalReviews}</span>
                <span className="sp-lbl">
                  総レビュー
                  <InfoTip term="総レビュー">
                    これまでに採点した延べ回数（問題数ではなく、解いた回数の累計）。
                  </InfoTip>
                </span>
              </div>
              <div className="stat-pill">
                <span className="sp-num">{stats.reviewedDays}</span>
                <span className="sp-lbl">学習日数</span>
              </div>
            </div>
            <Heatmap daily={stats.dailyCounts} />
          </>
        )}

        <div className="controls">
          <label>
            1セッション
            <input type="number" min={1} max={50} value={limit} onChange={(e) => setLimit(Number(e.target.value))} />問
          </label>
          <label>
            うち新規 最大
            <InfoTip term="新規カード">
              まだ一度も解いていないカード。1回のセッションに混ぜる新規問題の上限です。
            </InfoTip>
            <input type="number" min={0} max={50} value={maxNew} onChange={(e) => setMaxNew(Number(e.target.value))} />問
          </label>
          <label>
            モード
            <InfoTip term="学習モード">
              通常＝SRS の予定どおり採点して記録。速習＝記述をその場で4択に変換して手早く回す（記録あり）。Cram＝セットを覚えきるまで反復する練習（記録なし・SRS の予定は変わりません）。
            </InfoTip>
            <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
              <option value="normal">通常</option>
              <option value="learn">速習（記録あり）</option>
              <option value="cram">Cram（記録なし・反復）</option>
            </select>
          </label>
          {config && (
            <>
              <label>
                方式
                <InfoTip term="方式（復習アルゴリズム）">
                  復習の間隔を決める計算方式。SM-2＝Anki でも使われる定番。FSRS＝記憶の定着度を1問ごとに推定する新しい方式で、より効率的とされます。迷ったら SM-2 のままで大丈夫です。
                </InfoTip>
                <select
                  value={config.algo}
                  onChange={(e) => onAlgoChange(e.target.value as 'sm2' | 'fsrs')}
                >
                  <option value="sm2">SM-2</option>
                  <option value="fsrs">FSRS</option>
                </select>
              </label>
              {config.algo === 'fsrs' && (
                <label>
                  目標保持率 {Math.round(config.desiredRetention * 100)}%
                  <InfoTip term="目標保持率">
                    FSRS が狙う「復習した時に思い出せている確率」。高いほど忘れにくい代わりに復習が増え、低いほど復習が減ります。既定は 90%。
                  </InfoTip>
                  <input
                    type="range"
                    min={80}
                    max={97}
                    step={1}
                    value={Math.round(config.desiredRetention * 100)}
                    onChange={(e) => void applyAlgo('fsrs', Number(e.target.value) / 100)}
                  />
                </label>
              )}
            </>
          )}
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
        {genMsg && <div className="gen-note">{genMsg}</div>}
        {preparing && (
          <div className="prep-note">
            {mode === 'cram' ? 'Cram の選択肢を生成中…' : '速習の選択肢を生成中…'}
          </div>
        )}

        {domains.length === 0 ? (
          <p className="muted">問題のあるドメインがありません。study-log に問題を追加してください。</p>
        ) : (
          <>
            <div className="term-legend">
              <span className="tl-lead">カードの状態:</span>
              <span>
                復習
                <InfoTip term="復習（due）">
                  復習予定日が今日以前まで来ていて、出題待ちになっているカード。
                </InfoTip>
              </span>
              <span>
                新規
                <InfoTip term="新規">まだ一度も解いていないカード。</InfoTip>
              </span>
              <span>
                習得
                <InfoTip term="習得（mature）">
                  復習間隔が21日以上に伸びた、しっかり定着しているカード。
                </InfoTip>
              </span>
              <span>
                学習中
                <InfoTip term="学習中">一度は解いたが、まだ復習間隔が短い育成中のカード。</InfoTip>
              </span>
              <span>
                未
                <InfoTip term="未（未学習）">まだ一度も解いていない、学習履歴のないカード。</InfoTip>
              </span>
              <span>
                🐌
                <InfoTip term="leech（苦手カード）">
                  {LEECH_LAPSES}回以上ミスしている「なかなか覚えられない」カード。🐌 の目印が付きます（自動で出題を止めることはしません）。
                </InfoTip>
              </span>
            </div>
            <div className="domain-grid">
            {domains.map((d) => {
              const m = stats?.maturity.find((x) => x.domain === d.domain)
              const pct = (n: number): string => (m && m.total ? `${(n / m.total) * 100}%` : '0%')
              return (
                <div key={d.domain} className="domain-cell">
                  <button className="domain-card" onClick={() => void start(d.domain)} disabled={busy}>
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
                          {m.leeches > 0 && (
                            <span className="leech-flag" title={`苦手カード（${LEECH_LAPSES}回以上ミス）`}>
                              {' '}・ 🐌 {m.leeches}
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                    <div className="go">
                      {mode === 'cram'
                        ? 'Cram で開始 →'
                        : mode === 'learn'
                          ? '速習で開始 →'
                          : 'セッション開始 →'}
                    </div>
                  </button>
                  <button
                    className="ghost-btn sm gen-btn"
                    onClick={() => void genQuestions(d.domain)}
                    disabled={busy || genningDomain !== null}
                    title="Claude Code 用の生成プロンプトをコピー（CONTEXT＋スキーマ＋既存ギャップ入り）"
                  >
                    {genningDomain === d.domain ? 'コピー中…' : '📝 問題を作る by Claude Code'}
                  </button>
                </div>
              )
            })}
          </div>
          </>
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

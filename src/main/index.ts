import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { spawn } from 'child_process'
import { existsSync, promises as fs, readdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { domainInfo, gradeOne, pick, studyStats, summary } from '../engine/session'
import type { PickOptions } from '../engine/session'
import { exportMarkdown } from '../engine/export'
import { buildGenPrompt } from '../engine/gen'
import { readChat, writeChat } from '../engine/store'
import type { ChatMessage, SrsState } from '../engine/types'
import { buildFsrs } from '../engine/srs-fsrs'
import { reviewWith } from '../engine/srs-dispatch'
import { todayISO } from '../engine/srs'

// ---------------------------------------------------------------------------
// Config (study-log path + TTS voice) persisted in userData/settings.json
// ---------------------------------------------------------------------------
interface Settings {
  root: string | null
  voice: string
  rate: number
  fontSize: number // question-body base font size in px (content scales off this)
  autoSpeak: boolean
  algo: 'sm2' | 'fsrs' // active scheduler; SM-2 is the load-bearing default
  desiredRetention: number // FSRS target retention (0.80–0.97); inert under SM-2
}
const FONT_MIN = 16
const FONT_MAX = 30
const clampFont = (n: number): number => Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(n)))
const RETENTION_MIN = 0.8
const RETENTION_MAX = 0.97
const clampRetention = (n: number): number =>
  Number.isFinite(n) ? Math.max(RETENTION_MIN, Math.min(RETENTION_MAX, n)) : 0.9
const settingsFile = (): string => join(app.getPath('userData'), 'settings.json')

async function loadSettings(): Promise<Settings> {
  let saved: Partial<Settings> = {}
  try {
    saved = JSON.parse(await fs.readFile(settingsFile(), 'utf8'))
  } catch {
    /* first run */
  }
  // Resolve the study-log location from the env override, then the saved
  // choice; otherwise null → the UI shows the folder picker. (No hardcoded
  // path: this is a public, machine-agnostic repo.)
  let root = process.env.STUDY_LOG ?? saved.root ?? null
  if (root && !existsSync(root)) root = null
  return {
    root,
    voice: saved.voice ?? 'Samantha',
    rate: saved.rate ?? 165,
    fontSize: clampFont(saved.fontSize ?? 20),
    autoSpeak: saved.autoSpeak ?? true,
    algo: saved.algo ?? 'sm2',
    desiredRetention: clampRetention(saved.desiredRetention ?? 0.9)
  }
}

async function saveSettings(s: Settings): Promise<void> {
  await fs.writeFile(settingsFile(), JSON.stringify(s, null, 2) + '\n', 'utf8')
}

let settings: Settings

function requireRoot(): string {
  if (!settings.root) throw new Error('study-log フォルダが未設定です。設定から選んでください。')
  return settings.root
}

// ---------------------------------------------------------------------------
// say (TTS) — one utterance at a time; a new call interrupts the previous one
// ---------------------------------------------------------------------------
let currentSay: ReturnType<typeof spawn> | null = null
function speak(text: string, voice?: string, rate?: number): Promise<void> {
  return new Promise((resolve) => {
    if (currentSay) {
      currentSay.kill()
      currentSay = null
    }
    if (!text.trim()) return resolve()
    const child = spawn('say', ['-v', voice ?? settings.voice, '-r', String(rate ?? settings.rate), text])
    currentSay = child
    const done = (): void => {
      if (currentSay === child) currentSay = null
      resolve()
    }
    child.on('close', done)
    child.on('error', done)
  })
}

// ---------------------------------------------------------------------------
// git — commit + push the study-log at session end
// ---------------------------------------------------------------------------
function runGit(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => resolve({ code: code ?? 0, out: out.trim() }))
    child.on('error', (e) => resolve({ code: 1, out: String(e) }))
  })
}

// GitHub blob base for the study-log repo (e.g. https://github.com/owner/repo/blob/main),
// derived from its git remote so the UI can deep-link a question to its source file.
// null if root is unset or the remote is not a github URL.
async function repoWebBase(): Promise<string | null> {
  if (!settings.root) return null
  const remote = await runGit(settings.root, ['remote', 'get-url', 'origin'])
  const m = remote.out.match(/github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?\s*$/)
  if (remote.code !== 0 || !m) return null
  const branch = await runGit(settings.root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const ref = branch.code === 0 && branch.out && branch.out !== 'HEAD' ? branch.out : 'main'
  return `https://github.com/${m[1]}/${m[2]}/blob/${ref}`
}

async function commit(message: string): Promise<{ ok: boolean; out: string }> {
  const root = requireRoot()
  await runGit(root, ['add', '-A'])
  const status = await runGit(root, ['status', '--porcelain'])
  if (!status.out) return { ok: true, out: 'コミットする変更はありません。' }
  const c = await runGit(root, ['commit', '-m', message])
  if (c.code !== 0) return { ok: false, out: c.out }
  const p = await runGit(root, ['push'])
  return { ok: p.code === 0, out: `${c.out}\n${p.out}`.trim() }
}

// ---------------------------------------------------------------------------
// Claude Code integration (self-contained): the app shells out to the `claude`
// CLI in headless print mode. Auth is shared with the user's existing Claude
// Code login (macOS keychain); `setup-token` opens an OAuth URL when missing.
// No API key / secret is ever stored by this app.
// ---------------------------------------------------------------------------
let claudeBinCache: string | null | undefined

function resolveClaudeBin(): string | null {
  if (claudeBinCache !== undefined) return claudeBinCache
  const cands: string[] = []
  if (process.env.CLAUDE_BIN) cands.push(process.env.CLAUDE_BIN)
  // mise-managed node installs
  try {
    const miseNode = join(homedir(), '.local/share/mise/installs/node')
    for (const v of readdirSync(miseNode)) cands.push(join(miseNode, v, 'bin/claude'))
  } catch {
    /* no mise */
  }
  cands.push(
    join(homedir(), '.claude/local/claude'),
    join(homedir(), '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude'
  )
  claudeBinCache = cands.find((c) => existsSync(c)) ?? null
  return claudeBinCache
}

interface AskResult {
  ok: boolean
  text?: string
  error?: string
}

// One-shot call to the `claude` CLI in headless print mode. Sandboxed: cwd is the
// app temp dir and no tools/files are exposed — pure Q&A over the prompt, auth
// shared with the user's existing login. The in-app chat builds on this by
// resending a self-contained transcript each turn (it does NOT use session
// resume), so a conversation is reproducible from its persisted log and survives
// restarts.
function claudeAsk(message: string, model?: string): Promise<AskResult> {
  const bin = resolveClaudeBin()
  if (!bin) return Promise.resolve({ ok: false, error: 'claude CLI が見つかりません(未導入)。' })
  return new Promise((resolve) => {
    const args = ['-p', '--output-format', 'json', '--max-turns', '1']
    if (model) args.push('--model', model)
    const child = spawn(bin, args, { cwd: app.getPath('temp') })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => resolve({ ok: false, error: String(e) }))
    child.on('close', () => {
      try {
        const j = JSON.parse(out) as {
          is_error?: boolean
          api_error_status?: string | null
          result?: string
        }
        if (j.is_error || j.api_error_status) {
          resolve({ ok: false, error: j.result || j.api_error_status || 'Claude エラー' })
        } else {
          resolve({ ok: true, text: (j.result ?? '').trim() })
        }
      } catch {
        resolve({ ok: false, error: (err || out || 'claude の応答を解析できませんでした').slice(0, 300) })
      }
    })
    child.stdin.write(message)
    child.stdin.end()
  })
}

interface ClaudeStatus {
  installed: boolean
  connected: boolean
  detail: string
}

async function claudeStatus(): Promise<ClaudeStatus> {
  const bin = resolveClaudeBin()
  if (!bin) {
    return { installed: false, connected: false, detail: 'claude CLI 未導入(npm i -g @anthropic-ai/claude-code)' }
  }
  const r = await claudeAsk('OK とだけ返して', 'haiku')
  return r.ok
    ? { installed: true, connected: true, detail: '連携完了(既存ログインを共有)' }
    : { installed: true, connected: false, detail: r.error ?? '未接続' }
}

// VSCode-style: open the OAuth URL that `claude setup-token` prints.
function claudeLogin(win: BrowserWindow | null): Promise<{ ok: boolean; detail: string }> {
  const bin = resolveClaudeBin()
  if (!bin) return Promise.resolve({ ok: false, detail: 'claude CLI 未導入' })
  return new Promise((resolve) => {
    const child = spawn(bin, ['setup-token'], { cwd: app.getPath('temp') })
    let opened = false
    let buf = ''
    const scan = (chunk: string): void => {
      buf += chunk
      const m = buf.match(/https?:\/\/\S*(?:anthropic|claude)\S*/)
      if (m && !opened) {
        opened = true
        shell.openExternal(m[0])
        win?.webContents.send('claude:login-url', m[0])
      }
    }
    child.stdout.on('data', (d) => scan(String(d)))
    child.stderr.on('data', (d) => scan(String(d)))
    child.on('error', (e) => resolve({ ok: false, detail: String(e) }))
    child.on('close', (code) => resolve({ ok: code === 0, detail: code === 0 ? '連携完了' : 'ログイン未完了' }))
  })
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function registerIpc(): void {
  ipcMain.handle('config:get', () => settings)
  ipcMain.handle('config:pickRoot', async () => {
    const r = await dialog.showOpenDialog({
      title: 'study-log フォルダを選択',
      properties: ['openDirectory']
    })
    if (r.canceled || !r.filePaths[0]) return settings
    settings = { ...settings, root: r.filePaths[0] }
    await saveSettings(settings)
    return settings
  })
  ipcMain.handle('config:setVoice', async (_e, voice: string, rate: number, autoSpeak?: boolean) => {
    settings = { ...settings, voice, rate, autoSpeak: autoSpeak ?? settings.autoSpeak }
    await saveSettings(settings)
    return settings
  })
  ipcMain.handle('config:setFontSize', async (_e, fontSize: number) => {
    settings = { ...settings, fontSize: clampFont(fontSize) }
    await saveSettings(settings)
    return settings
  })
  ipcMain.handle('config:setAlgo', async (_e, algo: 'sm2' | 'fsrs', desiredRetention: number) => {
    const dr = clampRetention(desiredRetention)
    settings = { ...settings, algo, desiredRetention: dr }
    buildFsrs(dr) // live-apply retention so the FSRS scheduler reflects the slider
    await saveSettings(settings)
    return settings
  })

  ipcMain.handle('repo:webBase', () => repoWebBase())
  ipcMain.handle('domains:list', () => domainInfo(requireRoot()))
  ipcMain.handle('stats:get', () => studyStats(requireRoot()))
  ipcMain.handle('session:pick', (_e, domain: string, opts: PickOptions) =>
    pick(requireRoot(), domain, opts)
  )
  ipcMain.handle(
    'session:grade',
    (_e, domain: string, session: string, id: string, grade: number) =>
      gradeOne(requireRoot(), domain, session, id, grade, undefined, settings.algo)
  )
  ipcMain.handle('session:summary', (_e, domain: string, session: string) =>
    summary(requireRoot(), domain, session)
  )
  // Nominal next-interval per grade, computed in MAIN (which owns the active algo)
  // so the renderer never imports the FSRS scheduler. SM-2 here is fuzz-free (seed
  // 0) = the same nominal value the grade buttons showed before; the live record()
  // still fuzzes the stored SM-2 interval (unchanged, long-accepted divergence).
  ipcMain.handle(
    'session:preview',
    (_e, _domain: string, _id: string, state: SrsState, grades: number[]) =>
      Object.fromEntries(grades.map((g) => [g, reviewWith(settings.algo, state, g, todayISO()).interval]))
  )

  ipcMain.handle('speak', (_e, text: string, voice?: string, rate?: number) =>
    speak(text, voice, rate)
  )
  ipcMain.handle('speak:stop', () => {
    if (currentSay) {
      currentSay.kill()
      currentSay = null
    }
  })
  ipcMain.handle('export:md', () => exportMarkdown(requireRoot()))
  ipcMain.handle('gen:prompt', (_e, domain: string) => buildGenPrompt(requireRoot(), domain))
  ipcMain.handle('chat:get', (_e, domain: string, id: string) => readChat(requireRoot(), domain, id))
  ipcMain.handle('chat:save', (_e, domain: string, id: string, messages: ChatMessage[]) =>
    writeChat(requireRoot(), domain, id, messages)
  )
  ipcMain.handle('git:commit', (_e, message: string) => commit(message))
  ipcMain.handle('clipboard:write', (_e, text: string) => clipboard.writeText(text))
  ipcMain.handle('open:external', (_e, url: string) => shell.openExternal(url))

  ipcMain.handle('claude:status', () => claudeStatus())
  ipcMain.handle('claude:ask', (_e, prompt: string, model?: string) => claudeAsk(prompt, model))
  // Chat shares the one-shot core; the renderer resends a self-contained transcript.
  ipcMain.handle('claude:chat', (_e, message: string, model?: string) => claudeAsk(message, model))
  ipcMain.handle('claude:login', () => claudeLogin(BrowserWindow.getAllWindows()[0] ?? null))
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow(): void {
  const win = new BrowserWindow({
    width: 1000,
    height: 780,
    minWidth: 720,
    minHeight: 560,
    show: false,
    title: 'Study',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(async () => {
  settings = await loadSettings()
  buildFsrs(settings.desiredRetention) // prime the FSRS instance with saved retention
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

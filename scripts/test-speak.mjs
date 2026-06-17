// E2E probe: does the reveal-block 🔊 button actually invoke api.speak('speak')?
// Launches the built app under Playwright, replaces the main-process 'speak' IPC
// handler with a recorder (no audio), reveals an answer, then compares three
// triggers: DOM .click(), Playwright coordinate .click(), and the R key.
//
//   node scripts/test-speak.mjs
import { createRequire } from 'module'
import { _electron as electron } from 'playwright-core'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const APP_DIR = process.cwd()
const STUDY_LOG = process.env.STUDY_LOG || '/Users/tommy/Documents/ttmmpp/study-log'
const log = (...a) => console.log(...a)

const app = await electron.launch({
  executablePath: electronPath,
  args: ['--no-sandbox', '--user-data-dir=/tmp/study-test-ud', APP_DIR],
  cwd: APP_DIR,
  env: { ...process.env, STUDY_LOG, ELECTRON_RUN_AS_NODE: '' },
  timeout: 30000
})

// Record every 'speak' IPC call in the MAIN process instead of spawning `say`.
await app.evaluate(({ ipcMain }) => {
  try {
    ipcMain.removeHandler('speak')
  } catch {
    /* ignore */
  }
  globalThis.__speak = []
  ipcMain.handle('speak', (_e, text, voice, rate) => {
    globalThis.__speak.push({ text: String(text).slice(0, 40), voice, rate })
    return Promise.resolve()
  })
})
const speakCalls = () => app.evaluate(() => globalThis.__speak.slice())
const resetCalls = () => app.evaluate(() => {
  globalThis.__speak = []
})

const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')

await page.waitForSelector('.domain-card', { timeout: 15000 })
const picked = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.domain-card')]
  const c = cards.find((x) => /english|core/i.test(x.textContent || '')) || cards[0]
  if (!c) return 'NO CARD'
  c.click()
  return (c.textContent || '').trim().slice(0, 30)
})
log('• picked domain:', picked)

await page.waitForSelector('.card', { timeout: 15000 })
// english/core is non-choice → reveal via the 答え合わせ button (or Enter)
const revealed = await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('答え合わせ'))
  if (b) {
    b.click()
    return 'clicked 答え合わせ'
  }
  return 'NO reveal button'
})
log('• reveal:', revealed)
await page.waitForSelector('.verdict', { timeout: 10000 })

// Inspect the 🔊 button: present? disabled? is it the topmost element at its center?
const info = await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('英語を読み上げ'))
  if (!b) return { found: false }
  const r = b.getBoundingClientRect()
  const cx = r.left + r.width / 2
  const cy = r.top + r.height / 2
  const top = document.elementFromPoint(cx, cy)
  return {
    found: true,
    text: (b.textContent || '').trim(),
    disabled: b.disabled,
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    topIsButton: top === b || b.contains(top),
    topTag: top ? top.tagName + (top.className ? '.' + top.className : '') : null
  }
})
log('• 🔊 button:', JSON.stringify(info))

// 1) DOM .click()
await resetCalls()
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('英語を読み上げ'))
  if (b) b.click()
})
await page.waitForTimeout(300)
log('• after DOM .click():       ', JSON.stringify(await speakCalls()))

// 2) Playwright real (coordinate) click
await resetCalls()
try {
  await page.getByText('英語を読み上げ').click({ timeout: 3000 })
} catch (e) {
  log('  (pw click threw:', e.message.split('\n')[0], ')')
}
await page.waitForTimeout(300)
log('• after Playwright .click():', JSON.stringify(await speakCalls()))

// 3) R key
await resetCalls()
await page.evaluate(() => document.body.click())
await page.keyboard.press('r')
await page.waitForTimeout(300)
log('• after R key:              ', JSON.stringify(await speakCalls()))

await app.close()
log('DONE')

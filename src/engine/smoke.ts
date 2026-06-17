// Headless smoke test for the engine. Run with: pnpm smoke
// Creates a throwaway study-log, exercises pick -> record -> summary, asserts.
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { review, defaultState, todayISO, addDays } from './srs'
import { writeState, readState } from './store'
import { pick, record, summary, domainInfo, studyStats } from './session'
import { exportMarkdown } from './export'

let failures = 0
function ok(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok  - ${msg}`)
  else {
    failures++
    console.error(`  FAIL- ${msg}`)
  }
}

async function main(): Promise<void> {
  const today = todayISO()

  // --- SM-2 unit checks -------------------------------------------------
  let s = defaultState(today)
  s = review(s, 3, today) // Good, first time -> 1 day
  ok(s.interval === 1 && s.reps === 1, `Good#1 -> interval 1 (got ${s.interval})`)
  s = review(s, 3, today) // Good, second -> 6 days
  ok(s.interval === 6 && s.reps === 2, `Good#2 -> interval 6 (got ${s.interval})`)
  const before = s.interval
  s = review(s, 4, today) // Easy -> grows by ease*1.3, ease up
  ok(s.interval > before && s.ease > 2.5, `Easy grows interval & ease (got ${s.interval}, ease ${s.ease})`)
  const sLapse = review(s, 1, today) // Again -> reset
  ok(sLapse.reps === 0 && sLapse.lapses === 1 && sLapse.interval === 1, 'Again resets reps & lapses++')
  ok(sLapse.ease >= 1.3, 'ease never below floor 1.3')
  ok(review(s, 3, today).due === addDays(today, review(s, 3, today).interval), 'due = today + interval')

  // --- Full session round-trip -----------------------------------------
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'study-smoke-'))
  const qdir = path.join(root, 'demo', 'set', 'questions')
  await fs.mkdir(qdir, { recursive: true })
  await fs.mkdir(path.join(root, 'demo', 'set', 'logs'), { recursive: true })

  const mk = (id: string, topic: string, ans: string): string =>
    JSON.stringify(
      {
        id,
        domain: 'demo/set',
        topic,
        type: 'single_choice',
        grade_scale: 4,
        source: [`https://example.com/${topic}`],
        created: today,
        q: `Q for ${id}?`,
        choices: ['A. one', 'B. two'],
        answer: ans,
        explanation: 'because.',
        hint: null,
        speak: null
      },
      null,
      2
    )

  await fs.writeFile(path.join(qdir, 'demo-set-a-0001.json'), mk('demo-set-a-0001', 'a', 'A'))
  await fs.writeFile(path.join(qdir, 'demo-set-a-0002.json'), mk('demo-set-a-0002', 'a', 'B'))
  await fs.writeFile(path.join(qdir, 'demo-set-b-0001.json'), mk('demo-set-b-0001', 'b', 'A'))

  // init state: all due today
  const state = await readState(root)
  for (const id of ['demo-set-a-0001', 'demo-set-a-0002', 'demo-set-b-0001']) {
    state[id] = { ...defaultState(today), due: today }
  }
  await writeState(root, state)

  const info = await domainInfo(root)
  ok(info.length === 1 && info[0].domain === 'demo/set' && info[0].total === 3, 'domainInfo finds demo/set with 3 questions')
  ok(info[0].new === 3 && info[0].due === 0, 'all 3 are "new" before any review')

  const picked = await pick(root, 'demo/set', { limit: 2, maxNew: 5 })
  ok(picked.length === 2, `pick respects limit (got ${picked.length})`)
  ok(picked.every((p) => p.isNew), 'fresh system -> all picked are new')

  const sess = `${today}-smoke`
  await record(root, 'demo/set', sess, [
    { id: 'demo-set-a-0001', grade: 4 },
    { id: 'demo-set-a-0002', grade: 1 }
  ])
  const after = await readState(root)
  ok(after['demo-set-a-0001'].reps === 1 && after['demo-set-a-0001'].due > today, 'recorded Easy advances due')
  ok(after['demo-set-a-0002'].lapses === 1, 'recorded Again increments lapses')

  const sum = await summary(root, 'demo/set', sess)
  ok(sum.total === 2 && sum.correct === 1 && sum.accuracy === 50, `summary: 2 answered, 1 correct, 50% (got ${sum.accuracy}%)`)
  ok(sum.weakTopics.includes('a'), 'weak topic surfaced (a)')
  ok(sum.items.length === 2, `summary.items has one entry per question (got ${sum.items.length})`)
  const easyItem = sum.items.find((i) => i.id === 'demo-set-a-0001')
  ok(
    !!easyItem && easyItem.grade === 4 && easyItem.correct && easyItem.q === 'Q for demo-set-a-0001?',
    'item carries grade + correct + question text'
  )
  const againItem = sum.items.find((i) => i.id === 'demo-set-a-0002')
  ok(!!againItem && againItem.grade === 1 && !againItem.correct, 'Again item marked incorrect')

  const stats = await studyStats(root)
  ok(stats.reviewsToday === 2 && stats.totalReviews === 2, `studyStats counts today's reviews (got ${stats.reviewsToday}/${stats.totalReviews})`)
  ok(stats.streak === 1 && stats.reviewedDays === 1, `studyStats streak/days (got ${stats.streak}/${stats.reviewedDays})`)
  const dm = stats.maturity.find((m) => m.domain === 'demo/set')
  ok(!!dm && dm.total === 3 && dm.unseen === 1 && dm.learning === 2, `maturity split (got ${dm?.unseen} unseen / ${dm?.learning} learning)`)

  const exported = await exportMarkdown(root)
  const ex = exported.find((e) => e.domain === 'demo/set')
  ok(!!ex && ex.count === 3, `exportMarkdown writes one md per question (got ${ex?.count})`)
  const md = await fs.readFile(path.join(root, 'demo', 'set', 'export', 'demo-set-a-0001.md'), 'utf8')
  ok(md.startsWith('---') && md.includes('## 解答') && md.includes('tags: ['), 'exported md has frontmatter + answer section')

  await fs.rm(root, { recursive: true, force: true })

  console.log(failures === 0 ? '\nSMOKE PASS' : `\nSMOKE FAILED (${failures})`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

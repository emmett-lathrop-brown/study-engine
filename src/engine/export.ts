import { promises as fs } from 'fs'
import * as path from 'path'
import type { ChatLog, ExportResult, Question } from './types'
import { listDomains, listQuestions, readChat, safeBase } from './store'

// Obsidian-friendly Markdown export of the questions. The JSON under
// questions/ stays the source of truth; this writes a sibling export/ folder
// (per domain) of human-readable .md with YAML frontmatter (title/tags/source)
// so the study-log doubles as an Obsidian vault. export/ is exporter-owned:
// re-running overwrites and prunes notes for questions that no longer exist.

// Fold every C0 control char (newline, lone CR, tab, ...) to a space so a
// frontmatter scalar can't be broken by a stray control char.
const foldControls = (s: string): string =>
  s
    .split('')
    .map((c) => (c.charCodeAt(0) < 0x20 ? ' ' : c))
    .join('')

// Double-quote a YAML scalar, escaping backslash/quote then folding controls.
const yamlStr = (s: string): string =>
  `"${foldControls(s.replace(/\\/g, '\\\\').replace(/"/g, '\\"'))}"`

function titleOf(q: Question): string {
  const head = q.q.split('\n')[0].replace(/[:：]\s*$/, '').trim()
  const t = head.length > 60 ? `${head.slice(0, 57)}…` : head
  return t || q.id
}

/** One question → an Obsidian note (frontmatter + question/answer/explanation [+ chat]). */
export function questionToMarkdown(q: Question, chat?: ChatLog | null): string {
  const tags = ['study', q.domain, q.topic].filter(Boolean)
  const fm = [
    '---',
    `title: ${yamlStr(titleOf(q))}`,
    `id: ${yamlStr(q.id)}`,
    `domain: ${yamlStr(q.domain)}`,
    `topic: ${yamlStr(q.topic)}`,
    `type: ${yamlStr(q.type)}`,
    `created: ${yamlStr(q.created)}`,
    `tags: [${tags.map(yamlStr).join(', ')}]`
  ]
  if (q.source.length) {
    fm.push('source:')
    for (const s of q.source) fm.push(`  - ${yamlStr(s)}`)
  }
  fm.push('---')

  const body = ['', `# ${titleOf(q)}`, '', q.q, '']
  if (q.choices && q.choices.length) body.push('## 選択肢', ...q.choices.map((c) => `- ${c}`), '')
  body.push('## 解答', q.answer, '')
  if (q.explanation) body.push('## 解説', q.explanation, '')
  if (q.hint) body.push('## ヒント', q.hint, '')
  if (chat && chat.messages.length) {
    body.push('## Claude チャット', '')
    for (const m of chat.messages) {
      // Label on its own line so multi-line / markdown message bodies survive.
      body.push(`**${m.role === 'user' ? '私' : 'Claude'}:**`, '', m.text, '')
    }
  }
  return `${fm.join('\n')}\n${body.join('\n').trimEnd()}\n`
}

/** Export every domain's questions to <root>/<domain>/export/<id>.md. */
export async function exportMarkdown(root: string): Promise<ExportResult[]> {
  const out: ExportResult[] = []
  for (const domain of await listDomains(root)) {
    const qs = await listQuestions(root, domain)
    if (qs.length === 0) continue // no questions → don't scaffold an empty export/ dir
    const dir = path.join(root, domain, 'export')
    await fs.mkdir(dir, { recursive: true })

    const expected = new Set(qs.map((q) => `${safeBase(q.id)}.md`))
    let existing: string[] = []
    try {
      existing = await fs.readdir(dir)
    } catch {
      /* fresh export dir */
    }
    // Prune notes whose question was removed or whose id changed.
    for (const name of existing) {
      if (name.endsWith('.md') && !expected.has(name)) {
        await fs.rm(path.join(dir, name)).catch(() => undefined)
      }
    }
    for (const q of qs) {
      const chat = await readChat(root, domain, q.id)
      await fs.writeFile(path.join(dir, `${safeBase(q.id)}.md`), questionToMarkdown(q, chat), 'utf8')
    }
    out.push({ domain, count: qs.length, dir })
  }
  return out
}

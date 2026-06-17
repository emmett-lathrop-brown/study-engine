import { promises as fs } from 'fs'
import * as path from 'path'
import type { ExportResult, Question } from './types'
import { listDomains, listQuestions } from './store'

// Obsidian-friendly Markdown export of the questions. The JSON under
// questions/ stays the source of truth; this writes a sibling export/ folder
// (per domain) of human-readable .md with YAML frontmatter (title/tags/source)
// so the study-log doubles as an Obsidian vault. Re-running overwrites.

const yamlStr = (s: string): string =>
  `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`

function titleOf(q: Question): string {
  const head = q.q.split('\n')[0].replace(/[:：]\s*$/, '').trim()
  const t = head.length > 60 ? `${head.slice(0, 57)}…` : head
  return t || q.id
}

/** One question → an Obsidian note (frontmatter + question/answer/explanation). */
export function questionToMarkdown(q: Question): string {
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
  return `${fm.join('\n')}\n${body.join('\n').trimEnd()}\n`
}

/** Export every domain's questions to <root>/<domain>/export/<id>.md. */
export async function exportMarkdown(root: string): Promise<ExportResult[]> {
  const out: ExportResult[] = []
  for (const domain of await listDomains(root)) {
    const dir = path.join(root, domain, 'export')
    await fs.mkdir(dir, { recursive: true })
    const qs = await listQuestions(root, domain)
    for (const q of qs) {
      const base = q.id.replace(/[^\w.-]/g, '_')
      await fs.writeFile(path.join(dir, `${base}.md`), questionToMarkdown(q), 'utf8')
    }
    out.push({ domain, count: qs.length, dir })
  }
  return out
}

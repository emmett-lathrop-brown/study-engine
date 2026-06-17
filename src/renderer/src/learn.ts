import type { PickedQuestion } from '../../engine/types'
import { api } from './api'

// Learn (速習) mode turns free-recall questions (cloze / translation / free)
// into 4-choice questions for fast recognition practice. Distractors come from
// Claude in one batch call; if Claude is unavailable or returns too few, we fall
// back to other same-type answers in the session, and if still short we leave
// the question as free input (graceful degradation).

const LETTERS = ['A', 'B', 'C', 'D']
const isFree = (t: string): boolean => t === 'cloze' || t === 'translation' || t === 'free'
const normAns = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase()

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** Pull the first JSON array out of a model response (tolerates code fences). */
function extractJsonArray(text: string): unknown[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end <= start) return []
  try {
    const parsed = JSON.parse(text.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function claudeDistractors(
  items: Array<{ id: string; q: string; answer: string }>
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>()
  if (items.length === 0) return map
  const prompt = [
    '次の各問題について、正解と紛らわしいが明確に誤りの「短い選択肢」を3つずつ作ってください。',
    '- 形式・長さ・言語は正解に合わせる(正解が英文なら英文、語形なら語形)。',
    '- 正解そのものや実質同義のものは含めない。',
    '- 出力は JSON 配列のみ。説明やコードフェンスは不要。',
    '形式: [{"id":"<id>","distractors":["x","y","z"]}, ...]',
    '',
    '問題:',
    ...items.map((it) => `- id=${it.id} / 問題=${it.q} / 正解=${it.answer}`)
  ].join('\n')
  const r = await api.claudeAsk(prompt, 'haiku')
  if (!r.ok || !r.text) return map
  for (const row of extractJsonArray(r.text)) {
    const d = row as { id?: unknown; distractors?: unknown }
    if (typeof d.id === 'string' && Array.isArray(d.distractors)) {
      map.set(
        d.id,
        d.distractors.map((x) => String(x)).filter((x) => x.trim())
      )
    }
  }
  return map
}

/** Transform free questions into 4-choice; non-free (or un-fillable) pass through. */
export async function buildLearnQuestions(questions: PickedQuestion[]): Promise<PickedQuestion[]> {
  const free = questions.filter((q) => isFree(q.type) && q.answer.trim())
  const distractorMap = await claudeDistractors(
    free.map((q) => ({ id: q.id, q: q.q.replace(/\s*\n\s*/g, ' ').trim(), answer: q.answer.trim() }))
  )

  return questions.map((q) => {
    if (!isFree(q.type) || !q.answer.trim()) return q
    const answer = q.answer.trim()
    const seen = new Set([normAns(answer)])
    const distractors: string[] = []
    const add = (cand: string): void => {
      const c = cand.trim()
      if (c && !seen.has(normAns(c))) {
        seen.add(normAns(c))
        distractors.push(c)
      }
    }
    for (const d of distractorMap.get(q.id) ?? []) {
      if (distractors.length >= 3) break
      add(d)
    }
    // Fallback: borrow other same-type answers from this session.
    if (distractors.length < 3) {
      for (const other of shuffle(free)) {
        if (distractors.length >= 3) break
        if (other.id !== q.id) add(other.answer)
      }
    }
    if (distractors.length < 3) return q // not enough plausible options → keep free input

    const options = shuffle([answer, ...distractors.slice(0, 3)])
    const choices = options.map((opt, i) => `${LETTERS[i]}. ${opt}`)
    return {
      ...q,
      type: 'single_choice' as const,
      choices,
      answer: LETTERS[options.indexOf(answer)]
    }
  })
}

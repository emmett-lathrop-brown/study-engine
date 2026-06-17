import { promises as fs } from 'fs'
import * as path from 'path'
import { domainDir, listQuestions } from './store'
import { todayISO } from './srs'

/**
 * Build a paste-ready question-generation prompt for a REAL Claude Code session
 * (opened at the study-log repo, with file tools). It embeds the domain's
 * CONTEXT.md, the schema/ID rules, today's date, and the existing id/topic
 * coverage so the model fills gaps without duplicating. The dashboard copies the
 * result to the clipboard — the app's in-chat Claude is sandboxed and cannot
 * write files (CLAUDE.md §7), so generation is handed off to a real session.
 */
export async function buildGenPrompt(root: string, domain: string, count = 6): Promise<string> {
  let context: string
  try {
    context = (await fs.readFile(path.join(domainDir(root, domain), 'CONTEXT.md'), 'utf8')).trim()
  } catch {
    context = `(CONTEXT.md がありません — まず subjects/${domain}/CONTEXT.md を作成してください)`
  }

  const qs = await listQuestions(root, domain)
  const topicCounts = new Map<string, number>()
  for (const q of qs) topicCounts.set(q.topic, (topicCounts.get(q.topic) ?? 0) + 1)
  const coverage =
    [...topicCounts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([t, n]) => `- ${t}: ${n}問`)
      .join('\n') || '(まだ問題なし)'
  const existingIds = qs.map((q) => q.id).sort().join(', ') || '(なし)'
  const today = todayISO()

  return `あなたは study-log リポジトリで動く Claude Code です。学習ドメイン **${domain}** に、下記 CONTEXT を踏まえて**オリジナルの問題を新規 ${count} 問**生成し、ファイルとして保存してください。

== このドメインの CONTEXT（subjects/${domain}/CONTEXT.md） ==
${context}

== 既存カバレッジ（重複を避け、ギャップを埋める） ==
${coverage}

既存 ID（同じ ID を作らない）:
${existingIds}

== 厳守する仕様（正本: study-engine の CLAUDE.md §2 と schema/question.schema.json） ==
- 1 問 1 ファイルの JSON オブジェクトを \`subjects/${domain}/questions/\` に保存（ファイル名は ID 規約に沿う）。
- 必須キー: id(一意) / domain("${domain}") / topic / type / grade_scale(4) / source(一次情報URLの配列・実在&安定) / created("${today}") / q / answer / explanation。
- type: single_choice | multi | cloze | translation | free。choices は選択式のときだけ文字列配列("A. …" 形)、それ以外は null。
- answer: single_choice は記号("B")、multi は "A,C"、cloze/translation/free は模範解答テキスト。
- 任意: hint(答えを言わない一言。不要なら null) / speak(読み上げ対象言語テキスト。非言語は null) / answer_ruby(英語回答のカタカナルビ＝[単語,カナ]対の配列で、第1要素の連結が answer に完全一致)。
- 収集・丸写し禁止。一次情報を根拠に自作し、source に出典 URL を併記。確信が持てない数値・上限値は出さない（必要なら裏取り）。

== 保存後 ==
- 生成した各 ID を \`srs/state.json\` に \`{"interval":0,"ease":2.5,"due":"${today}","reps":0,"lapses":0}\` で追加（全問 due=今日）。
- 生成内容を簡潔に要約して提示する。コミット/プッシュはユーザーがレビューしてから行う（勝手に commit/push しない）。`
}

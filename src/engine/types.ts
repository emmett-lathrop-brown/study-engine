// Pure type definitions for the study engine. No runtime imports here so that
// the renderer can `import type` from this file without pulling in Node APIs.

export type QType = 'single_choice' | 'multi' | 'cloze' | 'translation' | 'free'

export interface Question {
  id: string // e.g. "aws-clf-s3-0003"
  domain: string // e.g. "aws/clf"
  topic: string // e.g. "s3"
  type: QType
  grade_scale: number // 4 = Again/Hard/Good/Easy
  source: string[] // primary-source URLs (required by policy)
  created: string // YYYY-MM-DD
  q: string
  choices?: string[] // present for single_choice / multi
  answer: string // letter(s) for choices; model answer otherwise
  explanation: string
  hint?: string // optional hint, shown on demand (not inline in the question)
  speak?: string // English text to read aloud (TTS); undefined for non-English
  file: string // absolute path on disk
}

export interface SrsState {
  interval: number // days until next review
  ease: number
  due: string // YYYY-MM-DD
  reps: number
  lapses: number
  last_review?: string // YYYY-MM-DD
  last_grade?: number
}

export type StateMap = Record<string, SrsState>

export interface Review {
  id: string
  ts: string // ISO8601 with offset
  grade: number
  session: string
}

export interface PickedQuestion extends Question {
  state: SrsState
  isNew: boolean
}

export interface DomainInfo {
  domain: string // "aws/clf"
  prefix: string // "aws-clf-"
  total: number
  due: number
  new: number
}

export interface SessionSummary {
  session: string
  domain: string
  total: number
  correct: number
  accuracy: number // 0..100
  byGrade: Record<number, number>
  weakTopics: string[]
}

import type { DomainInfo, PickedQuestion, SessionSummary, SrsState } from '../../engine/types'

export interface PickOptions {
  limit?: number
  maxNew?: number
  on?: string
}
export interface Settings {
  root: string | null
  voice: string
  rate: number
}
export interface DeepDiveArgs {
  id: string
  file: string
  domain: string
  q: string
  answer: string
  userAnswer?: string
  gradeLabel?: string
}

export interface StudyApi {
  getConfig(): Promise<Settings>
  pickRoot(): Promise<Settings>
  setVoice(voice: string, rate: number): Promise<Settings>
  listDomains(): Promise<DomainInfo[]>
  pickSession(domain: string, opts: PickOptions): Promise<PickedQuestion[]>
  grade(domain: string, session: string, id: string, grade: number): Promise<{ id: string; state: SrsState }>
  summary(domain: string, session: string): Promise<SessionSummary>
  speak(text: string, voice?: string, rate?: number): Promise<void>
  stopSpeak(): Promise<void>
  commit(message: string): Promise<{ ok: boolean; out: string }>
  deepDivePrompt(a: DeepDiveArgs): Promise<string>
  openExternal(url: string): Promise<void>
}

declare global {
  interface Window {
    api: StudyApi
  }
}

export const api: StudyApi = window.api

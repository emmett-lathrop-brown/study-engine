import type {
  ChatLog,
  ChatMessage,
  DomainInfo,
  ExportResult,
  PickedQuestion,
  SessionSummary,
  SrsState,
  StudyStats
} from '../../engine/types'

export interface PickOptions {
  limit?: number
  maxNew?: number
  on?: string
  shuffle?: boolean
  seed?: number
  ids?: string[]
}
export interface Settings {
  root: string | null
  voice: string
  rate: number
  fontSize: number
  autoSpeak: boolean
  algo: 'sm2' | 'fsrs'
  desiredRetention: number
}
export interface ClaudeStatus {
  installed: boolean
  connected: boolean
  detail: string
}
export interface AskResult {
  ok: boolean
  text?: string
  error?: string
}

export interface StudyApi {
  getConfig(): Promise<Settings>
  pickRoot(): Promise<Settings>
  setVoice(voice: string, rate: number, autoSpeak?: boolean): Promise<Settings>
  setFontSize(fontSize: number): Promise<Settings>
  setAlgo(algo: 'sm2' | 'fsrs', desiredRetention: number): Promise<Settings>
  repoWebBase(): Promise<string | null>
  listDomains(): Promise<DomainInfo[]>
  stats(): Promise<StudyStats>
  pickSession(domain: string, opts: PickOptions): Promise<PickedQuestion[]>
  grade(domain: string, session: string, id: string, grade: number): Promise<{ id: string; state: SrsState }>
  preview(domain: string, id: string, state: SrsState, grades: number[]): Promise<Record<number, number>>
  summary(domain: string, session: string): Promise<SessionSummary>
  genPrompt(domain: string): Promise<string>
  speak(text: string, voice?: string, rate?: number): Promise<void>
  stopSpeak(): Promise<void>
  commit(message: string): Promise<{ ok: boolean; out: string }>
  exportMarkdown(): Promise<ExportResult[]>
  getChat(domain: string, id: string): Promise<ChatLog | null>
  saveChat(domain: string, id: string, messages: ChatMessage[]): Promise<void>
  copyToClipboard(text: string): Promise<void>
  openExternal(url: string): Promise<void>
  claudeStatus(): Promise<ClaudeStatus>
  claudeAsk(prompt: string, model?: string): Promise<AskResult>
  claudeChat(message: string, model?: string): Promise<AskResult>
  claudeLogin(): Promise<{ ok: boolean; detail: string }>
}

declare global {
  interface Window {
    api: StudyApi
  }
}

export const api: StudyApi = window.api

// macOS `say` voices offered in the UI (English read-aloud).
export const VOICES = ['Samantha', 'Alex', 'Daniel', 'Karen', 'Moira', 'Tessa']

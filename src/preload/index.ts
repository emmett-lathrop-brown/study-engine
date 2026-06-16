import { contextBridge, ipcRenderer } from 'electron'
import type { DomainInfo, PickedQuestion, SessionSummary, SrsState } from '../engine/types'
import type { PickOptions } from '../engine/session'

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

const api = {
  getConfig: (): Promise<Settings> => ipcRenderer.invoke('config:get'),
  pickRoot: (): Promise<Settings> => ipcRenderer.invoke('config:pickRoot'),
  setVoice: (voice: string, rate: number): Promise<Settings> =>
    ipcRenderer.invoke('config:setVoice', voice, rate),

  listDomains: (): Promise<DomainInfo[]> => ipcRenderer.invoke('domains:list'),
  pickSession: (domain: string, opts: PickOptions): Promise<PickedQuestion[]> =>
    ipcRenderer.invoke('session:pick', domain, opts),
  grade: (
    domain: string,
    session: string,
    id: string,
    grade: number
  ): Promise<{ id: string; state: SrsState }> =>
    ipcRenderer.invoke('session:grade', domain, session, id, grade),
  summary: (domain: string, session: string): Promise<SessionSummary> =>
    ipcRenderer.invoke('session:summary', domain, session),

  speak: (text: string, voice?: string, rate?: number): Promise<void> =>
    ipcRenderer.invoke('speak', text, voice, rate),
  stopSpeak: (): Promise<void> => ipcRenderer.invoke('speak:stop'),
  commit: (message: string): Promise<{ ok: boolean; out: string }> =>
    ipcRenderer.invoke('git:commit', message),
  deepDivePrompt: (a: DeepDiveArgs): Promise<string> => ipcRenderer.invoke('deepdive:prompt', a),
  copyToClipboard: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('open:external', url),

  claudeStatus: (): Promise<{ installed: boolean; connected: boolean; detail: string }> =>
    ipcRenderer.invoke('claude:status'),
  claudeAsk: (prompt: string, model?: string): Promise<{ ok: boolean; text?: string; error?: string }> =>
    ipcRenderer.invoke('claude:ask', prompt, model),
  claudeLogin: (): Promise<{ ok: boolean; detail: string }> => ipcRenderer.invoke('claude:login')
}

export type StudyApi = typeof api

contextBridge.exposeInMainWorld('api', api)

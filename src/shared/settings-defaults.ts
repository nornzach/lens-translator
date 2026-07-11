export type HotkeyConfig = {
  altKey: boolean
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  code: string // KeyboardEvent.code, e.g. 'KeyL'
}

export type UserSettings = {
  baseURL: string
  apiKey: string
  model: string
  sourceLang: string
  targetLang: string
  autoTranslate: boolean
  lensWidthPx: number
  minTextLength: number
  batchCharLimit: number
  prefetchMarginRatio: number // 0.5 = half viewport
  hotkey: HotkeyConfig
  pausedHostnames: string[]
}

export const DEFAULT_SETTINGS: UserSettings = {
  baseURL: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  sourceLang: 'en',
  targetLang: 'zh',
  autoTranslate: true,
  lensWidthPx: 320,
  minTextLength: 10,
  batchCharLimit: 6000,
  prefetchMarginRatio: 0.5,
  hotkey: {
    altKey: true,
    shiftKey: true,
    ctrlKey: false,
    metaKey: false,
    code: 'KeyL',
  },
  pausedHostnames: [],
}

export function mergeSettings(partial: Partial<UserSettings> | null | undefined): UserSettings {
  const p = partial ?? {}
  return {
    ...DEFAULT_SETTINGS,
    ...p,
    hotkey: { ...DEFAULT_SETTINGS.hotkey, ...(p.hotkey ?? {}) },
    pausedHostnames: p.pausedHostnames ?? DEFAULT_SETTINGS.pausedHostnames,
  }
}

export function isConfigured(settings: UserSettings): boolean {
  return Boolean(settings.baseURL.trim() && settings.apiKey.trim() && settings.model.trim())
}

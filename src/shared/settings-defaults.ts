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
    // Normalize strings in case storage returned unexpected types
    baseURL: String(p.baseURL ?? DEFAULT_SETTINGS.baseURL ?? ''),
    apiKey: String(p.apiKey ?? DEFAULT_SETTINGS.apiKey ?? ''),
    model: String(p.model ?? DEFAULT_SETTINGS.model ?? ''),
    sourceLang: String(p.sourceLang ?? DEFAULT_SETTINGS.sourceLang),
    targetLang: String(p.targetLang ?? DEFAULT_SETTINGS.targetLang),
    hotkey: { ...DEFAULT_SETTINGS.hotkey, ...(p.hotkey ?? {}) },
    pausedHostnames: Array.isArray(p.pausedHostnames)
      ? p.pausedHostnames.map(String)
      : DEFAULT_SETTINGS.pausedHostnames,
  }
}

export function isConfigured(settings: UserSettings): boolean {
  const baseURL = settings.baseURL?.trim() ?? ''
  const apiKey = settings.apiKey?.trim() ?? ''
  const model = settings.model?.trim() ?? ''
  return baseURL.length > 0 && apiKey.length > 0 && model.length > 0
}

/** Human-readable list of missing required API fields. */
export function missingConfigFields(settings: UserSettings): string[] {
  const missing: string[] = []
  if (!(settings.baseURL?.trim() ?? '')) missing.push('Base URL')
  if (!(settings.apiKey?.trim() ?? '')) missing.push('API Key')
  if (!(settings.model?.trim() ?? '')) missing.push('模型')
  return missing
}

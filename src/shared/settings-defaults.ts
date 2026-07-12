import type { ProviderId, ReasoningPref } from './providers'

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
  /** auto | openai | deepseek | stepfun */
  provider: ProviderId
  /**
   * Thinking / reasoning for providers that support it.
   * Default off (or lowest where off is unavailable, e.g. StepFun → low).
   */
  reasoningPref: ReasoningPref
  sourceLang: string
  targetLang: string
  autoTranslate: boolean
  /** Use Chrome's on-device Translator API after the configured API fails or is absent. */
  browserTranslatorFallback: boolean
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
  provider: 'auto',
  reasoningPref: 'off',
  sourceLang: 'en',
  targetLang: 'zh',
  /** Default off: only translate the block under the lens (fast first paint). */
  autoTranslate: false,
  browserTranslatorFallback: true,
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

function asProviderId(v: unknown): ProviderId {
  if (v === 'openai' || v === 'deepseek' || v === 'stepfun' || v === 'auto') return v
  return DEFAULT_SETTINGS.provider
}

function asReasoningPref(v: unknown): ReasoningPref {
  if (v === 'off' || v === 'low' || v === 'medium' || v === 'high') return v
  return DEFAULT_SETTINGS.reasoningPref
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

function finiteNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback
}

function stringValue(value: unknown, fallback: string): string {
  return value === null || value === undefined ? fallback : String(value)
}

/** Validate persisted/untrusted settings and fill every omitted or malformed field. */
export function mergeSettings(partial: unknown): UserSettings {
  const p = isRecord(partial) ? partial : {}
  const hotkey = isRecord(p.hotkey) ? p.hotkey : {}
  return {
    baseURL: stringValue(p.baseURL, DEFAULT_SETTINGS.baseURL),
    apiKey: stringValue(p.apiKey, DEFAULT_SETTINGS.apiKey),
    model: stringValue(p.model, DEFAULT_SETTINGS.model),
    provider: asProviderId(p.provider),
    reasoningPref: asReasoningPref(p.reasoningPref),
    sourceLang: stringValue(p.sourceLang, DEFAULT_SETTINGS.sourceLang).slice(0, 64),
    targetLang: stringValue(p.targetLang, DEFAULT_SETTINGS.targetLang).slice(0, 64),
    autoTranslate:
      typeof p.autoTranslate === 'boolean' ? p.autoTranslate : DEFAULT_SETTINGS.autoTranslate,
    browserTranslatorFallback:
      typeof p.browserTranslatorFallback === 'boolean'
        ? p.browserTranslatorFallback
        : DEFAULT_SETTINGS.browserTranslatorFallback,
    lensWidthPx: finiteNumber(p.lensWidthPx, DEFAULT_SETTINGS.lensWidthPx, 120, 800),
    minTextLength: finiteNumber(p.minTextLength, DEFAULT_SETTINGS.minTextLength, 1, 1000),
    batchCharLimit: finiteNumber(
      p.batchCharLimit,
      DEFAULT_SETTINGS.batchCharLimit,
      100,
      100_000,
    ),
    prefetchMarginRatio: finiteNumber(
      p.prefetchMarginRatio,
      DEFAULT_SETTINGS.prefetchMarginRatio,
      0,
      5,
    ),
    hotkey: {
      altKey: typeof hotkey.altKey === 'boolean' ? hotkey.altKey : DEFAULT_SETTINGS.hotkey.altKey,
      shiftKey:
        typeof hotkey.shiftKey === 'boolean' ? hotkey.shiftKey : DEFAULT_SETTINGS.hotkey.shiftKey,
      ctrlKey:
        typeof hotkey.ctrlKey === 'boolean' ? hotkey.ctrlKey : DEFAULT_SETTINGS.hotkey.ctrlKey,
      metaKey:
        typeof hotkey.metaKey === 'boolean' ? hotkey.metaKey : DEFAULT_SETTINGS.hotkey.metaKey,
      code:
        typeof hotkey.code === 'string' && hotkey.code.length <= 64
          ? hotkey.code
          : DEFAULT_SETTINGS.hotkey.code,
    },
    pausedHostnames: Array.isArray(p.pausedHostnames)
      ? p.pausedHostnames
          .filter((hostname): hostname is string => typeof hostname === 'string')
          .slice(0, 1000)
      : DEFAULT_SETTINGS.pausedHostnames,
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Remote endpoints require TLS; loopback HTTP remains available for local model servers. */
export function apiBaseUrlError(baseURL: string): string | null {
  let url: URL
  try {
    url = new URL(baseURL)
  } catch {
    return 'Base URL 格式无效'
  }
  if (url.username || url.password) return 'Base URL 不得包含用户名或密码'
  if (url.protocol === 'https:') return null
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return null
  return '远程 Base URL 必须使用 HTTPS'
}

export function isConfigured(settings: UserSettings): boolean {
  const baseURL = settings.baseURL?.trim() ?? ''
  const apiKey = settings.apiKey?.trim() ?? ''
  const model = settings.model?.trim() ?? ''
  return (
    baseURL.length > 0 &&
    apiBaseUrlError(baseURL) === null &&
    apiKey.length > 0 &&
    model.length > 0
  )
}

/** Human-readable list of missing required API fields. */
export function missingConfigFields(settings: UserSettings): string[] {
  const missing: string[] = []
  if (!(settings.baseURL?.trim() ?? '')) missing.push('Base URL')
  else {
    const baseUrlError = apiBaseUrlError(settings.baseURL.trim())
    if (baseUrlError) missing.push(baseUrlError)
  }
  if (!(settings.apiKey?.trim() ?? '')) missing.push('API Key')
  if (!(settings.model?.trim() ?? '')) missing.push('模型')
  return missing
}

import type { ProviderId, ReasoningPref } from './providers'

export type HotkeyConfig = {
  altKey: boolean
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  code: string // KeyboardEvent.code, e.g. 'KeyL'
}

export type TranslationEngine = 'external' | 'browser'
export type TranslationFontFamily = 'system' | 'sans' | 'serif' | 'mono'

/** Per-host override resolved by the service worker before settings reach content scripts. */
export type SiteRule = {
  /** force-on: always auto page-translate this host; force-off: never auto-start. */
  autoPage?: 'force-on' | 'force-off'
  /** Engine override for both lens and full-page mode on this host. */
  engine?: TranslationEngine
}

/** How rendered translations appear in full-page mode. */
export type PageTranslationDisplayMode = 'bilingual' | 'translation-only' | 'learning'

export type UserSettings = {
  baseURL: string
  apiKey: string
  model: string
  /** auto | openai | deepseek | stepfun | alibaba */
  provider: ProviderId
  /**
   * Thinking / reasoning for providers that support it.
   * Default off (or lowest where off is unavailable, e.g. StepFun → low).
   */
  reasoningPref: ReasoningPref
  sourceLang: string
  targetLang: string
  autoTranslate: boolean
  /** Text translation uses exactly one engine; image translation always requires the external API. */
  translationEngine: TranslationEngine
  /** Engine used by the full-page bilingual DOM translation mode. */
  pageTranslationEngine: TranslationEngine
  /** Automatically enable full-page bilingual mode when the page matches sourceLang. */
  autoPageTranslation: boolean
  /**
   * When enabled, selecting text on the page shows a temporary translation popup.
   * Independent of the lens and full-page modes.
   */
  selectionTranslate: boolean
  /** Show the edge-docked floating control bubble on normal pages. */
  showFloatingBubble: boolean
  /** Lens works on editable fields: shows back-translation with an explicit replace action. */
  inputTranslate: boolean
  /** Per-host rules (always auto-translate / engine override). "Never translate" stays in pausedHostnames. */
  siteRules: Record<string, SiteRule>
  /** Full-page rendering mode: appended bilingual, translation-only, or hover-to-reveal. */
  pageTranslationDisplayMode: PageTranslationDisplayMode
  /** First-run setup wizard completed (or explicitly skipped). */
  onboardingCompleted: boolean
  pageTranslationFontFamily: TranslationFontFamily
  pageTranslationFontSizePx: number
  pageTranslationUseOriginalFontSize: boolean
  pageTranslationUseCustomColor: boolean
  pageTranslationTextColor: string
  pageTranslationUseBackground: boolean
  pageTranslationBackgroundColor: string
  pageTranslationBold: boolean
  pageTranslationItalic: boolean
  pageTranslationUnderline: boolean
  lensWidthPx: number
  minTextLength: number
  batchCharLimit: number
  prefetchMarginRatio: number // 0.5 = half viewport
  hotkey: HotkeyConfig
  pageTranslationHotkey: HotkeyConfig
  /** Region screenshot translation hotkey (tap to start, again/Esc to cancel). */
  shotTranslateHotkey: HotkeyConfig
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
  /** Prefer zero-config Chrome Translator for new installs. */
  translationEngine: 'browser',
  pageTranslationEngine: 'browser',
  autoPageTranslation: false,
  selectionTranslate: true,
  showFloatingBubble: true,
  inputTranslate: true,
  siteRules: {},
  pageTranslationDisplayMode: 'bilingual',
  onboardingCompleted: false,
  pageTranslationFontFamily: 'system',
  pageTranslationFontSizePx: 14,
  pageTranslationUseOriginalFontSize: true,
  pageTranslationUseCustomColor: false,
  pageTranslationTextColor: '#0e7490',
  pageTranslationUseBackground: false,
  pageTranslationBackgroundColor: '#ecfeff',
  pageTranslationBold: false,
  pageTranslationItalic: false,
  pageTranslationUnderline: false,
  lensWidthPx: 320,
  minTextLength: 3,
  batchCharLimit: 6000,
  prefetchMarginRatio: 0.5,
  hotkey: {
    altKey: true,
    shiftKey: true,
    ctrlKey: false,
    metaKey: false,
    code: 'KeyL',
  },
  pageTranslationHotkey: {
    altKey: true,
    shiftKey: true,
    ctrlKey: false,
    metaKey: false,
    code: 'Semicolon',
  },
  shotTranslateHotkey: {
    altKey: true,
    shiftKey: true,
    ctrlKey: false,
    metaKey: false,
    code: 'KeyS',
  },
  pausedHostnames: [],
}

function asProviderId(v: unknown): ProviderId {
  if (
    v === 'openai' ||
    v === 'deepseek' ||
    v === 'stepfun' ||
    v === 'alibaba' ||
    v === 'auto'
  ) {
    return v
  }
  return DEFAULT_SETTINGS.provider
}

function asReasoningPref(v: unknown): ReasoningPref {
  if (v === 'off' || v === 'low' || v === 'medium' || v === 'high') return v
  return DEFAULT_SETTINGS.reasoningPref
}

function asTranslationEngine(v: unknown, fallback: TranslationEngine): TranslationEngine {
  return v === 'browser' || v === 'external' ? v : fallback
}

function asTranslationFontFamily(value: unknown): TranslationFontFamily {
  return value === 'sans' || value === 'serif' || value === 'mono' || value === 'system'
    ? value
    : DEFAULT_SETTINGS.pageTranslationFontFamily
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

function colorValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback
}

function hotkeyValue(value: unknown, fallback: HotkeyConfig): HotkeyConfig {
  const hotkey = isRecord(value) ? value : {}
  return {
    altKey: typeof hotkey.altKey === 'boolean' ? hotkey.altKey : fallback.altKey,
    shiftKey: typeof hotkey.shiftKey === 'boolean' ? hotkey.shiftKey : fallback.shiftKey,
    ctrlKey: typeof hotkey.ctrlKey === 'boolean' ? hotkey.ctrlKey : fallback.ctrlKey,
    metaKey: typeof hotkey.metaKey === 'boolean' ? hotkey.metaKey : fallback.metaKey,
    code:
      typeof hotkey.code === 'string' && hotkey.code.length <= 64 ? hotkey.code : fallback.code,
  }
}

const HOST_KEY_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i

/** Untrusted persisted site rules: enum-checked, host-shaped keys, bounded count. */
function siteRulesValue(value: unknown): Record<string, SiteRule> {
  if (!isRecord(value)) return {}
  const out: Record<string, SiteRule> = {}
  for (const [rawHost, rawRule] of Object.entries(value)) {
    if (Object.keys(out).length >= 500) break
    const host = rawHost.trim().toLowerCase()
    if (!host || host.length > 253 || !HOST_KEY_RE.test(host) || !isRecord(rawRule)) continue
    const rule: SiteRule = {}
    if (rawRule.autoPage === 'force-on' || rawRule.autoPage === 'force-off') {
      rule.autoPage = rawRule.autoPage
    }
    if (rawRule.engine === 'browser' || rawRule.engine === 'external') {
      rule.engine = rawRule.engine
    }
    if (rule.autoPage || rule.engine) out[host] = rule
  }
  return out
}

/** Validate persisted/untrusted settings and fill every omitted or malformed field. */
export function mergeSettings(partial: unknown): UserSettings {
  const p = isRecord(partial) ? partial : {}
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
    translationEngine: asTranslationEngine(p.translationEngine, DEFAULT_SETTINGS.translationEngine),
    pageTranslationEngine: asTranslationEngine(
      p.pageTranslationEngine,
      DEFAULT_SETTINGS.pageTranslationEngine,
    ),
    autoPageTranslation:
      typeof p.autoPageTranslation === 'boolean'
        ? p.autoPageTranslation
        : DEFAULT_SETTINGS.autoPageTranslation,
    selectionTranslate:
      typeof p.selectionTranslate === 'boolean'
        ? p.selectionTranslate
        : DEFAULT_SETTINGS.selectionTranslate,
    showFloatingBubble:
      typeof p.showFloatingBubble === 'boolean'
        ? p.showFloatingBubble
        : DEFAULT_SETTINGS.showFloatingBubble,
    inputTranslate:
      typeof p.inputTranslate === 'boolean'
        ? p.inputTranslate
        : DEFAULT_SETTINGS.inputTranslate,
    siteRules: siteRulesValue(p.siteRules),
    pageTranslationDisplayMode:
      p.pageTranslationDisplayMode === 'translation-only' ||
      p.pageTranslationDisplayMode === 'learning'
        ? p.pageTranslationDisplayMode
        : DEFAULT_SETTINGS.pageTranslationDisplayMode,
    // Missing flag on an existing saved blob = upgrade; only brand-new installs see the wizard.
    onboardingCompleted:
      typeof p.onboardingCompleted === 'boolean'
        ? p.onboardingCompleted
        : Object.keys(p).length > 0
          ? true
          : DEFAULT_SETTINGS.onboardingCompleted,
    pageTranslationFontFamily: asTranslationFontFamily(p.pageTranslationFontFamily),
    // Preserve a previous non-default size on upgrade; otherwise follow the page.
    pageTranslationUseOriginalFontSize:
      typeof p.pageTranslationUseOriginalFontSize === 'boolean'
        ? p.pageTranslationUseOriginalFontSize
        : typeof p.pageTranslationFontSizePx !== 'number' ||
          !Number.isFinite(p.pageTranslationFontSizePx) ||
          p.pageTranslationFontSizePx === DEFAULT_SETTINGS.pageTranslationFontSizePx,
    pageTranslationFontSizePx: finiteNumber(
      p.pageTranslationFontSizePx,
      DEFAULT_SETTINGS.pageTranslationFontSizePx,
      10,
      32,
    ),
    pageTranslationUseCustomColor:
      typeof p.pageTranslationUseCustomColor === 'boolean'
        ? p.pageTranslationUseCustomColor
        : DEFAULT_SETTINGS.pageTranslationUseCustomColor,
    pageTranslationTextColor: colorValue(
      p.pageTranslationTextColor,
      DEFAULT_SETTINGS.pageTranslationTextColor,
    ),
    pageTranslationUseBackground:
      typeof p.pageTranslationUseBackground === 'boolean'
        ? p.pageTranslationUseBackground
        : DEFAULT_SETTINGS.pageTranslationUseBackground,
    pageTranslationBackgroundColor: colorValue(
      p.pageTranslationBackgroundColor,
      DEFAULT_SETTINGS.pageTranslationBackgroundColor,
    ),
    pageTranslationBold:
      typeof p.pageTranslationBold === 'boolean'
        ? p.pageTranslationBold
        : DEFAULT_SETTINGS.pageTranslationBold,
    pageTranslationItalic:
      typeof p.pageTranslationItalic === 'boolean'
        ? p.pageTranslationItalic
        : DEFAULT_SETTINGS.pageTranslationItalic,
    pageTranslationUnderline:
      typeof p.pageTranslationUnderline === 'boolean'
        ? p.pageTranslationUnderline
        : DEFAULT_SETTINGS.pageTranslationUnderline,
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
    hotkey: hotkeyValue(p.hotkey, DEFAULT_SETTINGS.hotkey),
    pageTranslationHotkey: hotkeyValue(
      p.pageTranslationHotkey,
      DEFAULT_SETTINGS.pageTranslationHotkey,
    ),
    shotTranslateHotkey: hotkeyValue(
      p.shotTranslateHotkey,
      DEFAULT_SETTINGS.shotTranslateHotkey,
    ),
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

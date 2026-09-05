import type { UserSettings } from './settings-defaults'

export type TranslateBlock = {
  id: string
  tag: string
  text: string
}

export type TranslateBatchRequestMsg = {
  type: 'translate-batch'
  pageKey: string
  blocks: TranslateBlock[]
  /**
   * Optional language-pair override (input back-translation, dictionary with
   * auto-detected source). Background falls back to stored settings when absent.
   */
  sourceLang?: string
  targetLang?: string
  /** Bypass every cache read; fresh results still overwrite both cache layers. */
  forceRefresh?: boolean
}

export type TranslateImageRequestMsg = {
  type: 'translate-image'
  imageUrl: string
}

/** Region screenshot translation: content captures a CSS-px rect, SW crops + OCR-translates. */
export type TranslateShotMsg = {
  type: 'translate-shot'
  rect: { x: number; y: number; width: number; height: number }
  devicePixelRatio?: number
}

export type TranslateShotResult =
  | { type: 'translate-shot-result'; ok: true; translation: string; image: string }
  | { type: 'translate-shot-result'; ok: false; error: string }

export type TranslateImageResultOk = {
  type: 'translate-image-result'
  ok: true
  translation: string
}

export type TranslateImageResultErr = {
  type: 'translate-image-result'
  ok: false
  error: string
}

export type TranslateBatchResultOk = {
  type: 'translate-batch-result'
  ok: true
  translations: { id: string; translation: string }[]
}

export type TranslateBatchResultErr = {
  type: 'translate-batch-result'
  ok: false
  error: string
  failedIds?: string[]
  /** Partial successes still applied by content script */
  translations?: { id: string; translation: string }[]
}

export type GetSettingsMsg = { type: 'get-settings' }
export type ContentSettings = Pick<
  UserSettings,
  | 'sourceLang'
  | 'targetLang'
  | 'autoTranslate'
  | 'translationEngine'
  | 'pageTranslationEngine'
  | 'autoPageTranslation'
  | 'selectionTranslate'
  | 'showFloatingBubble'
  | 'inputTranslate'
  | 'pageTranslationDisplayMode'
  | 'pageTranslationFontFamily'
  | 'pageTranslationFontSizePx'
  | 'pageTranslationUseOriginalFontSize'
  | 'pageTranslationUseCustomColor'
  | 'pageTranslationTextColor'
  | 'pageTranslationUseBackground'
  | 'pageTranslationBackgroundColor'
  | 'pageTranslationBold'
  | 'pageTranslationItalic'
  | 'pageTranslationUnderline'
  | 'lensWidthPx'
  | 'minTextLength'
  | 'batchCharLimit'
  | 'prefetchMarginRatio'
  | 'hotkey'
  | 'pageTranslationHotkey'
  | 'shotTranslateHotkey'
> & { apiKey: '' }

/** Effective per-host rule after SW resolution (null = follow global settings). */
export type EffectiveSiteRule = {
  autoPage?: 'force-on' | 'force-off'
  engine?: 'browser' | 'external'
}

export type SettingsMsg = {
  type: 'settings'
  /** Minimal content-script settings: no endpoint, model, provider, or secret fields. */
  settings: ContentSettings
  /** Pause state only for the requesting tab; the full hostname list stays in background storage. */
  paused: boolean
  /** Computed against complete background settings before minimization. */
  configured: boolean
  /** Site rule already applied to `settings`; surfaced for UI display only. */
  siteRule: EffectiveSiteRule | null
}

export type PauseHostnameMsg = {
  type: 'set-hostname-paused'
  hostname: string
  paused: boolean
}

export type OpenOptionsMsg = { type: 'open-options'; hash?: string }

/**
 * Options-page-only reachability probe. Carries the credentials currently typed
 * into the form (which may be unsaved) so the user can verify before saving; the
 * background rejects it unless it originates from a trusted extension page.
 */
export type TestConnectionMsg = {
  type: 'test-connection'
  baseURL: string
  apiKey: string
  model: string
  provider: UserSettings['provider']
  reasoningPref: UserSettings['reasoningPref']
}

export type TestConnectionResult =
  | { type: 'test-connection-result'; ok: true }
  | { type: 'test-connection-result'; ok: false; error: string }

export type TogglePageTranslationMsg = { type: 'toggle-page-translation' }
export type TogglePageTranslationResult =
  | { ok: true }
  | { ok: false; error: string }

export type ToggleLensMsg = { type: 'toggle-lens' }
export type ToggleLensResult =
  | { ok: true; lensActive: boolean }
  | { ok: false; error: string }

export type BubbleControlMsg = {
  type: 'bubble-control'
  command: 'get-state' | 'toggle-page-translation' | 'toggle-lens' | 'retranslate-page' | 'shot-translate'
}

export type TestVisionMsg = {
  type: 'test-vision'
  baseURL: string
  apiKey: string
  model: string
  provider: UserSettings['provider']
  reasoningPref: UserSettings['reasoningPref']
}

/**
 * Options-page-only model catalog query (OpenAI-compatible GET /models).
 * Same trusted-origin rule as test-connection: the key may be unsaved.
 */
export type ListModelsMsg = {
  type: 'list-models'
  baseURL: string
  apiKey: string
}

export type ListModelsResult =
  | { type: 'list-models-result'; ok: true; models: string[] }
  | { type: 'list-models-result'; ok: false; error: string }

export type TestVisionResult =
  | { type: 'test-vision-result'; ok: true }
  | { type: 'test-vision-result'; ok: false; error: string }

export type BubbleControlResult =
  | {
      ok: true
      lensActive: boolean
      pageTranslationActive: boolean
    }
  | { ok: false; error: string }

/** Options-page cache manager: sizes for both layers, and a full wipe. */
export type GetCacheStatsMsg = { type: 'get-cache-stats' }
export type CacheStatsResult =
  | {
      type: 'cache-stats-result'
      ok: true
      sessionEntries: number
      sessionChars: number
      persistentEntries: number
      persistentChars: number
    }
  | { type: 'cache-stats-result'; ok: false; error: string }

export type ClearTranslationCacheMsg = { type: 'clear-translation-cache' }
export type ClearTranslationCacheResult =
  | { type: 'clear-translation-cache-result'; ok: true }
  | { type: 'clear-translation-cache-result'; ok: false; error: string }

export type BackgroundErrorResult = {
  type: 'background-error'
  ok: false
  requestType: ToBackground['type']
  error: string
}

/** Content / options → background: proxy Chrome Translator via offscreen document. */
export type BrowserTranslatorRequest =
  | { type: 'browser-translator'; op: 'is-supported' }
  | {
      type: 'browser-translator'
      op: 'availability'
      sourceLanguage: string
      targetLanguage: string
    }
  | {
      type: 'browser-translator'
      op: 'prepare'
      sourceLanguage: string
      targetLanguage: string
    }
  | {
      type: 'browser-translator'
      op: 'translate'
      text: string
      sourceLanguage: string
      targetLanguage: string
    }

export type BrowserTranslatorIsSupportedResult = {
  type: 'browser-translator-result'
  ok: true
  op: 'is-supported'
  supported: boolean
}

export type BrowserTranslatorAvailabilityResult = {
  type: 'browser-translator-result'
  ok: true
  op: 'availability'
  availability: import('./browser-translator-core').BrowserTranslatorAvailability
}

export type BrowserTranslatorPrepareResult = {
  type: 'browser-translator-result'
  ok: true
  op: 'prepare'
  ready: boolean
  /** Present when ready is false — host-side lastError for diagnostics. */
  error?: string
}

export type BrowserTranslatorTranslateResult = {
  type: 'browser-translator-result'
  ok: true
  op: 'translate'
  translation: string | null
}

export type BrowserTranslatorResult =
  | BrowserTranslatorIsSupportedResult
  | BrowserTranslatorAvailabilityResult
  | BrowserTranslatorPrepareResult
  | BrowserTranslatorTranslateResult
  | { type: 'browser-translator-result'; ok: false; error: string }

/**
 * Background → translator host document only.
 * Host is a top-level extension page (minimized popup), not offscreen —
 * Chrome's Translator API is unavailable in offscreen documents.
 */
export type BrowserTranslatorHostRequest =
  | { type: 'browser-translator-host'; target: 'translator-host'; op: 'is-supported' }
  | {
      type: 'browser-translator-host'
      target: 'translator-host'
      op: 'availability'
      sourceLanguage: string
      targetLanguage: string
    }
  | {
      type: 'browser-translator-host'
      target: 'translator-host'
      op: 'prepare'
      sourceLanguage: string
      targetLanguage: string
    }
  | {
      type: 'browser-translator-host'
      target: 'translator-host'
      op: 'translate'
      text: string
      sourceLanguage: string
      targetLanguage: string
    }

/** @deprecated alias kept for type imports during transition */
export type BrowserTranslatorOffscreenRequest = BrowserTranslatorHostRequest

/** Translator host page → background: idle host window asks to be closed. */
export type CloseTranslatorHostMsg = { type: 'close-translator-host' }
export type CloseTranslatorHostResult = { type: 'close-translator-host-result'; ok: boolean }

/** Content → background: speak/stop text via chrome.tts (not available in content scripts). */
export type TtsSpeakMsg = { type: 'tts-speak'; text: string; lang: string }
export type TtsStopMsg = { type: 'tts-stop' }
export type TtsSpeakResult =
  | { type: 'tts-speak-result'; ok: true }
  | { type: 'tts-speak-result'; ok: false; error: string }

/** Content → background: single-word dictionary card (external engine only). */
export type TranslateDictRequestMsg = {
  type: 'translate-dict'
  text: string
  sourceLanguage: string
  targetLanguage: string
}
export type TranslateDictResult =
  | {
      type: 'translate-dict-result'
      ok: true
      entry: import('./schema').DictionaryEntry
    }
  | { type: 'translate-dict-result'; ok: false; error: string }

export type ToBackground =
  | TranslateBatchRequestMsg
  | TranslateImageRequestMsg
  | TranslateShotMsg
  | GetSettingsMsg
  | PauseHostnameMsg
  | OpenOptionsMsg
  | TestConnectionMsg
  | TestVisionMsg
  | ListModelsMsg
  | GetCacheStatsMsg
  | ClearTranslationCacheMsg
  | BrowserTranslatorRequest
  | CloseTranslatorHostMsg
  | TtsSpeakMsg
  | TtsStopMsg
  | TranslateDictRequestMsg
export type FromBackground =
  | TranslateBatchResultOk
  | TranslateBatchResultErr
  | TranslateImageResultOk
  | TranslateImageResultErr
  | TranslateShotResult
  | SettingsMsg
  | TestConnectionResult
  | TestVisionResult
  | ListModelsResult
  | CacheStatsResult
  | ClearTranslationCacheResult
  | BackgroundErrorResult
  | BrowserTranslatorResult
  | CloseTranslatorHostResult
  | TtsSpeakResult
  | TranslateDictResult
  | { type: 'open-options-result'; ok: boolean }

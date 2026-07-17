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
}

export type TranslateImageRequestMsg = {
  type: 'translate-image'
  imageUrl: string
}

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
  | 'pageTranslationFontSizePx'
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
> & { apiKey: '' }

export type SettingsMsg = {
  type: 'settings'
  /** Minimal content-script settings: no endpoint, model, provider, or secret fields. */
  settings: ContentSettings
  /** Pause state only for the requesting tab; the full hostname list stays in background storage. */
  paused: boolean
  /** Computed against complete background settings before minimization. */
  configured: boolean
}

export type PauseHostnameMsg = {
  type: 'set-hostname-paused'
  hostname: string
  paused: boolean
}

export type OpenOptionsMsg = { type: 'open-options' }

export type ToBackground =
  | TranslateBatchRequestMsg
  | TranslateImageRequestMsg
  | GetSettingsMsg
  | PauseHostnameMsg
  | OpenOptionsMsg
export type FromBackground =
  | TranslateBatchResultOk
  | TranslateBatchResultErr
  | TranslateImageResultOk
  | TranslateImageResultErr
  | SettingsMsg
  | { type: 'open-options-result'; ok: boolean }

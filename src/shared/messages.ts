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
export type SettingsMsg = {
  type: 'settings'
  /** API key is redacted in message responses to content scripts. */
  settings: import('./settings-defaults').UserSettings
  /** True when baseURL + apiKey + model are all set (computed before key redaction). */
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

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
export type SettingsMsg = { type: 'settings'; settings: import('./settings-defaults').UserSettings }

export type PauseHostnameMsg = {
  type: 'set-hostname-paused'
  hostname: string
  paused: boolean
}

export type ToBackground = TranslateBatchRequestMsg | GetSettingsMsg | PauseHostnameMsg
export type FromBackground = TranslateBatchResultOk | TranslateBatchResultErr | SettingsMsg

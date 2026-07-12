import { loadSettings, saveSettings, isConfigured } from '../shared/settings'
import type { UserSettings } from '../shared/settings'
import type {
  FromBackground,
  SettingsMsg,
  ToBackground,
  TranslateBlock,
} from '../shared/messages'
import {
  filterUncachedByText,
  expandTranslationsToAllIds,
  translateAllBlocks,
  translateImage,
} from './translate'

chrome.runtime.onMessage.addListener((rawMessage: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !isToBackground(rawMessage)) {
    sendResponse({ type: 'translate-batch-result', ok: false, error: 'invalid message' })
    return false
  }
  void handle(rawMessage, sender).then(sendResponse)
  return true
})

/** The only settings shape allowed to cross from the trusted background boundary. */
function settingsForContent(settings: UserSettings, hostname = ''): SettingsMsg {
  const {
    sourceLang,
    targetLang,
    autoTranslate,
    browserTranslatorFallback,
    lensWidthPx,
    minTextLength,
    batchCharLimit,
    prefetchMarginRatio,
    hotkey,
  } = settings
  return {
    type: 'settings',
    settings: {
      sourceLang,
      targetLang,
      autoTranslate,
      browserTranslatorFallback,
      lensWidthPx,
      minTextLength,
      batchCharLimit,
      prefetchMarginRatio,
      hotkey,
      apiKey: '',
    },
    paused: hostname ? settings.pausedHostnames.includes(hostname) : false,
    configured: isConfigured(settings),
  }
}

function senderHostname(sender: chrome.runtime.MessageSender): string {
  if (!sender.tab?.url) return ''
  try {
    const url = new URL(sender.tab.url)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname : ''
  } catch {
    return ''
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

function isTranslateBlock(value: unknown): value is TranslateBlock {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    value.id.length <= 256 &&
    typeof value.tag === 'string' &&
    value.tag.length <= 64 &&
    typeof value.text === 'string' &&
    value.text.length <= 20_000
  )
}

/** Runtime validation prevents internal pages from turning the worker into an unbounded fetch proxy. */
function isToBackground(value: unknown): value is ToBackground {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'get-settings' || value.type === 'open-options') return true
  if (value.type === 'set-hostname-paused') {
    return (
      typeof value.hostname === 'string' &&
      value.hostname.length > 0 &&
      value.hostname.length <= 253 &&
      typeof value.paused === 'boolean'
    )
  }
  if (value.type === 'translate-image') {
    return (
      typeof value.imageUrl === 'string' &&
      value.imageUrl.length > 0 &&
      value.imageUrl.length <= 5_500_000
    )
  }
  if (value.type === 'translate-batch') {
    if (
      typeof value.pageKey !== 'string' ||
      value.pageKey.length > 4096 ||
      !Array.isArray(value.blocks) ||
      value.blocks.length > 500
    ) {
      return false
    }
    let totalChars = 0
    for (const block of value.blocks) {
      if (!isTranslateBlock(block)) return false
      totalChars += block.text.length
      if (totalChars > 500_000) return false
    }
    return true
  }
  return false
}

async function handle(
  message: ToBackground,
  sender: chrome.runtime.MessageSender,
): Promise<FromBackground> {
  if (message.type === 'get-settings') {
    const settings = await loadSettings()
    return settingsForContent(settings, senderHostname(sender))
  }

  if (message.type === 'set-hostname-paused') {
    const settings = await loadSettings()
    const set = new Set(settings.pausedHostnames)
    if (message.paused) set.add(message.hostname)
    else set.delete(message.hostname)
    const next = { ...settings, pausedHostnames: [...set] }
    await saveSettings(next)
    return settingsForContent(next, message.hostname)
  }

  if (message.type === 'open-options') {
    try {
      await chrome.runtime.openOptionsPage()
      return { type: 'open-options-result', ok: true }
    } catch {
      return { type: 'open-options-result', ok: false }
    }
  }

  if (message.type === 'translate-image') {
    const settings = await loadSettings()
    if (!isConfigured(settings)) {
      return { type: 'translate-image-result', ok: false, error: 'API not configured' }
    }
    const result = await translateImage(message.imageUrl, settings)
    return result.ok
      ? { type: 'translate-image-result', ok: true, translation: result.translation }
      : { type: 'translate-image-result', ok: false, error: result.error }
  }

  if (message.type === 'translate-batch') {
    const settings = await loadSettings()
    if (!isConfigured(settings)) {
      return {
        type: 'translate-batch-result',
        ok: false,
        error: 'API not configured',
        failedIds: message.blocks.map((b) => b.id),
      }
    }

    const { cached, missing, textHashToIds, idToText } = filterUncachedByText(
      message.pageKey,
      settings.sourceLang,
      settings.targetLang,
      message.blocks,
    )

    if (missing.length === 0) {
      return { type: 'translate-batch-result', ok: true, translations: cached }
    }

    const result = await translateAllBlocks(missing, settings)
    const expanded = expandTranslationsToAllIds(
      message.pageKey,
      settings.sourceLang,
      settings.targetLang,
      result.translations,
      idToText,
      textHashToIds,
    )
    const translations = [...cached, ...expanded]

    if (result.ok) {
      return { type: 'translate-batch-result', ok: true, translations }
    }

    const cacheKeyById = new Map<string, string>()
    for (const [cacheKey, ids] of textHashToIds) {
      for (const id of ids) cacheKeyById.set(id, cacheKey)
    }
    const failedSet = new Set<string>()
    for (const failedId of result.failedIds) {
      const cacheKey = cacheKeyById.get(failedId)
      if (!cacheKey) {
        failedSet.add(failedId)
        continue
      }
      for (const id of textHashToIds.get(cacheKey) ?? [failedId]) failedSet.add(id)
    }
    return {
      type: 'translate-batch-result',
      ok: false,
      error: result.error,
      failedIds: [...failedSet],
      translations,
    }
  }

  return { type: 'translate-batch-result', ok: false, error: 'unknown message' }
}

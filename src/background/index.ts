import { loadSettings, saveSettings, isConfigured } from '../shared/settings'
import type { ToBackground } from '../shared/messages'
import {
  filterUncached,
  putCached,
  translateAllBlocks,
} from './translate'

chrome.runtime.onMessage.addListener((message: ToBackground, _sender, sendResponse) => {
  void handle(message).then(sendResponse)
  return true // async
})

function settingsForContent(settings: Awaited<ReturnType<typeof loadSettings>>) {
  return {
    type: 'settings' as const,
    settings: { ...settings, apiKey: '' },
    configured: isConfigured(settings),
  }
}

async function handle(message: ToBackground) {
  if (message.type === 'get-settings') {
    const settings = await loadSettings()
    return settingsForContent(settings)
  }

  if (message.type === 'set-hostname-paused') {
    const settings = await loadSettings()
    const set = new Set(settings.pausedHostnames)
    if (message.paused) set.add(message.hostname)
    else set.delete(message.hostname)
    const next = { ...settings, pausedHostnames: [...set] }
    await saveSettings(next)
    return settingsForContent(next)
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
    const { cached, missing } = filterUncached(message.pageKey, message.blocks)
    if (missing.length === 0) {
      return { type: 'translate-batch-result', ok: true, translations: cached }
    }
    const result = await translateAllBlocks(missing, settings)
    if (result.translations.length) putCached(message.pageKey, result.translations)
    const translations = [...cached, ...result.translations]
    if (result.ok) {
      return { type: 'translate-batch-result', ok: true, translations }
    }
    return {
      type: 'translate-batch-result',
      ok: false,
      error: result.error,
      failedIds: result.failedIds,
      translations,
    }
  }

  return { type: 'translate-batch-result', ok: false, error: 'unknown message' }
}

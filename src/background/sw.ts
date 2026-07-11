import { loadSettings, saveSettings, isConfigured } from '../shared/settings'
import type { ToBackground } from '../shared/messages'
import {
  filterUncachedByText,
  expandTranslationsToAllIds,
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

  if (message.type === 'open-options') {
    try {
      await chrome.runtime.openOptionsPage()
      return { type: 'open-options-result', ok: true }
    } catch {
      return { type: 'open-options-result', ok: false }
    }
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

    // Map failed representative ids → all ids that share their text
    const failedSet = new Set<string>()
    for (const fid of result.failedIds) {
      const key = [...textHashToIds.entries()].find(([, ids]) => ids.includes(fid))?.[0]
      if (key) {
        for (const id of textHashToIds.get(key) ?? [fid]) failedSet.add(id)
      } else {
        failedSet.add(fid)
      }
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

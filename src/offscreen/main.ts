import { BrowserTranslatorCore } from '../shared/browser-translator-core'
import type { BrowserTranslatorHostRequest } from '../shared/messages'

/**
 * Top-level extension document that hosts Chrome Translator API.
 * Loaded as a minimized popup window (not chrome.offscreen) because the
 * on-device Translator API is not available in offscreen documents.
 *
 * Content scripts on restricted hosts (Gmail, Vertex, …) proxy here via SW
 * when the page-local Translator is blocked by Permissions-Policy.
 */
const translator = new BrowserTranslatorCore()

/**
 * The host window exists only to serve translation requests. When nothing has
 * used it for a while it asks the service worker to close it, so the helper
 * window never lingers on the desktop waiting for a manual close. In-flight
 * operations (e.g. a language-pack download) postpone the close.
 */
const IDLE_CLOSE_MS = 3 * 60_000
let idleCloseTimer = 0
let pendingOps = 0

function scheduleIdleClose(): void {
  window.clearTimeout(idleCloseTimer)
  idleCloseTimer = window.setTimeout(() => {
    if (pendingOps > 0) {
      scheduleIdleClose()
      return
    }
    void chrome.runtime
      .sendMessage({ type: 'close-translator-host' })
      .then((response: unknown) => {
        // Anything but an explicit ok means the window is still open — retry
        // later instead of leaving it on the desktop forever.
        if (!(response && typeof response === 'object' && 'ok' in response && response.ok)) {
          scheduleIdleClose()
        }
      })
      .catch((error: unknown) => {
        // After an extension reload this page's context is dead: retrying would
        // spin forever, and only the browser closing can remove the window.
        const message = error instanceof Error ? error.message : String(error)
        if (/invalidated/i.test(message)) return
        // Service worker restarting — try again later.
        scheduleIdleClose()
      })
  }, IDLE_CLOSE_MS)
}

scheduleIdleClose()

chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
  if (!isHostRequest(raw)) return false
  pendingOps++
  void handle(raw)
    .then(sendResponse)
    .catch((error: unknown) => {
      sendResponse({
        type: 'browser-translator-host-result',
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    })
    .finally(() => {
      pendingOps--
      scheduleIdleClose()
    })
  return true
})

function isHostRequest(value: unknown): value is BrowserTranslatorHostRequest {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'type' in value &&
      value.type === 'browser-translator-host' &&
      'target' in value &&
      value.target === 'translator-host' &&
      'op' in value &&
      typeof value.op === 'string',
  )
}

async function handle(message: BrowserTranslatorHostRequest): Promise<Record<string, unknown>> {
  switch (message.op) {
    case 'is-supported':
      return {
        type: 'browser-translator-host-result',
        ok: true,
        op: 'is-supported',
        supported: translator.isSupported(),
      }
    case 'availability':
      return {
        type: 'browser-translator-host-result',
        ok: true,
        op: 'availability',
        availability: await translator.availability(
          message.sourceLanguage,
          message.targetLanguage,
        ),
      }
    case 'prepare': {
      const ready = await translator.prepare(message.sourceLanguage, message.targetLanguage)
      return {
        type: 'browser-translator-host-result',
        ok: true,
        op: 'prepare',
        ready,
        ...(ready ? {} : { error: translator.lastError ?? 'prepare failed' }),
      }
    }
    case 'translate': {
      const translation = await translator.translate(
        message.text,
        message.sourceLanguage,
        message.targetLanguage,
      )
      return {
        type: 'browser-translator-host-result',
        ok: true,
        op: 'translate',
        translation,
        ...(translation === null && translator.lastError
          ? { error: translator.lastError }
          : {}),
      }
    }
    default:
      return {
        type: 'browser-translator-host-result',
        ok: false,
        error: 'unknown translator-host op',
      }
  }
}

import type {
  BrowserTranslatorAvailabilityResult,
  BrowserTranslatorIsSupportedResult,
  BrowserTranslatorPrepareResult,
  BrowserTranslatorRequest,
  BrowserTranslatorResult,
  BrowserTranslatorTranslateResult,
  BrowserTranslatorHostRequest,
} from '../shared/messages'
import type { BrowserTranslatorAvailability } from '../shared/browser-translator-core'

/**
 * Top-level extension page that runs Translator.
 * Must NOT be chrome.offscreen — Chrome throws
 * "The on-device translation is not available" there.
 */
const HOST_PATH = 'src/offscreen/index.html'
const HOST_READY_TIMEOUT_MS = 8000

let creatingHost: Promise<void> | null = null
let hostWindowId: number | null = null

function hostUrl(): string {
  return chrome.runtime.getURL(HOST_PATH)
}

async function findHostContexts(): Promise<chrome.runtime.ExtensionContext[]> {
  if (!chrome.runtime.getContexts) return []
  return chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.TAB],
    documentUrls: [hostUrl()],
  })
}

async function hasHostDocument(): Promise<boolean> {
  return (await findHostContexts()).length > 0
}

/**
 * Ensure a top-level extension page is open to host Translator.
 * Uses a tiny unfocused popup window (minimized right after creation, and
 * closed by the host page after an idle stretch) so Permissions-Policy of
 * Gmail/Vertex does not apply, while still providing a real browsing context.
 */
export async function ensureTranslatorHost(): Promise<void> {
  if (await hasHostDocument()) return
  if (creatingHost) {
    await creatingHost
    return
  }

  creatingHost = (async () => {
    if (!chrome.windows?.create) {
      throw new Error('chrome.windows API unavailable (missing "windows" permission)')
    }

    // Close a stale tracked window id if any.
    if (hostWindowId !== null) {
      try {
        await chrome.windows.remove(hostWindowId)
      } catch {
        // already gone
      }
      hostWindowId = null
    }

    const win = await chrome.windows.create({
      url: HOST_PATH,
      type: 'popup',
      focused: false,
      width: 280,
      height: 120,
      // Tiny popup parked in the corner; minimized right after creation below
      // and auto-closed by the host page itself after an idle stretch.
      left: 0,
      top: 0,
    })
    hostWindowId = win?.id ?? null

    // Best-effort: popup windows cannot be created minimized, but most Chrome
    // builds accept minimizing right after — keeps the host off the desktop.
    if (hostWindowId !== null) {
      try {
        await chrome.windows.update(hostWindowId, { state: 'minimized' })
      } catch {
        // Unsupported for popup windows on this platform — leave it parked.
      }
    }

    // Wait until the host page is listening.
    const deadline = Date.now() + HOST_READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (await hasHostDocument()) {
        // Probe is-supported once so the listener is warm.
        try {
          await sendToHost({
            type: 'browser-translator-host',
            target: 'translator-host',
            op: 'is-supported',
          })
          return
        } catch {
          // still booting
        }
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error('translator host failed to start')
  })()
    .catch((error) => {
      hostWindowId = null
      throw error
    })
    .finally(() => {
      creatingHost = null
    })

  await creatingHost
}

/**
 * The host page asks to be closed after an idle stretch so the helper window
 * never lingers on the user's desktop. Only the real host document may close
 * a window, and only the window it lives in.
 */
export async function handleCloseTranslatorHost(
  sender: chrome.runtime.MessageSender,
): Promise<{ type: 'close-translator-host-result'; ok: boolean }> {
  const windowId = sender.tab?.windowId
  if (sender.url !== hostUrl() || windowId === undefined) {
    return { type: 'close-translator-host-result', ok: false }
  }
  try {
    await chrome.windows.remove(windowId)
  } catch {
    // already gone
  }
  if (hostWindowId === windowId) hostWindowId = null
  return { type: 'close-translator-host-result', ok: true }
}

function sendToHost(request: BrowserTranslatorHostRequest): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(request, (response: unknown) => {
      const err = chrome.runtime.lastError
      if (err) {
        reject(new Error(err.message))
        return
      }
      if (!response || typeof response !== 'object') {
        reject(new Error('translator host returned empty response'))
        return
      }
      resolve(response as Record<string, unknown>)
    })
  })
}

async function callHost(
  request: BrowserTranslatorHostRequest,
): Promise<Record<string, unknown>> {
  await ensureTranslatorHost()
  try {
    return await sendToHost(request)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/receiving end does not exist|no.*receiver/i.test(message)) {
      hostWindowId = null
      await ensureTranslatorHost()
      return sendToHost(request)
    }
    throw error
  }
}

function toHostRequest(message: BrowserTranslatorRequest): BrowserTranslatorHostRequest {
  switch (message.op) {
    case 'is-supported':
      return { type: 'browser-translator-host', target: 'translator-host', op: 'is-supported' }
    case 'availability':
      return {
        type: 'browser-translator-host',
        target: 'translator-host',
        op: 'availability',
        sourceLanguage: message.sourceLanguage,
        targetLanguage: message.targetLanguage,
      }
    case 'prepare':
      return {
        type: 'browser-translator-host',
        target: 'translator-host',
        op: 'prepare',
        sourceLanguage: message.sourceLanguage,
        targetLanguage: message.targetLanguage,
      }
    case 'translate':
      return {
        type: 'browser-translator-host',
        target: 'translator-host',
        op: 'translate',
        text: message.text,
        sourceLanguage: message.sourceLanguage,
        targetLanguage: message.targetLanguage,
      }
  }
}

export async function handleBrowserTranslatorRequest(
  message: BrowserTranslatorRequest,
): Promise<BrowserTranslatorResult> {
  try {
    const response = await callHost(toHostRequest(message))
    if (response.ok === false) {
      return {
        type: 'browser-translator-result',
        ok: false,
        error: String(response.error ?? 'translator host error'),
      }
    }

    switch (message.op) {
      case 'is-supported': {
        const result: BrowserTranslatorIsSupportedResult = {
          type: 'browser-translator-result',
          ok: true,
          op: 'is-supported',
          supported: Boolean(response.supported),
        }
        return result
      }
      case 'availability': {
        const result: BrowserTranslatorAvailabilityResult = {
          type: 'browser-translator-result',
          ok: true,
          op: 'availability',
          availability: response.availability as BrowserTranslatorAvailability,
        }
        return result
      }
      case 'prepare': {
        const result: BrowserTranslatorPrepareResult = {
          type: 'browser-translator-result',
          ok: true,
          op: 'prepare',
          ready: Boolean(response.ready),
          ...(typeof response.error === 'string' && response.error
            ? { error: response.error }
            : {}),
        }
        return result
      }
      case 'translate': {
        const translation =
          typeof response.translation === 'string' ? response.translation : null
        const result: BrowserTranslatorTranslateResult = {
          type: 'browser-translator-result',
          ok: true,
          op: 'translate',
          translation,
        }
        return result
      }
    }
  } catch (error) {
    return {
      type: 'browser-translator-result',
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

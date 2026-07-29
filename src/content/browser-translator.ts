import {
  BrowserTranslatorCore,
  type BrowserTranslatorAvailability,
  type BrowserTranslatorDownloadProgress,
} from '../shared/browser-translator-core'
import type { BrowserTranslatorRequest, BrowserTranslatorResult } from '../shared/messages'

export type {
  BrowserTranslatorAvailability,
  BrowserTranslatorDownloadProgress,
} from '../shared/browser-translator-core'

type Route = 'local' | 'remote' | 'auto'

function isUsable(availability: BrowserTranslatorAvailability): boolean {
  return (
    availability === 'available' ||
    availability === 'downloadable' ||
    availability === 'downloading'
  )
}

/**
 * Hybrid Chrome on-device translator:
 * 1. Prefer page-local Translator (fast; works on most sites).
 * 2. If the page blocks it (Gmail/Vertex Permissions-Policy → unavailable),
 *    proxy through the service worker → top-level extension host window.
 *
 * Never sticky-locks onto the remote host: a failed host window or a prior
 * policy-blocked page must not make a working browser look "unsupported".
 *
 * Never uses chrome.offscreen for Translator — that context throws
 * "The on-device translation is not available".
 */
export class BrowserTranslator {
  private readonly local = new BrowserTranslatorCore()
  private route: Route = 'auto'
  private remoteSupportedCache: boolean | null = null
  /** Last failure detail from prepare/translate (local or remote). */
  lastError: string | null = null

  isSupported(): boolean {
    if (this.local.isSupported()) return true
    if (this.remoteSupportedCache === null) {
      void this.refreshRemoteSupported()
      return true
    }
    return this.remoteSupportedCache
  }

  async refreshRemoteSupported(): Promise<boolean> {
    const result = await this.request({ type: 'browser-translator', op: 'is-supported' })
    if (result.ok && result.op === 'is-supported') {
      this.remoteSupportedCache = result.supported
      return result.supported
    }
    // Transport failure is not proof the browser lacks Translator.
    this.remoteSupportedCache = null
    return false
  }

  /**
   * Download/create the language pack. Prefer page-local create first so a
   * user click on options/onboarding is not spent spinning up the host window
   * (which also drops progress callbacks and user-activation context).
   */
  async prepare(
    sourceLanguage: string,
    targetLanguage: string,
    onDownloadProgress?: BrowserTranslatorDownloadProgress,
  ): Promise<boolean> {
    this.lastError = null

    if (this.local.isSupported()) {
      const ok = await this.local.prepare(sourceLanguage, targetLanguage, onDownloadProgress)
      if (ok) {
        this.route = 'local'
        this.lastError = null
        return true
      }
      this.lastError = this.local.lastError
      // Fall through to remote host when local create fails (policy / missing API quirks).
    }

    const remoteOk = await this.prepareRemote(sourceLanguage, targetLanguage)
    if (remoteOk) {
      this.route = 'remote'
      this.lastError = null
      return true
    }

    this.route = 'auto'
    if (!this.lastError) {
      this.lastError = this.local.lastError ?? 'prepare failed'
    }
    return false
  }

  async availability(
    sourceLanguage: string,
    targetLanguage: string,
  ): Promise<BrowserTranslatorAvailability> {
    return this.probeAvailability(sourceLanguage, targetLanguage)
  }

  async translate(
    text: string,
    sourceLanguage: string,
    targetLanguage: string,
  ): Promise<string | null> {
    const route = await this.resolveRoute(sourceLanguage, targetLanguage)
    if (route === 'local') {
      const translation = await this.local.translate(text, sourceLanguage, targetLanguage)
      if (translation !== null) return translation
      this.route = 'remote'
      const remote = await this.translateRemote(text, sourceLanguage, targetLanguage)
      if (remote === null) this.route = 'auto'
      return remote
    }
    const remote = await this.translateRemote(text, sourceLanguage, targetLanguage)
    if (remote !== null) return remote
    // Host flaked — clear sticky remote and try local once if present.
    this.route = 'auto'
    if (this.local.isSupported()) {
      return this.local.translate(text, sourceLanguage, targetLanguage)
    }
    return null
  }

  private async resolveRoute(
    sourceLanguage: string,
    targetLanguage: string,
  ): Promise<'local' | 'remote'> {
    // Always re-probe. Sticky remote after Gmail (etc.) previously made normal
    // pages keep using a dead host and look like "browser unsupported".
    await this.probeAvailability(sourceLanguage, targetLanguage)
    return this.route === 'remote' ? 'remote' : 'local'
  }

  private async probeAvailability(
    sourceLanguage: string,
    targetLanguage: string,
  ): Promise<BrowserTranslatorAvailability> {
    // Always try page-local first when the API exists in this world.
    if (this.local.isSupported()) {
      const local = await this.local.availability(sourceLanguage, targetLanguage)
      if (isUsable(local)) {
        this.route = 'local'
        return local
      }

      // Local pair unusable — may be Permissions-Policy (Gmail) or a real
      // missing language pack. Probe extension host as a second path.
      const remote = await this.availabilityRemote(sourceLanguage, targetLanguage)
      if (isUsable(remote)) {
        this.route = 'remote'
        return remote
      }

      // Both failed: keep route open for the next call; prefer the local pair
      // status (downloadable/unavailable) over a flaky host's "unsupported".
      this.route = 'auto'
      if (local === 'downloadable' || local === 'downloading' || local === 'unavailable') {
        return local
      }
      return remote
    }

    // No page-local API — only the extension host can help.
    const remote = await this.availabilityRemote(sourceLanguage, targetLanguage)
    if (isUsable(remote)) {
      this.route = 'remote'
      return remote
    }
    this.route = 'auto'
    return remote
  }

  private async prepareRemote(sourceLanguage: string, targetLanguage: string): Promise<boolean> {
    const result = await this.request({
      type: 'browser-translator',
      op: 'prepare',
      sourceLanguage,
      targetLanguage,
    })
    if (result.ok && result.op === 'prepare') {
      if (result.ready) return true
      this.lastError = result.error ?? this.lastError ?? 'prepare failed'
      return false
    }
    this.lastError =
      !result.ok && 'error' in result && typeof result.error === 'string'
        ? result.error
        : this.lastError ?? 'prepare failed'
    return false
  }

  private async availabilityRemote(
    sourceLanguage: string,
    targetLanguage: string,
  ): Promise<BrowserTranslatorAvailability> {
    const result = await this.request({
      type: 'browser-translator',
      op: 'availability',
      sourceLanguage,
      targetLanguage,
    })
    // Only trust affirmative host answers. Messaging / host-window failures are
    // transient and must not be mapped to "browser unsupported".
    if (result.ok && result.op === 'availability') return result.availability
    return 'unavailable'
  }

  private async translateRemote(
    text: string,
    sourceLanguage: string,
    targetLanguage: string,
  ): Promise<string | null> {
    const result = await this.request({
      type: 'browser-translator',
      op: 'translate',
      text,
      sourceLanguage,
      targetLanguage,
    })
    if (result.ok && result.op === 'translate') return result.translation
    return null
  }

  private request(message: BrowserTranslatorRequest): Promise<BrowserTranslatorResult> {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response: unknown) => {
          if (chrome.runtime.lastError) {
            resolve({
              type: 'browser-translator-result',
              ok: false,
              error: chrome.runtime.lastError.message ?? 'messaging failed',
            })
            return
          }
          if (
            response &&
            typeof response === 'object' &&
            'type' in response &&
            response.type === 'browser-translator-result'
          ) {
            resolve(response as BrowserTranslatorResult)
            return
          }
          resolve({
            type: 'browser-translator-result',
            ok: false,
            error: 'invalid browser-translator response',
          })
        })
      } catch (error) {
        resolve({
          type: 'browser-translator-result',
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })
  }
}

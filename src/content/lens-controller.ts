import { matchesHotkey } from '../shared/hotkey'
import { makeBlockId } from '../shared/block-id'
import type { UserSettings } from '../shared/settings-defaults'
import { DEFAULT_SETTINGS, mergeSettings } from '../shared/settings-defaults'
import type {
  SettingsMsg,
  TranslateBatchResultErr,
  TranslateBatchResultOk,
  TranslateBlock,
  TranslateImageResultErr,
  TranslateImageResultOk,
} from '../shared/messages'
import { normalizeText } from '../shared/text'
import { coarsePath, extractBlockAtElement, extractVisibleBlocks } from './extract'
import { BlockRegistry } from './registry'
import { LensOverlay } from './lens'
import { BrowserTranslator } from './browser-translator'
import { ImageRegistry, type ImageTranslationEntry } from './image-registry'
import { makePageKey } from './page-key'
import { TranslationBatcher } from './translation-batcher'

const TAP_STICKY_MS = 320

// ---------------------------------------------------------------------------
// Runtime type guards (no runtime dep, zero alloc on hot path)
// ---------------------------------------------------------------------------

function isImageTranslationResult(
  value: unknown,
): value is TranslateImageResultOk | TranslateImageResultErr {
  if (!value || typeof value !== 'object' || !('type' in value) || !('ok' in value)) return false
  if (value.type !== 'translate-image-result' || typeof value.ok !== 'boolean') return false
  return value.ok
    ? 'translation' in value && typeof value.translation === 'string'
    : 'error' in value && typeof value.error === 'string'
}

function isTranslationRow(value: unknown): value is { id: string; translation: string } {
  if (!value || typeof value !== 'object') return false
  return (
    'id' in value &&
    typeof value.id === 'string' &&
    'translation' in value &&
    typeof value.translation === 'string'
  )
}

function isTranslateBatchResult(
  value: unknown,
): value is TranslateBatchResultOk | TranslateBatchResultErr {
  if (!value || typeof value !== 'object' || !('type' in value) || !('ok' in value)) return false
  if (value.type !== 'translate-batch-result' || typeof value.ok !== 'boolean') return false
  if (value.ok) {
    return (
      'translations' in value &&
      Array.isArray(value.translations) &&
      value.translations.every(isTranslationRow)
    )
  }
  if (!('error' in value) || typeof value.error !== 'string') return false
  return (
    !('translations' in value) ||
    value.translations === undefined ||
    (Array.isArray(value.translations) && value.translations.every(isTranslationRow))
  )
}

function isSettingsMessage(value: unknown): value is SettingsMsg {
  if (!value || typeof value !== 'object') return false
  if (!('type' in value) || value.type !== 'settings') return false
  if (!('configured' in value) || typeof value.configured !== 'boolean') return false
  if (!('settings' in value) || !value.settings || typeof value.settings !== 'object') return false
  if (!('paused' in value) || typeof value.paused !== 'boolean') return false
  return 'apiKey' in value.settings && value.settings.apiKey === ''
}

function translateSigOf(s: UserSettings, isConfiguredFlag: boolean): string {
  return [
    isConfiguredFlag,
    s.sourceLang,
    s.targetLang,
    s.autoTranslate,
    s.browserTranslatorFallback,
    s.minTextLength,
    s.batchCharLimit,
  ].join('\0')
}

// ---------------------------------------------------------------------------
// LensController
// ---------------------------------------------------------------------------

/**
 * Owns all lens interaction state and orchestrates the translation pipeline.
 * Created once per content-script lifecycle; `main.ts` only mounts it.
 */
export class LensController {
  // --- sub-systems ---
  private readonly registry = new BlockRegistry()
  private readonly imageRegistry = new ImageRegistry()
  private readonly browserTranslator = new BrowserTranslator()
  private readonly lens: LensOverlay
  private readonly batcher: TranslationBatcher

  // --- settings state ---
  settings: UserSettings = DEFAULT_SETTINGS
  private configured = false
  private pausedHere = false
  private translateSettingsSig = ''

  // --- lens interaction state ---
  private lensActive = false
  private lensSticky = false
  private hotkeyDownAt = 0
  private lastMouse = { x: 0, y: 0 }

  // --- in-flight dedup ---
  /** In-flight block ids — avoid duplicate API calls for the same block. */
  private readonly inflight = new Set<string>()
  /** In-flight normalized texts — identical sentences share one request. */
  private readonly inflightTexts = new Set<string>()
  private readonly imageInflight = new Set<string>()

  // --- rAF + bind guard ---
  private pointerFrame = 0
  private listenersBound = false

  constructor(lensWidthPx = 340) {
    this.lens = new LensOverlay(lensWidthPx)
    this.batcher = new TranslationBatcher((blocks) => this.translateSpecific(blocks))
  }

  // -------------------------------------------------------------------------
  // Public API (called from main.ts)
  // -------------------------------------------------------------------------

  bindListeners(): void {
    if (this.listenersBound) return
    this.listenersBound = true
    window.addEventListener('keydown', this.onKeyDown, true)
    window.addEventListener('keyup', this.onKeyUp, true)
    window.addEventListener('blur', this.onBlur)
    window.addEventListener('mousemove', this.onMouseMove, true)

    const scheduleScan = debounce(() => {
      if (this.settings.autoTranslate) void this.scanVisibleAndTranslate()
    }, 300)
    window.addEventListener('scroll', scheduleScan, true)
    window.addEventListener('resize', scheduleScan)

    const mo = new MutationObserver(
      debounce(() => {
        if (this.settings.autoTranslate) void this.scanVisibleAndTranslate()
      }, 500),
    )
    mo.observe(document.documentElement, { childList: true, subtree: true })

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings) void this.refreshSettings()
    })
  }

  /** Refresh only redacted settings; the API key never enters the content-script world. */
  async refreshSettings(): Promise<void> {
    try {
      const response: unknown = await chrome.runtime.sendMessage({ type: 'get-settings' })
      if (!isSettingsMessage(response)) throw new Error('Invalid settings response')

      this.configured = response.configured
      this.settings = mergeSettings(response.settings)
      this.pausedHere = response.paused
      if (this.pausedHere && this.lensActive) this.deactivateLens()
      this.lens.setWidth(this.settings.lensWidthPx)

      const sig = translateSigOf(this.settings, this.configured)
      const changed = sig !== this.translateSettingsSig
      const previousSig = this.translateSettingsSig
      this.translateSettingsSig = sig

      if (this.configured && changed) {
        if (previousSig !== '') this.registry.resetErrorsToPending()
        if (this.settings.autoTranslate) void this.scanVisibleAndTranslate()
      }
    } catch (error) {
      console.warn(
        '[Lens Translator] settings refresh failed',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  ensureMouseSeed(): void {
    if (this.lastMouse.x === 0 && this.lastMouse.y === 0) {
      this.lastMouse = {
        x: Math.round(window.innerWidth / 2),
        y: Math.round(window.innerHeight / 2),
      }
    }
  }

  async scanVisibleAndTranslate(): Promise<void> {
    if (this.pausedHere || !this.settings.autoTranslate || !this.configured) return
    const margin = Math.round(window.innerHeight * this.settings.prefetchMarginRatio)
    const blocks = extractVisibleBlocks(this.settings.minTextLength, margin)
    for (const b of blocks) {
      this.registry.upsert({ id: b.id, el: b.el, tag: b.tag, text: b.text })
    }
    const pending = this.registry.pendingBlocks().filter((b) => !this.inflight.has(b.id))
    if (!pending.length) return
    await this.translateSpecific(pending)
  }

  // -------------------------------------------------------------------------
  // Private interaction handlers (arrow fns to preserve `this` in addEventListener)
  // -------------------------------------------------------------------------

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.lensActive) {
      e.preventDefault()
      this.deactivateLens()
      return
    }

    if (this.pausedHere) return
    if (!matchesHotkey(e, this.settings.hotkey)) return
    if (e.repeat) {
      e.preventDefault()
      return
    }
    e.preventDefault()
    e.stopPropagation()

    if (this.lensActive && this.lensSticky) {
      this.deactivateLens()
      return
    }

    if (!this.lensActive) {
      this.lensActive = true
      this.lensSticky = false
      this.hotkeyDownAt = Date.now()
      this.ensureMouseSeed()
      if (this.settings.browserTranslatorFallback && this.browserTranslator.isSupported()) {
        void this.browserTranslator.prepare(this.settings.sourceLang, this.settings.targetLang)
      }
      this.updateLens()
    }
  }

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (!this.lensActive || this.lensSticky || !this.isHotkeyRelease(e)) return

    const heldMs = Date.now() - this.hotkeyDownAt
    if (heldMs > 0 && heldMs < TAP_STICKY_MS) {
      this.lensSticky = true
      return
    }
    this.deactivateLens()
  }

  private readonly onBlur = (): void => {
    if (this.lensActive && !this.lensSticky) this.deactivateLens()
  }

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (e.composedPath().includes(this.lens.getHost())) return
    this.lastMouse = { x: e.clientX, y: e.clientY }
    if (!this.lensActive || this.pointerFrame) return
    this.pointerFrame = requestAnimationFrame(() => {
      this.pointerFrame = 0
      this.updateLens()
    })
  }

  // -------------------------------------------------------------------------
  // Lens update
  // -------------------------------------------------------------------------

  private updateLens(): void {
    if (!this.lensActive) {
      this.lens.hide()
      return
    }
    this.ensureMouseSeed()
    const host = this.lens.getHost()
    const stack = document
      .elementsFromPoint(this.lastMouse.x, this.lastMouse.y)
      .filter((el) => el !== host && !host.contains(el))
    const hit = stack[0] ?? null

    const imageEntry = this.imageEntryForHit(hit)
    if (imageEntry) {
      if (!this.configured) {
        this.lens.showAt(this.lastMouse.x, this.lastMouse.y, { kind: 'unconfigured' })
        this.lens.highlight(null)
        return
      }

      const sourceRect = imageEntry.el.getBoundingClientRect()
      this.lens.highlight(imageEntry.el)
      if (imageEntry.status === 'ready' && imageEntry.translation) {
        this.lens.showAt(this.lastMouse.x, this.lastMouse.y, {
          kind: 'ready',
          text: imageEntry.translation,
          sourceRect,
        })
        return
      }
      if (imageEntry.status === 'error' && !this.imageInflight.has(imageEntry.id)) {
        this.lens.showAt(this.lastMouse.x, this.lastMouse.y, {
          kind: 'error',
          message: imageEntry.error ?? '图片翻译失败',
          sourceRect,
        })
        return
      }

      this.lens.showAt(this.lastMouse.x, this.lastMouse.y, { kind: 'pending', sourceRect })
      void this.translateImageEntry(imageEntry)
      return
    }

    if (
      !this.configured &&
      (!this.settings.browserTranslatorFallback || !this.browserTranslator.isSupported())
    ) {
      this.lens.showAt(this.lastMouse.x, this.lastMouse.y, { kind: 'unconfigured' })
      this.lens.highlight(null)
      return
    }

    let entry = this.registry.getByElement(hit)
    if (!entry) {
      const block = extractBlockAtElement(hit, this.settings.minTextLength)
      if (block) entry = this.registry.upsert(block)
    }

    if (!entry) {
      this.lens.showAt(this.lastMouse.x, this.lastMouse.y, { kind: 'empty' })
      this.lens.highlight(null)
      return
    }

    this.lens.highlight(entry.el)
    const sourceRect = entry.el.getBoundingClientRect()
    const sourceText = entry.text

    if (entry.status === 'ready' && entry.translation) {
      this.lens.showAt(this.lastMouse.x, this.lastMouse.y, {
        kind: 'ready',
        text: entry.translation,
        sourceText,
        sourceRect,
      })
      return
    }

    if (entry.status === 'error' && !this.inflight.has(entry.id)) {
      this.lens.showAt(this.lastMouse.x, this.lastMouse.y, {
        kind: 'error',
        message: entry.error ?? '翻译失败',
        sourceText,
        sourceRect,
      })
      return
    }

    // Need translation — show EN while waiting
    this.lens.showAt(this.lastMouse.x, this.lastMouse.y, {
      kind: 'pending',
      sourceText,
      sourceRect,
    })
    if (!this.inflight.has(entry.id)) {
      this.batcher.enqueue({ id: entry.id, tag: entry.tag, text: entry.text })
    }
  }

  private deactivateLens(): void {
    this.lensActive = false
    this.lensSticky = false
    this.hotkeyDownAt = 0
    this.lens.hide()
  }

  // -------------------------------------------------------------------------
  // Translation
  // -------------------------------------------------------------------------

  private async translateImageEntry(entry: ImageTranslationEntry): Promise<void> {
    if (this.pausedHere || !this.configured || this.imageInflight.has(entry.id)) return

    this.imageInflight.add(entry.id)
    this.imageRegistry.setPending(entry.id)
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'translate-image',
        imageUrl: entry.url,
      })
      if (!isImageTranslationResult(result)) {
        this.imageRegistry.setError(entry.id, '图片翻译服务未返回有效结果')
      } else if (result.ok) {
        this.imageRegistry.setTranslation(entry.id, result.translation)
      } else {
        this.imageRegistry.setError(entry.id, result.error)
      }
    } catch (error) {
      this.imageRegistry.setError(entry.id, error instanceof Error ? error.message : String(error))
    } finally {
      this.imageInflight.delete(entry.id)
    }

    if (this.lensActive) this.updateLens()
  }

  /**
   * Translate unresolved blocks with Chrome's on-device Translator API.
   * The browser session is sequential; no configured API endpoint is contacted.
   */
  private async translateWithBrowser(blocks: TranslateBlock[]): Promise<void> {
    if (!this.settings.browserTranslatorFallback || !this.browserTranslator.isSupported()) return

    for (const block of blocks) {
      const translation = await this.browserTranslator.translate(
        block.text,
        this.settings.sourceLang,
        this.settings.targetLang,
      )
      if (translation) this.registry.setTranslation(block.id, translation)
    }
  }

  /**
   * Send blocks to the configured API, then use Chrome's on-device translator
   * for any unresolved blocks when the fallback is enabled.
   */
  async translateSpecific(blocks: TranslateBlock[]): Promise<void> {
    if (this.pausedHere) return

    const todo: TranslateBlock[] = []
    const seenText = new Set<string>()

    for (const b of blocks) {
      const e = this.registry.get(b.id)
      if (!e) continue
      if (e.status === 'ready' && e.translation) continue
      if (this.inflight.has(b.id)) continue
      const norm = normalizeText(b.text)
      if (this.inflightTexts.has(norm)) continue
      if (seenText.has(norm)) {
        this.registry.setPending(b.id)
        continue
      }
      seenText.add(norm)
      todo.push({ id: b.id, tag: b.tag, text: norm })
    }
    if (!todo.length) return

    for (const b of todo) {
      this.inflight.add(b.id)
      this.inflightTexts.add(normalizeText(b.text))
      this.registry.setPending(b.id)
    }

    let error = this.configured ? '翻译失败' : 'API 未配置，Chrome 内置翻译不可用'
    try {
      if (this.configured) {
        const response: unknown = await chrome.runtime.sendMessage({
          type: 'translate-batch',
          pageKey: makePageKey(),
          blocks: todo,
        })
        if (!isTranslateBatchResult(response)) {
          error = '翻译服务未返回有效结果'
        } else {
          for (const item of response.translations ?? []) {
            this.registry.setTranslation(item.id, item.translation)
          }
          if (!response.ok) error = response.error
        }
      }

      const unresolved = todo.filter((b) => !this.registry.get(b.id)?.translation)
      if (unresolved.length) await this.translateWithBrowser(unresolved)

      for (const b of todo) {
        if (!this.registry.get(b.id)?.translation) this.registry.setError(b.id, error)
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      await this.translateWithBrowser(todo.filter((b) => !this.registry.get(b.id)?.translation))
      for (const b of todo) {
        if (!this.registry.get(b.id)?.translation) this.registry.setError(b.id, error)
      }
    } finally {
      for (const b of todo) {
        this.inflight.delete(b.id)
        this.inflightTexts.delete(normalizeText(b.text))
      }
    }

    if (this.lensActive) this.updateLens()
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private imageEntryForHit(hit: Element | null): ImageTranslationEntry | undefined {
    if (!(hit instanceof HTMLImageElement)) return undefined
    if (!hit.complete || hit.naturalWidth < 2 || hit.naturalHeight < 2) return undefined
    const url = hit.currentSrc || hit.src
    if (!url) return undefined
    return this.imageRegistry.upsert(makeBlockId('img', url, coarsePath(hit)), hit, url)
  }

  private isHotkeyRelease(e: KeyboardEvent): boolean {
    const h = this.settings.hotkey
    if (e.code === h.code) return true
    if (h.altKey && (e.code === 'AltLeft' || e.code === 'AltRight' || e.key === 'Alt')) return true
    if (h.shiftKey && (e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.key === 'Shift')) {
      return true
    }
    if (
      h.ctrlKey &&
      (e.code === 'ControlLeft' || e.code === 'ControlRight' || e.key === 'Control')
    ) {
      return true
    }
    if (h.metaKey && (e.code === 'MetaLeft' || e.code === 'MetaRight' || e.key === 'Meta')) {
      return true
    }
    return false
  }
}

// ---------------------------------------------------------------------------
// Standalone util (not exported — used only here)
// ---------------------------------------------------------------------------

function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let t = 0
  return ((...args: unknown[]) => {
    window.clearTimeout(t)
    t = window.setTimeout(() => fn(...args), ms)
  }) as T
}

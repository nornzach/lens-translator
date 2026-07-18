import { matchesHotkey } from '../shared/hotkey'
import { makeBlockId } from '../shared/block-id'
import type { UserSettings } from '../shared/settings-defaults'
import { DEFAULT_SETTINGS, mergeSettings } from '../shared/settings-defaults'
import type {
  BubbleControlMsg,
  BubbleControlResult,
  SettingsMsg,
  TranslateBatchResultErr,
  TranslateBatchResultOk,
  TranslateBlock,
  TranslateImageResultErr,
  TranslateImageResultOk,
  TogglePageTranslationResult,
} from '../shared/messages'
import { isPredominantlyTargetLanguage, normalizeText } from '../shared/text'
import { coarsePath, extractBlockAtElement, extractVisibleBlocks } from './extract'
import { BlockRegistry } from './registry'
import { LensOverlay } from './lens'
import { BrowserTranslator } from './browser-translator'
import { ImageRegistry, type ImageTranslationEntry } from './image-registry'
import { makePageKey } from './page-key'
import { TranslationBatcher } from './translation-batcher'
import { PageTranslator } from './page-translator'
import { pageMatchesSourceLanguage } from './page-language'

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

function backgroundError(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  if (!('type' in value) || value.type !== 'background-error') return null
  return 'error' in value && typeof value.error === 'string' ? value.error : null
}

/**
 * Signature of settings that require re-translating the page (language pair,
 * engine, thresholds). A change here tears down and rebuilds the run.
 */
export function lensTranslationSigOf(s: UserSettings, isConfiguredFlag: boolean): string {
  return [
    s.translationEngine === 'external' ? isConfiguredFlag : true,
    s.sourceLang,
    s.targetLang,
    s.translationEngine,
    s.minTextLength,
    s.batchCharLimit,
  ].join('\0')
}

export function pageTranslationSigOf(s: UserSettings, isConfiguredFlag: boolean): string {
  return [
    s.pageTranslationEngine === 'external' ? isConfiguredFlag : true,
    s.sourceLang,
    s.targetLang,
    s.pageTranslationEngine,
    s.minTextLength,
    s.batchCharLimit,
  ].join('\0')
}

/**
 * Signature of appearance-only settings (font size, colors, weight…). A change
 * here just re-injects the stylesheet, keeping translations in place.
 */
function pageStyleSigOf(s: UserSettings): string {
  return [
    s.pageTranslationFontFamily,
    s.pageTranslationFontSizePx,
    s.pageTranslationUseCustomColor,
    s.pageTranslationTextColor,
    s.pageTranslationUseBackground,
    s.pageTranslationBackgroundColor,
    s.pageTranslationBold,
    s.pageTranslationItalic,
    s.pageTranslationUnderline,
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
  private readonly pageTranslator = new PageTranslator(this.browserTranslator)
  private readonly lens: LensOverlay
  private readonly batcher: TranslationBatcher

  // --- settings state ---
  settings: UserSettings = DEFAULT_SETTINGS
  private configured = false
  private pausedHere = false
  private lensSettingsSig = ''
  private pageSettingsSig = ''
  private pageStyleSig = ''
  private autoPageStartPending = false
  private settingsGeneration = 0
  private translationGeneration = 0

  // --- lens interaction state ---
  private lensActive = false
  private lensSticky = false
  private hotkeyDownAt = 0
  private lastMouse = { x: 0, y: 0 }

  // --- in-flight dedup ---
  /** In-flight block ids — avoid duplicate API calls for the same block. */
  private readonly inflight = new Map<string, number>()
  /** In-flight normalized texts — identical sentences share one request. */
  private readonly inflightTexts = new Map<string, number>()
  private readonly imageInflight = new Set<string>()

  // --- rAF + bind guard ---
  private pointerFrame = 0
  private stickyFrame = 0
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

    // A pinned (sticky) lens must keep its highlight ring aligned with the source
    // element as the page scrolls; the ring lives in a fixed overlay otherwise.
    window.addEventListener('scroll', this.onStickyReposition, true)
    window.addEventListener('resize', this.onStickyReposition)

    const mo = new MutationObserver(
      debounce(() => {
        if (this.settings.autoTranslate) void this.scanVisibleAndTranslate()
      }, 500),
    )
    mo.observe(document.documentElement, { childList: true, subtree: true })

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings) void this.refreshSettings()
    })

    // Popup and floating controls drive the same state transitions as hotkeys.
    chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
      if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object') return false
      const type = (message as { type?: unknown }).type
      if (type === 'toggle-page-translation') {
        void this.togglePageTranslation().then(sendResponse, (error: unknown) => {
          sendResponse(controlError(error))
        })
        return true
      }
      if (type === 'bubble-control' && isBubbleControlMessage(message)) {
        void this.handleBubbleControl(message).then(sendResponse, (error: unknown) => {
          sendResponse(controlError(error))
        })
        return true
      }
      return false
    })
  }

  /** Refresh only redacted settings; the API key never enters the content-script world. */
  async refreshSettings(): Promise<void> {
    try {
      const response: unknown = await chrome.runtime.sendMessage({ type: 'get-settings' })
      const responseError = backgroundError(response)
      if (responseError) throw new Error(responseError)
      if (!isSettingsMessage(response)) throw new Error('Invalid settings response')

      const previousSettings = this.settings
      this.configured = response.configured
      this.settings = mergeSettings(response.settings)
      this.settingsGeneration++
      this.pausedHere = response.paused
      if (this.pausedHere) {
        if (this.lensActive) this.deactivateLens()
        if (this.pageTranslator.isActive()) this.pageTranslator.deactivate()
      }
      this.lens.setWidth(this.settings.lensWidthPx)
      this.lens.setFontSize(this.settings.pageTranslationFontSizePx)
      this.lens.setFontFamily(this.settings.pageTranslationFontFamily)
      this.lens.setAppearance(this.settings)

      const lensSig = lensTranslationSigOf(this.settings, this.configured)
      const lensChanged = lensSig !== this.lensSettingsSig
      const previousLensSig = this.lensSettingsSig
      this.lensSettingsSig = lensSig

      const pageSig = pageTranslationSigOf(this.settings, this.configured)
      const pageChanged = pageSig !== this.pageSettingsSig
      const previousPageSig = this.pageSettingsSig
      this.pageSettingsSig = pageSig

      const styleSig = pageStyleSigOf(this.settings)
      const styleChanged = styleSig !== this.pageStyleSig
      this.pageStyleSig = styleSig

      if (previousPageSig !== '' && pageChanged && this.pageTranslator.isActive()) {
        this.pageTranslator.deactivate()
      } else if (styleChanged && this.pageTranslator.isActive()) {
        // Appearance-only change: restyle in place instead of losing translations.
        this.pageTranslator.restyle(this.settings)
      }

      if (previousLensSig !== '' && lensChanged) {
        this.translationGeneration++
        this.inflight.clear()
        this.inflightTexts.clear()
        this.registry.resetTranslationsToPending()
      }
      if (
        this.canTranslateText() &&
        this.settings.autoTranslate &&
        (lensChanged || !previousSettings.autoTranslate)
      ) {
        void this.scanVisibleAndTranslate()
      }
      if (this.settings.autoPageTranslation) await this.maybeStartPageTranslation()
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

  async togglePageTranslation(): Promise<TogglePageTranslationResult> {
    if (this.pageTranslator.isActive()) {
      this.pageTranslator.deactivate()
      return { ok: true }
    }
    const error = this.pageTranslationError()
    if (error) return { ok: false, error }
    if (this.lensActive) this.deactivateLens()
    await this.pageTranslator.toggle(this.settings, this.configured)
    return { ok: true }
  }

  toggleStickyLens(): BubbleControlResult {
    if (this.lensActive) {
      this.deactivateLens()
      return this.bubbleState()
    }
    if (this.pausedHere) return { ok: false, error: '当前网站已暂停翻译' }
    if (!this.canTranslateText()) {
      return {
        ok: false,
        error:
          this.settings.translationEngine === 'browser'
            ? '当前浏览器不支持 Chrome 内置翻译'
            : '透镜翻译需要先配置外部 API',
      }
    }
    this.lensActive = true
    this.lensSticky = true
    this.ensureMouseSeed()
    if (this.settings.translationEngine === 'browser') {
      void this.browserTranslator.prepare(this.settings.sourceLang, this.settings.targetLang)
    }
    this.updateLens()
    return this.bubbleState()
  }

  async scanVisibleAndTranslate(): Promise<void> {
    if (this.pausedHere || !this.settings.autoTranslate || !this.canTranslateText()) return
    const margin = Math.round(window.innerHeight * this.settings.prefetchMarginRatio)
    const blocks = extractVisibleBlocks(this.settings.minTextLength, margin)
    for (const b of blocks) {
      this.registry.upsert({ id: b.id, el: b.el, tag: b.tag, text: b.text })
    }
    const pending = this.registry
      .pendingBlocks()
      .filter(
        (block) =>
          !this.inflight.has(block.id) &&
          !isPredominantlyTargetLanguage(block.text, this.settings.targetLang),
      )
    if (!pending.length) return
    await this.translateSpecific(pending)
  }

  async maybeStartPageTranslation(): Promise<void> {
    if (
      this.autoPageStartPending ||
      this.pausedHere ||
      !this.settings.autoPageTranslation ||
      this.pageTranslator.isActive() ||
      !pageMatchesSourceLanguage(this.settings.sourceLang)
    ) {
      return
    }
    if (this.settings.pageTranslationEngine === 'external' && !this.configured) return

    const settingsGeneration = this.settingsGeneration
    const settings = this.settings
    const configured = this.configured
    this.autoPageStartPending = true
    try {
      if (settings.pageTranslationEngine === 'browser') {
        const availability = await this.browserTranslator.availability(
          settings.sourceLang,
          settings.targetLang,
        )
        if (availability !== 'available') return
      }
      if (
        settingsGeneration !== this.settingsGeneration ||
        this.pausedHere ||
        !this.settings.autoPageTranslation ||
        this.pageTranslator.isActive()
      ) {
        return
      }
      await this.pageTranslator.activate(settings, configured)
    } finally {
      this.autoPageStartPending = false
      if (
        settingsGeneration !== this.settingsGeneration &&
        this.settings.autoPageTranslation &&
        !this.pausedHere &&
        !this.pageTranslator.isActive()
      ) {
        void this.maybeStartPageTranslation()
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private interaction handlers (arrow fns to preserve `this` in addEventListener)
  // -------------------------------------------------------------------------

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      if (this.lensActive) {
        e.preventDefault()
        this.deactivateLens()
        return
      }
      if (this.pageTranslator.isActive()) {
        e.preventDefault()
        this.pageTranslator.deactivate()
        return
      }
    }

    if (this.pausedHere) return
    if (matchesHotkey(e, this.settings.pageTranslationHotkey)) {
      if (e.repeat) {
        e.preventDefault()
        return
      }
      e.preventDefault()
      e.stopPropagation()
      void this.togglePageTranslation()
      return
    }
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
      if (this.settings.translationEngine === 'browser' && this.browserTranslator.isSupported()) {
        void this.browserTranslator.prepare(this.settings.sourceLang, this.settings.targetLang)
      }
      this.updateLens()
    }
  }

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (!this.lensActive || this.lensSticky) return

    // The defining (non-modifier) key was released: this is the only event that
    // may pin the lens, so tap-vs-hold is judged consistently regardless of the
    // order in which combo keys are lifted.
    if (e.code === this.settings.hotkey.code) {
      const heldMs = Date.now() - this.hotkeyDownAt
      if (heldMs > 0 && heldMs < TAP_STICKY_MS) {
        this.lensSticky = true
        return
      }
      this.deactivateLens()
      return
    }

    // A required modifier was released before the defining key: the combo is
    // broken, so drop the preview rather than leaving a dangling lens. Never
    // auto-pins here, which prevents an out-of-order release from sticking.
    if (this.isHotkeyModifierRelease(e)) this.deactivateLens()
  }

  private readonly onBlur = (): void => {
    if (this.lensActive && !this.lensSticky) this.deactivateLens()
  }

  private readonly onMouseMove = (e: MouseEvent): void => {
    const path = e.composedPath()
    if (
      path.includes(this.lens.getHost()) ||
      path.some(
        (item) => item instanceof Element && item.id === 'lens-translator-bubble-root',
      )
    ) {
      return
    }
    this.lastMouse = { x: e.clientX, y: e.clientY }
    if (!this.lensActive || this.pointerFrame) return
    this.pointerFrame = requestAnimationFrame(() => {
      this.pointerFrame = 0
      this.updateLens()
    })
  }

  private readonly onStickyReposition = (): void => {
    if (!this.lensActive || !this.lensSticky || this.stickyFrame) return
    this.stickyFrame = requestAnimationFrame(() => {
      this.stickyFrame = 0
      this.lens.reposition()
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

    if (!this.canTranslateText()) {
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

    if (isPredominantlyTargetLanguage(entry.text, this.settings.targetLang)) {
      this.lens.showAt(this.lastMouse.x, this.lastMouse.y, { kind: 'target-language' })
      this.lens.highlight(entry.el)
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
   * Translate blocks with Chrome's on-device Translator API. The browser session
   * is sequential, and no configured API endpoint is contacted.
   */
  private async translateWithBrowser(blocks: TranslateBlock[]): Promise<void> {
    if (!this.browserTranslator.isSupported()) return

    const generation = this.translationGeneration
    const sourceLang = this.settings.sourceLang
    const targetLang = this.settings.targetLang

    for (const block of blocks) {
      if (generation !== this.translationGeneration) return
      const translation = await this.browserTranslator.translate(
        block.text,
        sourceLang,
        targetLang,
      )
      if (generation !== this.translationGeneration) return
      if (translation) this.registry.setTranslation(block.id, translation)
    }
  }

  /**
   * Translate blocks using only the selected text engine. Engines never fall
   * back to each other.
   */
  async translateSpecific(blocks: TranslateBlock[]): Promise<void> {
    if (this.pausedHere) return

    const generation = this.translationGeneration
    const engine = this.settings.translationEngine
    const configured = this.configured
    const todo: TranslateBlock[] = []
    const seenText = new Set<string>()

    for (const b of blocks) {
      if (isPredominantlyTargetLanguage(b.text, this.settings.targetLang)) continue
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
      this.inflight.set(b.id, generation)
      this.inflightTexts.set(normalizeText(b.text), generation)
      this.registry.setPending(b.id)
    }

    let error =
      engine === 'browser'
        ? 'Chrome 内置翻译不可用或不支持当前语言对'
        : '外部 API 未配置'
    try {
      if (engine === 'browser') {
        await this.translateWithBrowser(todo)
      } else if (configured) {
        const response: unknown = await chrome.runtime.sendMessage({
          type: 'translate-batch',
          pageKey: makePageKey(),
          blocks: todo,
        })
        if (generation !== this.translationGeneration) return
        if (!isTranslateBatchResult(response)) {
          error = '翻译服务未返回有效结果'
        } else {
          for (const item of response.translations ?? []) {
            this.registry.setTranslation(item.id, item.translation)
          }
          if (!response.ok) error = response.error
        }
      }

      if (generation !== this.translationGeneration) return
      for (const b of todo) {
        if (!this.registry.get(b.id)?.translation) this.registry.setError(b.id, error)
      }
    } catch (err) {
      if (generation !== this.translationGeneration) return
      error = err instanceof Error ? err.message : String(err)
      for (const b of todo) {
        if (!this.registry.get(b.id)?.translation) this.registry.setError(b.id, error)
      }
    } finally {
      for (const b of todo) {
        if (this.inflight.get(b.id) === generation) this.inflight.delete(b.id)
        const text = normalizeText(b.text)
        if (this.inflightTexts.get(text) === generation) this.inflightTexts.delete(text)
      }
    }

    if (this.lensActive) this.updateLens()
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private canTranslateText(): boolean {
    return this.settings.translationEngine === 'browser'
      ? this.browserTranslator.isSupported()
      : this.configured
  }

  private pageTranslationError(): string | null {
    if (this.pausedHere) return '当前网站已暂停翻译'
    if (this.settings.pageTranslationEngine === 'external' && !this.configured) {
      return '整页翻译需要先配置外部 API'
    }
    if (
      this.settings.pageTranslationEngine === 'browser' &&
      !this.browserTranslator.isSupported()
    ) {
      return '当前浏览器不支持 Chrome 内置翻译'
    }
    return null
  }

  private bubbleState(): BubbleControlResult {
    return {
      ok: true,
      lensActive: this.lensActive,
      pageTranslationActive: this.pageTranslator.isActive(),
    }
  }

  private async handleBubbleControl(message: BubbleControlMsg): Promise<BubbleControlResult> {
    if (message.command === 'get-state') return this.bubbleState()
    if (message.command === 'toggle-lens') return this.toggleStickyLens()
    const result = await this.togglePageTranslation()
    return result.ok ? this.bubbleState() : result
  }

  private imageEntryForHit(hit: Element | null): ImageTranslationEntry | undefined {
    if (!(hit instanceof HTMLImageElement)) return undefined
    if (!hit.complete || hit.naturalWidth < 2 || hit.naturalHeight < 2) return undefined
    const url = hit.currentSrc || hit.src
    if (!url) return undefined
    return this.imageRegistry.upsert(makeBlockId('img', url, coarsePath(hit)), hit, url)
  }

  private isHotkeyModifierRelease(e: KeyboardEvent): boolean {
    const h = this.settings.hotkey
    if (h.altKey && (e.code === 'AltLeft' || e.code === 'AltRight')) return true
    if (h.shiftKey && (e.code === 'ShiftLeft' || e.code === 'ShiftRight')) return true
    if (h.ctrlKey && (e.code === 'ControlLeft' || e.code === 'ControlRight')) return true
    if (h.metaKey && (e.code === 'MetaLeft' || e.code === 'MetaRight')) return true
    return false
  }
}

function isBubbleControlMessage(value: object): value is BubbleControlMsg {
  if (!('command' in value)) return false
  return (
    value.command === 'get-state' ||
    value.command === 'toggle-page-translation' ||
    value.command === 'toggle-lens'
  )
}

function controlError(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
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

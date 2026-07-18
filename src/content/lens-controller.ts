import { matchesHotkey } from '../shared/hotkey'
import { languageShortLabel } from '../shared/languages'
import { makeBlockId } from '../shared/block-id'
import type { UserSettings } from '../shared/settings-defaults'
import { DEFAULT_SETTINGS, mergeSettings } from '../shared/settings-defaults'
import type {
  BubbleControlMsg,
  BubbleControlResult,
  SettingsMsg,
  ToggleLensResult,
  TranslateBatchResultErr,
  TranslateBatchResultOk,
  TranslateBlock,
  TranslateImageResultErr,
  TranslateImageResultOk,
  TogglePageTranslationResult,
} from '../shared/messages'
import { isPredominantlyTargetLanguage, normalizeText } from '../shared/text'
import {
  coarsePath,
  extractLensTargetAt,
  extractVisibleBlocks,
  LENS_MIN_TEXT_LENGTH,
} from './extract'
import { BlockRegistry } from './registry'
import { LensOverlay } from './lens'
import { BrowserTranslator } from './browser-translator'
import { ImageRegistry, type ImageTranslationEntry } from './image-registry'
import { makePageKey } from './page-key'
import { TranslationBatcher } from './translation-batcher'
import { PageTranslator } from './page-translator'
import { evaluatePageLanguageMatch } from './page-language'
import { SelectionTranslator } from './selection-translator'
import { SetupPrompt } from './setup-prompt'

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
  private readonly setupPrompt = new SetupPrompt()
  private readonly selectionTranslator: SelectionTranslator

  // --- settings state ---
  settings: UserSettings = DEFAULT_SETTINGS
  private configured = false
  private pausedHere = false
  private lensSettingsSig = ''
  private pageSettingsSig = ''
  private pageStyleSig = ''
  private autoPageStartPending = false
  /**
   * Auto full-page start is once-per-page and must never fight the user:
   * - suppress: user closed full-page (Esc/toggle) → do not re-open until they re-enable the switch
   * - abandoned: this page definitively is not the source language / pack unusable
   * Retries only cover SPA hydration and language-pack download, with hard caps.
   */
  private autoPageRetryTimer = 0
  private autoPageRetryDeadline = 0
  private autoPageRetryAttempts = 0
  private autoPageRetryBackoffMs = 1000
  private autoPageSuppress = false
  private autoPageAbandoned = false
  private autoPageNoticeAt = 0
  private autoPageNoticeText = ''
  private settingsGeneration = 0
  private translationGeneration = 0

  // --- lens interaction state ---
  private lensActive = false
  private lensSticky = false
  private hotkeyDownAt = 0
  /** True while the lens hotkey combo is physically held (survives async readiness checks). */
  private hotkeyHeld = false
  private lastMouse = { x: 0, y: 0 }
  /** Throttle full-screen setup prompt when selection translation hits a cold engine. */
  private lastSelectionSetupPromptAt = 0

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
  private autoScanMo: MutationObserver | null = null
  private onBubbleVisibility: ((visible: boolean) => void) | null = null

  constructor(lensWidthPx = 340) {
    this.lens = new LensOverlay(lensWidthPx)
    this.batcher = new TranslationBatcher((blocks) => this.translateSpecific(blocks))
    this.selectionTranslator = new SelectionTranslator((text) => this.translateSelectionText(text))
  }

  /** Optional host for the edge bubble so settings can hide it without remounting. */
  setBubbleVisibilityHandler(handler: (visible: boolean) => void): void {
    this.onBubbleVisibility = handler
    handler(this.settings.showFloatingBubble !== false && !this.pausedHere)
  }

  // -------------------------------------------------------------------------
  // Public API (called from main.ts)
  // -------------------------------------------------------------------------

  bindListeners(): void {
    if (this.listenersBound) return
    this.listenersBound = true
    this.selectionTranslator.bind()
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

    // MutationObserver is only attached while auto-prefetch is on (see syncAutoScanObserver).

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings) void this.refreshSettings()
    })

    // Popup, toolbar icon, and floating controls drive the same state transitions as hotkeys.
    chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
      if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object') return false
      const type = (message as { type?: unknown }).type
      if (type === 'toggle-page-translation') {
        void this.togglePageTranslation().then(sendResponse, (error: unknown) => {
          sendResponse(controlError(error))
        })
        return true
      }
      if (type === 'toggle-lens') {
        void this.toggleStickyLensAsync().then(sendResponse, (error: unknown) => {
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
        this.selectionTranslator.hide()
        this.suppressAutoPage('paused')
      }
      this.lens.setWidth(this.settings.lensWidthPx)
      this.lens.setFontSize(this.settings.pageTranslationFontSizePx)
      this.lens.setFontFamily(this.settings.pageTranslationFontFamily)
      this.lens.setAppearance(this.settings)
      this.lens.setLanguageLabels(
        languageShortLabel(this.settings.sourceLang),
        languageShortLabel(this.settings.targetLang),
      )
      this.selectionTranslator.setPaused(this.pausedHere)
      this.selectionTranslator.setEnabled(this.settings.selectionTranslate)
      this.selectionTranslator.setLanguages(this.settings.sourceLang, this.settings.targetLang)
      this.onBubbleVisibility?.(this.settings.showFloatingBubble && !this.pausedHere)
      this.syncAutoScanObserver()

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

      // Re-arm auto-start only when the user turns the switch on, or language/engine changes.
      if (
        this.settings.autoPageTranslation &&
        (!previousSettings.autoPageTranslation || pageChanged)
      ) {
        this.autoPageSuppress = false
        this.autoPageAbandoned = false
        this.resetAutoPageRetryBudget()
      }
      if (!this.settings.autoPageTranslation) {
        this.suppressAutoPage('auto-off')
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
      // Manual close must not be undone by the next auto-start retry/settings tick.
      this.suppressAutoPage('user-close')
      return { ok: true }
    }
    const ready = await this.ensureEngineReady('page')
    if (!ready.ok) return ready
    if (this.lensActive) this.deactivateLens()
    // Manual open: suppress further auto-start noise for this page session.
    this.suppressAutoPage('user-open')
    await this.pageTranslator.toggle(this.settings, this.configured)
    return { ok: true }
  }

  /** Always gates on engine readiness (language pack / API), never only isSupported(). */
  async toggleStickyLensAsync(): Promise<ToggleLensResult> {
    if (this.lensActive) {
      this.deactivateLens()
      return { ok: true, lensActive: false }
    }
    if (this.pausedHere) return { ok: false, error: '当前网站已暂停翻译' }
    const ready = await this.ensureEngineReady('lens')
    if (!ready.ok) return ready
    this.activateStickyLens()
    return { ok: true, lensActive: true }
  }

  private activateStickyLens(): void {
    this.lensActive = true
    this.lensSticky = true
    this.hotkeyHeld = false
    this.ensureMouseSeed()
    if (this.settings.translationEngine === 'browser') {
      void this.browserTranslator.prepare(this.settings.sourceLang, this.settings.targetLang)
    }
    this.updateLens()
  }

  private activateTemporaryLens(downAt: number): void {
    this.lensActive = true
    this.lensSticky = false
    this.hotkeyDownAt = downAt
    this.ensureMouseSeed()
    if (this.settings.translationEngine === 'browser') {
      void this.browserTranslator.prepare(this.settings.sourceLang, this.settings.targetLang)
    }
    this.updateLens()
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
      this.autoPageSuppress ||
      this.autoPageAbandoned ||
      this.pausedHere ||
      !this.settings.autoPageTranslation ||
      this.pageTranslator.isActive()
    ) {
      return
    }

    const lang = evaluatePageLanguageMatch(this.settings.sourceLang)
    if (!lang.matches) {
      if (lang.shouldRetry) {
        this.scheduleAutoPageRetry(`lang:${lang.reason}`)
      } else {
        // Definitive mismatch (e.g. long Chinese body) — stop polling this page.
        this.abandonAutoPage(`lang:${lang.reason}`)
      }
      return
    }

    if (this.settings.pageTranslationEngine === 'external' && !this.configured) {
      this.abandonAutoPage('external-unconfigured')
      return
    }

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
        if (availability !== 'available') {
          if (availability === 'downloadable' || availability === 'downloading') {
            this.scheduleAutoPageRetry(`pack:${availability}`)
            this.noticeAutoPageBlocked(
              availability === 'downloading'
                ? 'Chrome 语言包下载中，就绪后将自动开启整页翻译'
                : '请先在设置中下载 Chrome 语言包，才能自动开启整页翻译',
            )
          } else {
            this.abandonAutoPage(`pack:${availability}`)
            this.noticeAutoPageBlocked(
              'Chrome 内置翻译当前不可用，自动整页已跳过（可改用外部 LLM 或手动开启）',
            )
          }
          return
        }
      }
      if (
        settingsGeneration !== this.settingsGeneration ||
        this.autoPageSuppress ||
        this.pausedHere ||
        !this.settings.autoPageTranslation ||
        this.pageTranslator.isActive()
      ) {
        return
      }

      // Hand off to PageTranslator once. Mutation observer there owns incremental content —
      // this method must not keep re-activating.
      this.clearAutoPageRetry()
      await this.pageTranslator.activate(settings, configured)
      if (this.pageTranslator.isActive()) {
        // Success (including “waiting for SPA content”): never auto-activate again on this page.
        this.suppressAutoPage('auto-started')
      } else {
        // Hard failure (missing API, unsupported, empty after grace, …) — stop polling.
        this.abandonAutoPage('activate-failed')
      }
    } finally {
      this.autoPageStartPending = false
      // Only re-enter immediately when settings changed mid-flight — never a free loop.
      if (
        settingsGeneration !== this.settingsGeneration &&
        this.settings.autoPageTranslation &&
        !this.autoPageSuppress &&
        !this.autoPageAbandoned &&
        !this.pausedHere &&
        !this.pageTranslator.isActive()
      ) {
        void this.maybeStartPageTranslation()
      }
    }
  }

  private static readonly AUTO_PAGE_RETRY_MAX_ATTEMPTS = 12
  private static readonly AUTO_PAGE_RETRY_WINDOW_MS = 12_000
  private static readonly AUTO_PAGE_RETRY_BACKOFF_MAX_MS = 2_500

  private scheduleAutoPageRetry(_reason: string): void {
    if (
      !this.settings.autoPageTranslation ||
      this.pausedHere ||
      this.autoPageSuppress ||
      this.autoPageAbandoned ||
      this.pageTranslator.isActive()
    ) {
      return
    }
    const now = Date.now()
    if (!this.autoPageRetryDeadline) {
      this.autoPageRetryDeadline = now + LensController.AUTO_PAGE_RETRY_WINDOW_MS
      this.autoPageRetryAttempts = 0
      this.autoPageRetryBackoffMs = 1000
    }
    if (
      now > this.autoPageRetryDeadline ||
      this.autoPageRetryAttempts >= LensController.AUTO_PAGE_RETRY_MAX_ATTEMPTS
    ) {
      this.abandonAutoPage('retry-budget-exhausted')
      return
    }
    if (this.autoPageRetryTimer) return

    const delay = this.autoPageRetryBackoffMs
    this.autoPageRetryAttempts++
    this.autoPageRetryBackoffMs = Math.min(
      Math.round(this.autoPageRetryBackoffMs * 1.35),
      LensController.AUTO_PAGE_RETRY_BACKOFF_MAX_MS,
    )
    this.autoPageRetryTimer = window.setTimeout(() => {
      this.autoPageRetryTimer = 0
      if (
        this.settings.autoPageTranslation &&
        !this.autoPageSuppress &&
        !this.autoPageAbandoned &&
        !this.pausedHere &&
        !this.pageTranslator.isActive()
      ) {
        void this.maybeStartPageTranslation()
      }
    }, delay)
  }

  private clearAutoPageRetry(): void {
    if (this.autoPageRetryTimer) window.clearTimeout(this.autoPageRetryTimer)
    this.autoPageRetryTimer = 0
  }

  private resetAutoPageRetryBudget(): void {
    this.clearAutoPageRetry()
    this.autoPageRetryDeadline = 0
    this.autoPageRetryAttempts = 0
    this.autoPageRetryBackoffMs = 1000
  }

  private suppressAutoPage(_reason: string): void {
    this.autoPageSuppress = true
    this.clearAutoPageRetry()
  }

  private abandonAutoPage(_reason: string): void {
    this.autoPageAbandoned = true
    this.clearAutoPageRetry()
    this.autoPageRetryDeadline = 0
    this.autoPageRetryAttempts = 0
  }

  /** Throttled console notice only — never mounts UI that could flicker. */
  private noticeAutoPageBlocked(message: string): void {
    const now = Date.now()
    if (message === this.autoPageNoticeText && now - this.autoPageNoticeAt < 30_000) return
    this.autoPageNoticeAt = now
    this.autoPageNoticeText = message
    console.info('[Lens Translator]', message)
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
        this.suppressAutoPage('escape')
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
      // Record hold state *before* any await so release during readiness is observed.
      this.hotkeyHeld = true
      this.hotkeyDownAt = Date.now()
      void this.beginHotkeyLens(this.hotkeyDownAt)
    }
  }

  /**
   * Hold/tap hotkey entry. Engine readiness is async; if the user already released
   * during the check, a short press pins sticky and a long press does nothing.
   */
  private async beginHotkeyLens(downAt: number): Promise<void> {
    const ready = await this.ensureEngineReady('lens')
    if (!ready.ok) {
      this.hotkeyHeld = false
      return
    }
    if (this.lensActive) return

    if (!this.hotkeyHeld) {
      const heldMs = Date.now() - downAt
      // Tap completed while we were waiting → pin sticky. Long hold already over → stay closed.
      if (heldMs > 0 && heldMs < TAP_STICKY_MS) this.activateStickyLens()
      return
    }

    this.activateTemporaryLens(downAt)
  }

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    const isDefining = e.code === this.settings.hotkey.code
    const isModifier = this.isHotkeyModifierRelease(e)
    if (isDefining || isModifier) this.hotkeyHeld = false

    if (!this.lensActive || this.lensSticky) return

    // The defining (non-modifier) key was released: this is the only event that
    // may pin the lens, so tap-vs-hold is judged consistently regardless of the
    // order in which combo keys are lifted.
    if (isDefining) {
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
    if (isModifier) this.deactivateLens()
  }

  private readonly onBlur = (): void => {
    this.hotkeyHeld = false
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

    // Lens uses deep pointer resolution (caret + tightest unit), not full-page
    // extract policy (which skips nav/pre/tooltips and enforces long min lengths).
    const lensMin = Math.min(LENS_MIN_TEXT_LENGTH + 1, this.settings.minTextLength)
    let entry = this.registry.getByElement(hit)
    if (!entry) {
      const block = extractLensTargetAt(this.lastMouse.x, this.lastMouse.y, lensMin)
      if (block) entry = this.registry.upsert(block)
    } else {
      // If registry only has a coarse parent from prefetch, re-resolve tightly under the cursor.
      const deep = extractLensTargetAt(this.lastMouse.x, this.lastMouse.y, lensMin)
      if (deep && deep.el !== entry.el && deep.text.length < entry.text.length) {
        entry = this.registry.upsert(deep)
      }
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
    this.hotkeyHeld = false
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
        this.imageRegistry.setError(entry.id, clarifyImageError(result.error))
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

  private syncAutoScanObserver(): void {
    if (this.settings.autoTranslate && !this.pausedHere) {
      if (!this.autoScanMo) {
        this.autoScanMo = new MutationObserver(
          debounce(() => {
            if (this.settings.autoTranslate) void this.scanVisibleAndTranslate()
          }, 500),
        )
        this.autoScanMo.observe(document.documentElement, {
          childList: true,
          subtree: true,
          characterData: true,
        })
      }
      return
    }
    this.autoScanMo?.disconnect()
    this.autoScanMo = null
  }

  /**
   * Gate browser / external engines before starting lens or full-page mode.
   * Shows an in-page prompt when a language pack is missing or LLM is unconfigured.
   * `quiet` skips the modal (used by selection translate; prompt is rate-limited there).
   */
  private async ensureEngineReady(
    mode: 'lens' | 'page',
    opts?: { quiet?: boolean },
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.pausedHere) return { ok: false, error: '当前网站已暂停翻译' }
    const engine =
      mode === 'lens' ? this.settings.translationEngine : this.settings.pageTranslationEngine
    const quiet = opts?.quiet === true

    if (engine === 'external') {
      if (this.configured) return { ok: true }
      if (!quiet) this.showEngineSetupPrompt({ kind: 'external-unconfigured' })
      return {
        ok: false,
        error: mode === 'lens' ? '透镜翻译需要先配置外部 API' : '整页翻译需要先配置外部 API',
      }
    }

    if (!this.browserTranslator.isSupported()) {
      if (!quiet) this.showEngineSetupPrompt({ kind: 'browser-unsupported' })
      return { ok: false, error: '当前浏览器不支持 Chrome 内置翻译' }
    }

    const availability = await this.browserTranslator.availability(
      this.settings.sourceLang,
      this.settings.targetLang,
    )
    if (availability === 'available') return { ok: true }

    if (!quiet) this.showEngineSetupPrompt({ kind: 'language-pack', availability })

    const message =
      availability === 'unavailable'
        ? '当前语言对在 Chrome 内置翻译中不可用'
        : '需要先下载 Chrome 语言包'
    return { ok: false, error: message }
  }

  private showEngineSetupPrompt(
    reason:
      | { kind: 'browser-unsupported' }
      | { kind: 'external-unconfigured' }
      | {
          kind: 'language-pack'
          availability: Awaited<ReturnType<BrowserTranslator['availability']>>
        },
  ): void {
    if (this.setupPrompt.isOpen()) return
    this.setupPrompt.show(
      reason,
      { sourceLang: this.settings.sourceLang, targetLang: this.settings.targetLang },
      {
        onDownload:
          reason.kind === 'language-pack'
            ? async () => {
                this.setupPrompt.setStatus('正在下载语言包…')
                const ready = await this.browserTranslator.prepare(
                  this.settings.sourceLang,
                  this.settings.targetLang,
                  (progress) => {
                    this.setupPrompt.setStatus(`语言包下载 ${Math.round(progress * 100)}%`)
                  },
                )
                if (ready) {
                  this.setupPrompt.setStatus('语言包已就绪，请再次开启翻译')
                  window.setTimeout(() => this.setupPrompt.dismiss(), 900)
                  return
                }
                this.setupPrompt.setStatus('语言包下载失败，请改用外部 LLM 或更换语言', true)
              }
            : undefined,
        onOpenLlmSetup: () => {
          void chrome.runtime.sendMessage({ type: 'open-options', hash: '#external-api' })
        },
        onOpenOnboarding: () => {
          void chrome.runtime.sendMessage({ type: 'open-options', hash: '#onboarding' })
        },
      },
    )
  }

  private async translateSelectionText(text: string): Promise<string | null> {
    if (this.pausedHere) return null
    if (this.settings.translationEngine === 'browser') {
      const ready = await this.ensureEngineReady('lens', { quiet: true })
      if (!ready.ok) {
        this.maybePromptSetupFromSelection()
        throw new Error(ready.error)
      }
      return this.browserTranslator.translate(
        text,
        this.settings.sourceLang,
        this.settings.targetLang,
      )
    }
    const ready = await this.ensureEngineReady('lens', { quiet: true })
    if (!ready.ok) {
      this.maybePromptSetupFromSelection()
      throw new Error(ready.error)
    }
    const response: unknown = await chrome.runtime.sendMessage({
      type: 'translate-batch',
      pageKey: makePageKey(),
      blocks: [{ id: 'sel', tag: 'selection', text }],
    })
    if (!isTranslateBatchResult(response) || !response.ok) {
      if (isTranslateBatchResult(response) && !response.ok) throw new Error(response.error)
      throw new Error('翻译服务未返回有效结果')
    }
    return response.translations.find((item) => item.id === 'sel')?.translation ?? null
  }

  /** At most one full setup modal per minute from selection-driven failures. */
  private maybePromptSetupFromSelection(): void {
    const now = Date.now()
    if (now - this.lastSelectionSetupPromptAt < 60_000) return
    this.lastSelectionSetupPromptAt = now
    void this.ensureEngineReady('lens')
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
    if (message.command === 'toggle-lens') {
      const result = await this.toggleStickyLensAsync()
      return result.ok ? this.bubbleState() : result
    }
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

/** Make vision/model failures actionable for users pointing the lens at images. */
function clarifyImageError(error: string): string {
  const lower = error.toLowerCase()
  if (error.includes('API not configured') || error.includes('未配置')) {
    return '图片翻译需要外部多模态模型：请先配置 Base URL、API Key 与支持 image 的模型'
  }
  if (
    lower.includes('image') &&
    (lower.includes('not support') ||
      lower.includes('unsupported') ||
      lower.includes('invalid') ||
      lower.includes('不支持'))
  ) {
    return error
  }
  if (error.includes('400') || lower.includes('invalid_request') || lower.includes('unknown field')) {
    return `当前模型可能不支持图片输入：${error}`
  }
  return error
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

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

const registry = new BlockRegistry()
const imageRegistry = new ImageRegistry()
const browserTranslator = new BrowserTranslator()
const lens = new LensOverlay(340)
let settings: UserSettings = DEFAULT_SETTINGS
let configured = false
let pausedHere = false
let lensActive = false
let lensSticky = false
let hotkeyDownAt = 0
let lastMouse = { x: 0, y: 0 }
let translateSettingsSig = ''
let listenersBound = false
let pointerFrame = 0

/** In-flight block ids — avoid duplicate API calls for the same block. */
const inflight = new Set<string>()
/** In-flight normalized texts — identical sentences share one request. */
const inflightTexts = new Set<string>()
const imageInflight = new Set<string>()

const TAP_STICKY_MS = 320


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

function ensureMouseSeed(): void {
  if (lastMouse.x === 0 && lastMouse.y === 0) {
    lastMouse = {
      x: Math.round(window.innerWidth / 2),
      y: Math.round(window.innerHeight / 2),
    }
  }
}

function disabledHere(): boolean {
  return pausedHere
}


function imageEntryForHit(hit: Element | null): ImageTranslationEntry | undefined {
  if (!(hit instanceof HTMLImageElement)) return undefined
  if (!hit.complete || hit.naturalWidth < 2 || hit.naturalHeight < 2) return undefined
  const url = hit.currentSrc || hit.src
  if (!url) return undefined
  return imageRegistry.upsert(makeBlockId('img', url, coarsePath(hit)), hit, url)
}

function isImageTranslationResult(
  value: unknown,
): value is TranslateImageResultOk | TranslateImageResultErr {
  if (!value || typeof value !== 'object' || !('type' in value) || !('ok' in value)) return false
  if (value.type !== 'translate-image-result' || typeof value.ok !== 'boolean') return false
  return value.ok ? 'translation' in value && typeof value.translation === 'string' : 'error' in value && typeof value.error === 'string'
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

async function translateImage(entry: ImageTranslationEntry): Promise<void> {
  if (disabledHere() || !configured || imageInflight.has(entry.id)) return

  imageInflight.add(entry.id)
  imageRegistry.setPending(entry.id)
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'translate-image',
      imageUrl: entry.url,
    })
    if (!isImageTranslationResult(result)) {
      imageRegistry.setError(entry.id, '图片翻译服务未返回有效结果')
    } else if (result.ok) {
      imageRegistry.setTranslation(entry.id, result.translation)
    } else {
      imageRegistry.setError(entry.id, result.error)
    }
  } catch (error) {
    imageRegistry.setError(entry.id, error instanceof Error ? error.message : String(error))
  } finally {
    imageInflight.delete(entry.id)
  }

  if (lensActive) updateLens()
}

/**
 * Translate unresolved blocks with Chrome's on-device Translator API.
 * The browser session is sequential and no configured API endpoint is contacted.
 */
async function translateWithBrowser(blocks: TranslateBlock[]): Promise<void> {
  if (!settings.browserTranslatorFallback || !browserTranslator.isSupported()) return

  for (const block of blocks) {
    const translation = await browserTranslator.translate(
      block.text,
      settings.sourceLang,
      settings.targetLang,
    )
    if (translation) registry.setTranslation(block.id, translation)
  }
}

/**
 * Send blocks to the configured API, then use Chrome's on-device translator
 * for any unresolved blocks when the fallback is enabled.
 */
async function translateSpecific(blocks: TranslateBlock[]): Promise<void> {
  if (disabledHere()) return

  const todo: TranslateBlock[] = []
  const seenText = new Set<string>()

  for (const b of blocks) {
    const e = registry.get(b.id)
    if (!e) continue
    if (e.status === 'ready' && e.translation) continue
    if (inflight.has(b.id)) continue
    const norm = normalizeText(b.text)
    if (inflightTexts.has(norm)) continue
    // One request per unique sentence in this batch
    if (seenText.has(norm)) {
      // Still mark pending so UI shows loading; result expands via setTranslation
      registry.setPending(b.id)
      continue
    }
    seenText.add(norm)
    todo.push({ id: b.id, tag: b.tag, text: norm })
  }
  if (!todo.length) return

  for (const b of todo) {
    inflight.add(b.id)
    inflightTexts.add(normalizeText(b.text))
    registry.setPending(b.id)
  }

  let error = configured ? '翻译失败' : 'API 未配置，Chrome 内置翻译不可用'
  try {
    if (configured) {
      const response: unknown = await chrome.runtime.sendMessage({
        type: 'translate-batch',
        pageKey: makePageKey(),
        blocks: todo,
      })
      if (!isTranslateBatchResult(response)) {
        error = '翻译服务未返回有效结果'
      } else {
        for (const item of response.translations ?? []) {
          registry.setTranslation(item.id, item.translation)
        }
        if (!response.ok) error = response.error
      }
    }

    const unresolved = todo.filter((b) => !registry.get(b.id)?.translation)
    if (unresolved.length) await translateWithBrowser(unresolved)

    for (const b of todo) {
      if (!registry.get(b.id)?.translation) registry.setError(b.id, error)
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    await translateWithBrowser(todo.filter((b) => !registry.get(b.id)?.translation))
    for (const b of todo) {
      if (!registry.get(b.id)?.translation) registry.setError(b.id, error)
    }
  } finally {
    for (const b of todo) {
      inflight.delete(b.id)
      inflightTexts.delete(normalizeText(b.text))
    }
  }

  if (lensActive) updateLens()
}

/** Auto mode: scan visible viewport (+ prefetch margin) and batch-translate pending. */
async function scanVisibleAndTranslate(): Promise<void> {
  if (disabledHere() || !settings.autoTranslate || !configured) return
  const margin = Math.round(window.innerHeight * settings.prefetchMarginRatio)
  const blocks = extractVisibleBlocks(settings.minTextLength, margin)
  for (const b of blocks) {
    registry.upsert({ id: b.id, el: b.el, tag: b.tag, text: b.text })
  }
  const pending = registry.pendingBlocks().filter((b) => !inflight.has(b.id))
  if (!pending.length) return
  await translateSpecific(pending)
}


/** Refresh only redacted settings; the API key never enters the content-script world. */
async function refreshSettings(): Promise<void> {
  try {
    const response: unknown = await chrome.runtime.sendMessage({ type: 'get-settings' })
    if (!isSettingsMessage(response)) throw new Error('Invalid settings response')

    configured = response.configured
    settings = mergeSettings(response.settings)
    pausedHere = response.paused
    if (pausedHere && lensActive) deactivateLens()
    lens.setWidth(settings.lensWidthPx)

    const sig = translateSigOf(settings, configured)
    const changed = sig !== translateSettingsSig
    const previousSig = translateSettingsSig
    translateSettingsSig = sig

    if (configured && changed) {
      if (previousSig !== '') registry.resetErrorsToPending()
      if (settings.autoTranslate) void scanVisibleAndTranslate()
    }
  } catch (error) {
    console.warn(
      '[Lens Translator] settings refresh failed',
      error instanceof Error ? error.message : String(error),
    )
  }
}

function updateLens(): void {
  if (!lensActive) {
    lens.hide()
    return
  }
  ensureMouseSeed()
  const host = lens.getHost()
  const stack = document
    .elementsFromPoint(lastMouse.x, lastMouse.y)
    .filter((el) => el !== host && !host.contains(el))
  const hit = stack[0] ?? null

  const imageEntry = imageEntryForHit(hit)
  if (imageEntry) {
    if (!configured) {
      lens.showAt(lastMouse.x, lastMouse.y, {
        kind: 'unconfigured',
      })
      lens.highlight(null)
      return
    }

    const sourceRect = imageEntry.el.getBoundingClientRect()
    lens.highlight(imageEntry.el)
    if (imageEntry.status === 'ready' && imageEntry.translation) {
      lens.showAt(lastMouse.x, lastMouse.y, {
        kind: 'ready',
        text: imageEntry.translation,
        sourceRect,
      })
      return
    }
    if (imageEntry.status === 'error' && !imageInflight.has(imageEntry.id)) {
      lens.showAt(lastMouse.x, lastMouse.y, {
        kind: 'error',
        message: imageEntry.error ?? '图片翻译失败',
        sourceRect,
      })
      return
    }

    lens.showAt(lastMouse.x, lastMouse.y, {
      kind: 'pending',
      sourceRect,
    })
    void translateImage(imageEntry)
    return
  }

  if (
    !configured &&
    (!settings.browserTranslatorFallback || !browserTranslator.isSupported())
  ) {
    lens.showAt(lastMouse.x, lastMouse.y, {
      kind: 'unconfigured',
    })
    lens.highlight(null)
    return
  }

  let entry = registry.getByElement(hit)
  if (!entry) {
    const block = extractBlockAtElement(hit, settings.minTextLength)
    if (block) entry = registry.upsert(block)
  }

  if (!entry) {
    lens.showAt(lastMouse.x, lastMouse.y, {
      kind: 'empty',
    })
    lens.highlight(null)
    return
  }

  // Thin outline on source only — panel placed away so English stays readable
  lens.highlight(entry.el)
  const sourceRect = entry.el.getBoundingClientRect()
  const sourceText = entry.text

  if (entry.status === 'ready' && entry.translation) {
    lens.showAt(lastMouse.x, lastMouse.y, {
      kind: 'ready',
      text: entry.translation,
      sourceText,
      sourceRect,
    })
    return
  }

  if (entry.status === 'error' && !inflight.has(entry.id)) {
    lens.showAt(lastMouse.x, lastMouse.y, {
      kind: 'error',
      message: entry.error ?? '翻译失败',
      sourceText,
      sourceRect,
    })
    return
  }

  // Need translation for this single block — still show EN while waiting
  lens.showAt(lastMouse.x, lastMouse.y, {
    kind: 'pending',
    sourceText,
    sourceRect,
  })
  if (!inflight.has(entry.id)) {
    void translateSpecific([{ id: entry.id, tag: entry.tag, text: entry.text }])
  }
}


function deactivateLens(): void {
  lensActive = false
  lensSticky = false
  hotkeyDownAt = 0
  lens.hide()
}

function isHotkeyRelease(e: KeyboardEvent): boolean {
  const h = settings.hotkey
  if (e.code === h.code) return true
  if (h.altKey && (e.code === 'AltLeft' || e.code === 'AltRight' || e.key === 'Alt')) return true
  if (h.shiftKey && (e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.key === 'Shift')) {
    return true
  }
  if (h.ctrlKey && (e.code === 'ControlLeft' || e.code === 'ControlRight' || e.key === 'Control')) {
    return true
  }
  if (h.metaKey && (e.code === 'MetaLeft' || e.code === 'MetaRight' || e.key === 'Meta')) {
    return true
  }
  return false
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && lensActive) {
    e.preventDefault()
    deactivateLens()
    return
  }

  if (disabledHere()) return
  if (!matchesHotkey(e, settings.hotkey)) return
  if (e.repeat) {
    e.preventDefault()
    return
  }
  e.preventDefault()
  e.stopPropagation()

  if (lensActive && lensSticky) {
    deactivateLens()
    return
  }

  if (!lensActive) {
    lensActive = true
    lensSticky = false
    hotkeyDownAt = Date.now()
    ensureMouseSeed()
    if (settings.browserTranslatorFallback && browserTranslator.isSupported()) {
      void browserTranslator.prepare(settings.sourceLang, settings.targetLang)
    }
    updateLens()
  }
}

function onKeyUp(e: KeyboardEvent): void {
  if (!lensActive || lensSticky || !isHotkeyRelease(e)) return

  const heldMs = Date.now() - hotkeyDownAt
  if (heldMs > 0 && heldMs < TAP_STICKY_MS) {
    lensSticky = true
    return
  }
  deactivateLens()
}

function onBlur(): void {
  if (lensActive && !lensSticky) deactivateLens()
}

function onMouseMove(e: MouseEvent): void {
  if (e.composedPath().includes(lens.getHost())) return
  lastMouse = { x: e.clientX, y: e.clientY }
  if (!lensActive || pointerFrame) return
  pointerFrame = requestAnimationFrame(() => {
    pointerFrame = 0
    updateLens()
  })
}

function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let t = 0
  return ((...args: unknown[]) => {
    window.clearTimeout(t)
    t = window.setTimeout(() => fn(...args), ms)
  }) as T
}

function bindListeners(): void {
  if (listenersBound) return
  listenersBound = true

  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('keyup', onKeyUp, true)
  window.addEventListener('blur', onBlur)
  window.addEventListener('mousemove', onMouseMove, true)

  // Auto-pretranslate only when enabled
  const scheduleScan = debounce(() => {
    if (settings.autoTranslate) void scanVisibleAndTranslate()
  }, 300)
  window.addEventListener('scroll', scheduleScan, true)
  window.addEventListener('resize', scheduleScan)

  const mo = new MutationObserver(
    debounce(() => {
      if (settings.autoTranslate) void scanVisibleAndTranslate()
    }, 500),
  )
  mo.observe(document.documentElement, { childList: true, subtree: true })

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) void refreshSettings()
  })
}

async function main(): Promise<void> {
  bindListeners()
  ensureMouseSeed()
  await refreshSettings()
  if (settings.autoTranslate) void scanVisibleAndTranslate()
}

void main()

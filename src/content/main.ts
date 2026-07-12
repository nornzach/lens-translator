import { matchesHotkey } from '../shared/hotkey'
import { makeBlockId } from '../shared/block-id'
import type { UserSettings } from '../shared/settings-defaults'
import { DEFAULT_SETTINGS, isConfigured, mergeSettings } from '../shared/settings-defaults'
import { loadSettings } from '../shared/settings'
import type {
  TranslateBatchResultErr,
  TranslateBatchResultOk,
  TranslateBlock,
  TranslateImageResultErr,
  TranslateImageResultOk,
} from '../shared/messages'
import { normalizeText } from '../shared/text'
import { coarsePath, extractVisibleBlocks } from './extract'
import { BlockRegistry } from './registry'
import { LensOverlay } from './lens'
import { BrowserTranslator } from './browser-translator'
import { ImageRegistry, type ImageTranslationEntry } from './image-registry'
import { makePageKey } from './page-key'
import { isHostnamePaused } from './pause'

const registry = new BlockRegistry()
const imageRegistry = new ImageRegistry()
const browserTranslator = new BrowserTranslator()
const lens = new LensOverlay(340)
let settings: UserSettings = DEFAULT_SETTINGS
let configured = false
let lensActive = false
let lensSticky = false
let hotkeyDownAt = 0
let lastMouse = { x: 0, y: 0 }
let translateSettingsSig = ''
let listenersBound = false

/** In-flight block ids — avoid duplicate API calls for the same block. */
const inflight = new Set<string>()
/** In-flight normalized texts — identical sentences share one request. */
const inflightTexts = new Set<string>()
const imageInflight = new Set<string>()

const TAP_STICKY_MS = 320


function translateSigOf(s: UserSettings, isConfiguredFlag: boolean): string {
  return [
    isConfiguredFlag,
    s.baseURL,
    s.model,
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
  return isHostnamePaused(location.hostname, settings.pausedHostnames)
}

function pageKey(): string {
  return makePageKey()
}

function imageEntryUnderPointer(): ImageTranslationEntry | undefined {
  const host = lens.getHost()
  const stack = document
    .elementsFromPoint(lastMouse.x, lastMouse.y)
    .filter((el) => el !== host && !host.contains(el))

  const image = stack[0]
  if (!(image instanceof HTMLImageElement)) return undefined
  if (!image.complete || image.naturalWidth < 2 || image.naturalHeight < 2) return undefined
  const url = image.currentSrc || image.src
  if (!url) return undefined
  return imageRegistry.upsert(makeBlockId('img', url, coarsePath(image)), image, url)
}

function isImageTranslationResult(
  value: unknown,
): value is TranslateImageResultOk | TranslateImageResultErr {
  if (!value || typeof value !== 'object' || !('type' in value) || !('ok' in value)) return false
  if (value.type !== 'translate-image-result' || typeof value.ok !== 'boolean') return false
  return value.ok ? 'translation' in value && typeof value.translation === 'string' : 'error' in value && typeof value.error === 'string'
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
 * Send blocks to background. Dedupes identical sentences client-side;
 * SW also caches by text hash so repeats never hit the API again.
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
      const res = (await chrome.runtime.sendMessage({
        type: 'translate-batch',
        pageKey: pageKey(),
        blocks: todo,
      })) as TranslateBatchResultOk | TranslateBatchResultErr

      const list =
        res && 'translations' in res && Array.isArray((res as TranslateBatchResultOk).translations)
          ? (res as TranslateBatchResultOk).translations
          : ((res as TranslateBatchResultErr).translations ?? [])

      // setTranslation fans out to all same-text blocks in the registry
      for (const t of list) registry.setTranslation(t.id, t.translation)
      if (!res || res.ok === false) {
        error = !res ? 'No response from background' : res.error
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

/**
 * On-demand: resolve the block under the pointer and translate only that one
 * (if not already cached in registry / SW session).
 */
async function translateBlockUnderPointer(): Promise<void> {
  if (
    disabledHere() ||
    (!configured && (!settings.browserTranslatorFallback || !browserTranslator.isSupported()))
  ) {
    return
  }

  // Register nearby blocks so getByElement can walk up to a text node
  const margin = 80
  const nearby = extractVisibleBlocks(settings.minTextLength, margin)
  for (const b of nearby) {
    registry.upsert({ id: b.id, el: b.el, tag: b.tag, text: b.text })
  }

  const host = lens.getHost()
  const stack = document
    .elementsFromPoint(lastMouse.x, lastMouse.y)
    .filter((el) => el !== host && !host.contains(el))
  const hit = stack[0] ?? null
  const entry = registry.getByElement(hit)
  if (!entry) return
  if (entry.status === 'ready' && entry.translation) return
  if (inflight.has(entry.id)) return

  await translateSpecific([
    { id: entry.id, tag: entry.tag, text: entry.text },
  ])
}

async function refreshSettings(): Promise<void> {
  try {
    const full = await loadSettings()
    configured = isConfigured(full)
    settings = mergeSettings({ ...full, apiKey: '' })
    lens.setWidth(settings.lensWidthPx)

    const sig = translateSigOf(settings, configured)
    const changed = sig !== translateSettingsSig
    const prev = translateSettingsSig
    translateSettingsSig = sig

    if (configured && changed) {
      if (prev !== '') registry.resetErrorsToPending()
      if (settings.autoTranslate) void scanVisibleAndTranslate()
    }

    console.info('[Lens Translator] settings', {
      configured,
      autoTranslate: settings.autoTranslate,
      browserTranslatorFallback: settings.browserTranslatorFallback,
      baseURL: settings.baseURL,
      model: settings.model,
      hasKey: Boolean(full.apiKey?.trim()),
    })
  } catch (err) {
    console.warn('[Lens Translator] refreshSettings failed', err)
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

  // Keep registry fresh near pointer for hit-testing
  const nearby = extractVisibleBlocks(settings.minTextLength, 80)
  for (const b of nearby) {
    registry.upsert({ id: b.id, el: b.el, tag: b.tag, text: b.text })
  }

  const entry = registry.getByElement(hit)

  const imageEntry = imageEntryUnderPointer()
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
  }

  // Need translation for this single block — still show EN while waiting
  lens.showAt(lastMouse.x, lastMouse.y, {
    kind: 'pending',
    sourceText,
    sourceRect,
  })
  void translateBlockUnderPointer()
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
  if (lensActive) updateLens()
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
  console.info(
    '[Lens Translator] ready · mode=',
    settings.autoTranslate ? 'auto-pretranslate' : 'on-demand',
    'hotkey',
    settings.hotkey,
    'configured=',
    configured,
  )
}

void main()

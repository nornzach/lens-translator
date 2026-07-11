import { matchesHotkey } from '../shared/hotkey'
import type { UserSettings } from '../shared/settings-defaults'
import { DEFAULT_SETTINGS, isConfigured, mergeSettings } from '../shared/settings-defaults'
import { loadSettings } from '../shared/settings'
import type {
  TranslateBatchResultErr,
  TranslateBatchResultOk,
  TranslateBlock,
} from '../shared/messages'
import { extractVisibleBlocks } from './extract'
import { BlockRegistry } from './registry'
import { LensOverlay } from './lens'
import { makePageKey } from './page-key'
import { isHostnamePaused } from './pause'

const registry = new BlockRegistry()
const lens = new LensOverlay()
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

const TAP_STICKY_MS = 320

function translateSigOf(s: UserSettings, isConfiguredFlag: boolean): string {
  return [
    isConfiguredFlag,
    s.baseURL,
    s.model,
    s.sourceLang,
    s.targetLang,
    s.autoTranslate,
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

/**
 * Send only the given blocks to the background.
 * Skips ready / inflight; session cache in SW also skips already-translated ids.
 */
async function translateSpecific(blocks: TranslateBlock[]): Promise<void> {
  if (disabledHere() || !configured) return

  const todo = blocks.filter((b) => {
    const e = registry.get(b.id)
    if (!e) return false
    if (e.status === 'ready' && e.translation) return false
    if (inflight.has(b.id)) return false
    return true
  })
  if (!todo.length) return

  for (const b of todo) {
    inflight.add(b.id)
    registry.setPending(b.id)
  }

  try {
    const res = (await chrome.runtime.sendMessage({
      type: 'translate-batch',
      pageKey: pageKey(),
      blocks: todo,
    })) as TranslateBatchResultOk | TranslateBatchResultErr

    const list =
      res && 'translations' in res && Array.isArray((res as TranslateBatchResultOk).translations)
        ? (res as TranslateBatchResultOk).translations
        : ((res as TranslateBatchResultErr).translations ?? [])

    for (const t of list) registry.setTranslation(t.id, t.translation)

    if (!res || res.ok === false) {
      const errMsg = !res ? 'No response from background' : res.error
      for (const b of todo) {
        if (!registry.get(b.id)?.translation) {
          registry.setError(b.id, errMsg)
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    for (const b of todo) {
      if (!registry.get(b.id)?.translation) registry.setError(b.id, msg)
    }
  } finally {
    for (const b of todo) inflight.delete(b.id)
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
  if (disabledHere() || !configured) return

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

  if (!configured) {
    lens.showAt(lastMouse.x, lastMouse.y, {
      kind: 'unconfigured',
      stickyHint: lensSticky,
    })
    lens.highlight(null)
    return
  }

  if (!entry) {
    lens.showAt(lastMouse.x, lastMouse.y, {
      kind: 'empty',
      stickyHint: lensSticky,
    })
    lens.highlight(null)
    return
  }

  lens.highlight(entry.el)

  if (entry.status === 'ready' && entry.translation) {
    lens.showAt(lastMouse.x, lastMouse.y, {
      kind: 'ready',
      text: entry.translation,
      stickyHint: lensSticky,
    })
    return
  }

  if (entry.status === 'error' && !inflight.has(entry.id)) {
    lens.showAt(lastMouse.x, lastMouse.y, {
      kind: 'error',
      message: entry.error ?? '翻译失败',
      stickyHint: lensSticky,
    })
    // Allow one retry on demand when user re-hovers (reset to pending)
    // Don't auto-loop: user can re-enter block after cache clear
  }

  // Need translation for this single block
  lens.showAt(lastMouse.x, lastMouse.y, {
    kind: 'pending',
    stickyHint: lensSticky,
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
    updateLens()
  }
}

function onKeyUp(e: KeyboardEvent): void {
  if (!lensActive || lensSticky) return
  if (!isHotkeyRelease(e)) return

  const heldMs = Date.now() - hotkeyDownAt
  if (heldMs > 0 && heldMs < TAP_STICKY_MS) {
    lensSticky = true
    updateLens()
    return
  }

  deactivateLens()
}

function onBlur(): void {
  if (lensActive && !lensSticky) deactivateLens()
}

function onMouseMove(e: MouseEvent): void {
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

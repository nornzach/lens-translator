import { matchesHotkey } from '../shared/hotkey'
import type { UserSettings } from '../shared/settings-defaults'
import { DEFAULT_SETTINGS } from '../shared/settings-defaults'
import { mergeSettings } from '../shared/settings-defaults'
import type { TranslateBatchResultErr, TranslateBatchResultOk } from '../shared/messages'
import { extractVisibleBlocks } from './extract'
import { BlockRegistry } from './registry'
import { LensOverlay } from './lens'
import { makePageKey } from './page-key'
import { isHostnamePaused } from './pause'

const registry = new BlockRegistry()
const lens = new LensOverlay()
let settings: UserSettings = DEFAULT_SETTINGS
/** From background; apiKey is never sent to the content script. */
let configured = false
let lensActive = false
/** Short-tap leaves the lens open until hotkey again or Escape. */
let lensSticky = false
let hotkeyDownAt = 0
let lastMouse = { x: 0, y: 0 }
let translating = false
let translateSettingsSig = ''
let listenersBound = false

const TAP_STICKY_MS = 320

function translateSigOf(s: UserSettings, isConfigured: boolean): string {
  return [
    isConfigured,
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

async function refreshSettings(): Promise<void> {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'get-settings' })
    if (res?.type !== 'settings') return

    // mergeSettings guards partial payloads / missing hotkey
    settings = mergeSettings(res.settings)
    configured = Boolean(res.configured)
    lens.setWidth(settings.lensWidthPx)

    const sig = translateSigOf(settings, configured)
    const changed = sig !== translateSettingsSig
    const prev = translateSettingsSig
    translateSettingsSig = sig

    if (configured && changed) {
      if (prev !== '') registry.resetErrorsToPending()
      void scanAndTranslate({ force: true })
    }
  } catch (err) {
    console.warn('[Lens Translator] refreshSettings failed', err)
  }
}

function disabledHere(): boolean {
  return isHostnamePaused(location.hostname, settings.pausedHostnames)
}

async function scanAndTranslate(opts?: { force?: boolean }): Promise<void> {
  if (disabledHere()) return
  if (!settings.autoTranslate && !opts?.force) return
  const margin = Math.round(window.innerHeight * settings.prefetchMarginRatio)
  const blocks = extractVisibleBlocks(settings.minTextLength, margin)
  for (const b of blocks) {
    registry.upsert({ id: b.id, el: b.el, tag: b.tag, text: b.text })
  }
  const pending = registry.pendingBlocks()
  if (!pending.length || translating) return
  translating = true
  try {
    const res = (await chrome.runtime.sendMessage({
      type: 'translate-batch',
      pageKey: makePageKey(),
      blocks: pending,
    })) as TranslateBatchResultOk | TranslateBatchResultErr

    const list =
      res && 'translations' in res && Array.isArray((res as TranslateBatchResultOk).translations)
        ? (res as TranslateBatchResultOk).translations
        : ((res as TranslateBatchResultErr & {
            translations?: { id: string; translation: string }[]
          }).translations ?? [])

    for (const t of list) registry.setTranslation(t.id, t.translation)
    if (!res || res.ok === false) {
      const errMsg = !res ? 'No response from background' : res.error
      for (const id of !res
        ? pending.map((p) => p.id)
        : (res.failedIds ?? pending.map((p) => p.id))) {
        if (!registry.get(id)?.translation) registry.setError(id, errMsg)
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    for (const p of pending) {
      if (!registry.get(p.id)?.translation) registry.setError(p.id, msg)
    }
  } finally {
    translating = false
    if (registry.pendingBlocks().length > 0) {
      void scanAndTranslate(opts)
    }
  }
  if (lensActive) updateLens()
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
  } else if (entry.status === 'error') {
    lens.showAt(lastMouse.x, lastMouse.y, {
      kind: 'error',
      message: entry.error ?? '翻译失败',
      stickyHint: lensSticky,
    })
  } else {
    lens.showAt(lastMouse.x, lastMouse.y, {
      kind: 'pending',
      stickyHint: lensSticky,
    })
    void scanAndTranslate({ force: true })
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
  // Prefer code for modifiers (Mac Option reports key "Alt")
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
  // Ignore OS auto-repeat while holding
  if (e.repeat) {
    e.preventDefault()
    return
  }
  e.preventDefault()
  e.stopPropagation()

  // Second activation while sticky → close
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
  // Short press ("click"): keep lens open (sticky) so it is actually usable
  if (heldMs > 0 && heldMs < TAP_STICKY_MS) {
    lensSticky = true
    updateLens()
    return
  }

  deactivateLens()
}

function onBlur(): void {
  // Only clear hold-mode; sticky survives focus changes (e.g. clicking into page)
  if (lensActive && !lensSticky) {
    deactivateLens()
  }
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

  const scheduleScan = debounce(() => void scanAndTranslate(), 300)
  window.addEventListener('scroll', scheduleScan, true)
  window.addEventListener('resize', scheduleScan)

  const mo = new MutationObserver(debounce(() => void scanAndTranslate(), 500))
  mo.observe(document.documentElement, { childList: true, subtree: true })

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) void refreshSettings()
  })
}

async function main(): Promise<void> {
  // Bind first so a slow/failed settings fetch never blocks hotkeys
  bindListeners()
  ensureMouseSeed()
  await refreshSettings()
  void scanAndTranslate()
  console.info(
    '[Lens Translator] ready · hotkey',
    settings.hotkey,
    'configured=',
    configured,
  )
}

void main()

import { matchesHotkey } from '../shared/hotkey'
import type { UserSettings } from '../shared/settings-defaults'
import { DEFAULT_SETTINGS } from '../shared/settings-defaults'
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
let lastMouse = { x: 0, y: 0 }
let translating = false
/** Signature of settings fields that affect translation; avoids rescan on width/hotkey-only edits. */
let translateSettingsSig = ''
let lastOpenOptionsAt = 0

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

async function refreshSettings(): Promise<void> {
  const res = await chrome.runtime.sendMessage({ type: 'get-settings' })
  if (res?.type !== 'settings') return

  settings = res.settings
  configured = Boolean(res.configured)
  lens.setWidth(settings.lensWidthPx)

  const sig = translateSigOf(settings, configured)
  const changed = sig !== translateSettingsSig
  const prev = translateSettingsSig
  translateSettingsSig = sig

  if (configured && changed) {
    // Skip reset on first load (prev === ''); main() still scans.
    if (prev !== '') registry.resetErrorsToPending()
    void scanAndTranslate({ force: true })
  }
}

function disabledHere(): boolean {
  return isHostnamePaused(location.hostname, settings.pausedHostnames)
}

function maybeOpenOptions(): void {
  const now = Date.now()
  if (now - lastOpenOptionsAt < 5000) return
  lastOpenOptionsAt = now
  void chrome.runtime.sendMessage({ type: 'open-options' })
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
  const host = lens.getHost()
  const stack = document
    .elementsFromPoint(lastMouse.x, lastMouse.y)
    .filter((el) => el !== host && !host.contains(el))
  const hit = stack[0] ?? null
  const entry = registry.getByElement(hit)

  if (!configured) {
    lens.showAt(lastMouse.x, lastMouse.y, { kind: 'unconfigured' })
    lens.highlight(null)
    maybeOpenOptions()
    return
  }

  if (!entry) {
    lens.showAt(lastMouse.x, lastMouse.y, { kind: 'empty' })
    lens.highlight(null)
    return
  }

  // Never rewrite page text — only show translation in the lens overlay
  lens.highlight(entry.el)
  if (entry.status === 'ready' && entry.translation) {
    lens.showAt(lastMouse.x, lastMouse.y, { kind: 'ready', text: entry.translation })
  } else if (entry.status === 'error') {
    lens.showAt(lastMouse.x, lastMouse.y, {
      kind: 'error',
      message: entry.error ?? '翻译失败',
    })
  } else {
    lens.showAt(lastMouse.x, lastMouse.y, { kind: 'pending' })
    void scanAndTranslate({ force: true })
  }
}

function onKeyDown(e: KeyboardEvent): void {
  if (disabledHere()) return
  if (!matchesHotkey(e, settings.hotkey)) return
  e.preventDefault()
  if (!lensActive) {
    lensActive = true
    updateLens()
  }
}

function onKeyUp(e: KeyboardEvent): void {
  if (!lensActive) return
  if (
    e.code === settings.hotkey.code ||
    (settings.hotkey.altKey && e.key === 'Alt') ||
    (settings.hotkey.shiftKey && e.key === 'Shift') ||
    (settings.hotkey.ctrlKey && e.key === 'Control') ||
    (settings.hotkey.metaKey && e.key === 'Meta')
  ) {
    lensActive = false
    lens.hide()
  }
}

function onBlur(): void {
  lensActive = false
  lens.hide()
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

async function main(): Promise<void> {
  await refreshSettings()
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) void refreshSettings()
  })

  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('keyup', onKeyUp, true)
  window.addEventListener('blur', onBlur)
  window.addEventListener('mousemove', onMouseMove, true)

  const scheduleScan = debounce(() => void scanAndTranslate(), 300)
  window.addEventListener('scroll', scheduleScan, true)
  window.addEventListener('resize', scheduleScan)

  const mo = new MutationObserver(debounce(() => void scanAndTranslate(), 500))
  mo.observe(document.documentElement, { childList: true, subtree: true })

  void scanAndTranslate()
}

void main()

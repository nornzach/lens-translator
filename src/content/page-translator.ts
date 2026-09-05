import type {
  TranslateBatchResultErr,
  TranslateBatchResultOk,
  TranslateBlock,
} from '../shared/messages'
import type { UserSettings } from '../shared/settings-defaults'
import { runWithConcurrency } from '../shared/concurrency'
import {
  isPageTranslatableText,
  isPredominantlyTargetLanguage,
  normalizeText,
} from '../shared/text'
import {
  collectPageRoots,
  elementText,
  pageSourceText,
  extractPageBlocks,
  isUiLabelElement,
  isVisible,
  PAGE_SOURCE_ATTR,
  PAGE_SEGMENT_ATTR,
  type ExtractedBlock,
} from './extract'
import { makePageKey } from './page-key'
import { BrowserTranslator } from './browser-translator'
import {
  PAGE_ALIGNMENT_FALLBACK_ATTR,
  PAGE_ALIGNMENT_HIGHLIGHT_NAME,
  PageAlignmentController,
} from './page-alignment'

const TRANSLATED_ATTR = 'data-lens-page-translated'
const STYLE_ID = 'lens-translator-page-style'
const STATUS_ID = 'lens-translator-page-status'
// Every translation stays inside its source. Controls use compact inline text;
// prose uses a separate line, without changing ancestor layout.
const INSERTED_ATTR = 'data-lens-page-inserted'
const CONTROL_ATTR = 'data-lens-page-control'

// A translated host that keeps mutating (clocks, counters, live chat) would loop
// forever between invalidate and re-translate. After this many re-invalidations
// within the window we give up on it and leave the original text in place.
const VOLATILE_CHURN_LIMIT = 3
const VOLATILE_CHURN_WINDOW_MS = 5000

// How many per-line translate requests may be in flight at once for one
// full-page run. Each maps to a separate background fetch, so this is real HTTP
// parallelism; the background retries 429s with backoff when the provider
// rate-limits the burst.
const PAGE_TRANSLATION_CONCURRENCY = 6

// When translation starts before dynamic content has rendered (SPA hydration,
// async data), keep observing and retrying the initial scan for this long before
// declaring the page empty, instead of failing on the first blank scan.
const INITIAL_CONTENT_GRACE_MS = 8000
const INITIAL_RETRY_INTERVAL_MS = 600

// Failed groups (network blip, provider 5xx) get a bounded automatic retry;
// without it one transient error leaves parts of the page untranslated until
// the user toggles manually (attempted-text marks otherwise skip them forever).
const FAILED_RETRY_MAX = 2
const FAILED_RETRY_BASE_MS = 2000

type ChurnRecord = { count: number; since: number }

/** Exported for snapshot tests of display-mode CSS. */
export function pageStyles(settings: PageSettings): string {
  const color = settings.pageTranslationUseCustomColor
    ? settings.pageTranslationTextColor
    : 'inherit'
  const background = settings.pageTranslationUseBackground
    ? settings.pageTranslationBackgroundColor
    : 'transparent'
  const padding = settings.pageTranslationUseBackground ? '0.3em 0.5em' : '0'
  const radius = settings.pageTranslationUseBackground ? '4px' : '0'
  const opacity =
    settings.pageTranslationUseCustomColor || settings.pageTranslationUseBackground ? '1' : '0.78'
  const fontSize = settings.pageTranslationUseOriginalFontSize
    ? 'inherit'
    : `${settings.pageTranslationFontSizePx}px`
  const fontFamily = {
    system: 'inherit',
    sans: 'Inter, ui-sans-serif, system-ui, sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
    mono: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
  }[settings.pageTranslationFontFamily]

  return `
/* Every translation is a source-owned child. It never climbs into an ancestor
   layout, so component, table, list, and slot boundaries remain intact.
   "all: initial" cuts it off from hostile site wildcard styles. */
[${INSERTED_ATTR}] {
  all: initial !important;
  display: block !important;
  min-width: 0 !important;
  max-width: 100% !important;
  box-sizing: border-box !important;
  margin: 0.24em 0 0.1em !important;
  padding: ${padding} !important;
  border: 0 !important;
  border-radius: ${radius} !important;
  background: ${background} !important;
  color: ${color} !important;
  font-family: ${fontFamily} !important;
  font-size: ${fontSize} !important;
  font-style: ${settings.pageTranslationItalic ? 'italic' : 'inherit'} !important;
  font-weight: ${settings.pageTranslationBold ? '700' : 'inherit'} !important;
  line-height: inherit !important;
  letter-spacing: 0 !important;
  overflow-wrap: anywhere !important;
  text-align: inherit !important;
  text-decoration: ${settings.pageTranslationUnderline ? 'underline' : 'none'} !important;
  text-transform: none !important;
  unicode-bidi: plaintext !important;
  white-space: pre-wrap !important;
  opacity: ${opacity} !important;
}

[${INSERTED_ATTR}]:not([${CONTROL_ATTR}]) {
  width: 100% !important;
  flex: 0 0 100% !important;
  grid-column: 1 / -1 !important;
}

[${INSERTED_ATTR}][${CONTROL_ATTR}] {
  display: inline !important;
  margin: 0 0 0 0.35em !important;
  vertical-align: baseline !important;
  white-space: nowrap !important;
}


::highlight(${PAGE_ALIGNMENT_HIGHLIGHT_NAME}) {
  background: rgb(250 204 21 / 52%);
  color: inherit;
  text-decoration: underline;
  text-decoration-color: rgb(202 138 4 / 80%);
  text-decoration-thickness: 2px;
}

[${PAGE_ALIGNMENT_FALLBACK_ATTR}] {
  background-color: rgb(250 204 21 / 22%) !important;
}
${
  settings.pageTranslationDisplayMode === 'translation-only'
    ? `
/* Hide original glyphs but keep every box's geometry — no holes, no collapse.
   The source-owned translation child is restored below. */
[${TRANSLATED_ATTR}],
[${TRANSLATED_ATTR}] * {
  visibility: hidden !important;
}
[${TRANSLATED_ATTR}] :is(input, textarea, select, video, audio, canvas, iframe, img, svg) {
  visibility: visible !important;
}
[${INSERTED_ATTR}] {
  visibility: visible !important;
}
`
    : ''
}${
  settings.pageTranslationDisplayMode === 'learning'
    ? `
/* Learning mode: translations stay blurred until hovered — read the original
   first, peek only when stuck. */
[${INSERTED_ATTR}] {
  filter: blur(5px) !important;
  opacity: 0.35 !important;
  transition: filter 0.15s ease, opacity 0.15s ease !important;
}
[${INSERTED_ATTR}]:hover {
  filter: none !important;
  opacity: 1 !important;
}
`
    : ''
}

#${STATUS_ID} {
  position: fixed !important;
  z-index: 2147483647 !important;
  top: 16px !important;
  right: 16px !important;
  max-width: min(360px, calc(100vw - 32px)) !important;
  padding: 9px 12px !important;
  border: 1px solid rgb(15 23 42 / 14%) !important;
  border-radius: 7px !important;
  background: rgb(255 255 255 / 96%) !important;
  box-shadow: 0 8px 24px rgb(15 23 42 / 16%) !important;
  color: #172033 !important;
  font: 500 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif !important;
  letter-spacing: 0 !important;
}

#${STATUS_ID}[data-error="true"] {
  border-color: rgb(185 28 28 / 24%) !important;
  color: #991b1b !important;
}

@media (prefers-color-scheme: dark) {
  #${STATUS_ID} {
    border-color: rgb(255 255 255 / 16%) !important;
    background: rgb(24 24 27 / 96%) !important;
    color: #f4f4f5 !important;
  }
  #${STATUS_ID}[data-error="true"] { color: #fca5a5 !important; }
}
`
}

type PageSettings = Pick<
  UserSettings,
  | 'sourceLang'
  | 'targetLang'
  | 'pageTranslationEngine'
  | 'pageTranslationDisplayMode'
  | 'pageTranslationFontFamily'
  | 'pageTranslationFontSizePx'
  | 'pageTranslationUseOriginalFontSize'
  | 'pageTranslationUseCustomColor'
  | 'pageTranslationTextColor'
  | 'pageTranslationUseBackground'
  | 'pageTranslationBackgroundColor'
  | 'pageTranslationBold'
  | 'pageTranslationItalic'
  | 'pageTranslationUnderline'
  | 'minTextLength'
>

type TranslationGroup = {
  representative: TranslateBlock
  blocks: ExtractedBlock[]
}

function isTranslationRow(value: unknown): value is { id: string; translation: string } {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'id' in value &&
      typeof value.id === 'string' &&
      'translation' in value &&
      typeof value.translation === 'string',
  )
}

function isTranslateBatchResult(
  value: unknown,
): value is TranslateBatchResultOk | TranslateBatchResultErr {
  if (!value || typeof value !== 'object' || !('type' in value) || !('ok' in value)) return false
  if (value.type !== 'translate-batch-result' || typeof value.ok !== 'boolean') return false
  if (
    'translations' in value &&
    value.translations !== undefined &&
    (!Array.isArray(value.translations) || !value.translations.every(isTranslationRow))
  ) {
    return false
  }
  return value.ok
    ? 'translations' in value && Array.isArray(value.translations)
    : 'error' in value && typeof value.error === 'string'
}

/** Visible blocks first, then DOM order; repeated text shares one translation operation. */
export function groupPageBlocks(blocks: ExtractedBlock[]): TranslationGroup[] {
  const inDocumentOrder = [...blocks].sort((a, b) => {
    if (a.el === b.el) return 0
    const position = a.el.compareDocumentPosition(b.el)
    return position & 4 ? -1 : 1
  })
  const visible: ExtractedBlock[] = []
  const offscreen: ExtractedBlock[] = []
  for (const block of inDocumentOrder) {
    if (isVisible(block.el, 0)) visible.push(block)
    else offscreen.push(block)
  }
  const ordered = [...visible, ...offscreen]
  const groups = new Map<string, TranslationGroup>()

  for (const block of ordered) {
    const text = normalizeText(block.text)
    const existing = groups.get(text)
    if (existing) {
      existing.blocks.push(block)
      continue
    }
    groups.set(text, {
      representative: { id: block.id, tag: block.tag, text },
      blocks: [block],
    })
  }
  return [...groups.values()]
}

type ScrollAnchor = { el: Element; top: number; at: number }

const virtualScrollCache = new WeakMap<Element, Element | null>()

/**
 * Virtualized feeds (X timeline, Reddit, infinite lists) recycle DOM nodes as
 * the user scrolls: items leaving the viewport are unmounted, new ones are
 * inserted in their place. Appending a block-level translation under each item
 * inflates its height, which makes the recycler re-measure and
 * re-mount neighbours — a layout-thrash loop.
 *
 * Detect the nearest tall, scrollable container so mutation handling scans only
 * newly mounted items instead of repeatedly rescanning the whole recycler.
 */
function findVirtualScrollAncestor(el: Element): Element | null {
  // Long, scrollable sidebars are ordinary navigation, not recycled feeds.
  if (el.closest('nav, aside, [role="navigation"], [role="complementary"]')) return null
  const cached = virtualScrollCache.get(el)
  if (cached !== undefined) return cached
  let node = el.parentElement
  let result: Element | null = null
  while (node && node !== document.body) {
    const style = window.getComputedStyle(node)
    const overflowY = style.overflowY
    if (
      (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
      node.clientHeight > 0 &&
      node.scrollHeight >= node.clientHeight * 1.5
    ) {
      result = node
      break
    }
    node = node.parentElement
  }
  // Cache hits only: a container still under the ratio may grow past it once
  // content loads, and a locked negative would keep the host on the wrong path.
  if (result) virtualScrollCache.set(el, result)
  return result
}

/** How an inserted translation sits in its host. */
export type PlacementVerdict = 'ok' | 'narrow' | 'clipped'

// Less room than this and CJK text degenerates into a one-glyph-per-line
// vertical column (Reddit rail links, collapsed templates, icon cells).
const MIN_TRANSLATION_WIDTH_EM = 2.5
const CLIP_VALUES = new Set(['hidden', 'clip'])

function rectOf(el: Element): DOMRect | null {
  if (typeof el.getBoundingClientRect !== 'function') return null
  try {
    return el.getBoundingClientRect()
  } catch {
    return null
  }
}

function styleOf(el: Element): CSSStyleDeclaration | null {
  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return null
  try {
    return window.getComputedStyle(el)
  } catch {
    return null
  }
}

/**
 * Measure a translation node right after insertion. Sites pack UI copy into
 * narrow, fixed-height, or overflow-clipped boxes (icon cells, zero-width
 * templates, chips, drawer rows): a full-width block child there either
 * collapses into a vertical glyph column, vanishes behind a clip, or stretches
 * a shrink-to-fit control sideways.
 *
 * Environments without layout (unit-test stubs) measure nothing and pass.
 */
export function evaluatePlacement(
  host: Element,
  node: HTMLElement,
  ui: boolean,
): PlacementVerdict {
  const rect = rectOf(node)
  if (!rect) return 'ok'
  const nodeStyle = styleOf(node)
  const fontSize = nodeStyle ? parseFloat(nodeStyle.fontSize) || 14 : 14
  const minWidth = ui ? 2 : Math.min(node.textContent?.trim().length || MIN_TRANSLATION_WIDTH_EM, MIN_TRANSLATION_WIDTH_EM) * fontSize
  if (rect.width + 1 < minWidth || rect.height < 2) return 'narrow'
  if (ui) {
    const control = host.closest?.('a, button, label, summary, [role="button"], [role="tab"], [role="link"], [role^="menuitem"], [role="option"], [role="switch"]')
    const bounds = control ? rectOf(control) : null
    if (bounds && (rect.left < bounds.left - 1 || rect.right > bounds.right + 1 || rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1)) return 'clipped'
  }
  // The host box itself must absorb the extra line: a fixed-height host or a
  // small flex/grid row would push the translation over its next sibling
  // (nav rails, drawer rows) even without overflow clipping.
  const hostRect = rectOf(host)
  const hostStyle = styleOf(host)
  if (hostRect && hostStyle && hostStyle.display !== 'inline' &&
      (rect.right > hostRect.right + 1 || rect.left < hostRect.left - 1)) return 'clipped'
  if (hostRect && hostStyle && rect.bottom > hostRect.bottom + 1) {
    const fixedHeight = hostStyle.height.endsWith('px') && hostRect.height < 160
    const smallFlexRow =
      (hostStyle.display.includes('flex') || hostStyle.display.includes('grid')) &&
      hostRect.height < 100
    if (fixedHeight || smallFlexRow) return 'clipped'
  }
  return clipVerdict(node, rect)
}

/** Clipped by any overflow-hidden/clip ancestor between the node and the page. */
function clipVerdict(node: HTMLElement, rect: DOMRect): PlacementVerdict {
  let cur: Element | null = node.parentElement
  let depth = 0
  while (cur && depth++ < 14) {
    const style = styleOf(cur)
    if (!style) break
    if (CLIP_VALUES.has(style.overflowX) || CLIP_VALUES.has(style.overflowY)) {
      const clip = rectOf(cur)
      if (
        clip &&
        clip.width > 0 &&
        clip.height > 0 &&
        (rect.bottom > clip.bottom + 1 ||
          rect.top < clip.top - 1 ||
          rect.right > clip.right + 1 ||
          rect.left < clip.left - 1)
      ) {
        return 'clipped'
      }
    }
    cur = cur.parentElement
  }
  return 'ok'
}

/**
 * A translation can fit its immediate host but overflow a fixed-height outer
 * box. Check those ancestors too, without moving or resizing them.
 */
export function downstreamOverlap(node: HTMLElement): boolean {
  const nr = rectOf(node)
  if (!nr) return false
  let cur: Element = node
  let depth = 0
  while (cur.parentElement && depth++ < 12) {
    const parent = cur.parentElement
    if (parent === document.body) break
    const pr = rectOf(parent)
    if (!pr) break
    if (nr.bottom <= pr.bottom + 1) { cur = parent; continue }
    let sib: Element | null = parent.nextElementSibling
    while (sib && sib.hasAttribute?.('data-lens-ignore')) sib = sib.nextElementSibling
    if (sib) {
      const sr = rectOf(sib)
      if (
        sr &&
        sr.height > 0 &&
        sr.top < nr.bottom - 1 &&
        sr.bottom > nr.top + 1 &&
        sr.left < nr.right &&
        sr.right > nr.left
      ) {
        return true
      }
    }
    cur = parent
  }
  return false
}

/** Owns one reversible full-page bilingual translation run. */
export class PageTranslator {
  private active = false
  private generation = 0
  private statusTimer = 0
  private mutationTimer = 0
  private initialRetryTimer = 0
  private anchorFrame = 0
  private pendingAnchor: ScrollAnchor | null = null
  private activationDeadline = 0
  private processingGeneration = 0
  private rescanRequested = false
  private observer: MutationObserver | null = null
  private observedRoots = new WeakSet<Node>()
  private currentSettings: PageSettings | null = null
  private readonly dirtyRoots = new Set<ParentNode>()
  private readonly translatedHosts = new Set<Element>()
  private readonly sourceHosts = new Map<Element, string | null>()
  private attemptedTextByHost = new WeakMap<Element, string>()
  private sourceBlockByHost = new WeakMap<Element, Element>()
  private volatileHosts = new WeakSet<Element>()
  private layoutFrame = 0
  private readonly layoutSkippedHosts = new Set<Element>()
  /** Styles injected into open shadow roots (document styles don't cross in). */
  private readonly shadowStyles = new Map<ShadowRoot, HTMLStyleElement>()
  private hostChurn = new WeakMap<Element, ChurnRecord>()
  private readonly translationCache = new Map<string, string>()
  private retryAttempts = 0
  private processedCount = 0
  private translatedCount = 0
  private totalCount = 0
  private forceRefresh = false
  private readonly alignment = new PageAlignmentController()
  // Maps a translated host to its inserted translation element.
  private readonly insertedNodeByHost = new Map<Element, HTMLElement>()
  // Reverse lookup: when the page removes one of our nodes we only see the node.
  private readonly hostByInsertedNode = new Map<Element, Element>()
  /** Source wrappers created only for paragraphs separated by hard line breaks. */
  private readonly segmentWrappers = new Set<HTMLElement>()

  constructor(private readonly browserTranslator: BrowserTranslator) {}

  isActive(): boolean {
    return this.active
  }

  /** Forward a word-star (vocabulary) callback into the alignment controller. */
  setWordStarHandler(handler: PageAlignmentController['onWordStar']): void {
    this.alignment.onWordStar = handler
  }

  async toggle(settings: PageSettings, externalConfigured: boolean): Promise<void> {
    if (this.active) {
      this.deactivate()
      return
    }
    await this.activate(settings, externalConfigured)
  }

  deactivate(): void {
    // Removing every translation at once shrinks the page above the reader.
    // Translations are in-flow, so removing them shrinks the content above the
    // reader by their height. Raw scrollTop restore can't see that — remember
    // the first on-screen translated host per scroller and re-align it after
    // teardown, synchronously, before any recycler can react.
    const scrollAnchors = this.captureScrollAnchors()
    this.active = false
    this.generation++
    this.observer?.disconnect()
    this.observer = null
    window.removeEventListener('resize', this.onLayoutChange)
    window.cancelAnimationFrame(this.layoutFrame)
    this.layoutFrame = 0
    this.layoutSkippedHosts.clear()
    this.alignment.deactivate()
    this.observedRoots = new WeakSet<Node>()
    this.lastStatusText = ''
    this.progressTick = 0
    window.clearTimeout(this.statusTimer)
    window.clearTimeout(this.mutationTimer)
    this.mutationTimer = 0
    window.clearTimeout(this.initialRetryTimer)
    if (this.anchorFrame) {
      window.cancelAnimationFrame(this.anchorFrame)
      this.anchorFrame = 0
      this.pendingAnchor = null
    }
    for (const host of this.translatedHosts) {
      host.removeAttribute(TRANSLATED_ATTR)
    }
    for (const node of this.insertedNodeByHost.values()) node.remove()
    this.insertedNodeByHost.clear()
    this.hostByInsertedNode.clear()
    for (const [host, previous] of this.sourceHosts) {
      if (previous === null) host.removeAttribute(PAGE_SOURCE_ATTR)
      else host.setAttribute(PAGE_SOURCE_ATTR, previous)
    }
    this.translatedHosts.clear()
    this.sourceHosts.clear()
    for (const wrapper of this.segmentWrappers) {
      if (wrapper.isConnected) wrapper.replaceWith(...wrapper.childNodes)
    }
    this.segmentWrappers.clear()
    this.attemptedTextByHost = new WeakMap<Element, string>()
    this.sourceBlockByHost = new WeakMap<Element, Element>()
    this.volatileHosts = new WeakSet<Element>()
    this.hostChurn = new WeakMap<Element, ChurnRecord>()
    this.translationCache.clear()
    this.retryAttempts = 0
    this.dirtyRoots.clear()
    this.currentSettings = null
    this.forceRefresh = false
    this.processingGeneration = 0
    this.rescanRequested = false
    document.getElementById(STATUS_ID)?.remove()
    document.getElementById(STYLE_ID)?.remove()
    // Re-align synchronously after DOM teardown, before any recycler reacts.
    for (const style of this.shadowStyles.values()) style.remove()
    this.shadowStyles.clear()
    this.restoreScrollAnchors(scrollAnchors)
  }

  /** First visible translated host per scroller, with its offset from the scroller top. */
  private captureScrollAnchors(): Map<Element | 'window', { el: Element; top: number }> {
    const anchors = new Map<Element | 'window', { el: Element; top: number }>()
    for (const host of this.translatedHosts) {
      if (!host.isConnected) continue
      const container = this.scrollContainerOf(host)
      const key: Element | 'window' = container ?? 'window'
      const base = container ? container.getBoundingClientRect().top : 0
      const top = host.getBoundingClientRect().top - base
      if (top < 0) continue
      const existing = anchors.get(key)
      if (!existing || top < existing.top) anchors.set(key, { el: host, top })
    }
    return anchors
  }

  /** Re-align each anchor after teardown removed the translations above it. */
  private restoreScrollAnchors(anchors: Map<Element | 'window', { el: Element; top: number }>): void {
    // Measure every delta before applying any scroll — a window scroll shifts
    // the viewport position of inner scrollers, corrupting their measurement.
    const adjustments: Array<{ key: Element | 'window'; delta: number }> = []
    for (const [key, anchor] of anchors) {
      if (!anchor.el.isConnected) continue
      const base = key === 'window' ? 0 : key.getBoundingClientRect().top
      const delta = anchor.el.getBoundingClientRect().top - base - anchor.top
      if (delta) adjustments.push({ key, delta })
    }
    for (const { key, delta } of adjustments) {
      if (key === 'window') window.scrollBy(0, delta)
      else key.scrollBy(0, delta)
    }
  }

  /**
   * Discard every rendered translation and re-run with fresh LLM results:
   * all cache layers are bypassed for this run, then overwritten.
   */
  async refresh(settings: PageSettings, externalConfigured: boolean): Promise<void> {
    this.deactivate()
    await this.activate(settings, externalConfigured, { forceRefresh: true })
  }

  /**
   * Re-apply appearance-only settings (font size, colors, weight…) without
   * tearing down the active translation or requesting it again.
   */
  restyle(settings: PageSettings): void {
    if (!this.active) return
    // A stylesheet rewrite resizes every rendered translation at once — the
    // same mass layout shift as toggling, so anchor the reading position too.
    this.scheduleScrollAnchorRestore()
    this.currentSettings = settings
    this.ensureStyles(settings)
    this.onLayoutChange()
  }

  async activate(
    settings: PageSettings,
    externalConfigured: boolean,
    opts?: { forceRefresh?: boolean },
  ): Promise<void> {
    window.clearTimeout(this.statusTimer)
    this.active = true
    this.forceRefresh = opts?.forceRefresh === true
    const generation = ++this.generation
    this.currentSettings = settings
    this.ensureStyles(settings)

    if (settings.pageTranslationEngine === 'external' && !externalConfigured) {
      this.failActivation('整页翻译需要先配置外部 API')
      return
    }
    if (settings.pageTranslationEngine === 'browser') {
      // Probe via offscreen (not page-local Translator) so restricted hosts still work.
      const availability = await this.browserTranslator.availability(
        settings.sourceLang,
        settings.targetLang,
      )
      if (availability === 'unsupported') {
        this.failActivation('当前浏览器不支持 Chrome 内置翻译')
        return
      }
      if (availability === 'unavailable') {
        this.failActivation('Chrome 内置翻译不支持当前语言对')
        return
      }
    }

    this.alignment.activate()
    this.startObserving()
    this.activationDeadline = Date.now() + INITIAL_CONTENT_GRACE_MS
    await this.scanAndTranslate(settings, generation, true)
  }

  private async scanAndTranslate(
    settings: PageSettings,
    generation: number,
    initial = false,
  ): Promise<void> {
    if (!this.isCurrent(generation)) return
    if (this.processingGeneration === generation) {
      this.rescanRequested = true
      return
    }
    if (this.processingGeneration !== 0) return
    this.processingGeneration = generation
    window.clearTimeout(this.statusTimer)

    try {
      const scanRoots = initial ? [document] : [...this.dirtyRoots]
      this.dirtyRoots.clear()
      this.observePageRoots(scanRoots)
      this.cleanupDisconnectedHosts()
      if (initial) this.showStatus('正在分析页面文本…')

      const blocksByElement = new Map<Node, ExtractedBlock>()
      for (const root of scanRoots) {
        if (root !== document && root instanceof Node && !root.isConnected) continue
        for (const block of extractPageBlocks(settings.minTextLength, root)) {
          blocksByElement.set(block.segmentNodes?.[0] ?? block.el, block)
        }
      }
      const blocks = [...blocksByElement.values()].filter((block) => {
        if (this.volatileHosts.has(block.el)) return false
        if (block.el.closest('time')) return false
        if (
          !isPageTranslatableText(
            block.text,
            isUiLabelElement(block.el) ? 1 : settings.minTextLength,
          )
        ) {
          return false
        }
        if (isPredominantlyTargetLanguage(block.text, settings.targetLang)) return false
        if (this.translatedHosts.has(block.el)) return false
        return this.attemptedTextByHost.get(block.el) !== block.text
      })
      const groups = groupPageBlocks(blocks)
      this.totalCount = groups.reduce((total, group) => total + group.blocks.length, 0)
      this.processedCount = 0
      this.translatedCount = 0

      if (!groups.length) {
        if (initial && this.translatedHosts.size === 0) {
          // Content may not have rendered yet. Keep the observer running (so late
          // content is picked up immediately) and retry the initial scan until the
          // grace window elapses, only then declaring the page empty.
          if (Date.now() < this.activationDeadline) {
            this.showStatus('正在等待页面内容加载…')
            this.scheduleInitialRetry(generation)
          } else {
            this.failActivation('当前页面没有可翻译文本')
          }
        } else {
          document.getElementById(STATUS_ID)?.remove()
        }
        return
      }
      if (!initial) this.showStatus('检测到新内容，正在翻译…')
      for (const group of groups) {
        for (const block of group.blocks) {
          this.attemptedTextByHost.set(block.el, block.text)
        }
      }
      this.updateProgress()

      const unresolved: TranslationGroup[] = []
      for (const group of groups) {
        const cached = this.translationCache.get(group.representative.text)
        if (cached) {
          this.renderGroup(group, cached, settings)
          this.processedCount += group.blocks.length
        } else {
          unresolved.push(group)
        }
      }
      this.updateProgress()

      let translateError: string | null = null
      if (unresolved.length) {
        try {
          if (settings.pageTranslationEngine === 'browser') {
            await this.translateWithBrowser(unresolved, settings, generation)
          } else {
            await this.translateWithExternal(unresolved, settings, generation)
          }
        } catch (error) {
          // Partial failures fall through to the retry pass below; the error is
          // still surfaced when this was a total (initial) failure.
          translateError = error instanceof Error ? error.message : String(error)
        }
      }
      if (!this.isCurrent(generation)) return

      if (initial && this.translatedCount === 0 && this.translatedHosts.size === 0 && !this.rescanRequested) {
        this.failActivation(translateError ?? '整页翻译失败，当前语言对可能不可用')
        return
      }

      // Un-mark failed groups and retry with backoff; the attempted-text mark
      // (set before translating) would otherwise skip them on every future scan.
      const failedGroups = groups.filter(
        (group) => !this.translationCache.has(group.representative.text),
      )
      let retryScheduled = false
      if (failedGroups.length === 0) {
        this.retryAttempts = 0
      } else if (this.retryAttempts < FAILED_RETRY_MAX) {
        this.retryAttempts++
        for (const group of failedGroups) {
          for (const block of group.blocks) this.attemptedTextByHost.delete(block.el)
        }
        this.dirtyRoots.add(document)
        this.scheduleScan(FAILED_RETRY_BASE_MS * this.retryAttempts)
        retryScheduled = true
      }

      const failed = this.totalCount - this.translatedCount
      if (retryScheduled) {
        this.showStatus(
          `翻译完成：${this.translatedCount} 段，${failed} 段失败，稍后自动重试…`,
        )
        this.scheduleStatusRemoval(FAILED_RETRY_BASE_MS * this.retryAttempts + 1500)
      } else if (failed > 0) {
        this.showStatus(
          translateError
            ? `整页翻译部分失败：${translateError}`
            : `翻译完成：${this.translatedCount} 段成功，${failed} 段失败`,
          true,
        )
        this.scheduleStatusRemoval(5000)
      } else {
        this.showStatus(`翻译完成：${this.translatedCount} 段`)
        this.scheduleStatusRemoval()
      }
    } catch (error) {
      if (!this.isCurrent(generation)) return
      const message = error instanceof Error ? error.message : String(error)
      if (initial && this.translatedHosts.size === 0) this.failActivation(message)
      else {
        this.showStatus(`整页翻译部分失败：${message}`, true)
        this.scheduleStatusRemoval(5000)
      }
    } finally {
      if (this.processingGeneration !== generation) return
      this.processingGeneration = 0
      if (this.rescanRequested && this.isCurrent(generation)) {
        this.rescanRequested = false
        this.scheduleScan(0)
      }
    }
  }

  private async translateWithBrowser(
    groups: TranslationGroup[],
    settings: PageSettings,
    generation: number,
  ): Promise<void> {
    const ready = await this.browserTranslator.prepare(settings.sourceLang, settings.targetLang)
    if (!this.isCurrent(generation)) return
    if (!ready) throw new Error('Chrome 内置翻译不支持当前语言对')
    for (const group of groups) {
      if (!this.isCurrent(generation)) return
      const translation = await this.browserTranslator.translate(
        group.representative.text,
        settings.sourceLang,
        settings.targetLang,
      )
      if (!this.isCurrent(generation)) return
      if (translation) this.renderGroup(group, translation, settings)
      this.processedCount += group.blocks.length
      this.updateProgress()
    }
  }

  private async translateWithExternal(
    groups: TranslationGroup[],
    settings: PageSettings,
    generation: number,
  ): Promise<void> {
    const pageKey = makePageKey()
    let firstError: string | null = null

    // Every line is its own request. Workers drain the queue in document order
    // (bounded parallelism), and each line renders the moment its translation
    // lands instead of waiting for a multi-block batch.
    this.scheduleScrollAnchorRestore()
    const runLine = async (group: TranslationGroup): Promise<void> => {
      if (!this.isCurrent(generation)) return
      try {
        const response: unknown = await chrome.runtime.sendMessage({
          type: 'translate-batch',
          pageKey,
          blocks: [group.representative],
          // Resolved before activation ('auto' → real page language); without
          // this the background guesses 'en' and the prompt lies about the source.
          sourceLang: settings.sourceLang,
          targetLang: settings.targetLang,
          ...(this.forceRefresh ? { forceRefresh: true } : {}),
        })
        if (!this.isCurrent(generation)) return
        if (!isTranslateBatchResult(response)) throw new Error('翻译服务未返回有效结果')

        const item = response.translations?.find((row) => row.id === group.representative.id)
        if (item) this.renderGroup(group, item.translation, settings)
        if (!response.ok && firstError === null) firstError = response.error
      } catch (error) {
        if (firstError === null) {
          firstError = error instanceof Error ? error.message : String(error)
        }
      }

      if (!this.isCurrent(generation)) return
      this.processedCount += group.blocks.length
      this.updateProgress()
    }

    await runWithConcurrency(groups, PAGE_TRANSLATION_CONCURRENCY, runLine)
    if (!this.isCurrent(generation)) return
    // External and on-device engines are intentionally isolated; surface any remaining gap.
    if (firstError !== null && groups.some((g) => !this.translationCache.has(g.representative.text))) {
      throw new Error(firstError)
    }
  }

  private renderGroup(group: TranslationGroup, translation: string, settings: PageSettings): void {
    // Appended translations push everything below them down; anchor the
    // reading position before mutating so streamed renders do not drift the page.
    this.scheduleScrollAnchorRestore()
    this.translationCache.set(group.representative.text, translation)
    for (const block of group.blocks) {
      // DOM identity survives virtualized content replacement. A late response
      // only belongs to the exact source that was sent, not its replacement.
      if (!block.el.isConnected || this.translatedHosts.has(block.el)) continue
      if (!block.segmentNodes && pageSourceText(block.el) !== block.text) {
        this.attemptedTextByHost.delete(block.el)
        this.dirtyRoots.add(block.el)
        this.rescanRequested = true
        continue
      }
      const host = this.materializeSegmentHost(block)
      if (!host || !host.isConnected || this.translatedHosts.has(host)) continue
      if (!this.sourceHosts.has(host)) {
        this.sourceHosts.set(host, host.getAttribute(PAGE_SOURCE_ATTR))
        host.setAttribute(PAGE_SOURCE_ATTR, block.text)
      }
      host.setAttribute(TRANSLATED_ATTR, '')
      const translationEl = this.insertTranslationIntoHost(host, translation)
      if (!translationEl) {
        // No placement survives this host's layout constraints (icon cell,
        // clipped chip, collapsed template). Leave the original untouched and
        // retry only after source or layout changes, without a new API request.
        host.removeAttribute(TRANSLATED_ATTR)
        const previous = this.sourceHosts.get(host)
        if (previous === null) host.removeAttribute(PAGE_SOURCE_ATTR)
        else if (previous !== undefined) host.setAttribute(PAGE_SOURCE_ATTR, previous)
        this.sourceHosts.delete(host)
        this.attemptedTextByHost.set(host, block.text)
        this.layoutSkippedHosts.add(host)
        this.totalCount = Math.max(0, this.totalCount - 1)
        continue
      }
      this.translatedHosts.add(host)
      this.layoutSkippedHosts.delete(host)
      this.sourceBlockByHost.set(host, block.el)
      this.alignment.register(
        host,
        block.text,
        translation,
        settings.sourceLang,
        settings.targetLang,
        translationEl,
      )
      this.translatedCount++
    }
  }

  private materializeSegmentHost(block: ExtractedBlock): Element | null {
    const nodes = block.segmentNodes
    if (!nodes?.length) return block.el
    const parent = nodes[0].parentNode
    if (
      !parent ||
      nodes.some((node) => !node.isConnected || node.parentNode !== parent) ||
      nodes.some((node, index) => index > 0 && nodes[index - 1].nextSibling !== node) ||
      normalizeText(nodes.map((node) => node.textContent ?? '').join('')) !== block.text
    ) {
      return null
    }
    const wrapper = document.createElement('span')
    wrapper.setAttribute(PAGE_SEGMENT_ATTR, '')
    parent.insertBefore(wrapper, nodes[0])
    for (const node of nodes) wrapper.append(node)
    this.segmentWrappers.add(wrapper)
    return wrapper
  }

  /**
   * Insert one neutral <span> into the exact source host.
   * Returns null when no placement survives the host's layout — the caller
   * must then leave the original text untouched.
   */
  private insertTranslationIntoHost(host: Element, translation: string): HTMLElement | null {
    this.removeInsertedNodeForHost(host)
    const control = isUiLabelElement(host)
    const node = document.createElement('span')
    node.setAttribute(INSERTED_ATTR, '')
    node.setAttribute('data-lens-ignore', '')
    if (control) node.setAttribute(CONTROL_ATTR, '')
    node.textContent = translation
    // Document styles never cross the shadow boundary — mirror the stylesheet
    // into each open shadow root that receives a translation.
    const root = host.getRootNode()
    if (root instanceof ShadowRoot && !this.shadowStyles.has(root) && this.currentSettings) {
      const style = document.createElement('style')
      style.setAttribute('data-lens-ignore', '')
      style.textContent = pageStyles(this.currentSettings)
      root.prepend(style)
      this.shadowStyles.set(root, style)
    }
    this.placeTranslationNode(host, node)
    if (evaluatePlacement(host, node, control) !== 'ok' || downstreamOverlap(node)) {
      // ponytail: fixed/clipped boxes keep their original geometry; use the
      // existing lens there instead of inventing cross-component placement.
      node.remove()
      return null
    }
    this.insertedNodeByHost.set(host, node)
    this.hostByInsertedNode.set(node, host)
    return node
  }

  private placeTranslationNode(host: Element, node: HTMLElement): void {
    host.append(node)
  }

  /** Remove the inserted translation node for a host (invalidate / teardown). */
  private removeInsertedNodeForHost(host: Element): void {
    const node = this.insertedNodeByHost.get(host)
    if (!node) return
    this.insertedNodeByHost.delete(host)
    this.hostByInsertedNode.delete(node)
    node.remove()
  }

  /**
   * Removal-by-the-site churn counter, mirroring the text-change churn: a host
   * whose translation keeps getting stripped goes volatile instead of looping
   * invalidate → re-translate → re-insert forever.
   */
  private recordTranslationRemoval(host: Element): boolean {
    const now = Date.now()
    const record = this.hostChurn.get(host)
    if (!record || now - record.since > VOLATILE_CHURN_WINDOW_MS) {
      this.hostChurn.set(host, { count: 1, since: now })
      return false
    }
    record.count++
    return record.count >= VOLATILE_CHURN_LIMIT
  }

  private startObserving(): void {
    this.observer?.disconnect()
    this.observedRoots = new WeakSet<Node>()
    this.observer = new MutationObserver((records) => this.onMutations(records))
    this.observePageRoots([document])
    window.addEventListener('resize', this.onLayoutChange)
  }

  private readonly onLayoutChange = (): void => {
    if (!this.active || this.layoutFrame) return
    this.layoutFrame = window.requestAnimationFrame(() => {
      this.layoutFrame = 0
      const retry = [...this.layoutSkippedHosts]
      for (const [host, node] of this.insertedNodeByHost) {
        if (!host.isConnected || !node.isConnected) continue
        if (evaluatePlacement(host, node, isUiLabelElement(host)) === 'ok' && !downstreamOverlap(node)) continue
        const source = host.getAttribute(PAGE_SOURCE_ATTR) ?? ''
        this.invalidateHost(host)
        this.attemptedTextByHost.set(host, source)
        this.layoutSkippedHosts.add(host)
      }
      for (const host of retry) {
        this.layoutSkippedHosts.delete(host)
        if (!host.isConnected) continue
        this.attemptedTextByHost.delete(host)
        this.dirtyRoots.add(host)
      }
      if (retry.length) this.scheduleScan()
    })
  }

  private observePageRoots(scanRoots: ParentNode[]): void {
    if (!this.observer) return
    for (const scanRoot of scanRoots) {
      for (const root of collectPageRoots(scanRoot)) {
        const target = root === document ? document.documentElement : (root as Node)
        if (this.observedRoots.has(target)) continue
        this.observer.observe(target, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['hidden', 'aria-hidden', 'class', 'style', 'open'],
        })
        this.observedRoots.add(target)
      }
    }
  }

  private onMutations(records: MutationRecord[]): void {
    let relevant = false
    for (const record of records) {
      const target =
        record.target.nodeType === 1
          ? (record.target as Element)
          : record.target.parentElement
      if (!target || target.closest('[data-lens-ignore]')) continue
      if (record.type === 'attributes') {
        this.dirtyRoots.add(target)
        relevant = true
        continue
      }

      // Typing inside editors is never extracted, so rescanning on it is pure waste.
      if (
        record.type === 'characterData' &&
        target.closest('[contenteditable]:not([contenteditable="false"]), textarea, input')
      ) {
        continue
      }

      if (record.type === 'childList') {
        // Frameworks (React reconciliation on X) may strip our inserted
        // translation node while keeping the host. Re-translate that host on
        // the next scan; the churn cap stops sites that keep removing it.
        for (const node of record.removedNodes) {
          if (node.nodeType !== 1 || !(node as Element).hasAttribute(INSERTED_ATTR)) continue
          const host = this.hostByInsertedNode.get(node as Element)
          if (!host) continue
          const source = host.getAttribute(PAGE_SOURCE_ATTR) ?? ''
          const suppressed = this.recordTranslationRemoval(host)
          this.invalidateHost(host)
          if (suppressed) {
            // Stop fighting a framework over unchanged source, but allow a
            // recycled node to translate again when its actual text changes.
            this.attemptedTextByHost.set(host, source)
          } else {
            this.dirtyRoots.add(host.parentElement ?? host)
            relevant = true
          }
        }

        const changed = [...record.addedNodes, ...record.removedNodes]
        if (changed.length > 0 && changed.every((node) => this.isOwnNode(node))) continue

        // Virtualized feeds (X timeline, Reddit, infinite lists) constantly
        // mount/unmount feed items as the user scrolls. Treating every recycler
        // mutation as a dirty *parent* forces a full-container rescan on every
        // scroll tick, which re-translates items, inflates their heights, and
        // trips the recycler again — a layout-thrash loop.
        //
        // Instead, when the mutation happens inside a virtual scroller, only
        // enqueue the newly added nodes themselves (not the parent), so the
        // next scan extracts only the fresh items. Removed nodes are handled
        // by cleanupDisconnectedHosts().
        if (this.isVirtualScrollChildList(record)) {
          let addedDirty = false
          const minLen = this.currentSettings?.minTextLength ?? 10
          for (const node of record.addedNodes) {
            if (node.nodeType !== 1) continue
            const el = node as Element
            if (this.isOwnNode(el)) continue
            // Only enqueue if the added subtree actually carries text worth
            // scanning; bare wrapper inserts (spacers, sentinels) are skipped.
            if (normalizeText(elementText(el)).length < minLen) continue
            this.dirtyRoots.add(el)
            addedDirty = true
          }
          if (addedDirty) relevant = true
          continue
        }
      }

      const translatedHost = target.closest(`[${TRANSLATED_ATTR}]`)
      if (translatedHost) {
        const source = translatedHost.getAttribute(PAGE_SOURCE_ATTR) ?? ''
        if (pageSourceText(translatedHost) === source) continue
        if (this.markChurnAndMaybeVolatile(translatedHost)) {
          // Host changes too often to be worth translating: restore the original
          // text and stop tracking it so we never loop on it again.
          this.invalidateHost(translatedHost)
          continue
        }
        this.invalidateHost(translatedHost)
        this.dirtyRoots.add(translatedHost.parentElement ?? translatedHost)
        relevant = true
        continue
      }
      this.dirtyRoots.add(target.parentElement ?? target)
      relevant = true
    }
    if (relevant) {
      this.onLayoutChange()
      this.scheduleScan()
    }
  }

  /**
   * A childList mutation whose target lives inside a virtual scroller and whose
   * siblings are feed items (not our own overlay/style nodes). Used to suppress
   * the full-parent rescan that would otherwise loop with the recycler.
   *
   * Mutations *inside* an already-translated host (tweet edited, reply expanded)
   * are excluded — they must go through the normal invalidate path so the host
   * gets re-translated instead of being treated as a fresh recycler insertion.
   */
  private isVirtualScrollChildList(record: MutationRecord): boolean {
    if (record.type !== 'childList') return false
    const target =
      record.target.nodeType === 1
        ? (record.target as Element)
        : record.target.parentElement
    if (!target) return false
    if (target.closest(`[${TRANSLATED_ATTR}]`)) return false
    return findVirtualScrollAncestor(target) !== null
  }

  private markChurnAndMaybeVolatile(host: Element): boolean {
    const now = Date.now()
    const record = this.hostChurn.get(host)
    if (!record || now - record.since > VOLATILE_CHURN_WINDOW_MS) {
      this.hostChurn.set(host, { count: 1, since: now })
      return false
    }
    record.count++
    if (record.count < VOLATILE_CHURN_LIMIT) return false
    this.volatileHosts.add(host)
    const sourceBlock = this.sourceBlockByHost.get(host)
    if (sourceBlock) this.volatileHosts.add(sourceBlock)
    return true
  }

  private isOwnNode(node: Node): boolean {
    return (
      node.nodeType === 1 &&
      ((node as Element).hasAttribute('data-lens-ignore') ||
        (node as Element).id === STYLE_ID ||
        (node as Element).id === STATUS_ID)
    )
  }

  private invalidateHost(host: Element): void {
    this.alignment.unregister(host)
    this.removeInsertedNodeForHost(host)
    host.removeAttribute(TRANSLATED_ATTR)
    this.translatedHosts.delete(host)
    const previous = this.sourceHosts.get(host)
    if (previous === null) host.removeAttribute(PAGE_SOURCE_ATTR)
    else if (previous !== undefined) host.setAttribute(PAGE_SOURCE_ATTR, previous)
    this.sourceHosts.delete(host)
    this.attemptedTextByHost.delete(this.sourceBlockByHost.get(host) ?? host)
    this.sourceBlockByHost.delete(host)
  }

  private cleanupDisconnectedHosts(): void {
    for (const host of this.translatedHosts) {
      if (host.isConnected) continue
      this.invalidateHost(host)
    }
    // Sweep inserted nodes the page detached without us seeing the mutation
    // (e.g. removed while the tab was hidden): re-translate their hosts.
    for (const [host, node] of [...this.insertedNodeByHost]) {
      if (node.isConnected || !host.isConnected) continue
      this.invalidateHost(host)
      this.dirtyRoots.add(host.parentElement ?? host)
    }
  }

  private scheduleScan(delay = 250): void {
    // Throttle, don't debounce: X and other live pages mutate continuously.
    // Resetting this timer on every mutation starves the scan forever.
    if (this.mutationTimer) return
    this.mutationTimer = window.setTimeout(() => {
      this.mutationTimer = 0
      if (!this.active || !this.currentSettings) return
      void this.scanAndTranslate(this.currentSettings, this.generation)
    }, delay)
  }
  private scheduleInitialRetry(generation: number): void {
    window.clearTimeout(this.initialRetryTimer)
    this.initialRetryTimer = window.setTimeout(() => {
      if (!this.isCurrent(generation) || !this.currentSettings) return
      void this.scanAndTranslate(this.currentSettings, generation, true)
    }, INITIAL_RETRY_INTERVAL_MS)
  }

  private isCurrent(generation: number): boolean {
    return this.active && generation === this.generation
  }

  /**
   * Translations render as real inserted blocks, so every render batch and
   * the final teardown shift all content below them. Chrome's native scroll
   * anchoring is suppressed when many nodes change at once, so re-measure the
   * reader's anchor after the frame and cancel the drift ourselves. If native
   * anchoring already compensated, the measured delta is 0 and we stay idle.
   */
  private scheduleScrollAnchorRestore(): void {
    // rAF never fires in a hidden tab — a stale anchor captured minutes ago must
    // not be reused on the next visible run.
    if (!this.pendingAnchor || Date.now() - this.pendingAnchor.at > 1000) {
      this.pendingAnchor = this.captureScrollAnchor()
    }
    if (!this.pendingAnchor || this.anchorFrame) return
    this.anchorFrame = window.requestAnimationFrame(() => {
      this.anchorFrame = 0
      const anchor = this.pendingAnchor
      this.pendingAnchor = null
      // Hidden tabs fire rAF only when re-shown — a stale anchor would apply a
      // bogus jump long after the mutations happened.
      if (!anchor || !anchor.el.isConnected || Date.now() - anchor.at > 1000) return
      const delta = anchor.el.getBoundingClientRect().top - anchor.top
      if (Math.abs(delta) <= 1) return
      const container = this.scrollContainerOf(anchor.el)
      if (container) container.scrollBy({ top: delta, left: 0, behavior: 'instant' })
      else window.scrollBy({ top: delta, left: 0, behavior: 'instant' })
    })
  }

  /** Topmost non-fixed content element — a proxy for what the user is reading. */
  private captureScrollAnchor(): ScrollAnchor | null {
    if (typeof document.elementsFromPoint !== 'function') return null
    const x = Math.round(window.innerWidth / 2)
    const maxY = Math.min(window.innerHeight, 480)
    for (let y = 1; y <= maxY; y += 24) {
      for (const el of document.elementsFromPoint(x, y)) {
        if (el === document.body || el === document.documentElement) continue
        if (el.closest('[data-lens-ignore]')) continue
        // Fixed/stuck-sticky elements do not move when content above them
        // grows, so they cannot measure layout drift.
        const position = window.getComputedStyle(el).position
        if (position === 'fixed' || position === 'sticky') continue
        // Skip elements inside virtualized scrollers: the recycler may swap or
        // recycle them before rAF fires, making the measured delta bogus and
        // causing the viewport to jump.
        if (findVirtualScrollAncestor(el)) continue
        return { el, top: el.getBoundingClientRect().top, at: Date.now() }
      }
    }
    return null
  }

  /** Sites like Gmail scroll an inner panel, not the document — compensate there. */
  private scrollContainerOf(el: Element): Element | null {
    let node = el.parentElement
    while (node && node !== document.body) {
      const style = window.getComputedStyle(node)
      if (
        /(auto|scroll|overlay)/.test(style.overflowY) &&
        node.scrollHeight > node.clientHeight
      ) {
        return node
      }
      node = node.parentElement
    }
    return null
  }

  private ensureStyles(settings: PageSettings): void {
    let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null
    if (!style) {
      style = document.createElement('style')
      style.id = STYLE_ID
      style.setAttribute('data-lens-ignore', '')
      ;(document.head ?? document.documentElement).append(style)
    }
    style.textContent = pageStyles(settings)
    for (const shadowStyle of this.shadowStyles.values()) {
      shadowStyle.textContent = style.textContent
    }
  }

  private lastStatusText = ''

  private showStatus(text: string, error = false): void {
    // Skip no-op DOM writes — rapid rescans used to rewrite the same toast and flicker.
    if (
      text === this.lastStatusText &&
      document.getElementById(STATUS_ID)?.dataset.error === (error ? 'true' : 'false')
    ) {
      return
    }
    this.lastStatusText = text
    let status = document.getElementById(STATUS_ID)
    if (!status) {
      status = document.createElement('div')
      status.id = STATUS_ID
      status.setAttribute('data-lens-ignore', '')
      status.setAttribute('role', 'status')
      status.setAttribute('aria-live', 'polite')
      document.documentElement.append(status)
    }
    status.dataset.error = error ? 'true' : 'false'
    status.textContent = text
  }

  private progressTick = 0

  private updateProgress(): void {
    // Throttle progress toasts so mutation-driven rescans do not strobe the corner badge.
    const now = Date.now()
    if (now - this.progressTick < 400 && this.processedCount < this.totalCount) return
    this.progressTick = now
    this.showStatus(`整页翻译 ${Math.min(this.processedCount, this.totalCount)}/${this.totalCount}`)
  }

  private failActivation(message: string): void {
    this.active = false
    window.clearTimeout(this.initialRetryTimer)
    this.observer?.disconnect()
    this.observer = null
    this.alignment.deactivate()
    this.showStatus(message, true)
    this.scheduleStatusRemoval(5000)
  }

  private scheduleStatusRemoval(delay = 3000): void {
    window.clearTimeout(this.statusTimer)
    this.statusTimer = window.setTimeout(() => {
      document.getElementById(STATUS_ID)?.remove()
    }, delay)
  }
}

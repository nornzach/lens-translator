import { languageShortLabel } from '../shared/languages'
import { isPredominantlyTargetLanguage, normalizeText } from '../shared/text'

export type SelectionTranslateRequest = (text: string) => Promise<string | null>

export type SelectionTranslatorActions = {
  onSpeak?: (text: string) => void
  onStar?: (source: string, translation: string) => void
}

/**
 * Wait for the selection to settle before translating. `selectionchange` fires
 * for every intermediate range while dragging (and on every Find-in-page jump),
 * so translating immediately would burn one API request per intermediate text.
 */
const SELECTION_SETTLE_MS = 300

/**
 * Temporary popup for selected text. Independent of the lens and full-page mode:
 * enable the toggle → select words → popup; clear selection → hide immediately.
 */
export class SelectionTranslator {
  private host: HTMLDivElement
  private root: ShadowRoot
  private panel: HTMLDivElement
  private sourceLabel: HTMLDivElement
  private sourceBody: HTMLDivElement
  private targetLabel: HTMLDivElement
  private targetBody: HTMLDivElement
  private bound = false
  private enabled = false
  private paused = false
  private sourceLang = 'en'
  private targetLang = 'zh'
  private requestId = 0
  private lastText = ''
  private lastTranslation = ''
  private refreshTimer = 0
  private actionRow: HTMLDivElement
  private starBtn: HTMLButtonElement
  private speakBtn: HTMLButtonElement
  private translate: SelectionTranslateRequest
  private readonly actions: SelectionTranslatorActions

  constructor(translate: SelectionTranslateRequest, actions: SelectionTranslatorActions = {}) {
    this.translate = translate
    this.actions = actions
    this.host = document.createElement('div')
    this.host.id = 'lens-translator-selection-root'
    this.host.setAttribute('data-lens-ignore', '')
    Object.assign(this.host.style, {
      all: 'initial',
      position: 'fixed',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '2147483645',
    })
    this.root = this.host.attachShadow({ mode: 'closed' })

    const style = document.createElement('style')
    style.textContent = STYLES
    this.panel = document.createElement('div')
    this.panel.className = 'panel'
    this.panel.style.display = 'none'
    this.panel.addEventListener('mousedown', (e) => e.stopPropagation())

    this.sourceLabel = document.createElement('div')
    this.sourceLabel.className = 'label'
    this.sourceBody = document.createElement('div')
    this.sourceBody.className = 'source'
    this.targetLabel = document.createElement('div')
    this.targetLabel.className = 'label target-label'
    this.targetBody = document.createElement('div')
    this.targetBody.className = 'target'

    this.actionRow = document.createElement('div')
    this.actionRow.className = 'actions'
    this.actionRow.hidden = true
    this.starBtn = document.createElement('button')
    this.starBtn.type = 'button'
    this.starBtn.className = 'icon-btn'
    this.starBtn.title = '收藏到生词本'
    this.starBtn.textContent = '☆'
    this.starBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (this.lastText && this.lastTranslation) {
        this.actions.onStar?.(this.lastText, this.lastTranslation)
        this.starBtn.textContent = '★'
      }
    })
    this.speakBtn = document.createElement('button')
    this.speakBtn.type = 'button'
    this.speakBtn.className = 'icon-btn'
    this.speakBtn.title = '朗读译文'
    this.speakBtn.textContent = '🔊'
    this.speakBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (this.lastTranslation) this.actions.onSpeak?.(this.lastTranslation)
    })
    this.actionRow.append(this.starBtn, this.speakBtn)

    this.panel.append(this.sourceLabel, this.sourceBody, this.targetLabel, this.targetBody, this.actionRow)
    this.root.append(style, this.panel)
  }

  bind(): void {
    if (this.bound) return
    this.bound = true
    document.addEventListener('selectionchange', this.onSelectionChange)
    document.addEventListener('mousedown', this.onMouseDown, true)
    window.addEventListener('scroll', this.hide, true)
    window.addEventListener('resize', this.hide)
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) this.hide()
  }

  setPaused(paused: boolean): void {
    this.paused = paused
    if (paused) this.hide()
  }

  setLanguages(sourceLang: string, targetLang: string): void {
    this.sourceLang = sourceLang
    this.targetLang = targetLang
    this.sourceLabel.textContent = languageShortLabel(sourceLang)
    this.targetLabel.textContent = languageShortLabel(targetLang)
  }

  private readonly onMouseDown = (e: MouseEvent): void => {
    const path = e.composedPath()
    if (path.includes(this.host) || path.includes(this.panel)) return
    // A new drag may start; clear stale popup until selection settles.
    if (this.panel.style.display !== 'none' && !this.getSelectedText()) this.hide()
  }

  private readonly onSelectionChange = (): void => {
    if (!this.enabled || this.paused) {
      this.hide()
      return
    }
    // Debounce: only the settled selection is worth a translation request.
    window.clearTimeout(this.refreshTimer)
    this.refreshTimer = window.setTimeout(
      () => void this.refreshFromSelection(),
      SELECTION_SETTLE_MS,
    )
  }

  private getSelectedText(): string {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return ''
    const text = normalizeText(selection.toString())
    if (text.length < 1 || text.length > 2000) return ''
    // Ignore selections inside our own UI / extension shells / editable fields.
    const anchor = selection.anchorNode
    if (anchor) {
      const el = anchor instanceof Element ? anchor : anchor.parentElement
      if (isIgnoredSelectionHost(el)) return ''
    }
    const focus = selection.focusNode
    if (focus) {
      const el = focus instanceof Element ? focus : focus.parentElement
      if (isIgnoredSelectionHost(el)) return ''
    }
    // Active text fields even when selection APIs report body-level ranges.
    if (isEditableElement(document.activeElement)) return ''
    return text
  }

  private async refreshFromSelection(): Promise<void> {
    const text = this.getSelectedText()
    if (!text) {
      this.hide()
      return
    }
    if (text === this.lastText && this.panel.style.display !== 'none') return
    this.lastText = text

    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) {
      this.hide()
      return
    }
    const range = selection.getRangeAt(0)
    const rect = range.getBoundingClientRect()
    if (rect.width < 1 && rect.height < 1) {
      this.hide()
      return
    }

    this.mount()
    this.sourceLabel.textContent = languageShortLabel(this.sourceLang)
    this.targetLabel.textContent = languageShortLabel(this.targetLang)
    this.sourceBody.textContent = text
    this.panel.style.display = 'block'

    if (isPredominantlyTargetLanguage(text, this.targetLang)) {
      this.targetBody.classList.add('muted')
      this.targetBody.textContent = '已是目标语言'
      this.place(rect)
      return
    }

    this.targetBody.classList.add('muted', 'pending')
    this.targetBody.textContent = '翻译中…'
    this.place(rect)

    const id = ++this.requestId
    try {
      const translation = await this.translate(text)
      if (id !== this.requestId || this.getSelectedText() !== text) return
      if (!translation) {
        // Quiet failure: keep the panel, never surface raw API/setup errors as popups.
        this.targetBody.classList.add('muted')
        this.targetBody.classList.remove('pending')
        this.targetBody.textContent = '暂无法翻译'
        return
      }
      this.targetBody.classList.remove('muted', 'pending')
      this.targetBody.textContent = translation
      this.lastTranslation = translation
      this.starBtn.textContent = '☆'
      this.actionRow.hidden = !this.actions.onSpeak && !this.actions.onStar
      this.place(rect)
    } catch {
      // Selection path must stay non-modal: swallow errors and show a short inline hint.
      if (id !== this.requestId) return
      this.targetBody.classList.add('muted')
      this.targetBody.classList.remove('pending')
      this.targetBody.textContent = '暂无法翻译'
    }
  }

  private place(rect: DOMRect): void {
    const gap = 10
    const vw = window.innerWidth
    const vh = window.innerHeight
    const pr = this.panel.getBoundingClientRect()
    const pw = Math.max(pr.width, 220)
    const ph = Math.max(pr.height, 72)
    let left = Math.min(Math.max(8, rect.left), vw - pw - 8)
    let top = rect.bottom + gap
    if (top + ph > vh - 8) top = Math.max(8, rect.top - ph - gap)
    this.panel.style.left = `${left}px`
    this.panel.style.top = `${top}px`
  }

  private mount(): void {
    if (!this.host.isConnected) document.documentElement.append(this.host)
  }

  readonly hide = (): void => {
    this.requestId++
    this.lastText = ''
    this.lastTranslation = ''
    // A pending debounced refresh must not resurrect the popup after hide.
    window.clearTimeout(this.refreshTimer)
    this.panel.style.display = 'none'
    this.actionRow.hidden = true
    this.targetBody.classList.remove('muted', 'pending')
  }
}

function isEditableElement(el: Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false
  if (el.isContentEditable) return true
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return Boolean(el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'))
}

function isIgnoredSelectionHost(el: Element | null): boolean {
  if (!el) return false
  if (isEditableElement(el)) return true
  return Boolean(
    el.closest(
      '#lens-translator-root, #lens-translator-bubble-root, #lens-translator-selection-root, #lens-translator-setup-prompt, [data-lens-ignore]',
    ),
  )
}

/**
 * Pure predicate for tests (no DOM). Mirrors isIgnoredSelectionHost rules.
 * `closestIds` lists ancestor ids / markers found via closest().
 */
export function shouldIgnoreSelectionContext(input: {
  tagName?: string
  isContentEditable?: boolean
  closestIds?: string[]
}): boolean {
  const tag = (input.tagName ?? '').toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (input.isContentEditable) return true
  const ids = input.closestIds ?? []
  if (ids.some((id) => id === 'lens-translator-root' || id === 'lens-translator-bubble-root')) {
    return true
  }
  if (ids.some((id) => id === 'lens-translator-selection-root' || id === 'lens-translator-setup-prompt')) {
    return true
  }
  if (ids.some((id) => id === 'data-lens-ignore')) return true
  return false
}

const STYLES = `
  :host, * { box-sizing: border-box; }
  .panel {
    position: fixed;
    min-width: 180px;
    max-width: min(360px, calc(100vw - 16px));
    max-height: min(280px, 42vh);
    overflow: auto;
    padding: 10px 12px;
    border-radius: 12px;
    background: rgb(255 255 255 / 96%);
    box-shadow:
      0 12px 32px rgb(15 23 42 / 18%),
      0 0 0 1px rgb(15 23 42 / 8%);
    color: #0f172a;
    font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
    pointer-events: auto;
    user-select: text;
  }
  .label {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.05em;
    color: #94a3b8;
    margin-bottom: 2px;
  }
  .target-label { margin-top: 8px; }
  .source {
    color: #64748b;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 12.5px;
  }
  .target {
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 14px;
    font-weight: 520;
    color: #0f172a;
  }
  .target.muted { color: #64748b; font-weight: 400; }
  .target.pending { animation: pulse 1.1s ease-in-out infinite; }
  .actions {
    margin-top: 6px;
    display: flex;
    gap: 2px;
    justify-content: flex-end;
  }
  .icon-btn {
    appearance: none;
    border: 0;
    border-radius: 6px;
    background: transparent;
    padding: 3px 5px;
    font-size: 13px;
    line-height: 1;
    color: #64748b;
    cursor: pointer;
  }
  .icon-btn:hover { background: rgb(15 23 42 / 8%); }
  @keyframes pulse {
    0%, 100% { opacity: 0.55; }
    50% { opacity: 1; }
  }
  @media (prefers-color-scheme: dark) {
    .panel {
      background: rgb(24 24 27 / 96%);
      color: #f4f4f5;
      box-shadow: 0 12px 32px rgb(0 0 0 / 45%), 0 0 0 1px rgb(255 255 255 / 8%);
    }
    .source { color: #a1a1aa; }
    .target { color: #fafafa; }
    .target.muted { color: #a1a1aa; }
  }
  @media (prefers-reduced-motion: reduce) {
    .target.pending { animation: none; }
  }
`

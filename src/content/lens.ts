import type { DictionaryEntry } from '../shared/schema'

export type LensViewState =
  | { kind: 'hidden' }
  | {
      kind: 'ready'
      /** Chinese translation */
      text: string
      /** English source text when the target is a text block. */
      sourceText?: string
      sourceRect?: DOMRect
    }
  | {
      kind: 'pending'
      sourceText?: string
      sourceRect?: DOMRect
    }
  | { kind: 'empty' }
  | { kind: 'target-language' }
  | {
      kind: 'error'
      message: string
      sourceText?: string
      sourceRect?: DOMRect
    }
  | { kind: 'unconfigured' }
  | {
      /** Writing mode: editable field content + back-translation + replace action. */
      kind: 'editable'
      sourceText: string
      translation: string | null
      status: 'pending' | 'ready' | 'error'
      error?: string
      writable: boolean
      sourceRect?: DOMRect
    }
  | {
      /** Dictionary card for single words (external engine). */
      kind: 'dict'
      entry: DictionaryEntry
      sourceText: string
      sourceRect?: DOMRect
    }

type LensAppearance = {
  pageTranslationUseCustomColor: boolean
  pageTranslationTextColor: string
  pageTranslationUseBackground: boolean
  pageTranslationBackgroundColor: string
  pageTranslationBold: boolean
  pageTranslationItalic: boolean
  pageTranslationUnderline: boolean
}

/**
 * Liquid-glass lens: bilingual EN/ZH panel placed **beside** the source
 * (never covering the original reading text).
 */
export class LensOverlay {
  private host: HTMLDivElement
  private root: ShadowRoot
  private panel: HTMLDivElement
  private textLayer: HTMLDivElement
  private sourceLabel: HTMLDivElement
  private sourceBody: HTMLDivElement
  private zhLabel: HTMLDivElement
  private body: HTMLDivElement
  private divider: HTMLDivElement
  private hint: HTMLDivElement
  private ring: HTMLDivElement
  private toolbar: HTMLDivElement
  private starBtn: HTMLButtonElement
  private speakSourceBtn: HTMLButtonElement
  private speakTargetBtn: HTMLButtonElement
  private dictCard: HTMLDivElement
  private actionRow: HTMLDivElement
  private actionBtn: HTMLButtonElement
  private actionHandler: (() => void) | null = null
  private starHandler: (() => void) | null = null
  private speakHandler: ((which: 'source' | 'target') => void) | null = null
  private highlightEl: Element | null = null
  private widthPx: number
  private lastSourceKey = ''
  private sourceLangLabel = '源语言'
  private targetLangLabel = '译文'

  constructor(widthPx = 340) {
    this.widthPx = widthPx
    this.host = document.createElement('div')
    this.host.id = 'lens-translator-root'
    Object.assign(this.host.style, {
      all: 'initial',
      position: 'fixed',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '2147483647',
    })
    this.root = this.host.attachShadow({ mode: 'open' })

    const style = document.createElement('style')
    style.textContent = LENS_STYLES

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('width', '0')
    svg.setAttribute('height', '0')
    svg.style.position = 'absolute'
    svg.innerHTML = `
      <defs>
        <filter id="glass-distortion" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.008 0.008" numOctaves="2" seed="3" result="noise" />
          <feGaussianBlur in="noise" stdDeviation="0.5" result="softNoise" />
          <feDisplacementMap in="SourceGraphic" in2="softNoise" scale="12" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
    `

    // Thin outline only — no blur/frost over original text
    this.ring = document.createElement('div')
    this.ring.className = 'source-outline'
    this.ring.style.display = 'none'

    this.panel = document.createElement('div')
    this.panel.className = 'liquidGlass-wrapper panel'
    this.panel.style.display = 'none'

    const effect = document.createElement('div')
    effect.className = 'liquidGlass-effect'
    const tint = document.createElement('div')
    tint.className = 'liquidGlass-tint'
    const shine = document.createElement('div')
    shine.className = 'liquidGlass-shine'

    this.textLayer = document.createElement('div')
    this.textLayer.className = 'liquidGlass-text'

    this.sourceLabel = document.createElement('div')
    this.sourceLabel.className = 'label label-source'
    this.sourceLabel.textContent = this.sourceLangLabel

    this.sourceBody = document.createElement('div')
    this.sourceBody.className = 'body body-source'

    this.divider = document.createElement('div')
    this.divider.className = 'divider'

    this.zhLabel = document.createElement('div')
    this.zhLabel.className = 'label label-target'
    this.zhLabel.textContent = this.targetLangLabel

    this.body = document.createElement('div')
    this.body.className = 'body body-zh'

    this.hint = document.createElement('div')
    this.hint.className = 'hint'

    this.toolbar = document.createElement('div')
    this.toolbar.className = 'toolbar'
    this.starBtn = LensOverlay.iconButton('star', '收藏到生词本')
    this.starBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.starHandler?.()
    })
    this.speakSourceBtn = LensOverlay.iconButton('speak', '朗读原文')
    this.speakSourceBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.speakHandler?.('source')
    })
    this.speakTargetBtn = LensOverlay.iconButton('speak', '朗读译文')
    this.speakTargetBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.speakHandler?.('target')
    })
    this.toolbar.append(this.starBtn, this.speakSourceBtn, this.speakTargetBtn)

    this.dictCard = document.createElement('div')
    this.dictCard.className = 'dict-card'

    this.actionRow = document.createElement('div')
    this.actionRow.className = 'action-row'
    this.actionBtn = document.createElement('button')
    this.actionBtn.type = 'button'
    this.actionBtn.className = 'action-btn'
    this.actionBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.actionHandler?.()
    })
    this.actionRow.append(this.actionBtn)

    this.textLayer.append(
      this.toolbar,
      this.sourceLabel,
      this.sourceBody,
      this.divider,
      this.zhLabel,
      this.body,
      this.dictCard,
      this.actionRow,
      this.hint,
    )
    this.panel.append(effect, tint, shine, this.textLayer)
    this.root.append(style, svg, this.ring, this.panel)
    this.applyWidth()
  }

  private applyWidth(): void {
    this.panel.style.width = `${this.widthPx}px`
    this.panel.style.maxWidth = `${this.widthPx}px`
  }

  private static iconButton(icon: 'star' | 'speak', title: string): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `icon-btn icon-${icon}`
    button.title = title
    button.setAttribute('aria-label', title)
    button.textContent = icon === 'star' ? '☆' : '🔊'
    return button
  }

  /** Controller hooks — rebound per state, so they always close over fresh data. */
  onAction(handler: (() => void) | null): void {
    this.actionHandler = handler
  }

  onStar(handler: (() => void) | null): void {
    this.starHandler = handler
  }

  onSpeak(handler: ((which: 'source' | 'target') => void) | null): void {
    this.speakHandler = handler
  }

  /** Mark the star when the current content is already in the notebook. */
  setStarActive(active: boolean): void {
    this.starBtn.textContent = active ? '★' : '☆'
    this.starBtn.classList.toggle('is-active', active)
  }

  mount(): void {
    if (!this.host.isConnected) document.documentElement.appendChild(this.host)
  }


  setWidth(widthPx: number): void {
    this.widthPx = Math.max(280, widthPx)
    this.applyWidth()
  }

  /** Update source/target badges for the active language pair. */
  setLanguageLabels(sourceLabel: string, targetLabel: string): void {
    this.sourceLangLabel = sourceLabel || '源语言'
    this.targetLangLabel = targetLabel || '译文'
    this.sourceLabel.textContent = this.sourceLangLabel
    this.zhLabel.textContent = this.targetLangLabel
  }

  /**
   * Scale the lens body text off the shared page-translation font-size setting so
   * the lens and full-page modes stay visually consistent. The offsets reproduce
   * the original 16.5px / 14.5px look at the default 14px setting.
   */
  setFontSize(fontSizePx: number): void {
    const base = Math.max(10, Math.min(28, fontSizePx))
    this.host.style.setProperty('--lens-zh-size', `${base + 2.5}px`)
    this.host.style.setProperty('--lens-en-size', `${base + 0.5}px`)
  }

  setFontFamily(fontFamily: 'system' | 'sans' | 'serif' | 'mono'): void {
    const stack = {
      system: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
      sans: 'Inter, ui-sans-serif, system-ui, sans-serif',
      serif: "Georgia, 'Times New Roman', serif",
      mono: "'SFMono-Regular', Consolas, 'Liberation Mono', monospace",
    }[fontFamily]
    this.host.style.setProperty('--lens-font-family', stack)
  }

  setAppearance(settings: LensAppearance): void {
    const prefersDark =
      typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
    const defaultTarget = prefersDark ? 'rgba(242, 244, 247, 0.96)' : 'rgba(20, 24, 32, 0.94)'
    this.host.style.setProperty(
      '--lens-target-color',
      settings.pageTranslationUseCustomColor ? settings.pageTranslationTextColor : defaultTarget,
    )
    this.host.style.setProperty(
      '--lens-target-background',
      settings.pageTranslationUseBackground ? settings.pageTranslationBackgroundColor : 'transparent',
    )
    this.host.style.setProperty('--lens-target-padding', settings.pageTranslationUseBackground ? '6px 8px' : '0')
    this.host.style.setProperty('--lens-target-radius', settings.pageTranslationUseBackground ? '4px' : '0')
    this.host.style.setProperty('--lens-target-weight', settings.pageTranslationBold ? '700' : '520')
    this.host.style.setProperty('--lens-target-style', settings.pageTranslationItalic ? 'italic' : 'normal')
    this.host.style.setProperty(
      '--lens-target-decoration',
      settings.pageTranslationUnderline ? 'underline' : 'none',
    )
  }

  /** Render one state, then place the selectable panel outside the highlighted source. */
  showAt(
    clientX: number,
    clientY: number,
    state: Exclude<LensViewState, { kind: 'hidden' }>,
  ): void {
    this.mount()
    this.panel.style.display = 'flex'
    this.panel.classList.add('is-visible')
    this.body.classList.remove('muted', 'pending-anim')
    this.sourceBody.classList.remove('muted')

    const isDict = state.kind === 'dict'
    const isEditable = state.kind === 'editable'
    const sourceText =
      'sourceText' in state && state.sourceText ? state.sourceText : ''
    const translationText =
      state.kind === 'ready'
        ? state.text
        : isEditable && state.status === 'ready'
          ? state.translation
          : null

    // Bilingual sections
    const showSource = Boolean(sourceText) && !isDict
    this.sourceLabel.hidden = !showSource
    this.sourceBody.hidden = !showSource
    this.divider.hidden = !showSource
    this.zhLabel.hidden =
      isDict ||
      state.kind === 'empty' ||
      state.kind === 'target-language' ||
      state.kind === 'unconfigured'

    if (showSource) {
      this.sourceBody.textContent = sourceText
    } else {
      this.sourceBody.textContent = ''
    }

    this.dictCard.hidden = !isDict
    if (isDict) this.renderDictCard(state.entry)

    this.actionRow.hidden = !(
      isEditable &&
      state.status === 'ready' &&
      state.writable &&
      state.translation
    )

    switch (state.kind) {
      case 'ready':
        this.zhLabel.textContent = this.targetLangLabel
        this.body.textContent = state.text
        break
      case 'pending':
        this.zhLabel.textContent = this.targetLangLabel
        this.body.classList.add('muted', 'pending-anim')
        this.body.textContent = '翻译中…'
        break
      case 'empty':
        this.sourceLabel.hidden = true
        this.sourceBody.hidden = true
        this.divider.hidden = true
        this.zhLabel.hidden = true
        this.body.classList.add('muted')
        this.body.textContent = '此处无可译文本（请移到文字上）'
        break
      case 'target-language':
        this.sourceLabel.hidden = true
        this.sourceBody.hidden = true
        this.divider.hidden = true
        this.zhLabel.hidden = true
        this.body.classList.add('muted')
        this.body.textContent = '此段已是目标语言'
        break
      case 'error':
        this.zhLabel.textContent = this.targetLangLabel
        this.body.classList.add('muted')
        this.body.textContent = state.message
        break
      case 'unconfigured':
        this.sourceLabel.hidden = true
        this.sourceBody.hidden = true
        this.divider.hidden = true
        this.zhLabel.hidden = true
        this.body.classList.add('muted')
        this.body.textContent = '翻译引擎未就绪，请下载语言包或配置外部 LLM'
        break
      case 'editable':
        this.zhLabel.textContent = '回译'
        if (state.status === 'pending') {
          this.body.classList.add('muted', 'pending-anim')
          this.body.textContent = '回译中…'
        } else if (state.status === 'error') {
          this.body.classList.add('muted')
          this.body.textContent = state.error ?? '回译失败'
        } else {
          this.body.textContent = state.translation ?? ''
        }
        break
      case 'dict':
        this.body.textContent = ''
        break
    }

    this.hint.textContent = isEditable
      ? '「替换为译文」会改写输入框全部内容 · Esc 关闭'
      : '可选择文本复制 · Esc 关闭'

    // Toolbar: star needs a translation; source speak needs source text.
    this.starBtn.hidden = !(
      state.kind === 'ready' ||
      isDict ||
      (isEditable && state.status === 'ready')
    )
    this.speakSourceBtn.hidden = !sourceText
    this.speakTargetBtn.hidden = !translationText
    this.toolbar.hidden =
      this.starBtn.hidden && this.speakSourceBtn.hidden && this.speakTargetBtn.hidden

    const sourceRect =
      'sourceRect' in state && state.sourceRect ? state.sourceRect : null
    if (sourceRect) {
      // Content changes (pending → ready with a longer translation) change the
      // panel height, so the placement clamp must re-run even when the source
      // rect is unchanged — otherwise a tall panel can overflow the viewport.
      const contentKey = `${state.kind}:${sourceText.length}:${
        'text' in state && state.text ? state.text.length : 0
      }:${'message' in state && state.message ? state.message.length : 0}:${
        'translation' in state && state.translation ? state.translation.length : 0
      }:${
        'entry' in state
          ? state.entry.senses.length * 100 + state.entry.examples.length * 10
          : 0
      }`
      const nextKey = `${Math.round(sourceRect.left)}|${Math.round(sourceRect.top)}|${Math.round(sourceRect.right)}|${Math.round(sourceRect.bottom)}|${contentKey}`
      if (nextKey !== this.lastSourceKey) {
        this.lastSourceKey = nextKey
        this.placePanel(clientX, clientY, sourceRect)
      }
    } else {
      this.lastSourceKey = ''
      this.placePanel(clientX, clientY, null)
    }
  }

  private renderDictCard(entry: DictionaryEntry): void {
    const title = document.createElement('div')
    title.className = 'dict-word'
    title.textContent = entry.word
    const parts: HTMLElement[] = [title]
    if (entry.phonetic) {
      const phonetic = document.createElement('span')
      phonetic.className = 'dict-phonetic'
      phonetic.textContent = entry.phonetic
      title.append(phonetic)
    }
    const senses = document.createElement('ol')
    senses.className = 'dict-senses'
    for (const sense of entry.senses) {
      const item = document.createElement('li')
      if (sense.pos) {
        const pos = document.createElement('span')
        pos.className = 'dict-pos'
        pos.textContent = sense.pos
        item.append(pos)
      }
      item.append(document.createTextNode(sense.gloss))
      senses.append(item)
    }
    parts.push(senses)
    if (entry.examples.length) {
      const examples = document.createElement('div')
      examples.className = 'dict-examples'
      for (const example of entry.examples) {
        const row = document.createElement('div')
        row.className = 'dict-example'
        const source = document.createElement('div')
        source.className = 'dict-example-source'
        source.textContent = example.source
        const translation = document.createElement('div')
        translation.className = 'dict-example-translation'
        translation.textContent = example.translation
        row.append(source, translation)
        examples.append(row)
      }
      parts.push(examples)
    }
    this.dictCard.replaceChildren(...parts)
  }


  /**
   * Place glass panel **outside** the source rect so original text stays fully readable.
   * Prefer below → above → right → left of source; fall back to cursor offset.
   */
  private placePanel(clientX: number, clientY: number, sourceRect: DOMRect | null): void {
    const gap = 12
    const vw = window.innerWidth
    const vh = window.innerHeight
    // Measure after content set
    const pr = this.panel.getBoundingClientRect()
    const pw = Math.max(pr.width, this.widthPx)
    const ph = Math.max(pr.height, 80)

    let left = clientX + 16
    let top = clientY + 16

    if (sourceRect && sourceRect.width > 0) {
      const candidates: { left: number; top: number; score: number }[] = []

      // Below source
      candidates.push({
        left: clamp(sourceRect.left, 8, vw - pw - 8),
        top: sourceRect.bottom + gap,
        score: 4,
      })
      // Above source
      candidates.push({
        left: clamp(sourceRect.left, 8, vw - pw - 8),
        top: sourceRect.top - ph - gap,
        score: 3,
      })
      // Right of source
      candidates.push({
        left: sourceRect.right + gap,
        top: clamp(sourceRect.top, 8, vh - ph - 8),
        score: 2,
      })
      // Left of source
      candidates.push({
        left: sourceRect.left - pw - gap,
        top: clamp(sourceRect.top, 8, vh - ph - 8),
        score: 1,
      })

      let best: { left: number; top: number; score: number } | null = null
      for (const c of candidates) {
        const fits =
          c.left >= 8 &&
          c.top >= 8 &&
          c.left + pw <= vw - 8 &&
          c.top + ph <= vh - 8
        if (!fits) continue
        // Prefer not overlapping source
        const panelBox = {
          left: c.left,
          top: c.top,
          right: c.left + pw,
          bottom: c.top + ph,
        }
        const overlaps = !(
          panelBox.right < sourceRect.left - 4 ||
          panelBox.left > sourceRect.right + 4 ||
          panelBox.bottom < sourceRect.top - 4 ||
          panelBox.top > sourceRect.bottom + 4
        )
        const score = c.score + (overlaps ? -10 : 0)
        if (!best || score > best.score) best = { ...c, score }
      }

      if (best) {
        left = best.left
        top = best.top
      } else {
        // Clamp cursor-based fallback
        left = clamp(clientX + 16, 8, vw - pw - 8)
        top = clamp(clientY + 16, 8, vh - ph - 8)
        // If still overlaps source, force below viewport mid
        if (sourceRect) {
          top = clamp(sourceRect.bottom + gap, 8, vh - ph - 8)
        }
      }
    } else {
      left = clamp(left, 8, vw - pw - 8)
      top = clamp(top, 8, vh - ph - 8)
    }

    this.panel.style.left = `${left}px`
    this.panel.style.top = `${top}px`
  }

  hide(): void {
    this.panel.style.display = 'none'
    this.panel.classList.remove('is-visible')
    this.lastSourceKey = ''
    this.clearHighlight()
  }

  getHost(): HTMLDivElement {
    return this.host
  }

  highlight(el: Element | null): void {
    if (this.highlightEl === el) {
      if (el) this.positionRing(el)
      return
    }
    this.highlightEl = el
    if (!el) {
      this.ring.style.display = 'none'
      return
    }
    this.positionRing(el)
  }

  /** Re-place the ring on the currently highlighted element (e.g. after scroll). */
  reposition(): void {
    if (this.highlightEl) this.positionRing(this.highlightEl)
  }

  private positionRing(el: Element): void {
    if (!el.isConnected) {
      this.ring.style.display = 'none'
      return
    }
    const r = el.getBoundingClientRect()
    const offscreen =
      r.bottom <= 0 ||
      r.right <= 0 ||
      r.top >= window.innerHeight ||
      r.left >= window.innerWidth
    if (r.width < 1 || r.height < 1 || offscreen) {
      this.ring.style.display = 'none'
      return
    }
    const pad = 3
    this.ring.style.display = 'block'
    this.ring.style.left = `${r.left - pad}px`
    this.ring.style.top = `${r.top - pad}px`
    this.ring.style.width = `${r.width + pad * 2}px`
    this.ring.style.height = `${r.height + pad * 2}px`
  }

  private clearHighlight(): void {
    this.highlightEl = null
    this.ring.style.display = 'none'
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

const LENS_STYLES = `
  :host, * { box-sizing: border-box; }

  .liquidGlass-wrapper {
    position: fixed;
    display: flex;
    overflow: hidden;
    padding: 0.85rem 1rem;
    border-radius: 14px;
    box-shadow:
      0 10px 32px rgba(15, 23, 42, 0.14),
      0 2px 8px rgba(15, 23, 42, 0.06),
      0 0 0 1px rgba(15, 23, 42, 0.06);
    transition: box-shadow 0.2s ease, transform 0.2s ease;
    font: 16px/1.55 var(--lens-font-family, Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, system-ui, sans-serif);
    -webkit-font-smoothing: antialiased;
    color: rgba(20, 24, 32, 0.94);
  }

  .liquidGlass-wrapper.is-visible {
    animation: glassIn 0.28s cubic-bezier(0.2, 0.8, 0.2, 1) both;
  }

  @keyframes glassIn {
    from { opacity: 0; transform: scale(0.96) translateY(4px); }
    to { opacity: 1; transform: scale(1) translateY(0); }
  }

  .liquidGlass-effect {
    position: absolute;
    z-index: 0;
    inset: 0;
    border-radius: inherit;
    backdrop-filter: blur(16px) saturate(140%);
    -webkit-backdrop-filter: blur(16px) saturate(140%);
    isolation: isolate;
  }

  .liquidGlass-tint {
    position: absolute;
    z-index: 1;
    inset: 0;
    border-radius: inherit;
    background: rgba(255, 255, 255, 0.94);
  }

  .liquidGlass-shine {
    position: absolute;
    z-index: 2;
    inset: 0;
    border-radius: inherit;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.7);
    pointer-events: none;
  }

  .liquidGlass-text {
    position: relative;
    z-index: 3;
    width: 100%;
    min-width: 0;
  }

  .panel {
    flex-direction: column;
    max-height: min(440px, 58vh);
    background: transparent;
    pointer-events: auto;
    user-select: text;
  }

  .panel .body,
  .panel .hint {
    cursor: text;
  }

  .panel .liquidGlass-text {
    overflow: auto;
    max-height: min(420px, 54vh);
  }

  .label {
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: rgba(91, 100, 114, 0.95);
    margin-bottom: 4px;
  }

  .label-target {
    margin-top: 2px;
  }

  .divider {
    height: 1px;
    margin: 10px 0;
    background: rgba(15, 23, 42, 0.08);
  }

  .body {
    white-space: pre-wrap;
    word-break: break-word;
    font-size: var(--lens-zh-size, 16.5px);
    line-height: 1.55;
    color: rgba(20, 24, 32, 0.94);
    font-weight: 520;
  }

  .body-source {
    font-size: var(--lens-en-size, 14.5px);
    line-height: 1.5;
    color: rgba(91, 100, 114, 0.95);
    font-weight: 450;
  }

  .body-zh,
  .body-target {
    font-size: var(--lens-zh-size, 16.5px);
    color: var(--lens-target-color, rgba(20, 24, 32, 0.94));
    background: var(--lens-target-background, transparent);
    padding: var(--lens-target-padding, 0);
    border-radius: var(--lens-target-radius, 0);
    font-weight: var(--lens-target-weight, 520);
    font-style: var(--lens-target-style, normal);
    text-decoration: var(--lens-target-decoration, none);
  }

  .body.muted {
    color: rgba(91, 100, 114, 0.95);
    font-weight: 400;
  }

  .hint {
    margin-top: 10px;
    font-size: 11.5px;
    color: rgba(139, 147, 160, 0.98);
    line-height: 1.4;
  }

  .toolbar {
    position: absolute;
    top: 6px;
    right: 8px;
    display: flex;
    gap: 2px;
    z-index: 4;
  }

  .icon-btn {
    appearance: none;
    border: 0;
    border-radius: 6px;
    background: transparent;
    padding: 3px 5px;
    font-size: 13px;
    line-height: 1;
    color: rgba(91, 100, 114, 0.95);
    cursor: pointer;
  }
  .icon-btn:hover { background: rgba(15, 23, 42, 0.07); }
  .icon-btn.is-active { color: #d97706; }

  .action-row {
    margin-top: 10px;
    display: flex;
    justify-content: flex-end;
  }

  .action-btn {
    appearance: none;
    border: 0;
    border-radius: 8px;
    background: #2563eb;
    color: #fff;
    font-size: 12.5px;
    font-weight: 600;
    padding: 7px 12px;
    cursor: pointer;
  }
  .action-btn:hover { background: #1d4ed8; }

  .dict-card {
    min-width: 0;
  }
  .dict-word {
    font-size: var(--lens-zh-size, 17px);
    font-weight: 700;
    color: rgba(20, 24, 32, 0.96);
    margin-bottom: 6px;
  }
  .dict-phonetic {
    margin-left: 8px;
    font-size: 12px;
    font-weight: 400;
    color: rgba(91, 100, 114, 0.95);
  }
  .dict-senses {
    margin: 0 0 6px;
    padding-left: 20px;
    font-size: 13.5px;
    line-height: 1.55;
  }
  .dict-senses li { margin-bottom: 2px; }
  .dict-pos {
    display: inline-block;
    margin-right: 6px;
    padding: 0 5px;
    border-radius: 4px;
    background: rgba(37, 99, 235, 0.1);
    color: #1d4ed8;
    font-size: 10.5px;
    font-weight: 700;
    font-style: italic;
  }
  .dict-examples {
    margin-top: 8px;
    border-top: 1px solid rgba(15, 23, 42, 0.08);
    padding-top: 8px;
  }
  .dict-example { margin-bottom: 6px; }
  .dict-example-source {
    font-size: 12.5px;
    color: rgba(20, 24, 32, 0.94);
  }
  .dict-example-translation {
    font-size: 12px;
    color: rgba(91, 100, 114, 0.95);
  }

  .source-outline {
    position: fixed;
    pointer-events: none;
    border-radius: 6px;
    border: 1.5px solid rgba(23, 105, 224, 0.55);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.45);
    background: transparent;
  }

  @keyframes lens-pulse {
    0%, 100% { opacity: 0.55; }
    50% { opacity: 1; }
  }

  .pending-anim {
    animation: lens-pulse 1.1s ease-in-out infinite;
  }

  @media (prefers-color-scheme: dark) {
    .liquidGlass-wrapper {
      color: rgba(242, 244, 247, 0.96);
      box-shadow:
        0 12px 36px rgba(0, 0, 0, 0.45),
        0 0 0 1px rgba(255, 255, 255, 0.08);
    }
    .liquidGlass-tint {
      background: rgba(24, 27, 33, 0.94);
    }
    .liquidGlass-shine {
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);
    }
    .label { color: rgba(168, 176, 189, 0.95); }
    .divider { background: rgba(255, 255, 255, 0.08); }
    .body { color: rgba(242, 244, 247, 0.96); }
    .body-source { color: rgba(168, 176, 189, 0.95); }
    .body-zh,
    .body-target {
      color: var(--lens-target-color, rgba(242, 244, 247, 0.96));
    }
    .body.muted { color: rgba(168, 176, 189, 0.9); }
    .hint { color: rgba(123, 132, 148, 0.98); }
    .icon-btn { color: rgba(168, 176, 189, 0.95); }
    .icon-btn:hover { background: rgba(255, 255, 255, 0.1); }
    .dict-word { color: rgba(242, 244, 247, 0.96); }
    .dict-phonetic { color: rgba(168, 176, 189, 0.95); }
    .dict-example-source { color: rgba(242, 244, 247, 0.96); }
    .dict-example-translation { color: rgba(168, 176, 189, 0.95); }
    .dict-examples { border-top-color: rgba(255, 255, 255, 0.08); }
    .source-outline {
      border-color: rgba(77, 142, 240, 0.7);
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .liquidGlass-wrapper.is-visible { animation: none; }
    .pending-anim { animation: none; }
  }
`

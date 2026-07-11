export type LensViewState =
  | { kind: 'hidden' }
  | { kind: 'ready'; text: string; stickyHint?: boolean }
  | { kind: 'pending'; stickyHint?: boolean }
  | { kind: 'empty'; stickyHint?: boolean }
  | { kind: 'error'; message: string; stickyHint?: boolean }
  | { kind: 'unconfigured'; stickyHint?: boolean }

/**
 * Rectangular lens with Apple-style liquid glass layers
 * (wrapper / effect / tint / shine / text) + SVG turbulence distortion.
 */
export class LensOverlay {
  private host: HTMLDivElement
  private root: ShadowRoot
  private panel: HTMLDivElement
  private textLayer: HTMLDivElement
  private label: HTMLDivElement
  private body: HTMLDivElement
  private hint: HTMLDivElement
  private ring: HTMLDivElement
  private highlightEl: Element | null = null
  private widthPx: number

  constructor(widthPx = 320) {
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

    // SVG filter for liquid glass distortion (referenced by filter: url(#glass-distortion))
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

    this.ring = document.createElement('div')
    this.ring.className = 'ring liquidGlass-wrapper'

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

    this.label = document.createElement('div')
    this.label.className = 'label'
    this.label.textContent = '中文'

    this.body = document.createElement('div')
    this.body.className = 'body'

    this.hint = document.createElement('div')
    this.hint.className = 'hint'

    this.textLayer.append(this.label, this.body, this.hint)
    this.panel.append(effect, tint, shine, this.textLayer)

    // Ring layers (highlight around source block)
    const rEffect = document.createElement('div')
    rEffect.className = 'liquidGlass-effect'
    const rTint = document.createElement('div')
    rTint.className = 'liquidGlass-tint ring-tint'
    const rShine = document.createElement('div')
    rShine.className = 'liquidGlass-shine'
    this.ring.append(rEffect, rTint, rShine)
    this.ring.style.display = 'none'

    this.root.append(style, svg, this.ring, this.panel)
    this.applyWidth()
  }

  private applyWidth(): void {
    this.panel.style.width = `${this.widthPx}px`
    this.panel.style.maxWidth = `${this.widthPx}px`
  }

  mount(): void {
    if (!this.host.isConnected) document.documentElement.appendChild(this.host)
  }

  unmount(): void {
    this.clearHighlight()
    this.host.remove()
  }

  setWidth(widthPx: number): void {
    this.widthPx = widthPx
    this.applyWidth()
  }

  showAt(
    clientX: number,
    clientY: number,
    state: Exclude<LensViewState, { kind: 'hidden' }>,
  ): void {
    this.mount()
    this.panel.style.display = 'flex'
    this.panel.classList.add('is-visible')
    this.body.classList.remove('muted', 'pending-anim')

    const sticky = 'stickyHint' in state ? Boolean(state.stickyHint) : false

    switch (state.kind) {
      case 'ready':
        this.body.textContent = state.text
        break
      case 'pending':
        this.body.classList.add('muted', 'pending-anim')
        this.body.textContent = '翻译中…'
        break
      case 'empty':
        this.body.classList.add('muted')
        this.body.textContent = '此处无可译文本（请移到段落上）'
        break
      case 'error':
        this.body.classList.add('muted')
        this.body.textContent = state.message
        break
      case 'unconfigured':
        this.body.classList.add('muted')
        this.body.textContent = '请先在扩展「选项」中配置 API'
        break
    }

    this.hint.textContent = sticky
      ? '已固定 · 再按快捷键或 Esc 关闭'
      : '按住快捷键保持 · 短按可固定'

    const offset = 16
    const rect = this.panel.getBoundingClientRect()
    let left = clientX + offset
    let top = clientY + offset
    const vw = window.innerWidth
    const vh = window.innerHeight
    if (left + Math.max(rect.width, this.widthPx) > vw - 8) {
      left = clientX - Math.max(rect.width, this.widthPx) - offset
    }
    if (top + rect.height > vh - 8) top = clientY - rect.height - offset
    left = Math.max(8, Math.min(left, vw - this.widthPx - 8))
    top = Math.max(8, top)
    this.panel.style.left = `${left}px`
    this.panel.style.top = `${top}px`
  }

  hide(): void {
    this.panel.style.display = 'none'
    this.panel.classList.remove('is-visible')
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

  private positionRing(el: Element): void {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) {
      this.ring.style.display = 'none'
      return
    }
    const pad = 4
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

const LENS_STYLES = `
  :host, * { box-sizing: border-box; }

  .liquidGlass-wrapper {
    position: fixed;
    display: flex;
    overflow: hidden;
    padding: 0.65rem 0.85rem;
    border-radius: 1.35rem;
    box-shadow:
      0 6px 6px rgba(0, 0, 0, 0.12),
      0 0 24px rgba(0, 0, 0, 0.08),
      0 12px 40px rgba(0, 0, 0, 0.1);
    transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    color: rgba(0, 0, 0, 0.88);
  }

  .liquidGlass-wrapper.is-visible {
    animation: glassIn 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275) both;
  }

  @keyframes glassIn {
    from { opacity: 0; transform: scale(0.94) translateY(6px); }
    to { opacity: 1; transform: scale(1) translateY(0); }
  }

  .liquidGlass-effect {
    position: absolute;
    z-index: 0;
    inset: 0;
    border-radius: inherit;
    backdrop-filter: blur(3px) saturate(160%);
    -webkit-backdrop-filter: blur(3px) saturate(160%);
    filter: url(#glass-distortion);
    isolation: isolate;
  }

  .liquidGlass-tint {
    position: absolute;
    z-index: 1;
    inset: 0;
    border-radius: inherit;
    background: rgba(255, 255, 255, 0.32);
    background-image:
      linear-gradient(
        145deg,
        rgba(255, 255, 255, 0.55) 0%,
        rgba(255, 255, 255, 0.18) 42%,
        rgba(200, 220, 255, 0.12) 100%
      );
  }

  .liquidGlass-shine {
    position: absolute;
    z-index: 2;
    inset: 0;
    border-radius: inherit;
    box-shadow:
      inset 2px 2px 1px 0 rgba(255, 255, 255, 0.55),
      inset -1px -1px 1px 1px rgba(255, 255, 255, 0.35),
      inset 0 0 0 0.5px rgba(255, 255, 255, 0.4);
    pointer-events: none;
  }

  .liquidGlass-text {
    position: relative;
    z-index: 3;
    width: 100%;
    min-width: 0;
    transition: transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
  }

  .panel {
    flex-direction: column;
    max-height: min(340px, 52vh);
  }

  .panel .liquidGlass-text {
    overflow: auto;
    max-height: min(320px, 48vh);
  }

  .label {
    font-size: 11px;
    font-weight: 650;
    letter-spacing: 0.04em;
    color: rgba(0, 0, 0, 0.45);
    margin-bottom: 6px;
  }

  .body {
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 13.5px;
    line-height: 1.5;
    color: rgba(0, 0, 0, 0.88);
    font-weight: 500;
  }

  .body.muted {
    color: rgba(0, 0, 0, 0.48);
    font-weight: 400;
  }

  .hint {
    margin-top: 8px;
    font-size: 10.5px;
    color: rgba(0, 0, 0, 0.38);
    line-height: 1.35;
  }

  .ring {
    padding: 0;
    border-radius: 0.85rem;
    box-shadow:
      0 4px 16px rgba(0, 0, 0, 0.1),
      0 0 0 0.5px rgba(255, 255, 255, 0.5);
    pointer-events: none;
  }

  .ring .liquidGlass-effect {
    backdrop-filter: blur(2px);
    -webkit-backdrop-filter: blur(2px);
  }

  .ring-tint {
    background: rgba(255, 255, 255, 0.12) !important;
    background-image: none !important;
    box-shadow: inset 0 0 0 1.5px rgba(255, 255, 255, 0.55);
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
      color: rgba(255, 255, 255, 0.92);
      box-shadow:
        0 6px 6px rgba(0, 0, 0, 0.35),
        0 0 24px rgba(0, 0, 0, 0.25),
        0 12px 40px rgba(0, 0, 0, 0.3);
    }
    .liquidGlass-tint {
      background: rgba(30, 30, 35, 0.4);
      background-image:
        linear-gradient(
          145deg,
          rgba(255, 255, 255, 0.14) 0%,
          rgba(255, 255, 255, 0.04) 45%,
          rgba(120, 160, 255, 0.08) 100%
        );
    }
    .liquidGlass-shine {
      box-shadow:
        inset 2px 2px 1px 0 rgba(255, 255, 255, 0.22),
        inset -1px -1px 1px 1px rgba(255, 255, 255, 0.1),
        inset 0 0 0 0.5px rgba(255, 255, 255, 0.12);
    }
    .label { color: rgba(255, 255, 255, 0.5); }
    .body { color: rgba(255, 255, 255, 0.92); }
    .body.muted { color: rgba(255, 255, 255, 0.5); }
    .hint { color: rgba(255, 255, 255, 0.38); }
    .ring-tint {
      background: rgba(255, 255, 255, 0.06) !important;
      box-shadow: inset 0 0 0 1.5px rgba(255, 255, 255, 0.28);
    }
  }
`

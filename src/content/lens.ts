export type LensViewState =
  | { kind: 'hidden' }
  | { kind: 'ready'; text: string }
  | { kind: 'pending' }
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | { kind: 'unconfigured' }

export class LensOverlay {
  private host: HTMLDivElement
  private root: ShadowRoot
  private panel: HTMLDivElement
  private label: HTMLDivElement
  private body: HTMLDivElement
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
    style.textContent = `
      .panel {
        position: fixed;
        max-width: ${this.widthPx}px;
        width: ${this.widthPx}px;
        max-height: 240px;
        overflow: auto;
        box-sizing: border-box;
        padding: 10px 12px;
        border-radius: 10px;
        border: 2px solid #38bdf8;
        background: rgba(15, 23, 42, 0.94);
        color: #e0f2fe;
        font: 13px/1.45 system-ui, -apple-system, sans-serif;
        box-shadow: 0 12px 40px rgba(0,0,0,.45);
        display: none;
      }
      .label {
        font-size: 10px;
        letter-spacing: 0.04em;
        color: #38bdf8;
        margin-bottom: 6px;
      }
      .body { white-space: pre-wrap; word-break: break-word; }
      .muted { color: #94a3b8; }
    `
    this.panel = document.createElement('div')
    this.panel.className = 'panel'
    this.label = document.createElement('div')
    this.label.className = 'label'
    this.label.textContent = 'LENS · ZH'
    this.body = document.createElement('div')
    this.body.className = 'body'
    this.panel.append(this.label, this.body)
    this.root.append(style, this.panel)
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
    this.panel.style.width = `${widthPx}px`
    this.panel.style.maxWidth = `${widthPx}px`
  }

  showAt(
    clientX: number,
    clientY: number,
    state: Exclude<LensViewState, { kind: 'hidden' }>,
  ): void {
    this.mount()
    this.panel.style.display = 'block'
    this.body.classList.remove('muted')

    // Only textContent for translations — never innerHTML
    switch (state.kind) {
      case 'ready':
        this.body.textContent = state.text
        break
      case 'pending':
        this.body.classList.add('muted')
        this.body.textContent = '翻译中…'
        break
      case 'empty':
        this.body.classList.add('muted')
        this.body.textContent = '此处无可译文本'
        break
      case 'error':
        this.body.classList.add('muted')
        this.body.textContent = state.message
        break
      case 'unconfigured':
        this.body.classList.add('muted')
        this.body.textContent = '请先配置 API'
        break
    }

    const offset = 16
    const rect = this.panel.getBoundingClientRect()
    let left = clientX + offset
    let top = clientY + offset
    const vw = window.innerWidth
    const vh = window.innerHeight
    if (left + rect.width > vw - 8) left = clientX - rect.width - offset
    if (top + rect.height > vh - 8) top = clientY - rect.height - offset
    left = Math.max(8, left)
    top = Math.max(8, top)
    this.panel.style.left = `${left}px`
    this.panel.style.top = `${top}px`
  }

  hide(): void {
    this.panel.style.display = 'none'
    this.clearHighlight()
  }

  getHost(): HTMLDivElement {
    return this.host
  }

  highlight(el: Element | null): void {
    if (this.highlightEl === el) return
    this.clearHighlight()
    this.highlightEl = el
    if (el instanceof HTMLElement) {
      el.dataset.lensHl = '1'
      el.style.outline = '2px solid #38bdf8'
      el.style.outlineOffset = '2px'
    }
  }

  private clearHighlight(): void {
    if (this.highlightEl instanceof HTMLElement) {
      elClear(this.highlightEl)
    }
    this.highlightEl = null
  }
}

function elClear(el: HTMLElement): void {
  el.style.outline = ''
  el.style.outlineOffset = ''
  delete el.dataset.lensHl
}

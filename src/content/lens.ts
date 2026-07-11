export type LensViewState =
  | { kind: 'hidden' }
  | { kind: 'ready'; text: string; stickyHint?: boolean }
  | { kind: 'pending'; stickyHint?: boolean }
  | { kind: 'empty'; stickyHint?: boolean }
  | { kind: 'error'; message: string; stickyHint?: boolean }
  | { kind: 'unconfigured'; stickyHint?: boolean }

export class LensOverlay {
  private host: HTMLDivElement
  private root: ShadowRoot
  private panel: HTMLDivElement
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
    style.textContent = `
      .panel {
        position: fixed;
        box-sizing: border-box;
        padding: 10px 12px;
        border-radius: 10px;
        border: 2px solid #38bdf8;
        background: rgba(15, 23, 42, 0.94);
        color: #e0f2fe;
        font: 13px/1.45 system-ui, -apple-system, sans-serif;
        box-shadow: 0 12px 40px rgba(0,0,0,.45);
        display: none;
        max-height: min(320px, 50vh);
        overflow: auto;
      }
      .label {
        font-size: 10px;
        letter-spacing: 0.04em;
        color: #38bdf8;
        margin-bottom: 6px;
      }
      .body { white-space: pre-wrap; word-break: break-word; }
      .muted { color: #94a3b8; }
      .hint {
        margin-top: 8px;
        font-size: 10px;
        color: #64748b;
        line-height: 1.35;
      }
      .ring {
        position: fixed;
        box-sizing: border-box;
        border: 2px solid #38bdf8;
        border-radius: 4px;
        box-shadow: 0 0 0 1px rgba(56, 189, 248, 0.25);
        pointer-events: none;
        display: none;
      }
      @keyframes lens-pulse {
        0%, 100% { opacity: 0.55; }
        50% { opacity: 1; }
      }
      .pending-anim { animation: lens-pulse 1.1s ease-in-out infinite; }
    `
    this.ring = document.createElement('div')
    this.ring.className = 'ring'
    this.panel = document.createElement('div')
    this.panel.className = 'panel'
    this.label = document.createElement('div')
    this.label.className = 'label'
    this.label.textContent = '中文'
    this.body = document.createElement('div')
    this.body.className = 'body'
    this.hint = document.createElement('div')
    this.hint.className = 'hint'
    this.panel.append(this.label, this.body, this.hint)
    this.root.append(style, this.ring, this.panel)
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
    this.panel.style.display = 'block'
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
    // Force layout so size is accurate
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
    const pad = 2
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

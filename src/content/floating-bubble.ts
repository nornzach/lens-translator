const BUBBLE_MESSAGE_TYPE = 'lens-translator-bubble-shell'

type BubbleShellMessage = {
  type: typeof BUBBLE_MESSAGE_TYPE
  action: 'pin' | 'unpin' | 'collapse'
}

/** Mounts an extension-origin control iframe in an isolated, edge-docked shell. */
export class FloatingBubbleHost {
  private readonly host: HTMLDivElement
  private readonly frame: HTMLIFrameElement
  private pinned = false
  private collapseTimer = 0
  private readonly mountObserver: MutationObserver

  constructor() {
    this.host = document.createElement('div')
    this.host.id = 'lens-translator-bubble-root'
    this.host.setAttribute('data-lens-ignore', '')
    const root = this.host.attachShadow({ mode: 'closed' })

    const style = document.createElement('style')
    style.textContent = SHELL_STYLES
    this.frame = document.createElement('iframe')
    this.frame.src = chrome.runtime.getURL('src/bubble/index.html')
    this.frame.title = 'Lens Translator 快捷控制'
    this.frame.setAttribute('allow', 'clipboard-write')
    root.append(style, this.frame)

    this.host.addEventListener('pointerenter', () => this.expand())
    this.host.addEventListener('pointerleave', () => this.scheduleCollapse())
    window.addEventListener('message', this.onMessage)
    this.mountObserver = new MutationObserver(() => {
      if (!this.host.isConnected) this.mount()
    })
    this.mountObserver.observe(document.documentElement, { childList: true })
  }

  mount(): void {
    if (!this.host.isConnected) document.documentElement.append(this.host)
  }

  private expand(): void {
    window.clearTimeout(this.collapseTimer)
    this.host.dataset.expanded = 'true'
  }

  private scheduleCollapse(): void {
    if (this.pinned) return
    window.clearTimeout(this.collapseTimer)
    this.collapseTimer = window.setTimeout(() => {
      delete this.host.dataset.expanded
    }, 420)
  }

  private readonly onMessage = (event: MessageEvent<unknown>): void => {
    if (event.source !== this.frame.contentWindow || !isBubbleShellMessage(event.data)) return
    if (event.data.action === 'pin') {
      this.pinned = true
      this.expand()
      return
    }
    this.pinned = false
    if (event.data.action === 'collapse') delete this.host.dataset.expanded
    else this.scheduleCollapse()
  }
}

function isBubbleShellMessage(value: unknown): value is BubbleShellMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as { type?: unknown; action?: unknown }
  return (
    message.type === BUBBLE_MESSAGE_TYPE &&
    (message.action === 'pin' || message.action === 'unpin' || message.action === 'collapse')
  )
}

const SHELL_STYLES = `
  :host { all: initial; }
  iframe {
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
    background: transparent;
  }
  :host {
    position: fixed;
    z-index: 2147483646;
    top: clamp(88px, 42vh, calc(100vh - 88px));
    right: -13px;
    width: 62px;
    height: 62px;
    overflow: hidden;
    pointer-events: auto;
    border-radius: 22px 0 0 22px;
    filter: drop-shadow(0 10px 22px rgb(15 23 42 / 18%));
    transition:
      width 320ms cubic-bezier(.2,.8,.2,1),
      height 320ms cubic-bezier(.2,.8,.2,1),
      right 320ms cubic-bezier(.2,.8,.2,1),
      top 320ms cubic-bezier(.2,.8,.2,1),
      border-radius 320ms ease;
  }
  :host([data-expanded="true"]) {
    top: clamp(12px, calc(50vh - 325px), 32px);
    right: 12px;
    width: min(372px, calc(100vw - 24px));
    height: min(650px, calc(100vh - 24px));
    border-radius: 8px;
  }
  @media (max-width: 520px) {
    :host([data-expanded="true"]) {
      top: 8px;
      right: 8px;
      width: calc(100vw - 16px);
      height: min(650px, calc(100vh - 16px));
    }
  }
  @media (prefers-reduced-motion: reduce) {
    :host { transition-duration: 1ms; }
  }
`

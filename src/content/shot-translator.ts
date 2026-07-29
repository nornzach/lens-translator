/**
 * Region screenshot translation: full-page selection overlay, then a result
 * card showing the captured crop beside its translation.
 * Everything renders with data-lens-ignore so our own nodes never re-enter
 * extraction or mutation-observer paths.
 */

export type ShotRect = { x: number; y: number; width: number; height: number }

export type ShotTranslateResult =
  | { ok: true; translation: string; image: string }
  | { ok: false; error: string }

export type ShotTranslateFn = (
  rect: ShotRect,
  devicePixelRatio: number,
) => Promise<ShotTranslateResult>

const OVERLAY_ID = 'lens-shot-overlay'
const CARD_ID = 'lens-shot-card'
const STYLE_ID = 'lens-shot-style'
const MIN_RECT_PX = 8

const STYLES = `
#${OVERLAY_ID} {
  position: fixed !important;
  inset: 0 !important;
  z-index: 2147483647 !important;
  cursor: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'><circle cx='16' cy='16' r='8.5' fill='none' stroke='%232563eb' stroke-width='2'/><path d='M16 1v9M16 22v9M1 16h9M22 16h9' stroke='%232563eb' stroke-width='2'/><circle cx='16' cy='16' r='2' fill='%232563eb'/></svg>") 16 16, crosshair !important;
  background: rgb(15 23 42 / 18%) !important;
  user-select: none !important;
  outline: none !important;
}
#${OVERLAY_ID} .lens-shot-guide-h,
#${OVERLAY_ID} .lens-shot-guide-v {
  position: fixed !important;
  background: rgb(37 99 235 / 55%) !important;
  pointer-events: none !important;
}
#${OVERLAY_ID} .lens-shot-guide-h {
  left: 0 !important;
  right: 0 !important;
  height: 1px !important;
}
#${OVERLAY_ID} .lens-shot-guide-v {
  top: 0 !important;
  bottom: 0 !important;
  width: 1px !important;
}
#${OVERLAY_ID} .lens-shot-size {
  position: fixed !important;
  padding: 3px 8px !important;
  border-radius: 5px !important;
  background: rgb(15 23 42 / 85%) !important;
  color: #f8fafc !important;
  font: 500 12px/1.3 system-ui, sans-serif !important;
  pointer-events: none !important;
  white-space: nowrap !important;
}
#${OVERLAY_ID} .lens-shot-band {
  position: fixed !important;
  border: 1.5px solid #2563eb !important;
  background: rgb(37 99 235 / 12%) !important;
  box-shadow: 0 0 0 1px rgb(255 255 255 / 45%) !important;
  pointer-events: none !important;
}
#${OVERLAY_ID} .lens-shot-hint {
  position: fixed !important;
  top: 14px !important;
  left: 50% !important;
  transform: translateX(-50%) !important;
  padding: 7px 14px !important;
  border-radius: 7px !important;
  background: rgb(15 23 42 / 85%) !important;
  color: #f8fafc !important;
  font: 500 13px/1.4 system-ui, sans-serif !important;
  pointer-events: none !important;
}
#${CARD_ID} {
  position: fixed !important;
  z-index: 2147483647 !important;
  max-width: 380px !important;
  min-width: 260px !important;
  max-height: calc(100vh - 16px) !important;
  overflow-y: auto !important;
  border: 1px solid rgb(15 23 42 / 14%) !important;
  border-radius: 8px !important;
  background: #ffffff !important;
  box-shadow: 0 12px 32px rgb(15 23 42 / 22%) !important;
  color: #172033 !important;
  font: 400 13px/1.55 system-ui, sans-serif !important;
  overflow-x: hidden !important;
}
#${CARD_ID} .lens-shot-grip {
  display: flex !important;
  align-items: center !important;
  gap: 8px !important;
  padding: 7px 12px !important;
  background: rgb(15 23 42 / 5%) !important;
  border-bottom: 1px solid rgb(15 23 42 / 10%) !important;
  cursor: move !important;
  user-select: none !important;
  font: 600 11.5px/1 system-ui, sans-serif !important;
  color: #64748b !important;
  letter-spacing: 0.02em !important;
}
#${CARD_ID} .lens-shot-grip::before {
  content: '⠿' !important;
  font-size: 13px !important;
  color: #94a3b8 !important;
}
#${CARD_ID} .lens-shot-image {
  display: block !important;
  max-width: 100% !important;
  max-height: 180px !important;
  object-fit: contain !important;
  background: #f1f5f9 !important;
  border-bottom: 1px solid rgb(15 23 42 / 10%) !important;
}
#${CARD_ID} .lens-shot-text {
  padding: 10px 12px !important;
  white-space: pre-wrap !important;
  overflow-wrap: anywhere !important;
  max-height: 240px !important;
  overflow-y: auto !important;
}
#${CARD_ID} .lens-shot-text[data-state='pending'] {
  color: #64748b !important;
}
#${CARD_ID} .lens-shot-text[data-state='error'] {
  color: #b91c1c !important;
}
#${CARD_ID} .lens-shot-actions {
  display: flex !important;
  gap: 8px !important;
  padding: 0 12px 10px !important;
}
#${CARD_ID} button {
  font: 500 12px/1 system-ui, sans-serif !important;
  padding: 6px 10px !important;
  border: 1px solid rgb(15 23 42 / 16%) !important;
  border-radius: 6px !important;
  background: #ffffff !important;
  color: #172033 !important;
  cursor: pointer !important;
}
#${CARD_ID} button:hover {
  border-color: #2563eb !important;
}
@media (prefers-color-scheme: dark) {
  #${CARD_ID} {
    background: #1e293b !important;
    color: #f1f5f9 !important;
    border-color: rgb(255 255 255 / 16%) !important;
  }
  #${CARD_ID} button {
    background: #1e293b !important;
    color: #f1f5f9 !important;
    border-color: rgb(255 255 255 / 22%) !important;
  }
  #${CARD_ID} .lens-shot-image { background: #0f172a !important; }
  #${CARD_ID} .lens-shot-grip {
    background: rgb(255 255 255 / 7%) !important;
    color: #94a3b8 !important;
  }
}
`

export class ShotTranslator {
  private overlay: HTMLDivElement | null = null
  private card: HTMLDivElement | null = null
  private keyHandler: ((event: KeyboardEvent) => void) | null = null
  private moveHandler: ((event: MouseEvent) => void) | null = null
  private upHandler: ((event: MouseEvent) => void) | null = null
  private sessionActive = false
  private generation = 0

  constructor(
    private readonly translate: ShotTranslateFn,
    /** selecting=true while a shot session runs (selection → capture settles). */
    private readonly onSessionChange?: (selecting: boolean) => void,
  ) {}

  isSelecting(): boolean {
    return this.overlay !== null
  }

  start(): void {
    if (this.overlay) return
    this.closeCard()
    this.ensureStyles()

    const overlay = document.createElement('div')
    overlay.id = OVERLAY_ID
    overlay.setAttribute('data-lens-ignore', '')
    const hint = document.createElement('div')
    hint.className = 'lens-shot-hint'
    hint.textContent = '拖动框选要翻译的区域 · Esc 取消'
    overlay.append(hint)

    const band = document.createElement('div')
    band.className = 'lens-shot-band'
    band.hidden = true
    overlay.append(band)

    // Full-viewport crosshair guides make the pointer trivial to find.
    const guideH = document.createElement('div')
    guideH.className = 'lens-shot-guide-h'
    const guideV = document.createElement('div')
    guideV.className = 'lens-shot-guide-v'
    const size = document.createElement('div')
    size.className = 'lens-shot-size'
    size.hidden = true
    overlay.append(guideH, guideV, size)

    let origin: { x: number; y: number } | null = null

    overlay.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      origin = { x: event.clientX, y: event.clientY }
      band.hidden = false
      hint.hidden = true
      size.hidden = false
    })
    // Drag listeners live on document: releasing outside the window (or over a
    // frame) must still finish the selection instead of leaving it stuck.
    const onMove = (event: MouseEvent) => {
      guideH.style.top = `${event.clientY}px`
      guideV.style.left = `${event.clientX}px`
      if (!origin) return
      const rect = rectFrom(origin, event)
      Object.assign(band.style, {
        left: `${rect.x}px`,
        top: `${rect.y}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      })
      size.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`
      size.style.left = `${Math.min(event.clientX + 14, window.innerWidth - 90)}px`
      size.style.top = `${Math.min(event.clientY + 14, window.innerHeight - 30)}px`
    }
    const onUp = (event: MouseEvent) => {
      if (event.button !== 0 || !origin) return
      const rect = rectFrom(origin, event)
      origin = null
      this.teardownOverlay()
      if (rect.width >= MIN_RECT_PX && rect.height >= MIN_RECT_PX) {
        void this.runTranslation(rect)
      } else {
        // Click-without-drag cancels the session entirely.
        this.endSession()
      }
    }
    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('mouseup', onUp, true)
    this.moveHandler = onMove
    this.upHandler = onUp

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        this.teardownOverlay()
        this.endSession()
      }
    }
    // Capture on document; the overlay is focused at start() so key events
    // reach the top document even right after a bubble-iframe click.
    document.addEventListener('keydown', onKey, true)
    this.keyHandler = onKey

    overlay.tabIndex = -1
    this.overlay = overlay
    document.documentElement.append(overlay)
    overlay.focus()
    this.sessionActive = true
    this.onSessionChange?.(true)
  }

  /** Public cancel for the hotkey toggle path — same as pressing Esc. */
  cancel(): void {
    this.teardownOverlay()
    this.endSession()
  }

  private endSession(): void {
    if (!this.sessionActive) return
    this.sessionActive = false
    this.onSessionChange?.(false)
  }

  private teardownOverlay(): void {
    if (!this.overlay) return
    if (this.keyHandler) {
      document.removeEventListener('keydown', this.keyHandler, true)
      this.keyHandler = null
    }
    if (this.moveHandler) {
      document.removeEventListener('mousemove', this.moveHandler, true)
      this.moveHandler = null
    }
    if (this.upHandler) {
      document.removeEventListener('mouseup', this.upHandler, true)
      this.upHandler = null
    }
    this.overlay.remove()
    this.overlay = null
  }

  private async runTranslation(rect: ShotRect): Promise<void> {
    // Snapshot AFTER showCard — closeCard() inside it bumps the generation.
    const card = this.showCard(rect)
    const generation = ++this.generation
    const text = card.querySelector<HTMLElement>('.lens-shot-text')!
    text.dataset.state = 'pending'
    text.textContent = '正在识别并翻译…'

    let result: ShotTranslateResult
    try {
      result = await this.translate(rect, window.devicePixelRatio || 1)
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      // The capture has happened by now — the page's own UI may be shown again.
      this.endSession()
    }
    if (generation !== this.generation || !card.isConnected) return

    if (result.ok) {
      const img = document.createElement('img')
      img.className = 'lens-shot-image'
      img.alt = '选区截图'
      // The card grows when the image lands — re-clamp it into the viewport.
      img.addEventListener('load', () => this.clampCard(card), { once: true })
      img.src = result.image
      card.insertBefore(img, text)
      text.dataset.state = 'done'
      text.textContent = result.translation
    } else {
      text.dataset.state = 'error'
      text.textContent = result.error
    }
  }

  private showCard(rect: ShotRect): HTMLDivElement {
    this.closeCard()
    const card = document.createElement('div')
    card.id = CARD_ID
    card.setAttribute('data-lens-ignore', '')

    const grip = document.createElement('div')
    grip.className = 'lens-shot-grip'
    grip.textContent = '翻译结果 · 可拖动'
    this.makeDraggable(card, grip)

    const text = document.createElement('div')
    text.className = 'lens-shot-text'
    const actions = document.createElement('div')
    actions.className = 'lens-shot-actions'
    const copy = document.createElement('button')
    copy.textContent = '复制译文'
    const copyWithSelectionApi = (value: string): void => {
      const scratch = document.createElement('textarea')
      scratch.value = value
      scratch.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
      card.append(scratch)
      scratch.select()
      document.execCommand('copy')
      scratch.remove()
    }
    copy.addEventListener('click', () => {
      const value = text.textContent ?? ''
      const done = () => {
        copy.textContent = '已复制'
        setTimeout(() => (copy.textContent = '复制译文'), 1200)
      }
      if (navigator.clipboard?.writeText) {
        // Permissions-Policy can deny clipboard-write on https too — fall back.
        void navigator.clipboard.writeText(value).then(done, () => {
          copyWithSelectionApi(value)
          done()
        })
        return
      }
      // Plain-http origins are not secure contexts — navigator.clipboard is
      // undefined there; fall back to the selection API.
      copyWithSelectionApi(value)
      done()
    })
    const close = document.createElement('button')
    close.textContent = '关闭'
    close.addEventListener('click', () => this.closeCard())
    actions.append(copy, close)
    card.append(grip, text, actions)

    // Default below the selection; flip above when space runs out; always clamped.
    document.documentElement.append(card)
    const margin = 8
    const below = rect.y + rect.height + margin
    const top =
      below + card.getBoundingClientRect().height <= window.innerHeight - margin
        ? below
        : rect.y - card.getBoundingClientRect().height - margin
    this.positionCard(card, rect.x, top)
    this.card = card
    return card
  }

  /** Place the card with its bounds clamped inside the viewport. */
  private positionCard(card: HTMLDivElement, x: number, y: number): void {
    const margin = 8
    const maxX = Math.max(margin, window.innerWidth - card.offsetWidth - margin)
    const maxY = Math.max(margin, window.innerHeight - card.offsetHeight - margin)
    card.style.left = `${Math.min(Math.max(margin, x), maxX)}px`
    card.style.top = `${Math.min(Math.max(margin, y), maxY)}px`
  }

  private clampCard(card: HTMLDivElement): void {
    if (card.isConnected) this.positionCard(card, card.offsetLeft, card.offsetTop)
  }

  private makeDraggable(card: HTMLDivElement, grip: HTMLElement): void {
    grip.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      const offsetX = event.clientX - card.offsetLeft
      const offsetY = event.clientY - card.offsetTop
      const onMove = (ev: PointerEvent) => {
        this.positionCard(card, ev.clientX - offsetX, ev.clientY - offsetY)
      }
      const onEnd = () => {
        grip.removeEventListener('pointermove', onMove)
        grip.removeEventListener('pointerup', onEnd)
        grip.removeEventListener('pointercancel', onEnd)
      }
      grip.addEventListener('pointermove', onMove)
      grip.addEventListener('pointerup', onEnd)
      grip.addEventListener('pointercancel', onEnd)
      grip.setPointerCapture(event.pointerId)
    })
  }

  private closeCard(): void {
    this.generation++
    this.card?.remove()
    this.card = null
  }

  private ensureStyles(): void {
    if (document.getElementById(STYLE_ID)) return
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.setAttribute('data-lens-ignore', '')
    style.textContent = STYLES
    ;(document.head ?? document.documentElement).append(style)
  }
}

function rectFrom(origin: { x: number; y: number }, event: MouseEvent): ShotRect {
  const x = Math.min(origin.x, event.clientX)
  const y = Math.min(origin.y, event.clientY)
  return {
    x,
    y,
    width: Math.abs(event.clientX - origin.x),
    height: Math.abs(event.clientY - origin.y),
  }
}

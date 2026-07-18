import { languagePairLabel } from '../shared/languages'
import type { BrowserTranslatorAvailability } from './browser-translator'

export type SetupPromptReason =
  | { kind: 'browser-unsupported' }
  | { kind: 'language-pack'; availability: BrowserTranslatorAvailability }
  | { kind: 'external-unconfigured' }

export type SetupPromptActions = {
  onDownload?: () => void | Promise<void>
  onOpenLlmSetup?: () => void | Promise<void>
  onOpenOnboarding?: () => void | Promise<void>
  onDismiss?: () => void
}

/**
 * In-page modal when translation cannot start with the selected engine.
 * Keeps users in context: download the language pack or jump to external LLM setup.
 */
export class SetupPrompt {
  private host: HTMLDivElement | null = null
  private root: ShadowRoot | null = null

  show(
    reason: SetupPromptReason,
    pair: { sourceLang: string; targetLang: string },
    actions: SetupPromptActions,
  ): void {
    this.dismiss()
    this.host = document.createElement('div')
    this.host.id = 'lens-translator-setup-prompt'
    this.host.setAttribute('data-lens-ignore', '')
    Object.assign(this.host.style, {
      all: 'initial',
      position: 'fixed',
      inset: '0',
      zIndex: '2147483647',
      pointerEvents: 'auto',
    })
    this.root = this.host.attachShadow({ mode: 'closed' })

    const pairLabel = languagePairLabel(pair.sourceLang, pair.targetLang)
    const copy = copyForReason(reason, pairLabel)

    const style = document.createElement('style')
    style.textContent = STYLES

    const backdrop = document.createElement('div')
    backdrop.className = 'backdrop'
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        actions.onDismiss?.()
        this.dismiss()
      }
    })

    const card = document.createElement('div')
    card.className = 'card'
    card.setAttribute('role', 'dialog')
    card.setAttribute('aria-modal', 'true')
    card.setAttribute('aria-labelledby', 'lens-setup-title')

    const title = document.createElement('h2')
    title.id = 'lens-setup-title'
    title.textContent = copy.title

    const body = document.createElement('p')
    body.className = 'body'
    body.textContent = copy.body

    const pairEl = document.createElement('div')
    pairEl.className = 'pair'
    pairEl.textContent = pairLabel

    const actionsRow = document.createElement('div')
    actionsRow.className = 'actions'

    if (copy.primary === 'download' && actions.onDownload) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'btn primary'
      btn.textContent = '下载语言包'
      btn.addEventListener('click', () => {
        void Promise.resolve(actions.onDownload?.())
      })
      actionsRow.append(btn)
    }

    if (actions.onOpenLlmSetup) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = copy.primary === 'llm' ? 'btn primary' : 'btn'
      btn.textContent = '配置外部 LLM'
      btn.addEventListener('click', () => {
        void Promise.resolve(actions.onOpenLlmSetup?.())
        this.dismiss()
      })
      actionsRow.append(btn)
    }

    if (actions.onOpenOnboarding) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'btn'
      btn.textContent = '打开设置向导'
      btn.addEventListener('click', () => {
        void Promise.resolve(actions.onOpenOnboarding?.())
        this.dismiss()
      })
      actionsRow.append(btn)
    }

    const dismiss = document.createElement('button')
    dismiss.type = 'button'
    dismiss.className = 'btn ghost'
    dismiss.textContent = '稍后'
    dismiss.addEventListener('click', () => {
      actions.onDismiss?.()
      this.dismiss()
    })
    actionsRow.append(dismiss)

    card.append(title, body, pairEl, actionsRow)
    backdrop.append(card)
    this.root.append(style, backdrop)
    document.documentElement.append(this.host)

    window.addEventListener('keydown', this.onKeyDown, true)
  }

  setStatus(text: string, error = false): void {
    if (!this.root) return
    let status = this.root.querySelector<HTMLElement>('.status')
    if (!status) {
      status = document.createElement('p')
      status.className = 'status'
      this.root.querySelector('.card')?.append(status)
    }
    status.textContent = text
    status.dataset.error = error ? 'true' : 'false'
  }

  dismiss(): void {
    window.removeEventListener('keydown', this.onKeyDown, true)
    this.host?.remove()
    this.host = null
    this.root = null
  }

  isOpen(): boolean {
    return Boolean(this.host?.isConnected)
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.isOpen()) {
      e.preventDefault()
      e.stopPropagation()
      this.dismiss()
    }
  }
}

function copyForReason(
  reason: SetupPromptReason,
  pairLabel: string,
): { title: string; body: string; primary: 'download' | 'llm' | 'none' } {
  if (reason.kind === 'browser-unsupported') {
    return {
      title: '当前浏览器不支持内置翻译',
      body: '需要桌面版 Chrome 138+ 的 Translator API，或改用外部 LLM 完成翻译。',
      primary: 'llm',
    }
  }
  if (reason.kind === 'external-unconfigured') {
    return {
      title: '尚未配置外部翻译服务',
      body: '当前选择了外部 LLM。请填写 Base URL、API Key 与模型，或改回 Chrome 内置翻译。',
      primary: 'llm',
    }
  }
  if (reason.availability === 'downloadable' || reason.availability === 'downloading') {
    return {
      title: '需要下载语言包',
      body: `语言对 ${pairLabel} 的 Chrome 语言包尚未就绪。下载后即可离线翻译；也可以改用外部 LLM。`,
      primary: 'download',
    }
  }
  if (reason.availability === 'unavailable') {
    return {
      title: '当前语言对不可用',
      body: `Chrome 内置翻译不支持 ${pairLabel}。请更换语言，或切换到外部 LLM。`,
      primary: 'llm',
    }
  }
  return {
    title: '翻译尚未就绪',
    body: '请检查语言包状态，或在设置中切换到外部 LLM。',
    primary: 'none',
  }
}

const STYLES = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  .backdrop {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 20px;
    background: rgb(15 23 42 / 42%);
    backdrop-filter: blur(4px);
  }
  .card {
    width: min(420px, 100%);
    padding: 22px 22px 18px;
    border-radius: 16px;
    background: #fff;
    box-shadow: 0 24px 60px rgb(15 23 42 / 28%);
    color: #0f172a;
  }
  h2 {
    margin: 0 0 10px;
    font-size: 17px;
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .body {
    margin: 0 0 12px;
    font-size: 13.5px;
    line-height: 1.55;
    color: #475569;
  }
  .pair {
    display: inline-flex;
    margin-bottom: 16px;
    padding: 5px 10px;
    border-radius: 999px;
    background: #eff6ff;
    color: #1d4ed8;
    font-size: 12px;
    font-weight: 600;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .btn {
    appearance: none;
    border: 1px solid #e2e8f0;
    border-radius: 10px;
    background: #f8fafc;
    color: #0f172a;
    font-size: 13px;
    font-weight: 600;
    padding: 9px 12px;
    cursor: pointer;
  }
  .btn:hover { background: #f1f5f9; }
  .btn.primary {
    border-color: #2563eb;
    background: #2563eb;
    color: #fff;
  }
  .btn.primary:hover { background: #1d4ed8; }
  .btn.ghost {
    border-color: transparent;
    background: transparent;
    color: #64748b;
  }
  .status {
    margin: 12px 0 0;
    font-size: 12.5px;
    color: #0369a1;
  }
  .status[data-error="true"] { color: #b91c1c; }
  @media (prefers-color-scheme: dark) {
    .card { background: #18181b; color: #f4f4f5; }
    .body { color: #a1a1aa; }
    .pair { background: #172554; color: #93c5fd; }
    .btn { border-color: #3f3f46; background: #27272a; color: #f4f4f5; }
    .btn:hover { background: #3f3f46; }
    .btn.ghost { color: #a1a1aa; }
  }
`

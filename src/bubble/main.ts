import {
  Activity,
  Bot,
  ChevronDown,
  Focus,
  KeyRound,
  Languages,
  PaintBucket,
  Palette,
  PanelRightClose,
  Pin,
  Save,
  ScanText,
  Settings2,
  Type,
  createElement,
  type IconNode,
} from 'lucide'
import type { BubbleControlMsg, BubbleControlResult, TestConnectionResult } from '../shared/messages'
import {
  apiBaseUrlError,
  isConfigured,
  loadSettings,
  mergeSettings,
  saveSettings,
  type TranslationEngine,
  type UserSettings,
} from '../shared/settings'
import type { ProviderId } from '../shared/providers'

const iconNodes: Record<string, IconNode> = {
  activity: Activity,
  bot: Bot,
  chevron: ChevronDown,
  focus: Focus,
  key: KeyRound,
  languages: Languages,
  'paint-bucket': PaintBucket,
  palette: Palette,
  'panel-close': PanelRightClose,
  pin: Pin,
  save: Save,
  'scan-text': ScanText,
  settings: Settings2,
  type: Type,
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing #${id}`)
  return node as T
}

for (const slot of document.querySelectorAll<HTMLElement>('[data-icon]')) {
  const icon = iconNodes[slot.dataset.icon ?? '']
  if (icon) slot.replaceChildren(createElement(icon, { width: 18, height: 18, 'stroke-width': 1.9 }))
}

let settings: UserSettings
let pinned = false
let styleTimer = 0
let saveChain: Promise<void> = Promise.resolve()

function shell(action: 'pin' | 'unpin' | 'collapse'): void {
  window.parent.postMessage({ type: 'lens-translator-bubble-shell', action }, '*')
}

async function activeTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tab?.id === undefined) throw new Error('无法定位当前页面')
  return tab.id
}

function isBubbleResult(value: unknown): value is BubbleControlResult {
  if (!value || typeof value !== 'object' || !('ok' in value)) return false
  if (value.ok === true) {
    return (
      'lensActive' in value &&
      typeof value.lensActive === 'boolean' &&
      'pageTranslationActive' in value &&
      typeof value.pageTranslationActive === 'boolean'
    )
  }
  return value.ok === false && 'error' in value && typeof value.error === 'string'
}

async function sendControl(command: BubbleControlMsg['command']): Promise<BubbleControlResult> {
  const message: BubbleControlMsg = { type: 'bubble-control', command }
  const response: unknown = await chrome.tabs.sendMessage(await activeTabId(), message)
  if (!isBubbleResult(response)) throw new Error('页面控制器未返回有效状态')
  return response
}

function renderControlState(state: BubbleControlResult): void {
  if (!state.ok) {
    showStatus(state.error, true)
    return
  }
  setActionState('lensAction', 'lensActionState', state.lensActive)
  setActionState('pageAction', 'pageActionState', state.pageTranslationActive)
  el('orbState').dataset.active = state.lensActive || state.pageTranslationActive ? 'true' : 'false'
}

function setActionState(buttonId: string, labelId: string, active: boolean): void {
  el<HTMLButtonElement>(buttonId).dataset.active = active ? 'true' : 'false'
  el(labelId).textContent = active ? '运行中' : '已关闭'
}

function showStatus(text: string, error = false): void {
  const status = el('saveState')
  status.textContent = text
  status.dataset.error = error ? 'true' : 'false'
}

function renderSettings(): void {
  el('connectionState').textContent = isConfigured(settings) ? '外部接口已配置' : '外部接口待配置'
  el('connectionState').dataset.configured = isConfigured(settings) ? 'true' : 'false'
  el<HTMLSelectElement>('fontFamily').value = settings.pageTranslationFontFamily
  el<HTMLInputElement>('fontSize').value = String(settings.pageTranslationFontSizePx)
  el('fontSizeValue').textContent = `${settings.pageTranslationFontSizePx}px`
  el<HTMLInputElement>('useTextColor').checked = settings.pageTranslationUseCustomColor
  el<HTMLInputElement>('textColor').value = settings.pageTranslationTextColor
  el<HTMLInputElement>('useBackground').checked = settings.pageTranslationUseBackground
  el<HTMLInputElement>('backgroundColor').value = settings.pageTranslationBackgroundColor
  setPressed('bold', settings.pageTranslationBold)
  setPressed('italic', settings.pageTranslationItalic)
  setPressed('underline', settings.pageTranslationUnderline)
  el<HTMLInputElement>('baseURL').value = settings.baseURL
  el<HTMLInputElement>('apiKey').value = ''
  el<HTMLInputElement>('apiKey').placeholder = settings.apiKey ? '已保存，留空保持不变' : 'sk-...'
  el<HTMLInputElement>('model').value = settings.model
  el<HTMLSelectElement>('provider').value = settings.provider
  renderEngineButtons()
  renderPreview()
}

function setPressed(id: string, pressed: boolean): void {
  el<HTMLButtonElement>(id).setAttribute('aria-pressed', pressed ? 'true' : 'false')
}

function renderEngineButtons(): void {
  for (const group of document.querySelectorAll<HTMLElement>('[data-engine-scope]')) {
    const selected = group.dataset.engineScope === 'lens'
      ? settings.translationEngine
      : settings.pageTranslationEngine
    for (const button of group.querySelectorAll<HTMLButtonElement>('[data-engine]')) {
      button.dataset.active = button.dataset.engine === selected ? 'true' : 'false'
    }
  }
}

function renderPreview(): void {
  const preview = el<HTMLParagraphElement>('stylePreview')
  const family = {
    system: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
    sans: 'Inter, ui-sans-serif, system-ui, sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
    mono: '"SFMono-Regular", Consolas, monospace',
  }[settings.pageTranslationFontFamily]
  Object.assign(preview.style, {
    fontFamily: family,
    fontSize: `${settings.pageTranslationFontSizePx}px`,
    color: settings.pageTranslationUseCustomColor ? settings.pageTranslationTextColor : '#162033',
    background: settings.pageTranslationUseBackground
      ? settings.pageTranslationBackgroundColor
      : 'transparent',
    fontWeight: settings.pageTranslationBold ? '700' : '400',
    fontStyle: settings.pageTranslationItalic ? 'italic' : 'normal',
    textDecoration: settings.pageTranslationUnderline ? 'underline' : 'none',
    padding: settings.pageTranslationUseBackground ? '7px 9px' : '7px 0',
  })
}

function queueSave(next: UserSettings): Promise<void> {
  settings = mergeSettings(next)
  const snapshot = settings
  saveChain = saveChain.catch(() => undefined).then(() => saveSettings(snapshot))
  return saveChain
}

function readStyleControls(): void {
  settings = mergeSettings({
    ...settings,
    pageTranslationFontFamily: el<HTMLSelectElement>('fontFamily').value,
    pageTranslationFontSizePx: Number(el<HTMLInputElement>('fontSize').value),
    pageTranslationUseCustomColor: el<HTMLInputElement>('useTextColor').checked,
    pageTranslationTextColor: el<HTMLInputElement>('textColor').value,
    pageTranslationUseBackground: el<HTMLInputElement>('useBackground').checked,
    pageTranslationBackgroundColor: el<HTMLInputElement>('backgroundColor').value,
    pageTranslationBold: el<HTMLButtonElement>('bold').getAttribute('aria-pressed') === 'true',
    pageTranslationItalic: el<HTMLButtonElement>('italic').getAttribute('aria-pressed') === 'true',
    pageTranslationUnderline:
      el<HTMLButtonElement>('underline').getAttribute('aria-pressed') === 'true',
  })
  el('fontSizeValue').textContent = `${settings.pageTranslationFontSizePx}px`
  renderPreview()
  showStatus('正在同步样式')
  window.clearTimeout(styleTimer)
  styleTimer = window.setTimeout(() => {
    void queueSave(settings).then(() => showStatus('样式已应用'), (error: unknown) => {
      showStatus(error instanceof Error ? error.message : String(error), true)
    })
  }, 120)
}

async function saveLlmSettings(): Promise<void> {
  const baseURL = el<HTMLInputElement>('baseURL').value.trim()
  const apiKey = el<HTMLInputElement>('apiKey').value.trim()
  const model = el<HTMLInputElement>('model').value.trim()
  const baseError = apiBaseUrlError(baseURL)
  if (baseError) throw new Error(baseError)
  if (!model) throw new Error('请填写模型名')
  if (!apiKey && !settings.apiKey) throw new Error('请填写 API Key')
  await queueSave({
    ...settings,
    baseURL,
    apiKey: apiKey || settings.apiKey,
    model,
    provider: el<HTMLSelectElement>('provider').value as ProviderId,
  })
  renderSettings()
  showStatus('LLM 配置已保存')
}

function isConnectionResult(value: unknown): value is TestConnectionResult {
  if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'test-connection-result') return false
  if (!('ok' in value)) return false
  return value.ok === true || (value.ok === false && 'error' in value && typeof value.error === 'string')
}

async function testLlmConnection(): Promise<void> {
  const response: unknown = await chrome.runtime.sendMessage({
    type: 'test-connection',
    baseURL: el<HTMLInputElement>('baseURL').value.trim(),
    apiKey: el<HTMLInputElement>('apiKey').value.trim() || settings.apiKey,
    model: el<HTMLInputElement>('model').value.trim(),
    provider: el<HTMLSelectElement>('provider').value as ProviderId,
    reasoningPref: settings.reasoningPref,
  })
  if (!isConnectionResult(response)) throw new Error('测试服务未返回有效结果')
  if (!response.ok) throw new Error(response.error)
  showStatus('连接测试成功')
}

async function init(): Promise<void> {
  settings = await loadSettings()
  renderSettings()
  try {
    renderControlState(await sendControl('get-state'))
  } catch {
    showStatus('当前页面暂不可控制', true)
  }

  el<HTMLButtonElement>('orb').addEventListener('click', () => {
    pinned = true
    shell('pin')
  })
  el<HTMLButtonElement>('pin').addEventListener('click', () => {
    pinned = !pinned
    el<HTMLButtonElement>('pin').setAttribute('aria-pressed', pinned ? 'true' : 'false')
    shell(pinned ? 'pin' : 'unpin')
  })
  el<HTMLButtonElement>('collapse').addEventListener('click', () => {
    pinned = false
    el<HTMLButtonElement>('pin').setAttribute('aria-pressed', 'false')
    shell('collapse')
  })

  el<HTMLButtonElement>('pageAction').addEventListener('click', async () => {
    try {
      renderControlState(await sendControl('toggle-page-translation'))
    } catch (error) {
      showStatus(error instanceof Error ? error.message : String(error), true)
    }
  })
  el<HTMLButtonElement>('lensAction').addEventListener('click', async () => {
    try {
      renderControlState(await sendControl('toggle-lens'))
    } catch (error) {
      showStatus(error instanceof Error ? error.message : String(error), true)
    }
  })

  for (const group of document.querySelectorAll<HTMLElement>('[data-engine-scope]')) {
    group.addEventListener('click', (event) => {
      const button = (event.target as Element).closest<HTMLButtonElement>('[data-engine]')
      if (!button) return
      const engine = button.dataset.engine as TranslationEngine
      settings = mergeSettings(
        group.dataset.engineScope === 'lens'
          ? { ...settings, translationEngine: engine }
          : { ...settings, pageTranslationEngine: engine },
      )
      renderEngineButtons()
      void queueSave(settings).then(() => showStatus('翻译引擎已切换'))
    })
  }

  for (const id of ['fontFamily', 'fontSize', 'useTextColor', 'textColor', 'useBackground', 'backgroundColor']) {
    el(id).addEventListener('input', readStyleControls)
    el(id).addEventListener('change', readStyleControls)
  }
  for (const id of ['bold', 'italic', 'underline']) {
    el<HTMLButtonElement>(id).addEventListener('click', (event) => {
      const button = event.currentTarget as HTMLButtonElement
      button.setAttribute('aria-pressed', button.getAttribute('aria-pressed') === 'true' ? 'false' : 'true')
      readStyleControls()
    })
  }

  el<HTMLButtonElement>('saveLlm').addEventListener('click', () => {
    void saveLlmSettings().catch((error: unknown) => {
      showStatus(error instanceof Error ? error.message : String(error), true)
    })
  })
  el<HTMLButtonElement>('testConnection').addEventListener('click', () => {
    showStatus('正在测试连接')
    void testLlmConnection().catch((error: unknown) => {
      showStatus(error instanceof Error ? error.message : String(error), true)
    })
  })
  el<HTMLButtonElement>('openSettings').addEventListener('click', () => {
    void chrome.runtime.openOptionsPage()
  })

  window.setInterval(() => {
    if (window.innerWidth <= 100) return
    void sendControl('get-state').then(renderControlState).catch(() => undefined)
  }, 1200)
}

void init().catch((error: unknown) => {
  showStatus(error instanceof Error ? error.message : String(error), true)
})

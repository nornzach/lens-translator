import {
  isConfigured,
  loadSettings,
  saveSettings,
  missingConfigFields,
  type UserSettings,
} from '../shared/settings'
import { formatHotkeyLabel } from '../shared/hotkey'
import { languagePairLabel } from '../shared/languages'
import type {
  PauseHostnameMsg,
  ToggleLensResult,
  TogglePageTranslationMsg,
  TogglePageTranslationResult,
} from '../shared/messages'

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing #${id}`)
  return node as T
}

function hostnameFromUrl(url: string | undefined): string {
  if (!url) return ''
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    return u.hostname
  } catch {
    return ''
  }
}

/**
 * Resolve the content tab to control. Prefer ?tabId= from the opener, then the
 * most recently focused http(s) tab — never the control panel tab itself.
 */
async function resolveContentTab(): Promise<chrome.tabs.Tab | undefined> {
  const raw = new URLSearchParams(location.search).get('tabId')
  if (raw) {
    const id = Number(raw)
    if (Number.isFinite(id) && id > 0) {
      try {
        const tab = await chrome.tabs.get(id)
        if (tab.id !== undefined && hostnameFromUrl(tab.url)) return tab
      } catch {
        // Tab may have closed; fall through.
      }
    }
  }
  try {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] })
    tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))
    return tabs[0]
  } catch {
    return undefined
  }
}

function renderStatus(settings: UserSettings): void {
  const configured = isConfigured(settings)
  const api = el<HTMLElement>('apiStatus')
  if (settings.translationEngine === 'browser') {
    api.textContent = 'Chrome 内置'
    api.className = 'pill ok'
  } else if (configured) {
    api.textContent = '外部 LLM'
    api.className = 'pill ok'
  } else {
    const miss = missingConfigFields(settings)
    api.textContent = miss.length ? `缺 ${miss.join('/')}` : '未配置'
    api.className = 'pill warn'
  }

  const pageEngine = el<HTMLElement>('pageEngineStatus')
  pageEngine.textContent =
    settings.pageTranslationEngine === 'browser' ? 'Chrome 内置' : '外部 LLM'
  pageEngine.className =
    settings.pageTranslationEngine === 'browser' || configured ? 'pill ok' : 'pill warn'

  el<HTMLElement>('pairHint').textContent = languagePairLabel(
    settings.sourceLang,
    settings.targetLang,
  )

  const lensLabel = formatHotkeyLabel(settings.hotkey)
  const pageLabel = formatHotkeyLabel(settings.pageTranslationHotkey)
  el<HTMLElement>('hotkeyHint').textContent = lensLabel
  el<HTMLElement>('pageHotkeyHint').textContent = pageLabel

  const auto = el<HTMLInputElement>('autoToggle')
  auto.checked = settings.autoTranslate
  el<HTMLElement>('modeDesc').textContent = settings.autoTranslate
    ? '开：进入页面会预译可见区'
    : '关：仅透镜对准的块才翻译'

  const selection = el<HTMLInputElement>('selectionToggle')
  selection.checked = settings.selectionTranslate
  el<HTMLElement>('selectionDesc').textContent = settings.selectionTranslate
    ? '开：选中文字即显示译文'
    : '关：不影响透镜与整页'

  const pageAuto = el<HTMLInputElement>('pageAutoToggle')
  pageAuto.checked = settings.autoPageTranslation
  el<HTMLElement>('pageAutoDesc').textContent = settings.autoPageTranslation
    ? '开：匹配源语言时自动开启'
    : '关：使用快捷键手动开启'

  const tip = el<HTMLElement>('unconfiguredTip')
  const needsExternal =
    settings.translationEngine === 'external' || settings.pageTranslationEngine === 'external'
  if (configured || !needsExternal) {
    tip.hidden = true
  } else {
    tip.hidden = false
    const miss = missingConfigFields(settings)
    tip.textContent = miss.length
      ? `尚未配置完整：请填写 ${miss.join('、')}`
      : '尚未配置外部 API，请打开设置填写并保存。'
  }
}

async function setHostnamePaused(hostname: string, paused: boolean): Promise<UserSettings> {
  const msg: PauseHostnameMsg = {
    type: 'set-hostname-paused',
    hostname,
    paused,
  }
  const response: unknown = await chrome.runtime.sendMessage(msg)
  if (
    response &&
    typeof response === 'object' &&
    'type' in response &&
    response.type === 'background-error' &&
    'error' in response &&
    typeof response.error === 'string'
  ) {
    throw new Error(response.error)
  }
  if (!response || typeof response !== 'object' || !('type' in response) || response.type !== 'settings') {
    throw new Error('更新暂停状态失败')
  }
  return loadSettings()
}

async function sendToActiveTab<T>(
  tabId: number,
  message: unknown,
  isResult: (value: unknown) => value is T,
): Promise<T> {
  let response: unknown
  try {
    response = await chrome.tabs.sendMessage(tabId, message)
  } catch {
    const files = (chrome.runtime.getManifest().content_scripts ?? []).flatMap((s) => s.js ?? [])
    if (!files.length) throw new Error('无法在此页面运行')
    await chrome.scripting.executeScript({ target: { tabId }, files })
    await new Promise((resolve) => setTimeout(resolve, 120))
    response = await chrome.tabs.sendMessage(tabId, message)
  }
  if (!isResult(response)) throw new Error('页面脚本未返回有效结果')
  return response
}

function isTogglePageTranslationResult(value: unknown): value is TogglePageTranslationResult {
  if (!value || typeof value !== 'object' || !('ok' in value)) return false
  if (value.ok === true) return true
  return value.ok === false && 'error' in value && typeof value.error === 'string'
}

function isToggleLensResult(value: unknown): value is ToggleLensResult {
  if (!value || typeof value !== 'object' || !('ok' in value)) return false
  if (value.ok === true) {
    return 'lensActive' in value && typeof value.lensActive === 'boolean'
  }
  return value.ok === false && 'error' in value && typeof value.error === 'string'
}

async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text)
  const toast = el<HTMLElement>('copyToast')
  toast.hidden = false
  toast.textContent = `已复制：${text}`
  window.setTimeout(() => {
    toast.hidden = true
  }, 1400)
}

function showError(err: unknown): void {
  const error = el<HTMLElement>('error')
  error.hidden = false
  error.textContent = err instanceof Error ? err.message : String(err)
}

async function init(): Promise<void> {
  el<HTMLButtonElement>('openOptions').addEventListener('click', () => {
    void chrome.runtime.openOptionsPage()
  })

  const tab = await resolveContentTab()
  const hostname = hostnameFromUrl(tab?.url)
  const hostnameEl = el<HTMLElement>('hostname')
  const pauseToggle = el<HTMLInputElement>('pauseToggle')
  const autoToggle = el<HTMLInputElement>('autoToggle')
  const pageAutoToggle = el<HTMLInputElement>('pageAutoToggle')
  const selectionToggle = el<HTMLInputElement>('selectionToggle')
  const translatePageBtn = el<HTMLButtonElement>('translatePage')
  const toggleLensBtn = el<HTMLButtonElement>('toggleLens')

  if (tab?.id === undefined || !hostname) {
    translatePageBtn.disabled = true
    toggleLensBtn.disabled = true
    hostnameEl.textContent = '（未找到可控制的网页，请先打开普通 http/https 页面）'
    pauseToggle.disabled = true
  } else {
    const tabId = tab.id
    hostnameEl.textContent = hostname
    pauseToggle.disabled = false
    translatePageBtn.addEventListener('click', async () => {
      try {
        el<HTMLElement>('error').hidden = true
        const message: TogglePageTranslationMsg = { type: 'toggle-page-translation' }
        const result = await sendToActiveTab(tabId, message, isTogglePageTranslationResult)
        if (!result.ok) throw new Error(result.error)
      } catch (err) {
        showError(err)
      }
    })
    toggleLensBtn.addEventListener('click', async () => {
      try {
        el<HTMLElement>('error').hidden = true
        const result = await sendToActiveTab(tabId, { type: 'toggle-lens' }, isToggleLensResult)
        if (!result.ok) throw new Error(result.error)
        el<HTMLElement>('toggleLensLabel').textContent = result.lensActive
          ? '关闭翻译透镜'
          : '开启翻译透镜'
      } catch (err) {
        showError(err)
      }
    })
  }

  let settings = await loadSettings()
  renderStatus(settings)

  el<HTMLButtonElement>('copyLensHotkey').addEventListener('click', () => {
    void copyText(formatHotkeyLabel(settings.hotkey)).catch(showError)
  })
  el<HTMLButtonElement>('copyPageHotkey').addEventListener('click', () => {
    void copyText(formatHotkeyLabel(settings.pageTranslationHotkey)).catch(showError)
  })

  if (hostname) {
    pauseToggle.checked = settings.pausedHostnames.includes(hostname)
    pauseToggle.addEventListener('change', async () => {
      try {
        el<HTMLElement>('error').hidden = true
        settings = await setHostnamePaused(hostname, pauseToggle.checked)
        renderStatus(settings)
      } catch (err) {
        pauseToggle.checked = !pauseToggle.checked
        showError(err)
      }
    })
  }

  autoToggle.addEventListener('change', async () => {
    try {
      el<HTMLElement>('error').hidden = true
      const next: UserSettings = { ...settings, autoTranslate: autoToggle.checked }
      await saveSettings(next)
      settings = await loadSettings()
      renderStatus(settings)
    } catch (err) {
      autoToggle.checked = !autoToggle.checked
      showError(err)
    }
  })

  selectionToggle.addEventListener('change', async () => {
    try {
      el<HTMLElement>('error').hidden = true
      const next: UserSettings = { ...settings, selectionTranslate: selectionToggle.checked }
      await saveSettings(next)
      settings = await loadSettings()
      renderStatus(settings)
    } catch (err) {
      selectionToggle.checked = !selectionToggle.checked
      showError(err)
    }
  })

  pageAutoToggle.addEventListener('change', async () => {
    try {
      el<HTMLElement>('error').hidden = true
      const next: UserSettings = {
        ...settings,
        autoPageTranslation: pageAutoToggle.checked,
      }
      await saveSettings(next)
      settings = await loadSettings()
      renderStatus(settings)
    } catch (err) {
      pageAutoToggle.checked = !pageAutoToggle.checked
      showError(err)
    }
  })
}

void init()

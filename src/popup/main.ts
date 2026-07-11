import { isConfigured, loadSettings, type UserSettings } from '../shared/settings'
import { formatHotkeyLabel } from '../shared/hotkey'
import type { PauseHostnameMsg, SettingsMsg } from '../shared/messages'

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

function renderStatus(settings: UserSettings): void {
  const configured = isConfigured(settings)
  const api = el<HTMLElement>('apiStatus')
  if (configured) {
    api.textContent = '已配置'
    api.className = 'value status-ok'
  } else {
    api.textContent = '未配置'
    api.className = 'value status-warn'
  }

  const auto = el<HTMLElement>('autoStatus')
  auto.textContent = settings.autoTranslate ? '开' : '关'
  auto.className = 'value'

  const label = formatHotkeyLabel(settings.hotkey)
  el<HTMLElement>('hotkeyHint').textContent = `按住 ${label} 偷看中文`

  const tip = el<HTMLElement>('unconfiguredTip')
  tip.hidden = configured
}

async function setHostnamePaused(hostname: string, paused: boolean): Promise<UserSettings> {
  const msg: PauseHostnameMsg = {
    type: 'set-hostname-paused',
    hostname,
    paused,
  }
  const res = (await chrome.runtime.sendMessage(msg)) as SettingsMsg
  if (!res || res.type !== 'settings') {
    throw new Error('更新暂停状态失败')
  }
  return loadSettings()
}

async function init(): Promise<void> {
  el<HTMLButtonElement>('openOptions').addEventListener('click', () => {
    void chrome.runtime.openOptionsPage()
  })

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const hostname = hostnameFromUrl(tab?.url)
  const hostnameEl = el<HTMLElement>('hostname')
  const toggle = el<HTMLInputElement>('pauseToggle')

  if (!hostname) {
    hostnameEl.textContent = '（无法读取此页）'
    toggle.disabled = true
  } else {
    hostnameEl.textContent = hostname
    toggle.disabled = false
  }

  let settings = await loadSettings()
  renderStatus(settings)

  if (hostname) {
    toggle.checked = settings.pausedHostnames.includes(hostname)
    toggle.addEventListener('change', async () => {
      try {
        el<HTMLElement>('error').hidden = true
        settings = await setHostnamePaused(hostname, toggle.checked)
        renderStatus(settings)
      } catch (err) {
        toggle.checked = !toggle.checked
        const error = el<HTMLElement>('error')
        error.hidden = false
        error.textContent = err instanceof Error ? err.message : String(err)
      }
    })
  }
}

void init()

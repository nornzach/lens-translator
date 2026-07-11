import {
  isConfigured,
  loadSettings,
  saveSettings,
  missingConfigFields,
  type UserSettings,
} from '../shared/settings'
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
    api.className = 'pill ok'
  } else {
    const miss = missingConfigFields(settings)
    api.textContent = miss.length ? `缺 ${miss.join('/')}` : '未配置'
    api.className = 'pill warn'
  }

  const auto = el<HTMLInputElement>('autoToggle')
  auto.checked = settings.autoTranslate
  el<HTMLElement>('modeDesc').textContent = settings.autoTranslate
    ? '开：进入页面会预译可见区（可能较慢）'
    : '关：仅透镜对准的块才翻译（推荐）'

  const label = formatHotkeyLabel(settings.hotkey)
  el<HTMLElement>('hotkeyHint').textContent = `按住 ${label} · 短按可固定`

  const tip = el<HTMLElement>('unconfiguredTip')
  if (configured) {
    tip.hidden = true
  } else {
    tip.hidden = false
    const miss = missingConfigFields(settings)
    tip.textContent = miss.length
      ? `尚未配置完整：请填写 ${miss.join('、')}`
      : '尚未配置 API，请打开设置填写并保存。'
  }
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
  const pauseToggle = el<HTMLInputElement>('pauseToggle')
  const autoToggle = el<HTMLInputElement>('autoToggle')

  if (!hostname) {
    hostnameEl.textContent = '（无法读取此页）'
    pauseToggle.disabled = true
  } else {
    hostnameEl.textContent = hostname
    pauseToggle.disabled = false
  }

  let settings = await loadSettings()
  renderStatus(settings)

  if (hostname) {
    pauseToggle.checked = settings.pausedHostnames.includes(hostname)
    pauseToggle.addEventListener('change', async () => {
      try {
        el<HTMLElement>('error').hidden = true
        settings = await setHostnamePaused(hostname, pauseToggle.checked)
        renderStatus(settings)
      } catch (err) {
        pauseToggle.checked = !pauseToggle.checked
        const error = el<HTMLElement>('error')
        error.hidden = false
        error.textContent = err instanceof Error ? err.message : String(err)
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
      const error = el<HTMLElement>('error')
      error.hidden = false
      error.textContent = err instanceof Error ? err.message : String(err)
    }
  })
}

void init()

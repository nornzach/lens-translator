import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type HotkeyConfig,
  type UserSettings,
} from '../shared/settings'
import { formatHotkeyLabel, hotkeyFromKeyboardEvent } from '../shared/hotkey'

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing #${id}`)
  return node as T
}

function parsePausedHostnames(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function readHotkeyFromHidden(): HotkeyConfig {
  return {
    altKey: el<HTMLInputElement>('hotkeyAlt').value === '1',
    shiftKey: el<HTMLInputElement>('hotkeyShift').value === '1',
    ctrlKey: el<HTMLInputElement>('hotkeyCtrl').value === '1',
    metaKey: el<HTMLInputElement>('hotkeyMeta').value === '1',
    code: el<HTMLInputElement>('hotkeyCode').value || DEFAULT_SETTINGS.hotkey.code,
  }
}

function writeHotkeyHidden(h: HotkeyConfig): void {
  el<HTMLInputElement>('hotkeyAlt').value = h.altKey ? '1' : '0'
  el<HTMLInputElement>('hotkeyShift').value = h.shiftKey ? '1' : '0'
  el<HTMLInputElement>('hotkeyCtrl').value = h.ctrlKey ? '1' : '0'
  el<HTMLInputElement>('hotkeyMeta').value = h.metaKey ? '1' : '0'
  el<HTMLInputElement>('hotkeyCode').value = h.code
  const label = formatHotkeyLabel(h)
  el<HTMLElement>('hotkeyPreview').textContent = label
  el<HTMLElement>('helpHotkey').textContent =
    `按住 ${label} 显示矩形透镜中文，松开即消失；页面英文不会被替换。`
}

function fillForm(s: UserSettings): void {
  el<HTMLInputElement>('baseURL').value = s.baseURL
  el<HTMLInputElement>('apiKey').value = s.apiKey
  el<HTMLInputElement>('model').value = s.model
  el<HTMLInputElement>('sourceLang').value = s.sourceLang
  el<HTMLInputElement>('targetLang').value = s.targetLang
  el<HTMLInputElement>('autoTranslate').checked = s.autoTranslate
  el<HTMLInputElement>('lensWidthPx').value = String(s.lensWidthPx)
  writeHotkeyHidden(s.hotkey)
  el<HTMLInputElement>('pausedHostnames').value = s.pausedHostnames.join(', ')
}

function readForm(base: UserSettings): UserSettings {
  const lensWidth = Number(el<HTMLInputElement>('lensWidthPx').value)
  return {
    ...base,
    baseURL: el<HTMLInputElement>('baseURL').value.trim(),
    apiKey: el<HTMLInputElement>('apiKey').value,
    model: el<HTMLInputElement>('model').value.trim(),
    sourceLang: el<HTMLInputElement>('sourceLang').value.trim() || DEFAULT_SETTINGS.sourceLang,
    targetLang: el<HTMLInputElement>('targetLang').value.trim() || DEFAULT_SETTINGS.targetLang,
    autoTranslate: el<HTMLInputElement>('autoTranslate').checked,
    lensWidthPx:
      Number.isFinite(lensWidth) && lensWidth > 0
        ? Math.round(lensWidth)
        : DEFAULT_SETTINGS.lensWidthPx,
    hotkey: readHotkeyFromHidden(),
    pausedHostnames: parsePausedHostnames(el<HTMLInputElement>('pausedHostnames').value),
  }
}

function setStatus(text: string): void {
  el<HTMLElement>('status').textContent = text
}

function setupHotkeyCapture(): void {
  const btn = el<HTMLButtonElement>('captureHotkey')
  const hint = el<HTMLElement>('captureHint')
  let capturing = false

  const onKey = (e: KeyboardEvent) => {
    if (!capturing) return
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      stopCapture()
      setStatus('已取消录制')
      return
    }
    const hk = hotkeyFromKeyboardEvent(e)
    if (!hk) return
    writeHotkeyHidden(hk)
    stopCapture()
    setStatus(`已录制：${formatHotkeyLabel(hk)}（记得点保存）`)
  }

  const stopCapture = () => {
    capturing = false
    hint.hidden = true
    btn.textContent = '录制快捷键'
    btn.classList.remove('recording')
    window.removeEventListener('keydown', onKey, true)
  }

  btn.addEventListener('click', () => {
    if (capturing) {
      stopCapture()
      return
    }
    capturing = true
    hint.hidden = false
    btn.textContent = '录制中…'
    btn.classList.add('recording')
    setStatus('')
    window.addEventListener('keydown', onKey, true)
  })
}

async function init(): Promise<void> {
  const current = await loadSettings()
  fillForm(current)
  setupHotkeyCapture()

  el<HTMLFormElement>('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const next = readForm(current)
    await saveSettings(next)
    Object.assign(current, next)
    setStatus('已保存')
  })

  el<HTMLButtonElement>('reset').addEventListener('click', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS })
    location.reload()
  })
}

void init()

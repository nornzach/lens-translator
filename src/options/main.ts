import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type UserSettings,
} from '../shared/settings'

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

function fillForm(s: UserSettings): void {
  el<HTMLInputElement>('baseURL').value = s.baseURL
  el<HTMLInputElement>('apiKey').value = s.apiKey
  el<HTMLInputElement>('model').value = s.model
  el<HTMLInputElement>('sourceLang').value = s.sourceLang
  el<HTMLInputElement>('targetLang').value = s.targetLang
  el<HTMLInputElement>('autoTranslate').checked = s.autoTranslate
  el<HTMLInputElement>('lensWidthPx').value = String(s.lensWidthPx)
  el<HTMLInputElement>('hotkeyAlt').checked = s.hotkey.altKey
  el<HTMLInputElement>('hotkeyShift').checked = s.hotkey.shiftKey
  el<HTMLInputElement>('hotkeyCtrl').checked = s.hotkey.ctrlKey
  el<HTMLInputElement>('hotkeyMeta').checked = s.hotkey.metaKey
  el<HTMLInputElement>('hotkeyCode').value = s.hotkey.code
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
    lensWidthPx: Number.isFinite(lensWidth) && lensWidth > 0 ? Math.round(lensWidth) : DEFAULT_SETTINGS.lensWidthPx,
    hotkey: {
      altKey: el<HTMLInputElement>('hotkeyAlt').checked,
      shiftKey: el<HTMLInputElement>('hotkeyShift').checked,
      ctrlKey: el<HTMLInputElement>('hotkeyCtrl').checked,
      metaKey: el<HTMLInputElement>('hotkeyMeta').checked,
      code: el<HTMLInputElement>('hotkeyCode').value.trim() || DEFAULT_SETTINGS.hotkey.code,
    },
    pausedHostnames: parsePausedHostnames(el<HTMLInputElement>('pausedHostnames').value),
  }
}

function setStatus(text: string): void {
  el<HTMLElement>('status').textContent = text
}

async function init(): Promise<void> {
  const current = await loadSettings()
  fillForm(current)

  el<HTMLFormElement>('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const next = readForm(current)
    await saveSettings(next)
    Object.assign(current, next)
    setStatus('已保存 / Saved')
  })

  el<HTMLButtonElement>('reset').addEventListener('click', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS })
    location.reload()
  })
}

void init()

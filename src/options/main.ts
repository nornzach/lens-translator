import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  isConfigured,
  missingConfigFields,
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
  // Never put real key into a placeholder-only state; show key if present
  el<HTMLInputElement>('apiKey').value = s.apiKey
  el<HTMLInputElement>('apiKey').placeholder = s.apiKey
    ? '已保存（留空再保存可保留原 Key）'
    : 'sk-... 或供应商密钥'
  el<HTMLInputElement>('model').value = s.model
  el<HTMLInputElement>('sourceLang').value = s.sourceLang
  el<HTMLInputElement>('targetLang').value = s.targetLang
  el<HTMLInputElement>('autoTranslate').checked = s.autoTranslate
  el<HTMLInputElement>('lensWidthPx').value = String(s.lensWidthPx)
  writeHotkeyHidden(s.hotkey)
  el<HTMLInputElement>('pausedHostnames').value = s.pausedHostnames.join(', ')
  updateConfigBadge(s)
}

/**
 * Build settings from the form.
 * If API Key input is blank, keep the previously stored key (common password-field UX).
 */
function readForm(stored: UserSettings): UserSettings {
  const lensWidth = Number(el<HTMLInputElement>('lensWidthPx').value)
  const typedKey = el<HTMLInputElement>('apiKey').value
  // Preserve existing key when field left empty (re-save other fields)
  const apiKey = typedKey.trim() ? typedKey : stored.apiKey

  return {
    ...stored,
    baseURL: el<HTMLInputElement>('baseURL').value.trim(),
    apiKey,
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

function setStatus(text: string, ok = true): void {
  const node = el<HTMLElement>('status')
  node.textContent = text
  node.classList.toggle('status-error', !ok)
}

function updateConfigBadge(s: UserSettings): void {
  const badge = el<HTMLElement>('configBadge')
  if (isConfigured(s)) {
    badge.textContent = '状态：已配置 ✓'
    badge.className = 'config-badge ok'
  } else {
    const miss = missingConfigFields(s).join('、')
    badge.textContent = `状态：未完成（缺少 ${miss || '配置'}）`
    badge.className = 'config-badge warn'
  }
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
  let stored = await loadSettings()
  fillForm(stored)
  setupHotkeyCapture()

  el<HTMLFormElement>('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    try {
      const next = readForm(stored)
      const missing = missingConfigFields(next)
      if (missing.length) {
        // Still save so partial progress is kept, but warn clearly
        await saveSettings(next)
        stored = await loadSettings()
        fillForm(stored)
        setStatus(`已保存，但尚未完成配置：请填写 ${missing.join('、')}`, false)
        return
      }
      await saveSettings(next)
      // Round-trip verify storage actually has the key
      stored = await loadSettings()
      fillForm(stored)
      if (isConfigured(stored)) {
        setStatus('已保存 · 配置有效。请回到网页刷新后再试快捷键。', true)
      } else {
        setStatus('保存后校验失败，请重新填写 API Key 并保存。', false)
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), false)
    }
  })

  el<HTMLButtonElement>('reset').addEventListener('click', async () => {
    if (!confirm('确定恢复默认？API Key 会被清空。')) return
    await saveSettings({ ...DEFAULT_SETTINGS })
    location.reload()
  })
}

void init()

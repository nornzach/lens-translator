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
import {
  PROVIDER_PRESETS,
  type ProviderId,
  type ReasoningPref,
} from '../shared/providers'

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
    `按住 ${label} 临时显示透镜；短按后保持打开并跟随鼠标，再次短按或按 Esc 关闭。`
}

function fillForm(s: UserSettings): void {
  el<HTMLSelectElement>('provider').value = s.provider
  el<HTMLInputElement>('baseURL').value = s.baseURL
  el<HTMLInputElement>('apiKey').value = s.apiKey
  el<HTMLInputElement>('apiKey').placeholder = s.apiKey
    ? '已保存（留空再保存可保留原 Key）'
    : 'sk-... 或供应商密钥'
  el<HTMLInputElement>('model').value = s.model
  el<HTMLSelectElement>('reasoningPref').value = s.reasoningPref
  el<HTMLInputElement>('sourceLang').value = s.sourceLang
  el<HTMLInputElement>('targetLang').value = s.targetLang
  el<HTMLInputElement>('autoTranslate').checked = s.autoTranslate
  el<HTMLInputElement>('browserTranslatorFallback').checked = s.browserTranslatorFallback
  el<HTMLInputElement>('lensWidthPx').value = String(s.lensWidthPx)
  writeHotkeyHidden(s.hotkey)
  el<HTMLInputElement>('pausedHostnames').value = s.pausedHostnames.join(', ')
  updateConfigBadge(s)
  updateProviderHint(s.provider)
}

function readForm(stored: UserSettings): UserSettings {
  const lensWidth = Number(el<HTMLInputElement>('lensWidthPx').value)
  const typedKey = el<HTMLInputElement>('apiKey').value
  const apiKey = typedKey.trim() ? typedKey : stored.apiKey
  const provider = el<HTMLSelectElement>('provider').value as ProviderId
  const reasoningPref = el<HTMLSelectElement>('reasoningPref').value as ReasoningPref

  return {
    ...stored,
    provider,
    reasoningPref,
    baseURL: el<HTMLInputElement>('baseURL').value.trim(),
    apiKey,
    model: el<HTMLInputElement>('model').value.trim(),
    sourceLang: el<HTMLInputElement>('sourceLang').value.trim() || DEFAULT_SETTINGS.sourceLang,
    targetLang: el<HTMLInputElement>('targetLang').value.trim() || DEFAULT_SETTINGS.targetLang,
    autoTranslate: el<HTMLInputElement>('autoTranslate').checked,
    browserTranslatorFallback: el<HTMLInputElement>('browserTranslatorFallback').checked,
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

function updateProviderHint(provider: string): void {
  const hint = el<HTMLElement>('providerHint')
  if (provider === 'deepseek') {
    hint.textContent =
      'DeepSeek：默认写入 thinking.type=disabled（关思考）。Base 常用 https://api.deepseek.com'
  } else if (provider === 'stepfun') {
    hint.textContent =
      'StepFun：默认 reasoning_effort=low（最低推理）。Base 常用 https://api.stepfun.com/v1 或 https://api.stepfun.ai/v1'
  } else if (provider === 'openai') {
    hint.textContent = '通用 OpenAI 兼容接口，不附加特殊思考参数。'
  } else {
    hint.textContent =
      '自动识别 Base URL / 模型：DeepSeek 关 thinking；StepFun 用 reasoning_effort=low。'
  }
}

function applyProviderPreset(id: string): void {
  const preset = PROVIDER_PRESETS.find((p) => p.id === id)
  if (!preset) return
  const base = el<HTMLInputElement>('baseURL')
  const model = el<HTMLInputElement>('model')
  // Only fill empty or previous default-looking fields
  if (!base.value.trim() || /openai\.com|deepseek\.com|stepfun\./i.test(base.value)) {
    base.value = preset.baseURL
  }
  if (!model.value.trim() || /gpt-4o-mini|deepseek|step-/i.test(model.value)) {
    model.value = preset.modelHint
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

  el<HTMLSelectElement>('provider').addEventListener('change', () => {
    const v = el<HTMLSelectElement>('provider').value
    updateProviderHint(v)
    if (v !== 'auto') applyProviderPreset(v)
  })

  el<HTMLFormElement>('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    try {
      const next = readForm(stored)
      const missing = missingConfigFields(next)
      if (missing.length) {
        await saveSettings(next)
        stored = await loadSettings()
        fillForm(stored)
        setStatus(`已保存，但尚未完成配置：请填写 ${missing.join('、')}`, false)
        return
      }
      await saveSettings(next)
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

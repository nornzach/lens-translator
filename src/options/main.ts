import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  isConfigured,
  missingConfigFields,
  type HotkeyConfig,
  type TranslationEngine,
  type UserSettings,
} from '../shared/settings'
import { formatHotkeyLabel, hotkeyFromKeyboardEvent, hotkeysEqual } from '../shared/hotkey'
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

function hotkeyFieldId(prefix: string, field: string): string {
  return `${prefix}${field}`
}

function readHotkeyFromHidden(prefix: string, fallback: HotkeyConfig): HotkeyConfig {
  return {
    altKey: el<HTMLInputElement>(hotkeyFieldId(prefix, 'Alt')).value === '1',
    shiftKey: el<HTMLInputElement>(hotkeyFieldId(prefix, 'Shift')).value === '1',
    ctrlKey: el<HTMLInputElement>(hotkeyFieldId(prefix, 'Ctrl')).value === '1',
    metaKey: el<HTMLInputElement>(hotkeyFieldId(prefix, 'Meta')).value === '1',
    code: el<HTMLInputElement>(hotkeyFieldId(prefix, 'Code')).value || fallback.code,
  }
}

function writeHotkeyHidden(prefix: string, h: HotkeyConfig): void {
  el<HTMLInputElement>(hotkeyFieldId(prefix, 'Alt')).value = h.altKey ? '1' : '0'
  el<HTMLInputElement>(hotkeyFieldId(prefix, 'Shift')).value = h.shiftKey ? '1' : '0'
  el<HTMLInputElement>(hotkeyFieldId(prefix, 'Ctrl')).value = h.ctrlKey ? '1' : '0'
  el<HTMLInputElement>(hotkeyFieldId(prefix, 'Meta')).value = h.metaKey ? '1' : '0'
  el<HTMLInputElement>(hotkeyFieldId(prefix, 'Code')).value = h.code
  el<HTMLElement>(hotkeyFieldId(prefix, 'Preview')).textContent = formatHotkeyLabel(h)
}

function updateHotkeyHelp(): void {
  const lensLabel = formatHotkeyLabel(readHotkeyFromHidden('hotkey', DEFAULT_SETTINGS.hotkey))
  const pageLabel = formatHotkeyLabel(
    readHotkeyFromHidden('pageHotkey', DEFAULT_SETTINGS.pageTranslationHotkey),
  )
  el<HTMLElement>('helpHotkey').textContent =
    `按住 ${lensLabel} 临时显示透镜；短按保持打开。${pageLabel} 切换整页双语翻译。`
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
  el<HTMLSelectElement>('translationEngine').value = s.translationEngine
  el<HTMLSelectElement>('pageTranslationEngine').value = s.pageTranslationEngine
  el<HTMLInputElement>('pageTranslationFontSizePx').value = String(
    s.pageTranslationFontSizePx,
  )
  el<HTMLInputElement>('pageTranslationUseCustomColor').checked =
    s.pageTranslationUseCustomColor
  el<HTMLInputElement>('pageTranslationTextColor').value = s.pageTranslationTextColor
  el<HTMLInputElement>('pageTranslationUseBackground').checked =
    s.pageTranslationUseBackground
  el<HTMLInputElement>('pageTranslationBackgroundColor').value =
    s.pageTranslationBackgroundColor
  el<HTMLInputElement>('pageTranslationBold').checked = s.pageTranslationBold
  el<HTMLInputElement>('pageTranslationItalic').checked = s.pageTranslationItalic
  el<HTMLInputElement>('pageTranslationUnderline').checked = s.pageTranslationUnderline
  el<HTMLInputElement>('lensWidthPx').value = String(s.lensWidthPx)
  writeHotkeyHidden('hotkey', s.hotkey)
  writeHotkeyHidden('pageHotkey', s.pageTranslationHotkey)
  updateHotkeyHelp()
  el<HTMLInputElement>('pausedHostnames').value = s.pausedHostnames.join(', ')
  updateConfigBadge(s)
  updateProviderHint(s.provider)
  updateStyleControlStates()
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
    translationEngine: el<HTMLSelectElement>('translationEngine').value as TranslationEngine,
    pageTranslationEngine: el<HTMLSelectElement>('pageTranslationEngine')
      .value as TranslationEngine,
    pageTranslationFontSizePx: Number(
      el<HTMLInputElement>('pageTranslationFontSizePx').value,
    ),
    pageTranslationUseCustomColor: el<HTMLInputElement>('pageTranslationUseCustomColor').checked,
    pageTranslationTextColor: el<HTMLInputElement>('pageTranslationTextColor').value,
    pageTranslationUseBackground: el<HTMLInputElement>('pageTranslationUseBackground').checked,
    pageTranslationBackgroundColor: el<HTMLInputElement>('pageTranslationBackgroundColor').value,
    pageTranslationBold: el<HTMLInputElement>('pageTranslationBold').checked,
    pageTranslationItalic: el<HTMLInputElement>('pageTranslationItalic').checked,
    pageTranslationUnderline: el<HTMLInputElement>('pageTranslationUnderline').checked,
    lensWidthPx:
      Number.isFinite(lensWidth) && lensWidth > 0
        ? Math.round(lensWidth)
        : DEFAULT_SETTINGS.lensWidthPx,
    hotkey: readHotkeyFromHidden('hotkey', DEFAULT_SETTINGS.hotkey),
    pageTranslationHotkey: readHotkeyFromHidden(
      'pageHotkey',
      DEFAULT_SETTINGS.pageTranslationHotkey,
    ),
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

function updateStyleControlStates(): void {
  el<HTMLInputElement>('pageTranslationTextColor').disabled =
    !el<HTMLInputElement>('pageTranslationUseCustomColor').checked
  el<HTMLInputElement>('pageTranslationBackgroundColor').disabled =
    !el<HTMLInputElement>('pageTranslationUseBackground').checked
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

function setupHotkeyCapture(prefix: string, buttonId: string, hintId: string): void {
  const btn = el<HTMLButtonElement>(buttonId)
  const hint = el<HTMLElement>(hintId)
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
    writeHotkeyHidden(prefix, hk)
    updateHotkeyHelp()
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
  setupHotkeyCapture('hotkey', 'captureHotkey', 'captureHint')
  setupHotkeyCapture('pageHotkey', 'capturePageHotkey', 'capturePageHint')
  el<HTMLInputElement>('pageTranslationUseCustomColor').addEventListener(
    'change',
    updateStyleControlStates,
  )
  el<HTMLInputElement>('pageTranslationUseBackground').addEventListener(
    'change',
    updateStyleControlStates,
  )

  el<HTMLSelectElement>('provider').addEventListener('change', () => {
    const v = el<HTMLSelectElement>('provider').value
    updateProviderHint(v)
    if (v !== 'auto') applyProviderPreset(v)
  })

  el<HTMLFormElement>('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    try {
      const next = readForm(stored)
      if (hotkeysEqual(next.hotkey, next.pageTranslationHotkey)) {
        setStatus('翻译透镜与整页翻译不能使用同一个快捷键', false)
        return
      }
      const usesExternal =
        next.translationEngine === 'external' || next.pageTranslationEngine === 'external'
      const missing = usesExternal ? missingConfigFields(next) : []
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
      if (
        stored.translationEngine === 'browser' &&
        stored.pageTranslationEngine === 'browser'
      ) {
        setStatus('已保存 · 两种文本模式均使用 Chrome 内置翻译。请回到网页刷新后再试。', true)
      } else if (isConfigured(stored)) {
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

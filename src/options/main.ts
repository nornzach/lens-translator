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
import { languagePairLabel } from '../shared/languages'
import {
  PROVIDER_PRESETS,
  type ProviderId,
  type ReasoningPref,
} from '../shared/providers'
import {
  BrowserTranslator,
  type BrowserTranslatorAvailability,
} from '../content/browser-translator'
import type { TestConnectionResult, TestVisionResult } from '../shared/messages'

const browserTranslator = new BrowserTranslator()
let browserCapability: BrowserTranslatorAvailability = 'unsupported'
let capabilityRequest = 0

const LANGUAGE_OPTIONS = [
  ['ar', '阿拉伯语'],
  ['bg', '保加利亚语'],
  ['bn', '孟加拉语'],
  ['cs', '捷克语'],
  ['da', '丹麦语'],
  ['de', '德语'],
  ['el', '希腊语'],
  ['en', '英语'],
  ['es', '西班牙语'],
  ['fi', '芬兰语'],
  ['fr', '法语'],
  ['he', '希伯来语'],
  ['hi', '印地语'],
  ['hr', '克罗地亚语'],
  ['hu', '匈牙利语'],
  ['id', '印度尼西亚语'],
  ['it', '意大利语'],
  ['ja', '日语'],
  ['kn', '卡纳达语'],
  ['ko', '韩语'],
  ['lt', '立陶宛语'],
  ['mr', '马拉地语'],
  ['nl', '荷兰语'],
  ['no', '挪威语'],
  ['pl', '波兰语'],
  ['pt', '葡萄牙语'],
  ['ro', '罗马尼亚语'],
  ['ru', '俄语'],
  ['sk', '斯洛伐克语'],
  ['sl', '斯洛文尼亚语'],
  ['sv', '瑞典语'],
  ['ta', '泰米尔语'],
  ['te', '泰卢固语'],
  ['th', '泰语'],
  ['tr', '土耳其语'],
  ['uk', '乌克兰语'],
  ['vi', '越南语'],
  ['zh', '简体中文'],
  ['zh-Hant', '繁体中文'],
] as const

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

function populateLanguageSelects(): void {
  for (const id of ['sourceLang', 'targetLang']) {
    const select = el<HTMLSelectElement>(id)
    select.replaceChildren(
      ...LANGUAGE_OPTIONS.map(([code, name]) => {
        const option = document.createElement('option')
        option.value = code
        option.textContent = `${name} · ${code}`
        return option
      }),
    )
  }
}

function setLanguageValue(id: 'sourceLang' | 'targetLang', value: string): void {
  const select = el<HTMLSelectElement>(id)
  if (![...select.options].some((option) => option.value === value)) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = `自定义 · ${value}`
    select.append(option)
  }
  select.value = value
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
  setLanguageValue('sourceLang', s.sourceLang)
  setLanguageValue('targetLang', s.targetLang)
  el<HTMLInputElement>('autoTranslate').checked = s.autoTranslate
  el<HTMLInputElement>('selectionTranslate').checked = s.selectionTranslate
  el<HTMLInputElement>('showFloatingBubble').checked = s.showFloatingBubble
  el<HTMLSelectElement>('translationEngine').value = s.translationEngine
  el<HTMLSelectElement>('pageTranslationEngine').value = s.pageTranslationEngine
  el<HTMLInputElement>('autoPageTranslation').checked = s.autoPageTranslation
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
  updateEngineSummary(s)
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
    sourceLang: el<HTMLSelectElement>('sourceLang').value || DEFAULT_SETTINGS.sourceLang,
    targetLang: el<HTMLSelectElement>('targetLang').value || DEFAULT_SETTINGS.targetLang,
    autoTranslate: el<HTMLInputElement>('autoTranslate').checked,
    selectionTranslate: el<HTMLInputElement>('selectionTranslate').checked,
    showFloatingBubble: el<HTMLInputElement>('showFloatingBubble').checked,
    translationEngine: el<HTMLSelectElement>('translationEngine').value as TranslationEngine,
    pageTranslationEngine: el<HTMLSelectElement>('pageTranslationEngine')
      .value as TranslationEngine,
    autoPageTranslation: el<HTMLInputElement>('autoPageTranslation').checked,
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

function setTestStatus(text: string, state: 'testing' | 'ok' | 'error'): void {
  const node = el<HTMLElement>('testConnectionStatus')
  node.textContent = text
  node.dataset.state = state
}

function isTestConnectionResult(value: unknown): value is TestConnectionResult {
  if (!value || typeof value !== 'object') return false
  const result = value as { type?: unknown; ok?: unknown; error?: unknown }
  if (result.type !== 'test-connection-result') return false
  return result.ok === true || (result.ok === false && typeof result.error === 'string')
}

/** Probe the currently entered endpoint/model/key (may be unsaved) via the background. */
async function runConnectionTest(settings: UserSettings): Promise<void> {
  const button = el<HTMLButtonElement>('testConnection')
  button.disabled = true
  setTestStatus('正在测试连接…', 'testing')
  try {
    const response: unknown = await chrome.runtime.sendMessage({
      type: 'test-connection',
      baseURL: settings.baseURL,
      apiKey: settings.apiKey,
      model: settings.model,
      provider: settings.provider,
      reasoningPref: settings.reasoningPref,
    })
    if (isTestConnectionResult(response) && response.ok) {
      setTestStatus('连接成功 · 接口可正常翻译', 'ok')
    } else {
      const error = isTestConnectionResult(response) && !response.ok ? response.error : '未知错误'
      setTestStatus(`连接失败：${error}`, 'error')
    }
  } catch (err) {
    setTestStatus(`连接失败：${err instanceof Error ? err.message : String(err)}`, 'error')
  } finally {
    button.disabled = false
  }
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

function updateEngineSummary(settings: UserSettings): void {
  const lens = settings.translationEngine === 'browser' ? 'Chrome' : '外部 LLM'
  const page = settings.pageTranslationEngine === 'browser' ? 'Chrome' : '外部 LLM'
  el<HTMLElement>('engineSummary').textContent = `透镜 ${lens} · 整页 ${page}`
}

function browserVersion(): string {
  return navigator.userAgent.match(/(?:Chrome|Chromium)\/(\d+)/u)?.[1] ?? '未知'
}

function renderBrowserCapability(
  availability: BrowserTranslatorAvailability | 'checking' | 'error',
  detail?: string,
): void {
  const panel = el<HTMLElement>('browserCapability')
  const title = el<HTMLElement>('browserCapabilityTitle')
  const description = el<HTMLElement>('browserCapabilityDescription')
  const action = el<HTMLButtonElement>('browserCapabilityAction')
  panel.dataset.state = availability
  action.hidden = availability === 'checking'
  action.disabled = availability === 'checking'

  const content = {
    checking: ['正在检测 Chrome 内置翻译', '正在检查 API 和当前语言对。'],
    available: ['Chrome 内置翻译已就绪', '当前语言对可直接在设备侧翻译。'],
    downloadable: [
      '需要下载语言包',
      '点击下载并测试；完成后即可用内置引擎翻译所选语言对。',
    ],
    downloading: ['语言包正在下载', detail || '请保持此页面打开。'],
    unavailable: ['当前语言对不可用', '可更换语言代码，或将对应翻译引擎切换为外部 LLM。'],
    unsupported: [
      '当前环境未提供 Translator API',
      `检测到 Chrome/Chromium ${browserVersion()}。该能力要求桌面版 Chrome 138+，其他 Chromium 浏览器不保证支持。`,
    ],
    error: ['检测失败', detail || '请重新检测；持续失败时可改用外部 LLM。'],
  } as const
  title.textContent = content[availability][0]
  description.textContent = detail || content[availability][1]
  action.textContent =
    availability === 'downloadable' || availability === 'downloading' ? '下载并测试' : '重新检测'
}

async function checkBrowserCapability(prepare = false): Promise<void> {
  const request = ++capabilityRequest
  const source = el<HTMLSelectElement>('sourceLang').value || DEFAULT_SETTINGS.sourceLang
  const target = el<HTMLSelectElement>('targetLang').value || DEFAULT_SETTINGS.targetLang
  renderBrowserCapability('checking')
  try {
    browserCapability = await browserTranslator.availability(source, target)
    if (request !== capabilityRequest) return
    if (prepare && (browserCapability === 'downloadable' || browserCapability === 'downloading')) {
      renderBrowserCapability('downloading', '准备语言包…')
      const ready = await browserTranslator.prepare(source, target, (progress) => {
        if (request !== capabilityRequest) return
        renderBrowserCapability('downloading', `语言包下载进度 ${Math.round(progress * 100)}%`)
      })
      if (request !== capabilityRequest) return
      browserCapability = ready ? 'available' : 'unavailable'
    }
    renderBrowserCapability(browserCapability)
  } catch (error) {
    if (request !== capabilityRequest) return
    renderBrowserCapability('error', error instanceof Error ? error.message : String(error))
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

function setupSectionNavigation(): void {
  const links = [...document.querySelectorAll<HTMLAnchorElement>('.section-nav a')]
  const sections = links
    .map((link) => document.querySelector<HTMLElement>(link.hash))
    .filter((section): section is HTMLElement => Boolean(section))
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]
      if (!visible) return
      for (const link of links) link.classList.toggle('active', link.hash === `#${visible.target.id}`)
    },
    { rootMargin: '-20% 0px -65% 0px', threshold: [0, 0.2, 0.6] },
  )
  for (const section of sections) observer.observe(section)
}

function isTestVisionResult(value: unknown): value is TestVisionResult {
  if (!value || typeof value !== 'object') return false
  const result = value as { type?: unknown; ok?: unknown; error?: unknown }
  if (result.type !== 'test-vision-result') return false
  return result.ok === true || (result.ok === false && typeof result.error === 'string')
}

async function runVisionTest(settings: UserSettings): Promise<void> {
  const button = el<HTMLButtonElement>('testVision')
  button.disabled = true
  setTestStatus('正在测试图片能力…', 'testing')
  try {
    const response: unknown = await chrome.runtime.sendMessage({
      type: 'test-vision',
      baseURL: settings.baseURL,
      apiKey: settings.apiKey,
      model: settings.model,
      provider: settings.provider,
      reasoningPref: settings.reasoningPref,
    })
    if (isTestVisionResult(response) && response.ok) {
      setTestStatus('图片能力可用 · 当前模型接受 image_url', 'ok')
    } else {
      const error = isTestVisionResult(response) && !response.ok ? response.error : '未知错误'
      setTestStatus(`图片能力不可用：${error}`, 'error')
    }
  } catch (err) {
    setTestStatus(`图片测试失败：${err instanceof Error ? err.message : String(err)}`, 'error')
  } finally {
    button.disabled = false
  }
}

// ---------------------------------------------------------------------------
// First-run 3-step onboarding
// ---------------------------------------------------------------------------

let onboardingStep = 1

function showOnboarding(show: boolean): void {
  el<HTMLElement>('onboarding').hidden = !show
}

function renderOnboardingStep(): void {
  for (const step of document.querySelectorAll<HTMLElement>('#onboardingSteps li')) {
    const n = Number(step.dataset.step)
    step.classList.toggle('active', n === onboardingStep)
    step.classList.toggle('done', n < onboardingStep)
  }
  for (const panel of document.querySelectorAll<HTMLElement>('.onboarding-panel')) {
    panel.hidden = Number(panel.dataset.panel) !== onboardingStep
  }
  el<HTMLButtonElement>('onboardBack').hidden = onboardingStep <= 1
  el<HTMLButtonElement>('onboardNext').textContent =
    onboardingStep >= 3 ? '完成并开始使用' : '下一步'
}

async function refreshOnboardBrowserStatus(): Promise<void> {
  const source = el<HTMLSelectElement>('onboardSource').value || DEFAULT_SETTINGS.sourceLang
  const target = el<HTMLSelectElement>('onboardTarget').value || DEFAULT_SETTINGS.targetLang
  const status = el<HTMLElement>('onboardBrowserStatus')
  const pair = languagePairLabel(source, target)
  if (!browserTranslator.isSupported()) {
    status.textContent = `当前环境无 Translator API。可跳过并用外部 LLM（${pair}）。`
    return
  }
  const availability = await browserTranslator.availability(source, target)
  if (availability === 'available') {
    status.textContent = `${pair} 语言包已就绪。`
  } else if (availability === 'downloadable' || availability === 'downloading') {
    status.textContent = `${pair} 需要下载语言包，可点下方按钮。`
  } else {
    status.textContent = `${pair} 在 Chrome 内置翻译中不可用，请更换语言或使用外部 LLM。`
  }
}

async function completeOnboarding(stored: UserSettings, partial?: Partial<UserSettings>): Promise<UserSettings> {
  const next: UserSettings = {
    ...stored,
    ...partial,
    onboardingCompleted: true,
  }
  await saveSettings(next)
  showOnboarding(false)
  return loadSettings()
}

function setupOnboarding(getStored: () => UserSettings, setStored: (s: UserSettings) => void): void {
  const sourceSelect = el<HTMLSelectElement>('onboardSource')
  const targetSelect = el<HTMLSelectElement>('onboardTarget')
  sourceSelect.replaceChildren(
    ...LANGUAGE_OPTIONS.map(([code, name]) => {
      const option = document.createElement('option')
      option.value = code
      option.textContent = `${name} · ${code}`
      return option
    }),
  )
  targetSelect.replaceChildren(
    ...LANGUAGE_OPTIONS.map(([code, name]) => {
      const option = document.createElement('option')
      option.value = code
      option.textContent = `${name} · ${code}`
      return option
    }),
  )

  const syncFromStored = () => {
    const s = getStored()
    sourceSelect.value = s.sourceLang
    targetSelect.value = s.targetLang
    el<HTMLInputElement>('onboardBaseURL').value = s.baseURL
    el<HTMLInputElement>('onboardModel').value = s.model
    el<HTMLElement>('onboardHotkeys').innerHTML = `
      <li><strong>点击扩展图标</strong>：开关翻译透镜（无需键盘）</li>
      <li><strong>${formatHotkeyLabel(s.hotkey)}</strong>：按住临时查看，短按保持打开</li>
      <li><strong>${formatHotkeyLabel(s.pageTranslationHotkey)}</strong>：切换整页双语</li>
      <li><strong>划词翻译</strong>：选中文本即出译文（默认开启）</li>
      <li>右键扩展图标可打开快捷控制面板与完整设置</li>
    `
    void refreshOnboardBrowserStatus()
  }

  sourceSelect.addEventListener('change', () => void refreshOnboardBrowserStatus())
  targetSelect.addEventListener('change', () => void refreshOnboardBrowserStatus())

  el<HTMLButtonElement>('onboardDownloadPack').addEventListener('click', async () => {
    const source = sourceSelect.value
    const target = targetSelect.value
    const status = el<HTMLElement>('onboardBrowserStatus')
    status.textContent = '正在下载语言包…'
    const ready = await browserTranslator.prepare(source, target, (p) => {
      status.textContent = `语言包下载 ${Math.round(p * 100)}%`
    })
    status.textContent = ready
      ? `${languagePairLabel(source, target)} 已就绪。`
      : '下载失败，请检查网络或改用外部 LLM。'
    void checkBrowserCapability()
  })

  el<HTMLButtonElement>('onboardSkip').addEventListener('click', async () => {
    setStored(await completeOnboarding(getStored()))
    fillForm(getStored())
  })

  el<HTMLButtonElement>('onboardBack').addEventListener('click', () => {
    onboardingStep = Math.max(1, onboardingStep - 1)
    renderOnboardingStep()
  })

  el<HTMLButtonElement>('onboardNext').addEventListener('click', async () => {
    if (onboardingStep === 1) {
      const next = {
        ...getStored(),
        sourceLang: sourceSelect.value || DEFAULT_SETTINGS.sourceLang,
        targetLang: targetSelect.value || DEFAULT_SETTINGS.targetLang,
      }
      await saveSettings(next)
      setStored(await loadSettings())
      fillForm(getStored())
      onboardingStep = 2
      renderOnboardingStep()
      return
    }
    if (onboardingStep === 2) {
      const baseURL = el<HTMLInputElement>('onboardBaseURL').value.trim()
      const apiKey = el<HTMLInputElement>('onboardApiKey').value.trim()
      const model = el<HTMLInputElement>('onboardModel').value.trim()
      if (baseURL || apiKey || model) {
        const next = {
          ...getStored(),
          baseURL: baseURL || getStored().baseURL,
          apiKey: apiKey || getStored().apiKey,
          model: model || getStored().model,
        }
        await saveSettings(next)
        setStored(await loadSettings())
        fillForm(getStored())
      }
      onboardingStep = 3
      syncFromStored()
      renderOnboardingStep()
      return
    }
    setStored(await completeOnboarding(getStored()))
    fillForm(getStored())
    setStatus('向导完成 · 点击扩展图标即可开始翻译', true)
  })

  syncFromStored()
  renderOnboardingStep()
}

async function init(): Promise<void> {
  populateLanguageSelects()
  let stored = await loadSettings()
  fillForm(stored)
  void checkBrowserCapability()
  setupSectionNavigation()
  setupHotkeyCapture('hotkey', 'captureHotkey', 'captureHint')
  setupHotkeyCapture('pageHotkey', 'capturePageHotkey', 'capturePageHint')
  setupOnboarding(
    () => stored,
    (s) => {
      stored = s
    },
  )

  const forceOnboarding =
    location.hash === '#onboarding' ||
    new URLSearchParams(location.search).get('onboarding') === '1'
  if (!stored.onboardingCompleted || forceOnboarding) {
    showOnboarding(true)
    if (forceOnboarding) history.replaceState(null, '', location.pathname)
  }

  el<HTMLInputElement>('pageTranslationUseCustomColor').addEventListener(
    'change',
    updateStyleControlStates,
  )
  el<HTMLInputElement>('pageTranslationUseBackground').addEventListener(
    'change',
    updateStyleControlStates,
  )
  el<HTMLButtonElement>('browserCapabilityAction').addEventListener('click', () => {
    void checkBrowserCapability(
      browserCapability === 'downloadable' || browserCapability === 'downloading',
    )
  })
  for (const id of ['sourceLang', 'targetLang']) {
    el<HTMLSelectElement>(id).addEventListener('change', () => void checkBrowserCapability())
  }
  for (const id of ['translationEngine', 'pageTranslationEngine']) {
    el<HTMLSelectElement>(id).addEventListener('change', () => {
      updateEngineSummary(readForm(stored))
    })
  }

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
        await saveSettings({ ...next, onboardingCompleted: true })
        stored = await loadSettings()
        fillForm(stored)
        setStatus(`已保存，但尚未完成配置：请填写 ${missing.join('、')}`, false)
        return
      }
      await saveSettings({ ...next, onboardingCompleted: true })
      stored = await loadSettings()
      fillForm(stored)
      const usesBrowser =
        stored.translationEngine === 'browser' || stored.pageTranslationEngine === 'browser'
      if (usesBrowser && (browserCapability === 'unsupported' || browserCapability === 'unavailable')) {
        setStatus('已保存，但当前 Chrome 内置翻译不可用；请查看能力诊断或改用外部 LLM。', false)
      } else if (
        usesBrowser &&
        (browserCapability === 'downloadable' || browserCapability === 'downloading')
      ) {
        setStatus('已保存 · 使用内置翻译前，请先在 Chrome 能力区下载语言包。', false)
      } else if (isConfigured(stored)) {
        setStatus('已保存 · 已同步到打开的网页。', true)
      } else if (!usesExternal) {
        setStatus('已保存 · Chrome 内置翻译模式已启用。', true)
      } else {
        setStatus('保存后校验失败，请重新填写 API Key 并保存。', false)
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), false)
    }
  })

  el<HTMLButtonElement>('testConnection').addEventListener('click', () => {
    void runConnectionTest(readForm(stored))
  })
  el<HTMLButtonElement>('testVision').addEventListener('click', () => {
    void runVisionTest(readForm(stored))
  })

  el<HTMLButtonElement>('reset').addEventListener('click', async () => {
    if (!confirm('确定恢复默认？API Key 会被清空。')) return
    await saveSettings({ ...DEFAULT_SETTINGS, onboardingCompleted: true })
    location.reload()
  })
}

void init()

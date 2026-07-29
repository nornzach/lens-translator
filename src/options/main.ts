import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  isConfigured,
  missingConfigFields,
  type HotkeyConfig,
  type SiteRule,
  type TranslationEngine,
  type UserSettings,
} from '../shared/settings'
import {
  clearVocabulary,
  loadVocabulary,
  removeVocabularyEntry,
  vocabularyToAnkiTsv,
  vocabularyToCsv,
  type VocabularyEntry,
} from '../shared/vocabulary'
import { formatHotkeyLabel, hotkeyFromKeyboardEvent, hotkeysEqual } from '../shared/hotkey'
import { languageName, languagePairLabel } from '../shared/languages'
import {
  PROVIDER_PRESETS,
  type ProviderId,
  type ReasoningPref,
} from '../shared/providers'
import {
  BrowserTranslator,
  type BrowserTranslatorAvailability,
} from '../content/browser-translator'
import type {
  CacheStatsResult,
  ClearTranslationCacheResult,
  ListModelsResult,
  TestConnectionResult,
  TestVisionResult,
} from '../shared/messages'

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
    const options = LANGUAGE_OPTIONS.map(([code, name]) => {
      const option = document.createElement('option')
      option.value = code
      option.textContent = `${name} · ${code}`
      return option
    })
    if (id === 'sourceLang') {
      const auto = document.createElement('option')
      auto.value = 'auto'
      auto.textContent = '自动检测'
      select.replaceChildren(auto, ...options)
    } else {
      select.replaceChildren(...options)
    }
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
  el<HTMLInputElement>('inputTranslate').checked = s.inputTranslate
  el<HTMLSelectElement>('translationEngine').value = s.translationEngine
  el<HTMLSelectElement>('pageTranslationEngine').value = s.pageTranslationEngine
  el<HTMLInputElement>('autoPageTranslation').checked = s.autoPageTranslation
  el<HTMLSelectElement>('pageTranslationDisplayMode').value = s.pageTranslationDisplayMode
  renderSiteRules(s.siteRules)
  void renderVocabulary()
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
    inputTranslate: el<HTMLInputElement>('inputTranslate').checked,
    translationEngine: el<HTMLSelectElement>('translationEngine').value as TranslationEngine,
    pageTranslationEngine: el<HTMLSelectElement>('pageTranslationEngine')
      .value as TranslationEngine,
    autoPageTranslation: el<HTMLInputElement>('autoPageTranslation').checked,
    pageTranslationDisplayMode: el<HTMLSelectElement>('pageTranslationDisplayMode')
      .value as UserSettings['pageTranslationDisplayMode'],
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

function isListModelsResult(value: unknown): value is ListModelsResult {
  if (!value || typeof value !== 'object') return false
  const result = value as { type?: unknown; ok?: unknown; models?: unknown; error?: unknown }
  if (result.type !== 'list-models-result') return false
  return result.ok === true
    ? Array.isArray(result.models)
    : result.ok === false && typeof result.error === 'string'
}

/** Populate the model datalist from the provider's OpenAI-compatible /models catalog. */
async function runFetchModels(settings: UserSettings): Promise<void> {
  const button = el<HTMLButtonElement>('fetchModels')
  button.disabled = true
  setTestStatus('正在获取模型列表…', 'testing')
  try {
    const response: unknown = await chrome.runtime.sendMessage({
      type: 'list-models',
      baseURL: settings.baseURL,
      apiKey: settings.apiKey,
    })
    if (isListModelsResult(response) && response.ok) {
      const datalist = el<HTMLDataListElement>('modelOptions')
      datalist.replaceChildren(
        ...response.models.map((id) => {
          const option = document.createElement('option')
          option.value = id
          return option
        }),
      )
      setTestStatus(`已获取 ${response.models.length} 个可用模型，在模型输入框下拉选择`, 'ok')
    } else {
      const error = isListModelsResult(response) && !response.ok ? response.error : '未知错误'
      setTestStatus(`获取模型列表失败：${error}`, 'error')
    }
  } catch (err) {
    setTestStatus(`获取模型列表失败：${err instanceof Error ? err.message : String(err)}`, 'error')
  } finally {
    button.disabled = false
  }
}

function isCacheStatsResult(value: unknown): value is CacheStatsResult {
  if (!value || typeof value !== 'object') return false
  const result = value as {
    type?: unknown
    ok?: unknown
    persistentEntries?: unknown
    error?: unknown
  }
  if (result.type !== 'cache-stats-result') return false
  return result.ok === true
    ? typeof result.persistentEntries === 'number'
    : result.ok === false && typeof result.error === 'string'
}

function formatCacheSize(chars: number): string {
  if (chars >= 1_000_000) return `${(chars / 1_000_000).toFixed(1)} MB`
  if (chars >= 10_000) return `${Math.round(chars / 1000)} KB`
  return `${chars} B`
}

/** Populate the cache-management row with live sizes for both cache layers. */
async function refreshCacheStats(): Promise<void> {
  const node = el<HTMLElement>('cacheStatsText')
  try {
    const response: unknown = await chrome.runtime.sendMessage({ type: 'get-cache-stats' })
    if (!isCacheStatsResult(response) || !response.ok) {
      node.textContent = '无法读取缓存统计。'
      return
    }
    node.textContent =
      `长期缓存 ${response.persistentEntries} 条（约 ${formatCacheSize(response.persistentChars)}），` +
      `跨页面复用相同句子；会话缓存 ${response.sessionEntries} 条。`
  } catch {
    node.textContent = '无法读取缓存统计。'
  }
}

function isClearCacheResult(value: unknown): value is ClearTranslationCacheResult {
  if (!value || typeof value !== 'object') return false
  const result = value as { type?: unknown; ok?: unknown; error?: unknown }
  if (result.type !== 'clear-translation-cache-result') return false
  return result.ok === true || (result.ok === false && typeof result.error === 'string')
}

async function runClearCache(): Promise<void> {
  if (!confirm('确定清空全部翻译缓存？已渲染的译文不受影响，下次翻译将重新请求。')) return
  const button = el<HTMLButtonElement>('clearCache')
  button.disabled = true
  try {
    const response: unknown = await chrome.runtime.sendMessage({ type: 'clear-translation-cache' })
    if (isClearCacheResult(response) && response.ok) {
      setStatus('翻译缓存已清空', true)
    } else {
      const error = isClearCacheResult(response) && !response.ok ? response.error : '未知错误'
      setStatus(`清空缓存失败：${error}`, false)
    }
  } catch (err) {
    setStatus(`清空缓存失败：${err instanceof Error ? err.message : String(err)}`, false)
  } finally {
    button.disabled = false
    void refreshCacheStats()
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
  } else if (provider === 'alibaba') {
    hint.textContent =
      '阿里云百炼：默认 enable_thinking=false（关思考，Qwen3 混合思考模型）。Base 常用 https://dashscope.aliyuncs.com/compatible-mode/v1'
  } else if (provider === 'openai') {
    hint.textContent = '通用 OpenAI 兼容接口，不附加特殊思考参数。'
  } else {
    hint.textContent =
      '自动识别 Base URL / 模型：DeepSeek 关 thinking；StepFun 用 reasoning_effort=low；阿里云百炼用 enable_thinking=false。'
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

// ---------------------------------------------------------------------------
// Site rules
// ---------------------------------------------------------------------------

const AUTO_PAGE_LABELS = { 'force-on': '自动整页·总是', 'force-off': '自动整页·从不' } as const
const ENGINE_LABELS = { browser: 'Chrome 内置', external: '外部 LLM' } as const

function renderSiteRules(rules: Record<string, SiteRule>): void {
  const list = el<HTMLElement>('siteRulesList')
  const rows = Object.entries(rules).map(([host, rule]) => {
    const item = document.createElement('div')
    item.className = 'site-rule-item'
    const hostEl = document.createElement('span')
    hostEl.className = 'host'
    hostEl.textContent = host
    hostEl.title = host
    const autoEl = document.createElement('span')
    autoEl.textContent = rule.autoPage ? AUTO_PAGE_LABELS[rule.autoPage] : '自动整页·跟随全局'
    const engineEl = document.createElement('span')
    engineEl.textContent = rule.engine ? `引擎·${ENGINE_LABELS[rule.engine]}` : '引擎·跟随全局'
    const removeBtn = document.createElement('button')
    removeBtn.type = 'button'
    removeBtn.className = 'button ghost'
    removeBtn.textContent = '删除'
    removeBtn.addEventListener('click', () => {
      void removeSiteRule(host)
    })
    item.append(hostEl, autoEl, engineEl, removeBtn)
    return item
  })
  list.replaceChildren(...rows)
}

async function persistSiteRules(rules: Record<string, SiteRule>): Promise<void> {
  const stored = await loadSettings()
  await saveSettings({ ...stored, siteRules: rules })
  renderSiteRules(rules)
  setStatus('站点规则已保存', true)
}

async function removeSiteRule(host: string): Promise<void> {
  const stored = await loadSettings()
  const rules = { ...stored.siteRules }
  delete rules[host]
  await persistSiteRules(rules)
}

async function addSiteRuleFromInputs(): Promise<void> {
  const host = el<HTMLInputElement>('siteRuleHost').value.trim().toLowerCase()
  if (!host || host.includes('/') || host.includes(' ')) {
    setStatus('请输入纯主机名（如 example.com）', false)
    return
  }
  const autoPage = el<HTMLSelectElement>('siteRuleAutoPage').value
  const engine = el<HTMLSelectElement>('siteRuleEngine').value
  const rule: SiteRule = {}
  if (autoPage === 'force-on' || autoPage === 'force-off') rule.autoPage = autoPage
  if (engine === 'browser' || engine === 'external') rule.engine = engine
  if (!rule.autoPage && !rule.engine) {
    setStatus('请至少选择一项规则（自动整页或引擎）', false)
    return
  }
  const stored = await loadSettings()
  await persistSiteRules({ ...stored.siteRules, [host]: rule })
  el<HTMLInputElement>('siteRuleHost').value = ''
  el<HTMLSelectElement>('siteRuleAutoPage').value = ''
  el<HTMLSelectElement>('siteRuleEngine').value = ''
}

// ---------------------------------------------------------------------------
// Vocabulary notebook
// ---------------------------------------------------------------------------

let vocabularyEntries: VocabularyEntry[] = []

function renderVocabularyList(): void {
  const query = el<HTMLInputElement>('vocabSearch').value.trim().toLowerCase()
  const list = el<HTMLElement>('vocabList')
  const filtered = query
    ? vocabularyEntries.filter(
        (entry) =>
          entry.source.toLowerCase().includes(query) ||
          entry.translation.toLowerCase().includes(query),
      )
    : vocabularyEntries

  const rows = filtered.slice(0, 200).map((entry) => {
    const item = document.createElement('div')
    item.className = 'vocab-item'
    const main = document.createElement('div')
    const source = document.createElement('div')
    source.className = 'source'
    source.textContent = entry.source
    const translation = document.createElement('div')
    translation.className = 'translation'
    translation.textContent = entry.translation
    const meta = document.createElement('div')
    meta.className = 'meta'
    const link = document.createElement('a')
    link.href = entry.pageUrl
    link.target = '_blank'
    link.rel = 'noreferrer'
    link.textContent = '来源'
    meta.append(
      document.createTextNode(
        `${entry.sourceLang}→${entry.targetLang} · ×${entry.count} · ${new Date(entry.lastSeenAt).toLocaleDateString()} · `,
      ),
      link,
    )
    main.append(source, translation, meta)
    const removeBtn = document.createElement('button')
    removeBtn.type = 'button'
    removeBtn.className = 'button ghost'
    removeBtn.textContent = '删除'
    removeBtn.addEventListener('click', () => {
      void removeVocabularyEntry(entry.id).then(renderVocabulary)
    })
    item.append(main, removeBtn)
    return item
  })
  list.replaceChildren(...rows)
  el<HTMLElement>('vocabCount').textContent =
    `${vocabularyEntries.length} 条` + (filtered.length !== vocabularyEntries.length ? `（筛选出 ${filtered.length}）` : '')
}

async function renderVocabulary(): Promise<void> {
  vocabularyEntries = await loadVocabulary()
  renderVocabularyList()
}

function downloadTextFile(filename: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
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
    unavailable: [
      '当前暂时无法使用内置翻译',
      '可能是语言包未就绪、页面策略限制，或扩展翻译宿主未启动。可点「重新检测」，或改用外部 LLM。',
    ],
    unsupported: [
      '当前环境未提供 Translator API',
      `检测到 Chrome/Chromium ${browserVersion()}。该能力要求桌面版 Chrome 138+；若你以前能用，请点重新检测或重启 Chrome 后再试。`,
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
  // 'auto' is a runtime resolution — probe the capability with English instead.
  const rawSource = el<HTMLSelectElement>('sourceLang').value || DEFAULT_SETTINGS.sourceLang
  const source = rawSource === 'auto' ? 'en' : rawSource
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
      if (ready) {
        browserCapability = 'available'
      } else {
        browserCapability = 'unavailable'
        renderBrowserCapability(
          'error',
          browserTranslator.lastError?.trim() ||
            '语言包下载失败。请检查网络（需能访问 Google 模型服务）后重试。',
        )
        return
      }
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
  if (!base.value.trim() || /openai\.com|deepseek\.com|stepfun\.|dashscope|aliyuncs/i.test(base.value)) {
    base.value = preset.baseURL
  }
  if (!model.value.trim() || /gpt-4o-mini|deepseek|step-|qwen/i.test(model.value)) {
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
  const rawSource = el<HTMLSelectElement>('onboardSource').value || DEFAULT_SETTINGS.sourceLang
  const target = el<HTMLSelectElement>('onboardTarget').value || DEFAULT_SETTINGS.targetLang
  const status = el<HTMLElement>('onboardBrowserStatus')
  // 'auto' resolves per page at runtime; probe the pack with English as baseline.
  const source = rawSource === 'auto' ? 'en' : rawSource
  const pair =
    rawSource === 'auto'
      ? `自动检测 → ${languageName(target)}`
      : languagePairLabel(source, target)
  try {
    if (!browserTranslator.isSupported()) {
      status.textContent = `当前环境无 Translator API。可跳过并用外部 LLM（${pair}）。`
      return
    }
    const availability = await browserTranslator.availability(source, target)
    if (availability === 'available') {
      status.textContent = `${pair} 语言包已就绪。`
    } else if (availability === 'downloadable' || availability === 'downloading') {
      status.textContent = `${pair} 需要下载语言包，可点下方按钮。`
    } else if (availability === 'unsupported') {
      status.textContent = `当前浏览器未提供内置翻译（需 Chrome 138+）。可跳过并用外部 LLM。`
    } else {
      status.textContent = `${pair} 暂时不可用：可重试下载，或改用外部 LLM。`
    }
  } catch (error) {
    status.textContent = `检测失败：${error instanceof Error ? error.message : String(error)}`
  }
}

/** Fire-and-forget async work must never become chrome://extensions errors. */
function runSafe(task: () => Promise<void>, label: string): void {
  void task().catch((error: unknown) => {
    console.error(`[Lens Translator options] ${label}`, error)
  })
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
  const autoOption = document.createElement('option')
  autoOption.value = 'auto'
  autoOption.textContent = '自动检测（推荐）'
  sourceSelect.replaceChildren(
    autoOption,
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
    runSafe(refreshOnboardBrowserStatus, 'onboard status')
  }

  sourceSelect.addEventListener('change', () =>
    runSafe(refreshOnboardBrowserStatus, 'onboard source change'),
  )
  targetSelect.addEventListener('change', () =>
    runSafe(refreshOnboardBrowserStatus, 'onboard target change'),
  )

  el<HTMLButtonElement>('onboardDownloadPack').addEventListener('click', () => {
    runSafe(async () => {
      const source = sourceSelect.value
      const target = targetSelect.value
      const status = el<HTMLElement>('onboardBrowserStatus')
      status.textContent = '正在下载语言包…'
      const ready = await browserTranslator.prepare(source, target, (p) => {
        status.textContent = `语言包下载 ${Math.round(p * 100)}%`
      })
      if (ready) {
        status.textContent = `${languagePairLabel(source, target)} 已就绪。`
      } else {
        const detail = browserTranslator.lastError?.trim()
        status.textContent = detail
          ? `下载失败：${detail}`
          : '下载失败。请确认桌面版 Chrome 138+、可访问 Google 模型下载，或改用外部 LLM。'
      }
      await checkBrowserCapability()
    }, 'onboard download pack')
  })

  el<HTMLButtonElement>('onboardSkip').addEventListener('click', () => {
    runSafe(async () => {
      setStored(await completeOnboarding(getStored()))
      fillForm(getStored())
    }, 'onboard skip')
  })

  el<HTMLButtonElement>('onboardBack').addEventListener('click', () => {
    onboardingStep = Math.max(1, onboardingStep - 1)
    renderOnboardingStep()
  })

  el<HTMLButtonElement>('onboardNext').addEventListener('click', () => {
    runSafe(async () => {
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
    }, 'onboard next')
  })

  syncFromStored()
  renderOnboardingStep()
}

async function init(): Promise<void> {
  populateLanguageSelects()
  let stored = await loadSettings()
  fillForm(stored)
  runSafe(() => checkBrowserCapability(), 'initial capability check')
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
    if (forceOnboarding) {
      try {
        history.replaceState(null, '', `${location.pathname}${location.search}`)
      } catch {
        // ignore history errors on restricted extension URLs
      }
    }
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
    runSafe(
      () =>
        checkBrowserCapability(
          browserCapability === 'downloadable' || browserCapability === 'downloading',
        ),
      'capability action',
    )
  })
  for (const id of ['sourceLang', 'targetLang']) {
    el<HTMLSelectElement>(id).addEventListener('change', () =>
      runSafe(() => checkBrowserCapability(), 'language change'),
    )
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

  el<HTMLFormElement>('settings-form').addEventListener('submit', (e) => {
    e.preventDefault()
    runSafe(async () => {
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
        if (
          usesBrowser &&
          (browserCapability === 'unsupported' || browserCapability === 'unavailable')
        ) {
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
    }, 'save settings')
  })

  el<HTMLButtonElement>('testConnection').addEventListener('click', () => {
    runSafe(() => runConnectionTest(readForm(stored)), 'test connection')
  })
  el<HTMLButtonElement>('testVision').addEventListener('click', () => {
    runSafe(() => runVisionTest(readForm(stored)), 'test vision')
  })
  el<HTMLButtonElement>('fetchModels').addEventListener('click', () => {
    runSafe(() => runFetchModels(readForm(stored)), 'fetch models')
  })
  el<HTMLButtonElement>('clearCache').addEventListener('click', () => {
    runSafe(runClearCache, 'clear cache')
  })
  void refreshCacheStats()

  el<HTMLButtonElement>('reset').addEventListener('click', () => {
    runSafe(async () => {
      if (!confirm('确定恢复默认？API Key 会被清空。')) return
      await saveSettings({ ...DEFAULT_SETTINGS, onboardingCompleted: true })
      location.reload()
    }, 'reset settings')
  })

  el<HTMLButtonElement>('siteRuleAdd').addEventListener('click', () => {
    runSafe(addSiteRuleFromInputs, 'add site rule')
  })

  el<HTMLInputElement>('vocabSearch').addEventListener('input', renderVocabularyList)
  el<HTMLButtonElement>('vocabExportCsv').addEventListener('click', () => {
    if (vocabularyEntries.length) {
      downloadTextFile('lens-vocabulary.csv', vocabularyToCsv(vocabularyEntries), 'text/csv;charset=utf-8')
    }
  })
  el<HTMLButtonElement>('vocabExportAnki').addEventListener('click', () => {
    if (vocabularyEntries.length) {
      downloadTextFile(
        'lens-vocabulary.tsv',
        vocabularyToAnkiTsv(vocabularyEntries),
        'text/tab-separated-values;charset=utf-8',
      )
    }
  })
  el<HTMLButtonElement>('vocabClear').addEventListener('click', () => {
    runSafe(async () => {
      if (!confirm('确定清空生词本？此操作不可撤销。')) return
      await clearVocabulary()
      await renderVocabulary()
    }, 'clear vocabulary')
  })
}

// Prevent transient messaging / Translator quirks from spamming chrome://extensions.
window.addEventListener('unhandledrejection', (event) => {
  console.error('[Lens Translator options] unhandledrejection', event.reason)
  event.preventDefault()
})
window.addEventListener('error', (event) => {
  console.error('[Lens Translator options] error', event.error ?? event.message)
})

runSafe(init, 'init')

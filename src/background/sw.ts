import { loadSettings, saveSettings, isConfigured, missingConfigFields } from '../shared/settings'
import type { UserSettings } from '../shared/settings'
import { formatHotkeyLabel } from '../shared/hotkey'
import type {
  FromBackground,
  SettingsMsg,
  ToBackground,
  TranslateBlock,
  TtsSpeakResult,
} from '../shared/messages'
import {
  translateBatchWithCaches,
  translateDictionaryEntry,
  translateImage,
  testConnection,
  testVisionCapability,
  listAvailableModels,
  translationCacheOverview,
  clearAllTranslationCaches,
  ensureCacheHydrated,
  persistTranslationCache,
} from './translate'
import { handleBrowserTranslatorRequest, handleCloseTranslatorHost } from './browser-translate'

const CONTEXT_PANEL = 'open-control-panel'
const CONTEXT_OPTIONS = 'open-options'

chrome.runtime.onMessage.addListener((rawMessage: unknown, sender, sendResponse) => {
  // Offscreen-targeted messages must not be answered here — SW also receives its own
  // chrome.runtime.sendMessage broadcasts, and a second sendResponse races the offscreen host.
  if (isOffscreenTargeted(rawMessage)) return false

  if (sender.id !== chrome.runtime.id || !isToBackground(rawMessage)) {
    sendResponse({ type: 'translate-batch-result', ok: false, error: 'invalid message' })
    return false
  }
  void handle(rawMessage, sender).then(sendResponse, (error: unknown) => {
    sendResponse(errorResponse(rawMessage, error))
  })
  return true
})

function errorResponse(message: ToBackground, error: unknown): FromBackground {
  const detail = error instanceof Error ? error.message : String(error)
  if (message.type === 'translate-batch') {
    return {
      type: 'translate-batch-result',
      ok: false,
      error: detail,
      failedIds: message.blocks.map((block) => block.id),
    }
  }
  if (message.type === 'translate-image') {
    return { type: 'translate-image-result', ok: false, error: detail }
  }
  if (message.type === 'test-connection') {
    return { type: 'test-connection-result', ok: false, error: detail }
  }
  if (message.type === 'test-vision') {
    return { type: 'test-vision-result', ok: false, error: detail }
  }
  if (message.type === 'list-models') {
    return { type: 'list-models-result', ok: false, error: detail }
  }
  if (message.type === 'get-cache-stats') {
    return { type: 'cache-stats-result', ok: false, error: detail }
  }
  if (message.type === 'clear-translation-cache') {
    return { type: 'clear-translation-cache-result', ok: false, error: detail }
  }
  if (message.type === 'open-options') {
    return { type: 'open-options-result', ok: false }
  }
  if (message.type === 'browser-translator') {
    return { type: 'browser-translator-result', ok: false, error: detail }
  }
  return {
    type: 'background-error',
    ok: false,
    requestType: message.type,
    error: detail,
  }
}

/** Host-targeted messages are answered by the translator host page, not the SW. */
function isOffscreenTargeted(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('target' in value)) return false
  const target = (value as { target?: unknown }).target
  return target === 'offscreen' || target === 'translator-host'
}

/**
 * chrome.tts is unavailable in content scripts, so the SW proxies it.
 * Language is restricted to the configured pair to avoid becoming a free TTS
 * relay for arbitrary content.
 */
async function ttsSpeak(text: string, lang: string): Promise<TtsSpeakResult> {
  if (!chrome.tts) return { type: 'tts-speak-result', ok: false, error: 'tts unavailable' }
  const settings = await loadSettings()
  const allowed = new Set([settings.targetLang.toLowerCase()])
  if (settings.sourceLang !== 'auto') allowed.add(settings.sourceLang.toLowerCase())
  const requested = lang.toLowerCase()
  // Auto mode: detected source varies per page — accept any plausible BCP-47 tag.
  const plausible = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(requested)
  if (!allowed.has(requested) && !(settings.sourceLang === 'auto' && plausible)) {
    return { type: 'tts-speak-result', ok: false, error: 'language not allowed' }
  }
  // Resolve once playback actually starts (or fails) — holding the message
  // channel open until the utterance ends would stall the caller for minutes
  // on long text.
  return new Promise((resolve) => {
    let settled = false
    const done = (result: TtsSpeakResult) => {
      if (!settled) {
        settled = true
        resolve(result)
      }
    }
    try {
      chrome.tts.stop()
      chrome.tts.speak(text, {
        lang,
        rate: 1.0,
        onEvent: (event) => {
          if (event.type === 'start') done({ type: 'tts-speak-result', ok: true })
          else if (event.type === 'error') {
            done({
              type: 'tts-speak-result',
              ok: false,
              error: event.errorMessage ?? 'tts error',
            })
          }
        },
      })
      // Some platforms never fire events — assume started rather than hanging.
      setTimeout(() => done({ type: 'tts-speak-result', ok: true }), 1500)
    } catch (error) {
      done({
        type: 'tts-speak-result',
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })
}

// Content scripts declared in the manifest only load on navigation, so tabs open
// before first install stay untranslatable until reloaded. Inject into them once.
chrome.runtime.onInstalled.addListener((details) => {
  void ensureContextMenus()
  // Updating cannot safely tear down content scripts from the previous version.
  // Existing tabs receive the new script on their next navigation.
  if (details.reason === 'install') {
    void injectIntoOpenTabs()
    void onFirstInstall()
  }
})

chrome.runtime.onStartup.addListener(() => {
  void ensureContextMenus()
})

/** Toolbar click toggles sticky lens (no default_popup so onClicked fires). */
chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return
  void toggleLensInTab(tab.id)
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === CONTEXT_PANEL) {
    void openControlPanel(tab)
    return
  }
  if (info.menuItemId === CONTEXT_OPTIONS) {
    void openOptionsPage()
  }
})

/** Open the control UI with an explicit content-tab id so actions don't target the panel itself. */
async function openControlPanel(hint?: chrome.tabs.Tab): Promise<void> {
  let tabId = isHttpTab(hint) ? hint!.id : undefined
  if (tabId === undefined) {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (isHttpTab(active)) tabId = active.id
  }
  if (tabId === undefined) {
    const recent = await mostRecentHttpTab()
    tabId = recent?.id
  }
  const base = chrome.runtime.getURL('src/popup/index.html')
  const url = tabId !== undefined ? `${base}?tabId=${tabId}` : base
  await chrome.tabs.create({ url })
}

function isHttpTab(tab: chrome.tabs.Tab | undefined): tab is chrome.tabs.Tab & { id: number } {
  if (tab?.id === undefined || !tab.url) return false
  try {
    const protocol = new URL(tab.url).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

async function mostRecentHttpTab(): Promise<chrome.tabs.Tab | undefined> {
  try {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] })
    tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))
    return tabs[0]
  } catch {
    return undefined
  }
}

async function ensureContextMenus(): Promise<void> {
  try {
    await chrome.contextMenus.removeAll()
    await chrome.contextMenus.create({
      id: CONTEXT_PANEL,
      title: '打开快捷控制面板',
      contexts: ['action'],
    })
    await chrome.contextMenus.create({
      id: CONTEXT_OPTIONS,
      title: '打开设置',
      contexts: ['action'],
    })
  } catch {
    // contextMenus may be unavailable in some test harnesses
  }
}

async function onFirstInstall(): Promise<void> {
  const settings = await loadSettings()
  const lens = formatHotkeyLabel(settings.hotkey)
  const page = formatHotkeyLabel(settings.pageTranslationHotkey)
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#2563eb' })
    await chrome.action.setBadgeText({ text: 'ON' })
    await chrome.action.setTitle({
      title: `Lens Translator\n点击图标：开关翻译透镜\n${lens} 透镜 · ${page} 整页`,
    })
  } catch {
    // badge APIs are best-effort
  }
  try {
    if (chrome.notifications?.create) {
      // 1×1 PNG data URL — notifications require an icon URL in some Chrome builds.
      const iconUrl =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
      await chrome.notifications.create('lens-install', {
        type: 'basic',
        iconUrl,
        title: 'Lens Translator 已安装',
        message: `默认使用 Chrome 内置翻译。点击扩展图标开关透镜；${lens} 临时/常驻透镜；${page} 整页双语。右键图标可打开控制面板与设置。`,
        priority: 2,
      })
    }
  } catch {
    // notifications permission may be absent
  }
  await openOptionsPage('#onboarding')
  // Clear the install badge after the user has a chance to notice it.
  setTimeout(() => {
    void chrome.action.setBadgeText({ text: '' })
  }, 12_000)
}

async function openOptionsPage(hash = ''): Promise<boolean> {
  try {
    const url = chrome.runtime.getURL(`src/options/index.html${hash || ''}`)
    if (hash) {
      // Hash routes (e.g. #onboarding) need an explicit tab URL; openOptionsPage ignores hash.
      await chrome.tabs.create({ url })
      return true
    }
    try {
      await chrome.runtime.openOptionsPage()
      return true
    } catch {
      await chrome.tabs.create({ url })
      return true
    }
  } catch {
    return false
  }
}

async function toggleLensInTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'toggle-lens' })
  } catch {
    const files = (chrome.runtime.getManifest().content_scripts ?? []).flatMap((s) => s.js ?? [])
    if (!files.length) return
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files })
      await new Promise((r) => setTimeout(r, 120))
      await chrome.tabs.sendMessage(tabId, { type: 'toggle-lens' })
    } catch {
      // Restricted pages reject injection.
    }
  }
}

async function injectIntoOpenTabs(): Promise<void> {
  const files = (chrome.runtime.getManifest().content_scripts ?? []).flatMap((s) => s.js ?? [])
  if (!files.length) return
  let tabs: chrome.tabs.Tab[]
  try {
    tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] })
  } catch {
    return
  }
  for (const tab of tabs) {
    if (tab.id === undefined) continue
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files,
      })
    } catch {
      // Restricted pages (Web Store, PDF viewer, other extensions) reject injection.
    }
  }
}

/** The only settings shape allowed to cross from the trusted background boundary. */
function settingsForContent(settings: UserSettings, hostname = ''): SettingsMsg {
  const {
    sourceLang,
    targetLang,
    autoTranslate,
    selectionTranslate,
    showFloatingBubble,
    inputTranslate,
    pageTranslationDisplayMode,
    pageTranslationFontFamily,
    pageTranslationFontSizePx,
    pageTranslationUseCustomColor,
    pageTranslationTextColor,
    pageTranslationUseBackground,
    pageTranslationBackgroundColor,
    pageTranslationBold,
    pageTranslationItalic,
    pageTranslationUnderline,
    lensWidthPx,
    minTextLength,
    batchCharLimit,
    prefetchMarginRatio,
    hotkey,
    pageTranslationHotkey,
  } = settings

  // Per-host rules are resolved here, at the trusted boundary, so content
  // scripts only ever see the effective result.
  const rule = hostname ? settings.siteRules[hostname.toLowerCase()] : undefined
  const engineOverride = rule?.engine
  const autoPageTranslation =
    rule?.autoPage === 'force-on'
      ? true
      : rule?.autoPage === 'force-off'
        ? false
        : settings.autoPageTranslation
  const translationEngine = engineOverride ?? settings.translationEngine
  const pageTranslationEngine = engineOverride ?? settings.pageTranslationEngine

  return {
    type: 'settings',
    settings: {
      sourceLang,
      targetLang,
      autoTranslate,
      translationEngine,
      pageTranslationEngine,
      autoPageTranslation,
      selectionTranslate,
      showFloatingBubble,
      inputTranslate,
      pageTranslationDisplayMode,
      pageTranslationFontFamily,
      pageTranslationFontSizePx,
      pageTranslationUseCustomColor,
      pageTranslationTextColor,
      pageTranslationUseBackground,
      pageTranslationBackgroundColor,
      pageTranslationBold,
      pageTranslationItalic,
      pageTranslationUnderline,
      lensWidthPx,
      minTextLength,
      batchCharLimit,
      prefetchMarginRatio,
      hotkey,
      pageTranslationHotkey,
      apiKey: '',
    },
    paused: hostname ? settings.pausedHostnames.includes(hostname) : false,
    configured: isConfigured(settings),
    siteRule: rule ? { ...(rule.autoPage ? { autoPage: rule.autoPage } : {}), ...(rule.engine ? { engine: rule.engine } : {}) } : null,
  }
}

function senderHostname(sender: chrome.runtime.MessageSender): string {
  if (!sender.tab?.url) return ''
  try {
    const url = new URL(sender.tab.url)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname : ''
  } catch {
    return ''
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

function isTranslateBlock(value: unknown): value is TranslateBlock {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    value.id.length <= 256 &&
    typeof value.tag === 'string' &&
    value.tag.length <= 64 &&
    typeof value.text === 'string' &&
    value.text.length <= 20_000
  )
}

/** Runtime validation prevents internal pages from turning the worker into an unbounded fetch proxy. */
function isToBackground(value: unknown): value is ToBackground {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'get-settings') return true
  if (value.type === 'close-translator-host') return true
  if (value.type === 'open-options') {
    return value.hash === undefined || (typeof value.hash === 'string' && value.hash.length <= 128)
  }
  if (value.type === 'set-hostname-paused') {
    return (
      typeof value.hostname === 'string' &&
      value.hostname.length > 0 &&
      value.hostname.length <= 253 &&
      typeof value.paused === 'boolean'
    )
  }
  if (value.type === 'translate-image') {
    return (
      typeof value.imageUrl === 'string' &&
      value.imageUrl.length > 0 &&
      value.imageUrl.length <= 5_500_000
    )
  }
  if (value.type === 'translate-batch') {
    if (
      typeof value.pageKey !== 'string' ||
      value.pageKey.length > 4096 ||
      !Array.isArray(value.blocks) ||
      value.blocks.length > 500
    ) {
      return false
    }
    // Optional language-pair override (input back-translation etc.).
    for (const lang of [value.sourceLang, value.targetLang]) {
      if (lang !== undefined && (typeof lang !== 'string' || !lang.length || lang.length > 32)) {
        return false
      }
    }
    if (value.forceRefresh !== undefined && typeof value.forceRefresh !== 'boolean') return false
    let totalChars = 0
    for (const block of value.blocks) {
      if (!isTranslateBlock(block)) return false
      totalChars += block.text.length
      if (totalChars > 500_000) return false
    }
    return true
  }
  if (value.type === 'translate-dict') {
    return (
      typeof value.text === 'string' &&
      value.text.length > 0 &&
      value.text.length <= 200 &&
      typeof value.sourceLanguage === 'string' &&
      value.sourceLanguage.length > 0 &&
      value.sourceLanguage.length <= 32 &&
      typeof value.targetLanguage === 'string' &&
      value.targetLanguage.length > 0 &&
      value.targetLanguage.length <= 32
    )
  }
  if (value.type === 'tts-speak') {
    return (
      typeof value.text === 'string' &&
      value.text.length > 0 &&
      value.text.length <= 4000 &&
      typeof value.lang === 'string' &&
      value.lang.length > 0 &&
      value.lang.length <= 32
    )
  }
  if (value.type === 'tts-stop') return true
  if (value.type === 'get-cache-stats' || value.type === 'clear-translation-cache') return true
  if (value.type === 'test-connection' || value.type === 'test-vision') {
    return (
      typeof value.baseURL === 'string' &&
      value.baseURL.length <= 2048 &&
      typeof value.apiKey === 'string' &&
      value.apiKey.length <= 512 &&
      typeof value.model === 'string' &&
      value.model.length <= 256 &&
      (value.provider === 'auto' ||
        value.provider === 'openai' ||
        value.provider === 'deepseek' ||
        value.provider === 'stepfun' ||
        value.provider === 'alibaba') &&
      (value.reasoningPref === 'off' ||
        value.reasoningPref === 'low' ||
        value.reasoningPref === 'medium' ||
        value.reasoningPref === 'high')
    )
  }
  if (value.type === 'list-models') {
    return (
      typeof value.baseURL === 'string' &&
      value.baseURL.length <= 2048 &&
      typeof value.apiKey === 'string' &&
      value.apiKey.length <= 512
    )
  }
  if (value.type === 'browser-translator') {
    if (value.op === 'is-supported') return true
    if (
      (value.op === 'availability' || value.op === 'prepare') &&
      typeof value.sourceLanguage === 'string' &&
      value.sourceLanguage.length > 0 &&
      value.sourceLanguage.length <= 32 &&
      typeof value.targetLanguage === 'string' &&
      value.targetLanguage.length > 0 &&
      value.targetLanguage.length <= 32
    ) {
      return true
    }
    if (
      value.op === 'translate' &&
      typeof value.text === 'string' &&
      value.text.length <= 50_000 &&
      typeof value.sourceLanguage === 'string' &&
      value.sourceLanguage.length > 0 &&
      value.sourceLanguage.length <= 32 &&
      typeof value.targetLanguage === 'string' &&
      value.targetLanguage.length > 0 &&
      value.targetLanguage.length <= 32
    ) {
      return true
    }
    return false
  }
  return false
}

async function handle(
  message: ToBackground,
  sender: chrome.runtime.MessageSender,
): Promise<FromBackground> {
  if (message.type === 'get-settings') {
    const settings = await loadSettings()
    return settingsForContent(settings, senderHostname(sender))
  }

  if (message.type === 'set-hostname-paused') {
    const settings = await loadSettings()
    const set = new Set(settings.pausedHostnames)
    if (message.paused) set.add(message.hostname)
    else set.delete(message.hostname)
    const next = { ...settings, pausedHostnames: [...set] }
    await saveSettings(next)
    return settingsForContent(next, message.hostname)
  }

  if (message.type === 'open-options') {
    const ok = await openOptionsPage(message.hash ?? '')
    return { type: 'open-options-result', ok }
  }

  if (message.type === 'browser-translator') {
    return handleBrowserTranslatorRequest(message)
  }

  if (message.type === 'close-translator-host') {
    return handleCloseTranslatorHost(sender)
  }

  if (message.type === 'translate-image') {
    const settings = await loadSettings()
    if (!isConfigured(settings)) {
      return {
        type: 'translate-image-result',
        ok: false,
        error: '图片翻译需要外部多模态模型：请先配置 Base URL、API Key 与支持 image 的模型',
      }
    }
    const result = await translateImage(message.imageUrl, settings)
    return result.ok
      ? { type: 'translate-image-result', ok: true, translation: result.translation }
      : { type: 'translate-image-result', ok: false, error: result.error }
  }

  if (message.type === 'tts-speak') {
    return ttsSpeak(message.text, message.lang)
  }

  if (message.type === 'tts-stop') {
    try {
      chrome.tts?.stop()
    } catch {
      // tts unavailable on this platform
    }
    return { type: 'tts-speak-result', ok: true }
  }

  if (message.type === 'translate-dict') {
    const settings = await loadSettings()
    if (!isConfigured(settings)) {
      return {
        type: 'translate-dict-result',
        ok: false,
        error: '词典模式需要配置外部 API',
      }
    }
    await ensureCacheHydrated()
    const result = await translateDictionaryEntry(
      message.text,
      message.sourceLanguage,
      message.targetLanguage,
      settings,
    )
    return result.ok
      ? { type: 'translate-dict-result', ok: true, entry: result.entry }
      : { type: 'translate-dict-result', ok: false, error: result.error }
  }

  if (message.type === 'translate-batch') {
    const settings = await loadSettings()
    if (!isConfigured(settings)) {
      return {
        type: 'translate-batch-result',
        ok: false,
        error: 'API not configured',
        failedIds: message.blocks.map((b) => b.id),
      }
    }

    const sourceLang =
      message.sourceLang ?? (settings.sourceLang === 'auto' ? 'en' : settings.sourceLang)
    const targetLang = message.targetLang ?? settings.targetLang
    // Overrides must reach the prompt, not only the cache key — carry them in
    // the settings object handed to the translation pipeline.
    const effectiveSettings = { ...settings, sourceLang, targetLang }

    await ensureCacheHydrated()
    const result = await translateBatchWithCaches({
      pageKey: message.pageKey,
      sourceLang,
      targetLang,
      blocks: message.blocks,
      settings: effectiveSettings,
      forceRefresh: message.forceRefresh,
    })
    if (result.translations.length) await persistTranslationCache()

    if (result.ok) {
      return { type: 'translate-batch-result', ok: true, translations: result.translations }
    }
    return {
      type: 'translate-batch-result',
      ok: false,
      error: result.error,
      failedIds: result.failedIds,
      translations: result.translations,
    }
  }

  if (message.type === 'get-cache-stats' || message.type === 'clear-translation-cache') {
    // Cache management is a settings-surface feature, same trust rule as list-models.
    if (!sender.url?.startsWith(chrome.runtime.getURL(''))) {
      return {
        type: message.type === 'get-cache-stats' ? 'cache-stats-result' : 'clear-translation-cache-result',
        ok: false,
        error: '仅设置页可管理翻译缓存',
      }
    }
    if (message.type === 'get-cache-stats') {
      const overview = await translationCacheOverview()
      return { type: 'cache-stats-result', ok: true, ...overview }
    }
    await clearAllTranslationCaches()
    return { type: 'clear-translation-cache-result', ok: true }
  }

  if (message.type === 'list-models') {
    // Same trusted-origin rule as the connectivity tests: the key may be unsaved.
    if (!sender.url?.startsWith(chrome.runtime.getURL(''))) {
      return { type: 'list-models-result', ok: false, error: '仅设置页可获取模型列表' }
    }
    const stored = await loadSettings()
    const result = await listAvailableModels(
      message.baseURL.trim(),
      message.apiKey.trim() || stored.apiKey,
    )
    return result.ok
      ? { type: 'list-models-result', ok: true, models: result.models }
      : { type: 'list-models-result', ok: false, error: result.error }
  }

  if (message.type === 'test-connection' || message.type === 'test-vision') {
    // Only extension-origin pages may supply an arbitrary endpoint/key. This also
    // permits the isolated floating controller iframe embedded in a normal tab.
    if (!sender.url?.startsWith(chrome.runtime.getURL(''))) {
      return {
        type: message.type === 'test-vision' ? 'test-vision-result' : 'test-connection-result',
        ok: false,
        error: '仅设置页可发起连通性测试',
      }
    }
    const stored = await loadSettings()
    const probe: UserSettings = {
      ...stored,
      baseURL: message.baseURL.trim(),
      apiKey: message.apiKey.trim() || stored.apiKey,
      model: message.model.trim(),
      provider: message.provider,
      reasoningPref: message.reasoningPref,
    }
    const missing = missingConfigFields(probe)
    if (missing.length) {
      return {
        type: message.type === 'test-vision' ? 'test-vision-result' : 'test-connection-result',
        ok: false,
        error: `请先填写 ${missing.join('、')}`,
      }
    }
    if (message.type === 'test-vision') {
      const result = await testVisionCapability(probe)
      return result.ok
        ? { type: 'test-vision-result', ok: true }
        : { type: 'test-vision-result', ok: false, error: result.error }
    }
    const result = await testConnection(probe)
    return result.ok
      ? { type: 'test-connection-result', ok: true }
      : { type: 'test-connection-result', ok: false, error: result.error }
  }

  return { type: 'translate-batch-result', ok: false, error: 'unknown message' }
}

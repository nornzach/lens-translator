import { translatorLanguageTagCandidates } from './languages'

type TranslatorAvailability = 'available' | 'downloadable' | 'downloading' | 'unavailable'
export type BrowserTranslatorAvailability = TranslatorAvailability | 'unsupported'
export type BrowserTranslatorDownloadProgress = (progress: number) => void

type TranslatorSession = {
  translate(text: string): Promise<string>
  destroy?(): void
}

type TranslatorApi = {
  availability(options: {
    sourceLanguage: string
    targetLanguage: string
  }): Promise<TranslatorAvailability>
  create(options: {
    sourceLanguage: string
    targetLanguage: string
    monitor?: (monitor: {
      addEventListener(
        type: 'downloadprogress',
        listener: (event: { loaded: number }) => void,
      ): void
    }) => void
  }): Promise<TranslatorSession>
}

type TranslatorGlobal = typeof globalThis & { Translator?: TranslatorApi }

type ResolvedPair = {
  source: string
  target: string
  availability: TranslatorAvailability
}

function isUsable(availability: TranslatorAvailability): boolean {
  return (
    availability === 'available' ||
    availability === 'downloadable' ||
    availability === 'downloading'
  )
}

/**
 * Direct adapter around Chrome's on-device Translator API.
 * Must run in a document context that is allowed to use Translator
 * (normal pages, top-level extension pages — not offscreen documents,
 * which throw "The on-device translation is not available").
 */
export class BrowserTranslatorCore {
  private session: TranslatorSession | null = null
  private languagePair = ''
  private operations: Promise<void> = Promise.resolve()
  /** Last failure detail from create/translate (for diagnostics). */
  lastError: string | null = null

  isSupported(): boolean {
    return Boolean((globalThis as TranslatorGlobal).Translator)
  }

  /** Prepare one language pair without racing an active translation or session replacement. */
  prepare(
    sourceLanguage: string,
    targetLanguage: string,
    onDownloadProgress?: BrowserTranslatorDownloadProgress,
  ): Promise<boolean> {
    return this.runExclusive(() =>
      this.prepareNow(sourceLanguage, targetLanguage, onDownloadProgress),
    )
  }

  async availability(
    sourceLanguage: string,
    targetLanguage: string,
  ): Promise<BrowserTranslatorAvailability> {
    const api = (globalThis as TranslatorGlobal).Translator
    if (!api) return 'unsupported'
    try {
      const resolved = await this.resolvePair(api, sourceLanguage, targetLanguage)
      return resolved?.availability ?? 'unavailable'
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      return 'unavailable'
    }
  }

  /** Translate on device; unsupported pairs and browser failures return null to the caller. */
  translate(
    text: string,
    sourceLanguage: string,
    targetLanguage: string,
  ): Promise<string | null> {
    return this.runExclusive(async () => {
      if (!(await this.prepareNow(sourceLanguage, targetLanguage))) return null
      try {
        const translation = await this.session?.translate(text)
        this.lastError = null
        return translation?.trim() || null
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error)
        return null
      }
    })
  }

  private async prepareNow(
    sourceLanguage: string,
    targetLanguage: string,
    onDownloadProgress?: BrowserTranslatorDownloadProgress,
  ): Promise<boolean> {
    const api = (globalThis as TranslatorGlobal).Translator
    if (!api) {
      this.lastError = 'Translator API missing in this context'
      return false
    }

    const resolved = await this.resolvePair(api, sourceLanguage, targetLanguage)
    if (!resolved) {
      const sources = translatorLanguageTagCandidates(sourceLanguage).join('|')
      const targets = translatorLanguageTagCandidates(targetLanguage).join('|')
      this.lastError = `Chrome 内置翻译不支持该语言对（尝试了 ${sources} → ${targets}）。可换语言或改用外部 LLM。`
      return false
    }

    const pair = `${resolved.source}\0${resolved.target}`
    if (this.session && this.languagePair === pair) return true
    return this.createSession(
      api,
      resolved.source,
      resolved.target,
      pair,
      onDownloadProgress,
    )
  }

  /**
   * Probe candidate BCP-47 tags until Chrome reports a usable pair.
   * Critical for Chinese: some builds accept `zh`, others only `zh-Hans` / `zh-CN`.
   */
  private async resolvePair(
    api: TranslatorApi,
    sourceLanguage: string,
    targetLanguage: string,
  ): Promise<ResolvedPair | null> {
    const sources = translatorLanguageTagCandidates(sourceLanguage)
    const targets = translatorLanguageTagCandidates(targetLanguage)

    for (const source of sources) {
      for (const target of targets) {
        if (source === target) continue
        try {
          const availability = await api.availability({
            sourceLanguage: source,
            targetLanguage: target,
          })
          if (isUsable(availability)) {
            return { source, target, availability }
          }
        } catch (error) {
          this.lastError = error instanceof Error ? error.message : String(error)
        }
      }
    }
    return null
  }

  private async createSession(
    api: TranslatorApi,
    sourceLanguage: string,
    targetLanguage: string,
    pair: string,
    onDownloadProgress?: BrowserTranslatorDownloadProgress,
  ): Promise<boolean> {
    try {
      // create() triggers language-pack download when status is downloadable.
      const next = await api.create({
        sourceLanguage,
        targetLanguage,
        ...(onDownloadProgress
          ? {
              monitor: (monitor: {
                addEventListener(
                  type: 'downloadprogress',
                  listener: (event: { loaded: number }) => void,
                ): void
              }) => {
                monitor.addEventListener('downloadprogress', (event) => {
                  onDownloadProgress(Math.max(0, Math.min(1, event.loaded)))
                })
              },
            }
          : {}),
      })
      this.session?.destroy?.()
      this.session = next
      this.languagePair = pair
      this.lastError = null
      return true
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.session = null
      this.languagePair = ''
      return false
    }
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation, operation)
    this.operations = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

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

/**
 * Small adapter around Chrome's on-device Translator API. It intentionally
 * keeps only one language-pair session: the extension has one active pair,
 * and Chrome processes translations for a session sequentially anyway.
 */
export class BrowserTranslator {
  private session: TranslatorSession | null = null
  private languagePair = ''
  private operations: Promise<void> = Promise.resolve()

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
    if (sourceLanguage === targetLanguage) return 'unavailable'
    try {
      return await api.availability({ sourceLanguage, targetLanguage })
    } catch {
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
        return translation?.trim() || null
      } catch {
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
    const pair = `${sourceLanguage}\0${targetLanguage}`
    if (!api || sourceLanguage === targetLanguage) return false
    if (this.session && this.languagePair === pair) return true
    return this.createSession(api, sourceLanguage, targetLanguage, pair, onDownloadProgress)
  }

  private async createSession(
    api: TranslatorApi,
    sourceLanguage: string,
    targetLanguage: string,
    pair: string,
    onDownloadProgress?: BrowserTranslatorDownloadProgress,
  ): Promise<boolean> {
    try {
      const availability = await api.availability({ sourceLanguage, targetLanguage })
      if (availability === 'unavailable') return false

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
      return true
    } catch {
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

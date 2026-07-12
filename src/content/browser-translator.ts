type TranslatorAvailability = 'available' | 'downloadable' | 'downloading' | 'unavailable'

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
  private preparing: Promise<boolean> | null = null

  isSupported(): boolean {
    return Boolean((globalThis as TranslatorGlobal).Translator)
  }

  async prepare(sourceLanguage: string, targetLanguage: string): Promise<boolean> {
    const api = (globalThis as TranslatorGlobal).Translator
    const pair = `${sourceLanguage}\0${targetLanguage}`
    if (!api || sourceLanguage === targetLanguage) return false
    if (this.session && this.languagePair === pair) return true
    if (this.preparing) return this.preparing

    this.preparing = this.createSession(api, sourceLanguage, targetLanguage, pair)
    try {
      return await this.preparing
    } finally {
      this.preparing = null
    }
  }

  async translate(
    text: string,
    sourceLanguage: string,
    targetLanguage: string,
  ): Promise<string | null> {
    if (!(await this.prepare(sourceLanguage, targetLanguage))) return null
    try {
      const translation = await this.session?.translate(text)
      return translation?.trim() || null
    } catch {
      return null
    }
  }

  private async createSession(
    api: TranslatorApi,
    sourceLanguage: string,
    targetLanguage: string,
    pair: string,
  ): Promise<boolean> {
    try {
      const availability = await api.availability({ sourceLanguage, targetLanguage })
      if (availability === 'unavailable') return false

      const next = await api.create({ sourceLanguage, targetLanguage })
      this.session?.destroy?.()
      this.session = next
      this.languagePair = pair
      return true
    } catch {
      return false
    }
  }
}

export type ImageTranslationStatus = 'pending' | 'ready' | 'error'

export type ImageTranslationEntry = {
  id: string
  el: HTMLImageElement
  url: string
  status: ImageTranslationStatus
  translation?: string
  error?: string
}

/** Bounded page-local image state; identical resource URLs share one translation. */
export class ImageRegistry {
  private byId = new Map<string, ImageTranslationEntry>()
  private byUrl = new Map<string, string>()
  private readonly maxEntries: number
  private readonly maxTranslations: number

  constructor(maxEntries = 300, maxTranslations = 500) {
    this.maxEntries = Math.max(1, maxEntries)
    this.maxTranslations = Math.max(1, maxTranslations)
  }

  upsert(id: string, el: HTMLImageElement, url: string): ImageTranslationEntry {
    const existing = this.byId.get(id)
    if (!existing) this.makeRoom()
    const cached = this.byUrl.get(url)
    const next: ImageTranslationEntry = {
      id,
      el,
      url,
      status: existing?.status ?? (cached ? 'ready' : 'pending'),
      translation: existing?.translation ?? cached,
      error: existing?.error,
    }
    if (next.translation) next.error = undefined
    this.byId.set(id, next)
    return next
  }

  get(id: string): ImageTranslationEntry | undefined {
    return this.byId.get(id)
  }

  setPending(id: string): void {
    const entry = this.byId.get(id)
    if (!entry) return
    entry.status = 'pending'
    entry.error = undefined
  }

  setTranslation(id: string, translation: string): void {
    const entry = this.byId.get(id)
    if (!entry) return
    this.byUrl.delete(entry.url)
    this.byUrl.set(entry.url, translation)
    while (this.byUrl.size > this.maxTranslations) {
      const oldest = this.byUrl.keys().next().value
      if (oldest === undefined) break
      this.byUrl.delete(oldest)
    }
    for (const other of this.byId.values()) {
      if (other.url !== entry.url) continue
      other.translation = translation
      other.status = 'ready'
      other.error = undefined
    }
  }

  setError(id: string, error: string): void {
    const entry = this.byId.get(id)
    if (!entry || entry.translation) return
    entry.status = 'error'
    entry.error = error
  }

  private makeRoom(): void {
    if (this.byId.size < this.maxEntries) return
    for (const [id, entry] of this.byId) {
      if (!entry.el.isConnected) this.byId.delete(id)
    }
    while (this.byId.size >= this.maxEntries) {
      const oldest = this.byId.keys().next().value
      if (oldest === undefined) break
      this.byId.delete(oldest)
    }
  }
}

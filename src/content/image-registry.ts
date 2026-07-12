export type ImageTranslationStatus = 'pending' | 'ready' | 'error'

export type ImageTranslationEntry = {
  id: string
  el: HTMLImageElement
  url: string
  status: ImageTranslationStatus
  translation?: string
  error?: string
}

/** Tracks image translation state separately from text blocks. */
export class ImageRegistry {
  private byId = new Map<string, ImageTranslationEntry>()
  private byImage = new WeakMap<HTMLImageElement, string>()
  private byUrl = new Map<string, string>()

  upsert(id: string, el: HTMLImageElement, url: string): ImageTranslationEntry {
    const existing = this.byId.get(id)
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
    this.byImage.set(el, id)
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
    this.byUrl.set(entry.url, translation)
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
}

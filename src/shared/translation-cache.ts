/**
 * Bounded LRU cache for translation strings.
 * Evicts least-recently-used entries when over maxEntries or maxTotalChars.
 */
export type TranslationCacheOptions = {
  /** Max number of entries (default 2500). */
  maxEntries?: number
  /**
   * Approx budget for stored characters (source key material is not stored;
   * we count translation string length). Default ~800k chars.
   */
  maxTotalChars?: number
}

export class TranslationCache {
  private readonly maxEntries: number
  private readonly maxTotalChars: number
  /** key → translation; Map iteration order = insertion order (LRU via re-insert). */
  private readonly map = new Map<string, string>()
  private totalChars = 0

  constructor(opts: TranslationCacheOptions = {}) {
    this.maxEntries = opts.maxEntries ?? 2500
    this.maxTotalChars = opts.maxTotalChars ?? 800_000
  }

  get size(): number {
    return this.map.size
  }

  get charCount(): number {
    return this.totalChars
  }

  get(key: string): string | undefined {
    const v = this.map.get(key)
    if (v === undefined) return undefined
    // refresh LRU
    this.map.delete(key)
    this.map.set(key, v)
    return v
  }

  set(key: string, translation: string): void {
    const prev = this.map.get(key)
    if (prev !== undefined) {
      this.totalChars -= prev.length
      this.map.delete(key)
    }
    this.map.set(key, translation)
    this.totalChars += translation.length
    this.evict()
  }


  clear(): void {
    this.map.clear()
    this.totalChars = 0
  }

  /** Snapshot entries in LRU order (oldest first) for persistence. */
  entries(): [string, string][] {
    return [...this.map.entries()]
  }

  /** Replace contents from a persisted snapshot; capacity limits still apply. */
  load(entries: Iterable<[string, string]>): void {
    this.clear()
    for (const [key, value] of entries) {
      if (typeof key === 'string' && typeof value === 'string') this.set(key, value)
    }
  }


  private evict(): void {
    while (
      this.map.size > this.maxEntries ||
      this.totalChars > this.maxTotalChars
    ) {
      const oldest = this.map.keys().next().value as string | undefined
      if (oldest === undefined) break
      const val = this.map.get(oldest)
      this.map.delete(oldest)
      if (val !== undefined) this.totalChars -= val.length
    }
    if (this.totalChars < 0) this.totalChars = 0
  }
}

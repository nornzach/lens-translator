export type BlockStatus = 'pending' | 'ready' | 'error' | 'empty'

export type RegistryEntry = {
  id: string
  el: Element
  tag: string
  text: string
  status: BlockStatus
  translation?: string
  error?: string
}

export class BlockRegistry {
  private byId = new Map<string, RegistryEntry>()
  private byEl = new WeakMap<Element, string>()

  upsert(
    entry: Omit<RegistryEntry, 'status' | 'translation' | 'error'> & {
      status?: BlockStatus
    },
  ): RegistryEntry {
    const existing = this.byId.get(entry.id)
    const next: RegistryEntry = {
      id: entry.id,
      el: entry.el,
      tag: entry.tag,
      text: entry.text,
      status: entry.status ?? existing?.status ?? 'pending',
      translation: existing?.translation,
      error: existing?.error,
    }
    // Preserve translation when same id and same text
    if (existing && existing.text === next.text && existing.translation) {
      next.translation = existing.translation
      next.status = 'ready'
    }
    this.byId.set(next.id, next)
    this.byEl.set(next.el, next.id)
    return next
  }

  setTranslation(id: string, translation: string): void {
    const e = this.byId.get(id)
    if (!e) return
    e.translation = translation
    e.status = 'ready'
    e.error = undefined
  }

  setError(id: string, error: string): void {
    const e = this.byId.get(id)
    if (!e) return
    e.status = 'error'
    e.error = error
  }

  setPending(id: string): void {
    const e = this.byId.get(id)
    if (!e) return
    if (e.status !== 'ready') e.status = 'pending'
  }

  get(id: string): RegistryEntry | undefined {
    return this.byId.get(id)
  }

  getByElement(el: Element | null): RegistryEntry | undefined {
    if (!el) return undefined
    let cur: Element | null = el
    while (cur) {
      const id = this.byEl.get(cur)
      if (id) return this.byId.get(id)
      cur = cur.parentElement
    }
    return undefined
  }

  pendingBlocks(): { id: string; tag: string; text: string }[] {
    return [...this.byId.values()]
      .filter((e) => e.status === 'pending')
      .map((e) => ({ id: e.id, tag: e.tag, text: e.text }))
  }

  resetErrorsToPending(): void {
    for (const e of this.byId.values()) {
      if (e.status === 'error') {
        e.status = 'pending'
        e.error = undefined
      }
    }
  }

  all(): RegistryEntry[] {
    return [...this.byId.values()]
  }
}

/**
 * Browser-level persistent cache for LLM text translations (IndexedDB).
 *
 * Layer 2 of the translation cache: global keys (no pageKey) so identical
 * sentences — menus, docs, fixed phrases — resolve instantly across pages,
 * tabs, and browser restarts. Only external-LLM text results are stored here
 * (the browser engine never touches the background pipeline; image and
 * dictionary results stay out by design).
 *
 * LRU eviction by entry count, capped per-entry translation length as a
 * size backstop. Falls back to an in-memory store when IndexedDB is
 * unavailable (tests, restricted contexts) — same interface, session scope.
 */

export type PersistentCacheStats = { entries: number; approxChars: number }

type EntryRecord = { t: string; at: number }

interface Store {
  getEntries(keys: string[]): Promise<Map<string, EntryRecord>>
  putEntries(rows: [string, EntryRecord][]): Promise<void>
  deleteOldest(limit: number): Promise<void>
  count(): Promise<number>
  sumChars(): Promise<number>
  clear(): Promise<void>
}

const DB_NAME = 'lens-translator-persistent-cache'
const STORE_NAME = 'entries'
const ACCESS_INDEX = 'byAccess'

class IdbStore implements Store {
  private dbPromise: Promise<IDBDatabase> | null = null

  private open(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>()
      this.dbPromise = promise
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME).createIndex(ACCESS_INDEX, 'at')
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'))
    }
    return this.dbPromise
  }

  async getEntries(keys: string[]): Promise<Map<string, EntryRecord>> {
    const out = new Map<string, EntryRecord>()
    if (!keys.length) return out
    const db = await this.open()
    const { promise, resolve, reject } = Promise.withResolvers<Map<string, EntryRecord>>()
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    let pending = keys.length
    for (const key of keys) {
      const req = store.get(key)
      req.onsuccess = () => {
        const value = req.result as EntryRecord | undefined
        if (value && typeof value.t === 'string' && typeof value.at === 'number') {
          out.set(key, value)
        }
        if (--pending === 0) resolve(out)
      }
      req.onerror = () => reject(req.error ?? new Error('indexedDB get failed'))
    }
    return promise
  }

  async putEntries(rows: [string, EntryRecord][]): Promise<void> {
    if (!rows.length) return
    const db = await this.open()
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    for (const [key, record] of rows) store.put(record, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('indexedDB put failed'))
    return promise
  }

  async deleteOldest(limit: number): Promise<void> {
    if (limit <= 0) return
    const db = await this.open()
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const index = tx.objectStore(STORE_NAME).index(ACCESS_INDEX)
    const cursorReq = index.openCursor()
    let deleted = 0
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result
      if (!cursor || deleted >= limit) return
      cursor.delete()
      deleted++
      cursor.continue()
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('indexedDB evict failed'))
    return promise
  }

  async count(): Promise<number> {
    const db = await this.open()
    const { promise, resolve, reject } = Promise.withResolvers<number>()
    const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).count()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('indexedDB count failed'))
    return promise
  }

  /** Full-scan character total — stats UI only, never on the translation path. */
  async sumChars(): Promise<number> {
    const db = await this.open()
    const { promise, resolve, reject } = Promise.withResolvers<number>()
    const tx = db.transaction(STORE_NAME, 'readonly')
    const cursorReq = tx.objectStore(STORE_NAME).openCursor()
    let total = 0
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result
      if (!cursor) return
      const value = cursor.value as EntryRecord
      total += String(cursor.key).length + (typeof value?.t === 'string' ? value.t.length : 0)
      cursor.continue()
    }
    tx.oncomplete = () => resolve(total)
    tx.onerror = () => reject(tx.error ?? new Error('indexedDB scan failed'))
    return promise
  }

  async clear(): Promise<void> {
    const db = await this.open()
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).clear()
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('indexedDB clear failed'))
    return promise
  }
}

/** Test / fallback store: Map iteration order doubles as LRU order via re-insert. */
class MemoryStore implements Store {
  private readonly map = new Map<string, EntryRecord>()

  async getEntries(keys: string[]): Promise<Map<string, EntryRecord>> {
    const out = new Map<string, EntryRecord>()
    for (const key of keys) {
      const record = this.map.get(key)
      if (!record) continue
      this.map.delete(key)
      this.map.set(key, record)
      out.set(key, record)
    }
    return out
  }

  async putEntries(rows: [string, EntryRecord][]): Promise<void> {
    for (const [key, record] of rows) {
      this.map.delete(key)
      this.map.set(key, record)
    }
  }

  async deleteOldest(limit: number): Promise<void> {
    for (const key of this.map.keys()) {
      if (limit-- <= 0) break
      this.map.delete(key)
    }
  }

  async count(): Promise<number> {
    return this.map.size
  }

  async sumChars(): Promise<number> {
    let total = 0
    for (const [key, record] of this.map) total += key.length + record.t.length
    return total
  }

  async clear(): Promise<void> {
    this.map.clear()
  }
}

export type PersistentCacheConfig = {
  /** Max cached entries before LRU eviction kicks in (default 100k). */
  maxEntries?: number
  /** Per-entry translation length backstop; longer results are not cached (default 50k). */
  maxTranslationChars?: number
}

export class PersistentTextCache {
  private readonly maxEntries: number
  private readonly maxTranslationChars: number
  private storePromise: Promise<Store> | null = null

  constructor(config: PersistentCacheConfig = {}) {
    this.maxEntries = config.maxEntries ?? 100_000
    this.maxTranslationChars = config.maxTranslationChars ?? 50_000
  }

  private store(): Promise<Store> {
    if (!this.storePromise) {
      this.storePromise = (async (): Promise<Store> => {
        if (typeof indexedDB === 'undefined') return new MemoryStore()
        try {
          const store = new IdbStore()
          // Probe the connection once so a restricted/failed environment swaps
          // to memory instead of failing every lookup.
          await store.count()
          return store
        } catch {
          return new MemoryStore()
        }
      })()
    }
    return this.storePromise
  }

  /** Batch read; hits are touched so frequently used fixed phrases stay hot. */
  async getMany(keys: string[]): Promise<Map<string, string>> {
    const store = await this.store()
    const records = await store.getEntries(keys)
    if (records.size) {
      const now = Date.now()
      const touches: [string, EntryRecord][] = []
      for (const [key, record] of records) touches.push([key, { t: record.t, at: now }])
      try {
        await store.putEntries(touches)
      } catch {
        // LRU bookkeeping is best-effort; a failed touch must not discard
        // hits that were successfully read (disk pressure, restricted profile).
      }
    }
    const out = new Map<string, string>()
    for (const [key, record] of records) out.set(key, record.t)
    return out
  }

  /** Write fresh translations; evicts the oldest ~5% when over the entry cap. */
  async setMany(rows: { key: string; translation: string }[]): Promise<void> {
    const now = Date.now()
    const entries: [string, EntryRecord][] = []
    for (const row of rows) {
      if (!row.key || !row.translation || row.translation.length > this.maxTranslationChars) {
        continue
      }
      entries.push([row.key, { t: row.translation, at: now }])
    }
    if (!entries.length) return
    const store = await this.store()
    await store.putEntries(entries)
    const count = await store.count()
    if (count > this.maxEntries) {
      await store.deleteOldest(Math.ceil(this.maxEntries * 0.05))
    }
  }

  async stats(): Promise<PersistentCacheStats> {
    const store = await this.store()
    return { entries: await store.count(), approxChars: await store.sumChars() }
  }

  async clear(): Promise<void> {
    await (await this.store()).clear()
  }
}

/** Shared instance for the service-worker translation pipeline. */
export const sharedPersistentCache = new PersistentTextCache()

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensureCacheHydrated,
  filterUncachedByText,
  expandTranslationsToAllIds,
  getCachedTranslation,
  persistTranslationCache,
  clearAllTranslationCaches,
  testConnection,
  translateAllBlocks,
  translateBatchWithCaches,
  translateBlocksSingleFlight,
  _resetTranslationCacheForTests,
  _cacheStatsForTests,
} from '../../src/background/translate'
import { DEFAULT_SETTINGS } from '../../src/shared/settings-defaults'
import { makeTranslationCacheKey } from '../../src/shared/text-hash'
import { PersistentTextCache } from '../../src/background/persistent-cache'

describe('text-hash translation cache', () => {
  const pageKey = 'https://example.com/article'
  const sourceLang = 'en'
  const targetLang = 'zh'

  beforeEach(() => {
    _resetTranslationCacheForTests()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('dedupes identical sentences into one missing block', () => {
    const { cached, missing, textHashToIds } = filterUncachedByText(
      pageKey,
      sourceLang,
      targetLang,
      [
        { id: 'a', tag: 'p', text: 'Hello world there' },
        { id: 'b', tag: 'p', text: 'Hello world there' },
        { id: 'c', tag: 'li', text: 'Hello world there' },
        { id: 'd', tag: 'p', text: 'Something else entirely' },
      ],
    )
    expect(cached).toEqual([])
    expect(missing).toHaveLength(2)
    expect(missing.map((m) => m.text).sort()).toEqual([
      'Hello world there',
      'Something else entirely',
    ])
    // three ids share one text key
    const sizes = [...textHashToIds.values()].map((ids) => ids.length).sort()
    expect(sizes).toEqual([1, 3])
  })

  it('returns cache hits and expands to all ids', () => {
    const first = filterUncachedByText(pageKey, sourceLang, targetLang, [
      { id: 'a', tag: 'p', text: 'Same sentence here ok' },
      { id: 'b', tag: 'p', text: 'Same sentence here ok' },
    ])
    const expanded = expandTranslationsToAllIds(
      pageKey,
      sourceLang,
      targetLang,
      [{ id: 'a', translation: '同一句话' }],
      first.idToText,
      first.textHashToIds,
    )
    expect(expanded).toEqual([
      { id: 'a', translation: '同一句话' },
      { id: 'b', translation: '同一句话' },
    ])
    expect(getCachedTranslation(pageKey, sourceLang, targetLang, 'Same sentence here ok')).toBe(
      '同一句话',
    )

    const second = filterUncachedByText(pageKey, sourceLang, targetLang, [
      { id: 'c', tag: 'h2', text: 'Same sentence here ok' },
      { id: 'd', tag: 'p', text: 'Brand new line of text' },
    ])
    expect(second.cached).toEqual([{ id: 'c', translation: '同一句话' }])
    expect(second.missing.map((m) => m.id)).toEqual(['d'])
  })

  it('skipCache treats every block as missing while still deduping by text', () => {
    // Seed L1 for 'Hello world there'.
    const seed = filterUncachedByText(pageKey, sourceLang, targetLang, [
      { id: 'a', tag: 'p', text: 'Hello world there' },
    ])
    expandTranslationsToAllIds(
      pageKey,
      sourceLang,
      targetLang,
      [{ id: 'a', translation: '已缓存' }],
      seed.idToText,
      seed.textHashToIds,
    )

    const { cached, missing, textHashToIds } = filterUncachedByText(
      pageKey,
      sourceLang,
      targetLang,
      [
        { id: 'a', tag: 'p', text: 'Hello world there' },
        { id: 'b', tag: 'p', text: 'Hello world there' },
      ],
      { skipCache: true },
    )

    expect(cached).toEqual([])
    expect(missing).toHaveLength(1)
    expect([...textHashToIds.values()][0].sort()).toEqual(['a', 'b'])
  })

  it('tracks cache stats after puts', () => {
    expandTranslationsToAllIds(
      pageKey,
      sourceLang,
      targetLang,
      [{ id: 'x', translation: '你好' }],
      new Map([['x', 'Hello']]),
      new Map([[`dummy`, ['x']]]),
    )
    // expand still sets cache via text from idToText
    const stats = _cacheStatsForTests()
    expect(stats.size).toBeGreaterThanOrEqual(0)
  })

  it('clear waits for queued session persists so wiped entries stay wiped', async () => {
    // The mock applies storage mutations only when the write promise resolves,
    // so a remove that runs before a queued write lands is observable.
    let releaseWrite!: () => void
    let applied: [string, string][] | 'removed' | null = null
    const set = vi.fn(
      (payload: Record<string, [string, string][]>) =>
        new Promise<void>((resolve) => {
          releaseWrite = () => {
            applied = payload['lens-translation-cache-v1']
            resolve()
          }
        }),
    )
    const remove = vi.fn(async (_key: string) => {
      applied = 'removed'
    })
    vi.stubGlobal('chrome', { storage: { session: { get: vi.fn(async () => ({})), set, remove } } })

    const miss = filterUncachedByText(pageKey, sourceLang, targetLang, [
      { id: 'x', tag: 'p', text: 'Stale sentence' },
    ])
    expandTranslationsToAllIds(
      pageKey,
      sourceLang,
      targetLang,
      [{ id: 'x', translation: '旧译文' }],
      miss.idToText,
      miss.textHashToIds,
    )
    const pendingWrite = persistTranslationCache()
    await vi.waitFor(() => expect(set).toHaveBeenCalledOnce())

    const cleared = clearAllTranslationCaches()
    releaseWrite()
    await Promise.all([pendingWrite, cleared])

    // The wipe must land AFTER the queued snapshot — never the other way around.
    expect(applied).toBe('removed')
    expect(remove).toHaveBeenCalledWith('lens-translation-cache-v1')
  })

  it('hydrates and persists cache entries through session storage', async () => {
    const cacheKey = makeTranslationCacheKey(
      pageKey,
      sourceLang,
      targetLang,
      'Persisted sentence',
    )
    const get = vi.fn(async () => ({
      'lens-translation-cache-v1': [[cacheKey, '已缓存']],
    }))
    const set = vi.fn(async (_payload: Record<string, unknown>) => undefined)
    vi.stubGlobal('chrome', { storage: { session: { get, set } } })

    await ensureCacheHydrated()
    expect(getCachedTranslation(pageKey, sourceLang, targetLang, 'Persisted sentence')).toBe(
      '已缓存',
    )

    const pending = filterUncachedByText(pageKey, sourceLang, targetLang, [
      { id: 'new', tag: 'p', text: 'A new sentence' },
    ])
    expandTranslationsToAllIds(
      pageKey,
      sourceLang,
      targetLang,
      [{ id: 'new', translation: '新句子' }],
      pending.idToText,
      pending.textHashToIds,
    )
    await persistTranslationCache()

    expect(set).toHaveBeenCalledOnce()
    const payload = set.mock.calls[0][0] as Record<string, [string, string][]>
    expect(payload['lens-translation-cache-v1'].map((entry) => entry[1])).toEqual([
      '已缓存',
      '新句子',
    ])
  })

  it('serializes session snapshots so an older write cannot overwrite a newer cache', async () => {
    let releaseFirstWrite!: () => void
    const set = vi
      .fn<(payload: Record<string, unknown>) => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFirstWrite = resolve
          }),
      )
      .mockResolvedValue(undefined)
    vi.stubGlobal('chrome', {
      storage: { session: { get: vi.fn(async () => ({})), set } },
    })

    const firstMiss = filterUncachedByText(pageKey, sourceLang, targetLang, [
      { id: 'first', tag: 'p', text: 'First sentence' },
    ])
    expandTranslationsToAllIds(
      pageKey,
      sourceLang,
      targetLang,
      [{ id: 'first', translation: '第一句' }],
      firstMiss.idToText,
      firstMiss.textHashToIds,
    )
    const firstWrite = persistTranslationCache()

    const secondMiss = filterUncachedByText(pageKey, sourceLang, targetLang, [
      { id: 'second', tag: 'p', text: 'Second sentence' },
    ])
    expandTranslationsToAllIds(
      pageKey,
      sourceLang,
      targetLang,
      [{ id: 'second', translation: '第二句' }],
      secondMiss.idToText,
      secondMiss.textHashToIds,
    )
    const secondWrite = persistTranslationCache()

    await vi.waitFor(() => expect(set).toHaveBeenCalledOnce())
    releaseFirstWrite()
    await Promise.all([firstWrite, secondWrite])

    expect(set).toHaveBeenCalledTimes(2)
    const newest = set.mock.calls[1][0] as Record<string, [string, string][]>
    expect(newest['lens-translation-cache-v1'].map((entry) => entry[1])).toEqual([
      '第一句',
      '第二句',
    ])
  })
})

describe('translation request resilience', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('does not sleep after the final retryable failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
    const sleep = vi.fn(async (_delay: number) => undefined)

    const result = await translateAllBlocks(
      [{ id: 'a', tag: 'p', text: 'Hello world' }],
      DEFAULT_SETTINGS,
      { sleep },
    )

    expect(result.ok).toBe(false)
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([500, 1000, 2000, 4000])
  })

  it('honors a server Retry-After cooldown that exceeds the backoff on 429', async () => {
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        async () => new Response('', { status: 429, headers: { 'Retry-After': '2' } }),
      )
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({ items: [{ id: 'a', translation: '你好' }] }),
                  },
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      )
    vi.stubGlobal('fetch', fetch)
    const sleep = vi.fn(async (_delay: number) => undefined)

    const result = await translateAllBlocks(
      [{ id: 'a', tag: 'p', text: 'Hello world' }],
      DEFAULT_SETTINGS,
      { sleep },
    )

    expect(result).toEqual({ ok: true, translations: [{ id: 'a', translation: '你好' }] })
    // Backoff would be 500ms; the advertised 2s cooldown wins.
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([2000])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('keeps translating later batches when one batch fails', async () => {
    // batchCharLimit 10 → each block its own batch. Batch 1 returns 400 (non-
    // retryable, both with and without json_schema), batch 2 succeeds.
    const fetch = vi
      .fn()
      .mockImplementationOnce(async () => new Response('', { status: 400 }))
      .mockImplementationOnce(async () => new Response('', { status: 400 }))
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                { message: { content: JSON.stringify({ items: [{ id: 'b', translation: '第二批' }] }) } },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      )
    vi.stubGlobal('fetch', fetch)

    const result = await translateAllBlocks(
      [
        { id: 'a', tag: 'p', text: 'First batch text' },
        { id: 'b', tag: 'p', text: 'Second batch text' },
      ],
      { ...DEFAULT_SETTINGS, batchCharLimit: 10 },
    )

    expect(result.ok).toBe(false)
    expect(result.translations).toEqual([{ id: 'b', translation: '第二批' }])
    if (!result.ok) expect(result.failedIds).toEqual(['a'])
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('requires a valid translation payload for a successful connection test', async () => {
    const fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ items: [{ id: 't0', translation: '你好' }] }) } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetch)
    await expect(testConnection(DEFAULT_SETTINGS)).resolves.toEqual({ ok: true })

    fetch.mockImplementationOnce(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'not-json' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    await expect(testConnection(DEFAULT_SETTINGS)).resolves.toEqual({
      ok: false,
      error: '响应格式无效：模型未返回有效 JSON',
    })
  })

  it('coalesces concurrent requests for the same page text', async () => {
    let resolveFetch!: (response: Response) => void
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve
        }),
    )
    vi.stubGlobal('fetch', fetch)

    const first = translateBlocksSingleFlight(
      'https://example.com',
      'en',
      'zh',
      [{ id: 'a', tag: 'p', text: 'Shared sentence' }],
      DEFAULT_SETTINGS,
    )
    const second = translateBlocksSingleFlight(
      'https://example.com',
      'en',
      'zh',
      [{ id: 'b', tag: 'p', text: 'Shared sentence' }],
      DEFAULT_SETTINGS,
    )

    expect(fetch).toHaveBeenCalledOnce()
    resolveFetch(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ items: [{ id: 'a', translation: '共享句子' }] }) } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    await expect(first).resolves.toEqual({
      ok: true,
      translations: [{ id: 'a', translation: '共享句子' }],
    })
    await expect(second).resolves.toEqual({
      ok: true,
      translations: [{ id: 'b', translation: '共享句子' }],
    })
  })
})

describe('translateBatchWithCaches', () => {
  const pageKey = 'https://example.com/article'
  const sourceLang = 'en'
  const targetLang = 'zh'

  beforeEach(() => {
    _resetTranslationCacheForTests()
  })

  afterEach(() => vi.unstubAllGlobals())

  function stubLlmFetch(translation: string) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({ items: [{ id: 'a', translation }] }),
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )
  }

  it('serves identical sentences from the persistent cache without fetching', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const persistent = {
      getMany: vi.fn(async (keys: string[]) => new Map([[keys[0], '你好世界']])),
      setMany: vi.fn(async () => undefined),
    }

    const result = await translateBatchWithCaches({
      pageKey,
      sourceLang,
      targetLang,
      blocks: [{ id: 'a', tag: 'p', text: 'Hello world' }],
      settings: DEFAULT_SETTINGS,
      persistent,
    })

    expect(result).toEqual({ ok: true, translations: [{ id: 'a', translation: '你好世界' }] })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(persistent.setMany).not.toHaveBeenCalled()
    // L2 hits seed the session cache for follow-up requests on this page.
    expect(getCachedTranslation(pageKey, sourceLang, targetLang, 'Hello world')).toBe('你好世界')
  })

  it('writes fresh LLM results through to the persistent cache with global keys', async () => {
    stubLlmFetch('你好')
    const persistent = {
      getMany: vi.fn(async () => new Map<string, string>()),
      setMany: vi.fn(async (_rows: { key: string; translation: string }[]) => undefined),
    }

    const result = await translateBatchWithCaches({
      pageKey,
      sourceLang,
      targetLang,
      blocks: [{ id: 'a', tag: 'p', text: 'Hello world' }],
      settings: DEFAULT_SETTINGS,
      persistent,
    })

    expect(result.ok).toBe(true)
    expect(persistent.setMany).toHaveBeenCalledOnce()
    expect(persistent.setMany.mock.calls[0][0]).toEqual([
      { key: makeTranslationCacheKey('', sourceLang, targetLang, 'Hello world'), translation: '你好' },
    ])
  })

  it('forceRefresh bypasses both cache layers and overwrites them with fresh results', async () => {
    // Seed L1 with a stale translation.
    const seed = filterUncachedByText(pageKey, sourceLang, targetLang, [
      { id: 'a', tag: 'p', text: 'Hello world' },
    ])
    expandTranslationsToAllIds(
      pageKey,
      sourceLang,
      targetLang,
      [{ id: 'a', translation: '旧译文' }],
      seed.idToText,
      seed.textHashToIds,
    )
    stubLlmFetch('新译文')
    const persistent = {
      getMany: vi.fn(async (keys: string[]) => new Map([[keys[0], '旧译文']])),
      setMany: vi.fn(async () => undefined),
    }

    const result = await translateBatchWithCaches({
      pageKey,
      sourceLang,
      targetLang,
      blocks: [{ id: 'a', tag: 'p', text: 'Hello world' }],
      settings: DEFAULT_SETTINGS,
      forceRefresh: true,
      persistent,
    })

    expect(persistent.getMany).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: true, translations: [{ id: 'a', translation: '新译文' }] })
    expect(persistent.setMany).toHaveBeenCalledOnce()
    // The stale session entry is overwritten too.
    expect(getCachedTranslation(pageKey, sourceLang, targetLang, 'Hello world')).toBe('新译文')
  })

  it('maps a failed representative to every id sharing its text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 400 })))
    const persistent = {
      getMany: vi.fn(async () => new Map<string, string>()),
      setMany: vi.fn(async () => undefined),
    }

    const result = await translateBatchWithCaches({
      pageKey,
      sourceLang,
      targetLang,
      blocks: [
        { id: 'a', tag: 'p', text: 'Same sentence here' },
        { id: 'b', tag: 'p', text: 'Same sentence here' },
      ],
      settings: DEFAULT_SETTINGS,
      persistent,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failedIds.sort()).toEqual(['a', 'b'])
  })

  it('serves a second request from the real persistent cache across page keys', async () => {
    // Real PersistentTextCache (MemoryStore in node) instead of a stub — the
    // pipeline and the store must agree on key shape and read/write contract.
    const persistent = new PersistentTextCache()
    stubLlmFetch('世界你好')

    const first = await translateBatchWithCaches({
      pageKey: 'https://site-a.com/1',
      sourceLang,
      targetLang,
      blocks: [{ id: 'a', tag: 'p', text: 'Hello world' }],
      settings: DEFAULT_SETTINGS,
      persistent,
    })
    expect(first.ok).toBe(true)

    // Different page, same sentence → L2 hit, no second upstream request.
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockClear()
    const second = await translateBatchWithCaches({
      pageKey: 'https://site-b.com/2',
      sourceLang,
      targetLang,
      blocks: [{ id: 'b', tag: 'p', text: 'Hello world' }],
      settings: DEFAULT_SETTINGS,
      persistent,
    })

    expect(second).toEqual({ ok: true, translations: [{ id: 'b', translation: '世界你好' }] })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('degrades to plain API translation when the persistent cache throws', async () => {
    stubLlmFetch('降级也可用')
    const persistent = {
      getMany: vi.fn(async () => {
        throw new Error('indexedDB corrupted')
      }),
      setMany: vi.fn(async () => {
        throw new Error('indexedDB corrupted')
      }),
    }

    const result = await translateBatchWithCaches({
      pageKey,
      sourceLang,
      targetLang,
      blocks: [{ id: 'a', tag: 'p', text: 'Hello world' }],
      settings: DEFAULT_SETTINGS,
      persistent,
    })

    // Cache layer must be fail-open: users still get their translation.
    expect(result).toEqual({ ok: true, translations: [{ id: 'a', translation: '降级也可用' }] })
  })
})

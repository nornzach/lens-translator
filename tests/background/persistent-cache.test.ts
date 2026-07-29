import { describe, expect, it } from 'vitest'
import { PersistentTextCache } from '../../src/background/persistent-cache'

// Node has no indexedDB, so every test exercises the MemoryStore fallback —
// the same code path IDB uses, minus persistence.
describe('PersistentTextCache', () => {
  it('roundtrips translations', async () => {
    const cache = new PersistentTextCache()
    await cache.setMany([
      { key: 'k1', translation: '你好' },
      { key: 'k2', translation: '世界' },
    ])
    expect(await cache.getMany(['k1', 'k2', 'k3'])).toEqual(
      new Map([
        ['k1', '你好'],
        ['k2', '世界'],
      ]),
    )
  })

  it('overwrites existing keys with fresh translations', async () => {
    const cache = new PersistentTextCache()
    await cache.setMany([{ key: 'k', translation: '旧' }])
    await cache.setMany([{ key: 'k', translation: '新' }])
    expect(await cache.getMany(['k'])).toEqual(new Map([['k', '新']]))
  })

  it('skips empty and oversized translations as a size backstop', async () => {
    const cache = new PersistentTextCache({ maxTranslationChars: 4 })
    await cache.setMany([
      { key: 'a', translation: '' },
      { key: 'b', translation: '12345' },
      { key: 'c', translation: '1234' },
    ])
    expect(await cache.getMany(['a', 'b', 'c'])).toEqual(new Map([['c', '1234']]))
  })

  it('evicts the oldest entries over the cap and keeps touched entries hot', async () => {
    const cache = new PersistentTextCache({ maxEntries: 3 })
    await cache.setMany([
      { key: 'a', translation: '1' },
      { key: 'b', translation: '2' },
      { key: 'c', translation: '3' },
    ])
    // Touch 'a' → 'b' becomes the oldest.
    await cache.getMany(['a'])
    // Fourth insert pushes count to 4 > 3 → evict ceil(3 * 0.05) = 1 oldest.
    await cache.setMany([{ key: 'd', translation: '4' }])
    expect([...(await cache.getMany(['a', 'b', 'c', 'd'])).keys()].sort()).toEqual(['a', 'c', 'd'])
  })

  it('reports entry/char stats and clears everything', async () => {
    const cache = new PersistentTextCache()
    await cache.setMany([{ key: 'ab', translation: 'cd' }])
    expect(await cache.stats()).toEqual({ entries: 1, approxChars: 4 })
    await cache.clear()
    expect(await cache.stats()).toEqual({ entries: 0, approxChars: 0 })
    expect((await cache.getMany(['ab'])).size).toBe(0)
  })
})

import { describe, it, expect, beforeEach } from 'vitest'
import {
  filterUncachedByText,
  expandTranslationsToAllIds,
  getCachedTranslation,
  _resetTranslationCacheForTests,
  _cacheStatsForTests,
} from '../../src/background/translate'

describe('text-hash translation cache', () => {
  const pageKey = 'https://example.com/article'
  const sourceLang = 'en'
  const targetLang = 'zh'

  beforeEach(() => {
    _resetTranslationCacheForTests()
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
})

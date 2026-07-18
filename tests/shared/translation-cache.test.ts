import { describe, it, expect } from 'vitest'
import { TranslationCache } from '../../src/shared/translation-cache'
import { hashNormalizedText, makeTranslationCacheKey } from '../../src/shared/text-hash'

describe('hashNormalizedText', () => {
  it('is stable for whitespace variants', () => {
    expect(hashNormalizedText('Hello   world')).toBe(hashNormalizedText('Hello world'))
  })

  it('differs when text differs', () => {
    expect(hashNormalizedText('Hello')).not.toBe(hashNormalizedText('Hello!'))
  })
})

describe('makeTranslationCacheKey', () => {
  it('includes page and langs', () => {
    const a = makeTranslationCacheKey('https://a/', 'en', 'zh', 'Hi there friend')
    const b = makeTranslationCacheKey('https://b/', 'en', 'zh', 'Hi there friend')
    const c = makeTranslationCacheKey('https://a/', 'en', 'ja', 'Hi there friend')
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
  })
})

describe('TranslationCache LRU bounds', () => {
  it('evicts oldest when over maxEntries', () => {
    const c = new TranslationCache({ maxEntries: 3, maxTotalChars: 1_000_000 })
    c.set('k1', '一')
    c.set('k2', '二')
    c.set('k3', '三')
    expect(c.size).toBe(3)
    c.set('k4', '四')
    expect(c.size).toBe(3)
    expect(c.get('k1')).toBeUndefined()
    expect(c.get('k2')).toBe('二')
  })

  it('evicts when over char budget', () => {
    const c = new TranslationCache({ maxEntries: 100, maxTotalChars: 10 })
    c.set('a', '12345')
    c.set('b', '67890')
    // total 10; adding more should evict
    c.set('c', 'xyz')
    expect(c.charCount).toBeLessThanOrEqual(10)
    expect(c.get('a')).toBeUndefined()
  })

  it('refreshes LRU on get', () => {
    const c = new TranslationCache({ maxEntries: 2, maxTotalChars: 1_000_000 })
    c.set('k1', '一')
    c.set('k2', '二')
    expect(c.get('k1')).toBe('一') // k1 now newest
    c.set('k3', '三')
    expect(c.get('k1')).toBe('一')
    expect(c.get('k2')).toBeUndefined()
  })
})

describe('TranslationCache persistence', () => {
  it('round-trips entries through a snapshot', () => {
    const a = new TranslationCache({ maxEntries: 10, maxTotalChars: 1_000_000 })
    a.set('k1', '一')
    a.set('k2', '二')
    const snapshot = a.entries()

    const b = new TranslationCache({ maxEntries: 10, maxTotalChars: 1_000_000 })
    b.load(snapshot)
    expect(b.get('k1')).toBe('一')
    expect(b.get('k2')).toBe('二')
    expect(b.size).toBe(2)
  })

  it('load replaces prior contents and re-applies capacity limits', () => {
    const c = new TranslationCache({ maxEntries: 2, maxTotalChars: 1_000_000 })
    c.set('old', 'x')
    c.load([
      ['a', '1'],
      ['b', '2'],
      ['c', '3'],
    ])
    expect(c.get('old')).toBeUndefined()
    expect(c.size).toBe(2)
    expect(c.get('a')).toBeUndefined() // oldest evicted under maxEntries=2
    expect(c.get('c')).toBe('3')
  })
})

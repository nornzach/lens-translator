import { describe, it, expect, beforeEach } from 'vitest'
import { filterUncached, putCached, getCached } from '../../src/background/translate'

describe('session cache', () => {
  const pageKey = 'https://example.com/'

  beforeEach(() => {
    // re-importing module state: put only for this pageKey unique ids
    putCached(pageKey, [{ id: 'x1', translation: '缓存' }])
  })

  it('returns cached and missing', () => {
    const { cached, missing } = filterUncached(pageKey, [
      { id: 'x1', tag: 'p', text: 'Hello there friend' },
      { id: 'x2', tag: 'p', text: 'Another block text' },
    ])
    expect(cached).toEqual([{ id: 'x1', translation: '缓存' }])
    expect(missing.map((m) => m.id)).toEqual(['x2'])
    expect(getCached(pageKey, 'x1')).toBe('缓存')
  })
})

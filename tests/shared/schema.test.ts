import { describe, it, expect } from 'vitest'
import { parseImageTranslationResult, parseTranslateBatchResult } from '../../src/shared/schema'

describe('parseTranslateBatchResult', () => {
  it('keeps only allowed ids', () => {
    const parsed = parseTranslateBatchResult(
      {
        items: [
          { id: 'a', translation: '甲' },
          { id: 'evil', translation: 'x' },
          { id: 'b', translation: '乙' },
        ],
      },
      new Set(['a', 'b']),
    )
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.items).toEqual([
        { id: 'a', translation: '甲' },
        { id: 'b', translation: '乙' },
      ])
    }
  })

  it('fails when items missing', () => {
    const parsed = parseTranslateBatchResult({}, new Set())
    expect(parsed.ok).toBe(false)
  })
})

describe('parseImageTranslationResult', () => {
  it('accepts non-empty translated image text and rejects empty output', () => {
    expect(parseImageTranslationResult({ translation: '图片中的文字' })).toEqual({
      ok: true,
      translation: '图片中的文字',
    })
    expect(parseImageTranslationResult({ translation: '   ' })).toEqual({
      ok: false,
      error: 'translation empty',
    })
  })
})

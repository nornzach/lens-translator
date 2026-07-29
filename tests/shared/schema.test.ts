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

describe('parseDictionaryResult', () => {
  it('parses a full dictionary card', async () => {
    const { parseDictionaryResult } = await import('../../src/shared/schema')
    const parsed = parseDictionaryResult(
      {
        word: 'ubiquitous',
        phonetic: '/juːˈbɪkwɪtəs/',
        senses: [
          { pos: 'adj.', gloss: '无处不在的' },
          { pos: '', gloss: '普遍存在的' },
        ],
        examples: [{ source: 'Wi-Fi is ubiquitous.', translation: 'Wi-Fi 无处不在。' }],
      },
      'ubiquitous',
    )
    expect(parsed).toEqual({
      ok: true,
      entry: {
        word: 'ubiquitous',
        phonetic: '/juːˈbɪkwɪtəs/',
        senses: [
          { pos: 'adj.', gloss: '无处不在的' },
          { pos: '', gloss: '普遍存在的' },
        ],
        examples: [{ source: 'Wi-Fi is ubiquitous.', translation: 'Wi-Fi 无处不在。' }],
      },
    })
  })

  it('falls back to the input word, drops invalid rows, and requires senses', async () => {
    const { parseDictionaryResult } = await import('../../src/shared/schema')
    const parsed = parseDictionaryResult(
      {
        senses: [{ pos: 'n.', gloss: '测试' }, { pos: 'x' }, 'garbage'],
        examples: [{ source: '', translation: 'skip' }, { source: '例', translation: 'example' }],
      },
      'fallback-word',
    )
    expect(parsed).toEqual({
      ok: true,
      entry: {
        word: 'fallback-word',
        senses: [{ pos: 'n.', gloss: '测试' }],
        examples: [{ source: '例', translation: 'example' }],
      },
    })

    expect(parseDictionaryResult({ senses: [] }, 'w').ok).toBe(false)
    expect(parseDictionaryResult('nope', 'w').ok).toBe(false)
  })
})

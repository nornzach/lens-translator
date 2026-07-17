import { describe, expect, it } from 'vitest'
import {
  findApproximateSourceSpan,
  segmentDisplayText,
} from '../../src/content/page-alignment'

describe('segmentDisplayText', () => {
  it('preserves target text while identifying hoverable words', () => {
    const text = '你好，world!'
    const segments = segmentDisplayText(text, 'zh')

    expect(segments.map((segment) => segment.text).join('')).toBe(text)
    expect(segments.filter((segment) => segment.wordIndex !== null).map((segment) => segment.text))
      .toEqual(expect.arrayContaining(['你好', 'world']))
    expect(segments.some((segment) => segment.wordIndex === null && segment.text.includes('，'))).toBe(
      true,
    )
  })
})

describe('findApproximateSourceSpan', () => {
  it('matches a back-translated compound to the source word', () => {
    const source = 'Kimi K3 frontend work is completely insane.'
    const span = findApproximateSourceSpan(source, 'front end', 1, 5, 'en')

    expect(span && source.slice(span.start, span.end)).toBe('frontend')
  })

  it('matches an exact source phrase', () => {
    const source = 'Clients earn interest on their uninvested cash balances.'
    const span = findApproximateSourceSpan(source, 'uninvested cash', 4, 7, 'en')

    expect(span && source.slice(span.start, span.end)).toBe('uninvested cash')
  })

  it('falls back to source order when lexical matching fails', () => {
    const source = 'zero one two three four five six seven'
    const span = findApproximateSourceSpan(source, 'unrelated', 2, 4, 'en')

    expect(span && source.slice(span.start, span.end)).toBe('five')
  })
})

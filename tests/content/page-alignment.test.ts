import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  findApproximateSourceSpan,
  segmentDisplayText,
  PageAlignmentController,
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

describe('PageAlignmentController.alignSegment', () => {
  type TestTranslatorGlobal = typeof globalThis & { Translator?: unknown }
  const testGlobal = globalThis as TestTranslatorGlobal
  const originalTranslator = testGlobal.Translator

  afterEach(() => {
    if (originalTranslator === undefined) delete testGlobal.Translator
    else testGlobal.Translator = originalTranslator
  })

  type Alignable = {
    alignSegment(
      entry: {
        sourceText: string
        wordCount: number
        sourceLanguage: string
        targetLanguage: string
      },
      segment: { text: string; start: number; end: number; wordIndex: number },
    ): Promise<{ start: number; end: number } | null>
  }

  const entry = {
    sourceText: 'hello world from tests',
    wordCount: 2,
    sourceLanguage: 'en',
    targetLanguage: 'zh',
  }
  const segment = { text: '你好', start: 0, end: 2, wordIndex: 0 }

  it('never creates a reverse session when the pair is not already available', async () => {
    const create = vi.fn()
    testGlobal.Translator = {
      availability: vi.fn(async () => 'downloadable'),
      create,
    }
    const controller = new PageAlignmentController() as unknown as Alignable

    const span = await controller.alignSegment(entry, segment)

    // Proportional fallback still works; no pack download was triggered.
    expect(span).not.toBeNull()
    expect(create).not.toHaveBeenCalled()
  })

  it('back-translates only when the reverse pair is ready on device', async () => {
    const translate = vi.fn(async () => 'hello')
    const create = vi.fn(async () => ({ translate }))
    testGlobal.Translator = {
      availability: vi.fn(async () => 'available'),
      create,
    }
    const controller = new PageAlignmentController() as unknown as Alignable

    const span = await controller.alignSegment(entry, segment)

    expect(create).toHaveBeenCalledTimes(1)
    expect(translate).toHaveBeenCalledWith('你好')
    expect(span).not.toBeNull()
  })
})

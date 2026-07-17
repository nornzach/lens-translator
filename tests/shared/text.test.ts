import { describe, it, expect } from 'vitest'
import {
  normalizeText,
  isPageTranslatableText,
  isTranslatableText,
} from '../../src/shared/text'

describe('normalizeText', () => {
  it('collapses whitespace', () => {
    expect(normalizeText('  hello   \n world  ')).toBe('hello world')
  })
})

describe('isTranslatableText', () => {
  it('rejects short text', () => {
    expect(isTranslatableText('hi', 10)).toBe(false)
  })
  it('rejects pure numbers/symbols', () => {
    expect(isTranslatableText('12345-67890', 5)).toBe(false)
    expect(isTranslatableText('!!!!!', 1)).toBe(false)
  })
  it('accepts normal sentences', () => {
    expect(isTranslatableText('Modern tools make immersion easier.', 10)).toBe(true)
  })
})

describe('isPageTranslatableText', () => {
  it('rejects standalone URLs and email addresses', () => {
    expect(isPageTranslatableText('https://example.com/docs/start', 5)).toBe(false)
    expect(isPageTranslatableText('docs.example.com/start', 5)).toBe(false)
    expect(isPageTranslatableText('hello@example.com', 5)).toBe(false)
  })

  it('rejects standalone handles and hashtags', () => {
    expect(isPageTranslatableText('@openai', 2)).toBe(false)
    expect(isPageTranslatableText('#AI #MachineLearning', 2)).toBe(false)
  })

  it('keeps prose that contains a link or hashtag', () => {
    expect(isPageTranslatableText('Read the full guide at https://example.com/docs.', 5)).toBe(true)
    expect(isPageTranslatableText('This is a longer post about #MachineLearning.', 5)).toBe(true)
  })
})

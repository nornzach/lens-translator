import { describe, it, expect } from 'vitest'
import { normalizeText, isTranslatableText } from '../../src/shared/text'

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

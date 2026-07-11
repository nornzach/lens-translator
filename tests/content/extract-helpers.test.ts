import { describe, it, expect } from 'vitest'
import { isTranslatableText, normalizeText } from '../../src/shared/text'

describe('extract policy (text layer)', () => {
  it('accepts long div-like copy', () => {
    const t = normalizeText(
      'Modern tools make immersion easier than ever for self-learners worldwide.',
    )
    expect(isTranslatableText(t, 10)).toBe(true)
  })
})

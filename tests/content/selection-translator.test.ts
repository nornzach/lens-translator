import { describe, expect, it } from 'vitest'
import { shouldIgnoreSelectionContext } from '../../src/content/selection-translator'

describe('shouldIgnoreSelectionContext', () => {
  it('ignores form fields and contenteditable', () => {
    expect(shouldIgnoreSelectionContext({ tagName: 'INPUT' })).toBe(true)
    expect(shouldIgnoreSelectionContext({ tagName: 'TEXTAREA' })).toBe(true)
    expect(shouldIgnoreSelectionContext({ tagName: 'SELECT' })).toBe(true)
    expect(shouldIgnoreSelectionContext({ tagName: 'DIV', isContentEditable: true })).toBe(true)
  })

  it('ignores extension UI shells', () => {
    expect(
      shouldIgnoreSelectionContext({
        tagName: 'SPAN',
        closestIds: ['lens-translator-root'],
      }),
    ).toBe(true)
    expect(
      shouldIgnoreSelectionContext({
        tagName: 'SPAN',
        closestIds: ['data-lens-ignore'],
      }),
    ).toBe(true)
  })

  it('allows normal page text hosts', () => {
    expect(shouldIgnoreSelectionContext({ tagName: 'P' })).toBe(false)
    expect(shouldIgnoreSelectionContext({ tagName: 'DIV', closestIds: [] })).toBe(false)
  })
})

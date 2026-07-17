import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  groupPageBlocks,
  isPageTranslationCandidate,
  isPageUiTranslationCandidate,
} from '../../src/content/page-translator'
import type { ExtractedBlock } from '../../src/content/extract'

function block(id: string, text: string, top: number, order: number): ExtractedBlock {
  const el = {
    isConnected: true,
    getBoundingClientRect: () => ({
      width: 400,
      height: 30,
      top,
      left: 0,
      bottom: top + 30,
      right: 400,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }),
    compareDocumentPosition: (other: Element) =>
      order < (other as Element & { __order: number }).__order ? 4 : 2,
    __order: order,
  } as unknown as Element
  return { id, text, tag: 'p', el }
}

function candidateElement(
  text: string,
  tagName = 'span',
  ancestors: Array<{ tagName: string; role?: string; text?: string }> = [],
): Element {
  const self: { tagName: string; role?: string; text?: string } = { tagName, text }
  const chain = [self, ...ancestors]
  return {
    tagName: tagName.toUpperCase(),
    textContent: text,
    getAttribute: (name: string) => (name === 'role' ? null : null),
    closest: (selector: string) => {
      for (const item of chain) {
        const matches = selector.split(',').some((part) => {
          const value = part.trim()
          if (value === item.tagName) return true
          const role = value.match(/^\[role="(.+)"\]$/)?.[1]
          return role !== undefined && role === item.role
        })
        if (matches) return { textContent: item.text ?? text }
      }
      return null
    },
  } as unknown as Element
}

afterEach(() => vi.unstubAllGlobals())

describe('groupPageBlocks', () => {
  it('prioritizes visible text and deduplicates repeated content', () => {
    vi.stubGlobal('window', {
      innerHeight: 800,
      innerWidth: 1200,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    })
    const offscreenDuplicate = block('offscreen', 'Repeated paragraph', 4000, 0)
    const visibleDuplicate = block('visible', 'Repeated paragraph', 100, 1)
    const visibleOther = block('other', 'Another visible paragraph', 200, 2)

    const groups = groupPageBlocks([offscreenDuplicate, visibleOther, visibleDuplicate])

    expect(groups.map((group) => group.representative.id)).toEqual(['visible', 'other'])
    expect(groups[0].blocks.map((item) => item.id)).toEqual(['visible', 'offscreen'])
  })
})

describe('isPageTranslationCandidate', () => {
  it('keeps navigation and controls as compact UI translations', () => {
    const candidates = [
      { id: 'nav', text: 'Explore topics', ancestors: [{ tagName: 'nav' }] },
      { id: 'button', text: 'Show more results', ancestors: [{ tagName: 'button' }] },
    ]

    for (const { id, text, ancestors } of candidates) {
      const candidate = {
        id,
        el: candidateElement(text, 'span', ancestors),
        tag: 'span',
        text,
      }
      expect(isPageTranslationCandidate(candidate, 10)).toBe(true)
      expect(isPageUiTranslationCandidate(candidate)).toBe(true)
    }
  })

  it('rejects metadata links and time labels', () => {
    const candidates = [
      { id: 'handle', text: '@example_user', ancestors: [{ tagName: 'a' }] },
      { id: 'time', text: 'Yesterday morning', ancestors: [{ tagName: 'time' }] },
    ]

    for (const { id, text, ancestors } of candidates) {
      const candidate = {
        id,
        el: candidateElement(text, 'span', ancestors),
        tag: 'span',
        text,
      }
      expect(isPageTranslationCandidate(candidate, 2)).toBe(false)
    }
  })

  it('keeps prose, including prose with an inline link', () => {
    const text = 'A useful explanation with supporting documentation.'
    const candidate = { id: 'post', el: candidateElement(text, 'p'), tag: 'p', text }

    expect(isPageTranslationCandidate(candidate, 10)).toBe(true)
  })
})

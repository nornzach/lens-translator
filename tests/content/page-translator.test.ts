import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  groupPageBlocks,
  isPageTranslationCandidate,
  isPageUiTranslationCandidate,
  pageTranslationHost,
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
    children: [],
    querySelectorAll: () => [],
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
      { id: 'nav', text: 'Explore topics', tagName: 'span', ancestors: [{ tagName: 'nav' }] },
      { id: 'button', text: 'Show more results', tagName: 'span', ancestors: [{ tagName: 'button' }] },
      { id: 'link', text: 'Features overview', tagName: 'a', ancestors: [] },
    ]

    for (const { id, text, tagName, ancestors } of candidates) {
      const candidate = {
        id,
        el: candidateElement(text, tagName, ancestors),
        tag: tagName,
        text,
      }
      expect(isPageTranslationCandidate(candidate, 10)).toBe(true)
      expect(isPageUiTranslationCandidate(candidate)).toBe(true)
    }
  })

  it('rejects metadata links and time labels', () => {
    const candidates = [
      { id: 'handle', text: '@example_user', ancestors: [{ tagName: 'a' }] },
      { id: 'account', text: 'Example @example_user', ancestors: [{ tagName: 'a' }] },
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

  it('skips grid/chart widgets and bare date-axis labels that break layout', () => {
    const gridLabels = [
      { id: 'month', text: 'Jul', ancestors: [{ tagName: 'td' }, { tagName: 'table', role: 'grid' }] },
      { id: 'weekday', text: 'Mon', ancestors: [{ tagName: 'td' }, { tagName: 'table', role: 'grid' }] },
    ]
    for (const { id, text, ancestors } of gridLabels) {
      const candidate = { id, el: candidateElement(text, 'span', ancestors), tag: 'span', text }
      expect(isPageTranslationCandidate(candidate, 2)).toBe(false)
    }

    // Even outside a grid, a standalone month/weekday token adds no value and risks layout.
    for (const text of ['August', 'Sunday', 'Sep', 'May']) {
      const candidate = { id: text, el: candidateElement(text, 'span'), tag: 'span', text }
      expect(isPageTranslationCandidate(candidate, 2)).toBe(false)
    }
  })

  it('places UI translation on the inner text label instead of the flex link', () => {
    const label = candidateElement('Home', 'span')
    const link = candidateElement('Home', 'a')
    link.querySelectorAll = (() => [label]) as unknown as typeof link.querySelectorAll
    const candidate = { id: 'home', el: link, tag: 'a', text: 'Home' }

    expect(pageTranslationHost(candidate)).toBe(label)
  })

  it('keeps prose, including prose with an inline link', () => {
    const text = 'A useful explanation with supporting documentation.'
    const candidate = { id: 'post', el: candidateElement(text, 'p'), tag: 'p', text }

    expect(isPageTranslationCandidate(candidate, 10)).toBe(true)
  })
})

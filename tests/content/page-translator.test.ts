import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  downstreamOverlap,
  evaluatePlacement,
  groupPageBlocks,
  pageStyles,
  PageTranslator,
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

describe('PageTranslator source-owned rendering', () => {
  function subject() {
    const value = Object.create(PageTranslator.prototype) as {
      insertedNodeByHost: Map<Element, HTMLElement>
      hostByInsertedNode: WeakMap<HTMLElement, Element>
      shadowStyles: WeakMap<ShadowRoot, HTMLStyleElement>
      currentSettings: null
      insertTranslationIntoHost(host: Element, translation: string): HTMLElement
    }
    value.insertedNodeByHost = new Map()
    value.hostByInsertedNode = new WeakMap()
    value.shadowStyles = new WeakMap()
    value.currentSettings = null
    return value
  }

  it.each(['P', 'LI', 'TD', 'TH'])('keeps a %s translation inside its exact host', (tag) => {
    const inserted = {
      setAttribute: vi.fn(),
      textContent: '',
    } as unknown as HTMLElement
    const append = vi.fn()
    const host = {
      tagName: tag,
      getAttribute: () => null,
      closest: () => null,
      hasAttribute: () => false,
      append,
      getRootNode: () => document,
    } as unknown as Element
    const createElement = vi.fn(() => inserted)
    vi.stubGlobal('ShadowRoot', class {})
    vi.stubGlobal('document', { createElement })

    expect(subject().insertTranslationIntoHost(host, '译文')).toBe(inserted)
    expect(createElement).toHaveBeenCalledWith('span')
    expect(append).toHaveBeenCalledWith(inserted)
  })

  it('never escapes a web-component slot', () => {
    const inserted = {
      setAttribute: vi.fn(),
      textContent: '',
    } as unknown as HTMLElement
    const slot = {
      hasAttribute: (name: string) => name === 'slot',
    } as unknown as Element
    const append = vi.fn()
    const host = {
      tagName: 'P',
      parentElement: slot,
      getAttribute: () => null,
      closest: () => null,
      hasAttribute: () => false,
      append,
      getRootNode: () => document,
    } as unknown as Element
    vi.stubGlobal('ShadowRoot', class {})
    vi.stubGlobal('document', { createElement: () => inserted })

    subject().insertTranslationIntoHost(host, '译文')

    expect(append).toHaveBeenCalledWith(inserted)
    expect(inserted.setAttribute).not.toHaveBeenCalledWith('slot', expect.anything())
  })

  it('marks a compact control without freezing inherited styles inline', () => {
    const attributes = new Set<string>()
    const setProperty = vi.fn()
    const inserted = {
      setAttribute: vi.fn((name: string) => attributes.add(name)),
      hasAttribute: (name: string) => attributes.has(name),
      style: { setProperty },
      textContent: '',
    } as unknown as HTMLElement
    const label = {
      closest: () => null,
    } as unknown as HTMLElement
    const textNode = {
      textContent: 'Share',
      parentElement: label,
    } as unknown as Node
    const nextNode = vi.fn().mockReturnValueOnce(textNode).mockReturnValue(null)
    const append = vi.fn()
    const host = {
      tagName: 'BUTTON',
      getAttribute: () => null,
      closest: () => null,
      hasAttribute: () => false,
      append,
      getRootNode: () => document,
      ownerDocument: { createTreeWalker: () => ({ nextNode }) },
    } as unknown as Element
    const createElement = vi.fn(() => inserted)
    vi.stubGlobal('ShadowRoot', class {})
    vi.stubGlobal('window', {
      getComputedStyle: (el: Element) => ({
        color: el === label ? 'rgb(15, 20, 25)' : 'rgb(85, 26, 139)',
      }),
    })
    vi.stubGlobal('document', { createElement })

    subject().insertTranslationIntoHost(host, '分享')

    expect(createElement).toHaveBeenCalledWith('span')
    expect(inserted.setAttribute).toHaveBeenCalledWith('data-lens-page-control', '')
    expect(setProperty).not.toHaveBeenCalled()
    expect(append).toHaveBeenCalledWith(inserted)
  })
})

describe('PageTranslator mutation scan scheduling', () => {
  it('cannot be starved by continuous mutations', () => {
    const callbacks: Array<() => void> = []
    const setTimeout = vi.fn((callback: () => void) => {
      callbacks.push(callback)
      return 1
    })
    vi.stubGlobal('window', { setTimeout })

    const scanAndTranslate = vi.fn()
    const translator = Object.create(PageTranslator.prototype) as {
      mutationTimer: number
      active: boolean
      currentSettings: object | null
      generation: number
      scanAndTranslate: typeof scanAndTranslate
      scheduleScan(delay?: number): void
    }
    translator.mutationTimer = 0
    translator.active = true
    translator.currentSettings = {}
    translator.generation = 1
    translator.scanAndTranslate = scanAndTranslate

    translator.scheduleScan()
    translator.scheduleScan()
    translator.scheduleScan()

    expect(setTimeout).toHaveBeenCalledTimes(1)
    callbacks[0]()
    expect(translator.mutationTimer).toBe(0)
    expect(scanAndTranslate).toHaveBeenCalledTimes(1)
  })
})


describe('translation placement measurement', () => {
  type FakeStyle = {
    fontSize?: string
    overflowX?: string
    overflowY?: string
    height?: string
    display?: string
    flexDirection?: string
  }
  type FakeEl = {
    getBoundingClientRect: () => Record<string, number>
    parentElement: FakeEl | null
    __style: FakeStyle
    nextElementSibling?: FakeEl | null
    hasAttribute?: (name: string) => boolean
  }
  function fakeEl(width: number, height: number, style: FakeStyle = {}, top = 0): FakeEl {
    return {
      getBoundingClientRect: () => ({
        width,
        height,
        top,
        left: 0,
        bottom: top + height,
        right: width,
      }),
      parentElement: null,
      __style: style,
    }
  }
  function stubLayout(): void {
    vi.stubGlobal('window', {
      getComputedStyle: (el: FakeEl) => ({
        fontSize: el.__style.fontSize ?? '14px',
        overflowX: el.__style.overflowX ?? 'visible',
        overflowY: el.__style.overflowY ?? 'visible',
        height: el.__style.height ?? 'auto',
        display: el.__style.display ?? 'block',
        flexDirection: el.__style.flexDirection ?? 'row',
      }),
    })
    vi.stubGlobal('document', { body: {} })
  }

  it('flags hosts too narrow for readable text (vertical glyph column)', () => {
    stubLayout()
    const host = fakeEl(16, 20)
    const node = fakeEl(16, 140)
    node.parentElement = host

    expect(evaluatePlacement(host as unknown as Element, node as unknown as HTMLElement, false)).toBe('narrow')
  })

  it('flags translations clipped by an overflow-hidden ancestor', () => {
    stubLayout()
    const chip = fakeEl(106, 38, { overflowX: 'hidden', overflowY: 'hidden' })
    const node = fakeEl(100, 60, {}, 30) // bottom 90 exceeds chip bottom 38
    node.parentElement = chip

    expect(evaluatePlacement(chip as unknown as Element, node as unknown as HTMLElement, true)).toBe('clipped')
  })

  it('flags translations overflowing a fixed-height host row (nav rails)', () => {
    stubLayout()
    const rail = fakeEl(240, 40, { height: '40px' })
    const node = fakeEl(220, 20, {}, 44) // bottom 64 > rail bottom 40
    node.parentElement = rail

    expect(evaluatePlacement(rail as unknown as Element, node as unknown as HTMLElement, true)).toBe('clipped')
  })

  it('flags a compact translation outside its interactive control', () => {
    stubLayout()
    const button = fakeEl(106, 38)
    const node = fakeEl(217, 20, {}, 0)
    node.parentElement = button

    expect(evaluatePlacement(button as unknown as Element, node as unknown as HTMLElement, true)).toBe('clipped')
  })

  it('accepts a healthy wide placement', () => {
    stubLayout()
    const host = fakeEl(692, 80)
    const node = fakeEl(692, 20, {}, 48)
    node.parentElement = host

    expect(evaluatePlacement(host as unknown as Element, node as unknown as HTMLElement, false)).toBe('ok')
  })

  it('passes through environments without layout measurement', () => {
    const host = {} as Element
    const node = {} as HTMLElement
    expect(evaluatePlacement(host, node, false)).toBe('ok')
  })

  it('reports overlap when a node overflows a fixed-height box onto its next sibling', () => {
    stubLayout()
    // wrap (64px) contains the node whose bottom reaches 90; the next wrap
    // starts at 78 — they collide.
    const node = fakeEl(560, 20, {}, 70) // bottom 90
    const wrap = fakeEl(640, 64, { height: '64px' })
    const nextWrap = fakeEl(640, 64, { height: '64px' }, 78)
    node.parentElement = wrap
    wrap.parentElement = fakeEl(640, 400)
    wrap.nextElementSibling = nextWrap
    wrap.hasAttribute = () => false
    nextWrap.hasAttribute = () => false

    expect(downstreamOverlap(node as unknown as HTMLElement)).toBe(true)
  })

  it('reports no overlap while the node stays inside its ancestors', () => {
    stubLayout()
    const node = fakeEl(560, 20, {}, 30) // bottom 50 < wrap bottom 64
    const wrap = fakeEl(640, 64, { height: '64px' })
    const nextWrap = fakeEl(640, 64, { height: '64px' }, 78)
    node.parentElement = wrap
    wrap.parentElement = fakeEl(640, 400)
    wrap.nextElementSibling = nextWrap
    wrap.hasAttribute = () => false

    expect(downstreamOverlap(node as unknown as HTMLElement)).toBe(false)
  })
})

describe('pageStyles display modes', () => {
  const base = {
    sourceLang: 'en',
    targetLang: 'zh',
    pageTranslationEngine: 'browser',
    pageTranslationFontFamily: 'system',
    pageTranslationFontSizePx: 14,
    pageTranslationUseOriginalFontSize: true,
    pageTranslationUseCustomColor: false,
    pageTranslationTextColor: '#0e7490',
    pageTranslationUseBackground: false,
    pageTranslationBackgroundColor: '#ecfeff',
    pageTranslationBold: false,
    pageTranslationItalic: false,
    pageTranslationUnderline: false,
    batchCharLimit: 6000,
    minTextLength: 10,
  } as const

  it('renders every translation as an inserted element — no ::after path exists', async () => {
    for (const mode of ['bilingual', 'translation-only', 'learning'] as const) {
      const css = pageStyles({ ...base, pageTranslationDisplayMode: mode })
      expect(css).not.toContain('::after')
      expect(css).toContain('[data-lens-page-inserted]')
    }
  })

  it('styles only inserted nodes and never rewrites ancestor geometry', () => {
    const css = pageStyles({ ...base, pageTranslationDisplayMode: 'bilingual' })
    expect(css).not.toContain(':has(')
    expect(css).not.toContain('flex-wrap:')
    expect(css).toContain('width: 100% !important')
    expect(css).toContain('grid-column: 1 / -1 !important')
    expect(css).not.toContain('height: auto !important')
    expect(css).toContain('display: inline !important')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain('[data-lens-page-inserted][data-lens-page-pending]::before { animation: none !important; }')
  })

  it('bilingual mode adds no collapsing or blur rules', async () => {
    const css = pageStyles({ ...base, pageTranslationDisplayMode: 'bilingual' })
    expect(css).not.toContain('font-size: 0 !important')
    expect(css).not.toContain('blur')
    expect(css).not.toContain('visibility: hidden')
  })

  it('translation-only hides originals without collapsing layout', async () => {
    const css = pageStyles({ ...base, pageTranslationDisplayMode: 'translation-only' })
    // Transparent via visibility: boxes keep their metrics, inserted node unaffected.
    expect(css).toContain('visibility: hidden !important')
    expect(css).toContain('visibility: visible !important')
    // Default size: translations inherit the surrounding size (hierarchy survives).
    expect(css).toContain('font-size: inherit !important')
  })

  it('translation-only honors an explicit custom font size', async () => {
    const css = pageStyles({
      ...base,
      pageTranslationDisplayMode: 'translation-only',
      pageTranslationFontSizePx: 18,
      pageTranslationUseOriginalFontSize: false,
    })
    expect(css).toContain('font-size: 18px !important')
  })

  it('uses the custom translation color when configured', async () => {
    const css = pageStyles({
      ...base,
      pageTranslationDisplayMode: 'bilingual',
      pageTranslationUseCustomColor: true,
    })
    expect(css).toContain('color: #0e7490 !important')
  })

  it('learning mode blurs translations until hover', async () => {
    const css = pageStyles({ ...base, pageTranslationDisplayMode: 'learning' })
    expect(css).toContain('blur(5px)')
    expect(css).toContain('[data-lens-page-inserted]:not([data-lens-page-pending]):hover')
  })
})

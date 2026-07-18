import { afterEach, describe, it, expect, vi } from 'vitest'
import { isTranslatableText, normalizeText } from '../../src/shared/text'
import {
  classNameOf,
  hasTextBlockHint,
  isPhrasingOnly,
  isLeafTextContainer,
  isUiLabelElement,
  dedupeNestedBlocks,
  elementText,
  extractBlockAtElement,
  extractLensBlockAtElement,
  extractPageBlocks,
  extractVisibleBlocks,
  PHRASING_TAGS,
  type ExtractedBlock,
} from '../../src/content/extract'

/** Minimal Element-like stubs for pure heuristic tests (no jsdom). */
function fakeEl(opts: {
  tag: string
  text?: string
  className?: string
  role?: string
  attrs?: Record<string, string>
  children?: ReturnType<typeof fakeEl>[]
  parent?: ReturnType<typeof fakeEl> | null
}): Element {
  const children = opts.children ?? []
  const attrs = { ...(opts.attrs ?? {}) }
  if (opts.className) attrs.class = opts.className
  if (opts.role) attrs.role = opts.role

  const el = {
    tagName: opts.tag.toUpperCase(),
    className: opts.className ?? '',
    textContent: opts.text ?? children.map((c) => c.textContent).join('') ?? '',
    children: {
      length: children.length,
      [Symbol.iterator]: function* () {
        yield* children
      },
      item: (i: number) => children[i] ?? null,
    },
    childNodes: children,
    parentElement: opts.parent ?? null,
    getAttribute: (name: string) => attrs[name] ?? null,
    hasAttribute: (name: string) => name in attrs,
    querySelector: () => null,
    querySelectorAll: () => [] as unknown as NodeListOf<Element>,
    contains: (other: Element) => other !== (el as unknown as Element) && (children as unknown as Element[]).includes(other),
    closest: () => null,
    getBoundingClientRect: () => ({
      width: 100,
      height: 20,
      top: 0,
      left: 0,
      bottom: 20,
      right: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  }

  // Make HTMLCollection-like iterable with length for isPhrasingOnly
  Object.defineProperty(el, 'children', {
    get() {
      const arr = children as unknown as Element[]
      return Object.assign(arr, {
        length: arr.length,
        item: (i: number) => arr[i] ?? null,
      })
    },
  })

  return el as unknown as Element
}

afterEach(() => vi.unstubAllGlobals())

describe('extract policy (text layer)', () => {
  it('accepts long prose', () => {
    const t = normalizeText(
      'Modern tools make immersion easier than ever for self-learners worldwide.',
    )
    expect(isTranslatableText(t, 10)).toBe(true)
  })
})

describe('phrasing + hints', () => {
  it('knows common phrasing tags', () => {
    expect(PHRASING_TAGS.has('code')).toBe(true)
    expect(PHRASING_TAGS.has('a')).toBe(true)
    expect(PHRASING_TAGS.has('div')).toBe(false)
  })

  it('detects markdown / notion style class hints', () => {
    const el = fakeEl({
      tag: 'div',
      className: 'notion-text-block',
      text: 'Hello world this is long enough text.',
    })
    expect(hasTextBlockHint(el)).toBe(true)
    expect(classNameOf(el)).toContain('notion')
  })

  it('detects data-block-type paragraph', () => {
    const el = fakeEl({
      tag: 'div',
      text: 'A paragraph from a block editor that is long enough.',
      attrs: { 'data-block-type': 'paragraph' },
    })
    expect(hasTextBlockHint(el)).toBe(true)
  })

  it('isPhrasingOnly for span with em/code', () => {
    const em = fakeEl({ tag: 'em', text: 'hi' })
    const code = fakeEl({ tag: 'code', text: 'x' })
    // Empty children on leaves
    for (const leaf of [em, code]) {
      Object.defineProperty(leaf, 'children', {
        get: () => [] as unknown as HTMLCollection,
      })
    }
    const span = fakeEl({
      tag: 'span',
      text: 'hi x more text here for length',
    })
    const kids = [em, code]
    Object.defineProperty(span, 'children', {
      get: () => kids as unknown as HTMLCollection,
    })
    expect(isPhrasingOnly(span)).toBe(true)
  })

  it('isLeafTextContainer for plain div text', () => {
    const div = fakeEl({
      tag: 'div',
      text: 'Modern tools make immersion easier than ever for learners.',
    })
    Object.defineProperty(div, 'children', {
      get: () =>
        Object.assign([], {
          length: 0,
          [Symbol.iterator]: function* () {},
        }),
    })
    expect(isLeafTextContainer(div, 10)).toBe(true)
  })

  it('recognizes tab / button UI labels like POWERSHELL', () => {
    const tab = fakeEl({
      tag: 'button',
      text: 'POWERSHELL',
      role: 'tab',
    })
    Object.defineProperty(tab, 'children', {
      get: () => [] as unknown as HTMLCollection,
    })
    expect(isUiLabelElement(tab)).toBe(true)
    expect(isLeafTextContainer(tab, 10)).toBe(true)
  })

  it('does not merge a wrapper containing multiple links into one text block', () => {
    const first = fakeEl({ tag: 'a', text: 'Quickstart' })
    const second = fakeEl({ tag: 'a', text: 'Features overview' })
    const wrapper = fakeEl({
      tag: 'div',
      children: [first, second],
    })
    wrapper.querySelectorAll = ((selector: string) =>
      selector.startsWith('a, button') ? [first, second] : []) as unknown as typeof wrapper.querySelectorAll

    expect(isLeafTextContainer(wrapper, 2)).toBe(false)
  })
})

  it('extracts the pointer target without a document-wide scan', () => {
    vi.stubGlobal('window', {
      innerHeight: 800,
      innerWidth: 1200,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    })
    const paragraph = fakeEl({
      tag: 'p',
      text: 'Pointer-local extraction avoids scanning the full document on every move.',
    })

    expect(extractBlockAtElement(paragraph, 10)).toMatchObject({
      el: paragraph,
      tag: 'p',
      text: 'Pointer-local extraction avoids scanning the full document on every move.',
    })
  })

  it('lens deep extract accepts short labels without page min-length', () => {
    vi.stubGlobal('window', {
      innerHeight: 800,
      innerWidth: 1200,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    })
    // Non-UI bare span: page leaf heuristics + minLength 10 reject "OK".
    const span = fakeEl({ tag: 'span', text: 'OK' })
    Object.defineProperty(span, 'children', {
      get: () => [] as unknown as HTMLCollection,
    })
    expect(extractBlockAtElement(span, 10)).toBeUndefined()
    expect(extractLensBlockAtElement(span, 1)).toMatchObject({
      el: span,
      text: 'OK',
    })
  })

  it('lens deep extract prefers the tight span over a huge ancestor shell', () => {
    vi.stubGlobal('window', {
      innerHeight: 800,
      innerWidth: 1200,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    })
    const span = fakeEl({
      tag: 'span',
      text: 'Hover this phrase only',
    })
    Object.defineProperty(span, 'children', {
      get: () => [] as unknown as HTMLCollection,
    })
    const p1 = fakeEl({ tag: 'p', text: 'Paragraph one with enough length for shell detection here.' })
    const p2 = fakeEl({ tag: 'p', text: 'Paragraph two with enough length for shell detection here.' })
    const p3 = fakeEl({ tag: 'p', text: 'Paragraph three with enough length for shell detection.' })
    const p4 = fakeEl({ tag: 'p', text: 'Paragraph four with enough length for shell detection.' })
    const main = fakeEl({
      tag: 'main',
      text: [
        'Hover this phrase only',
        'Paragraph one with enough length for shell detection here.',
        'Paragraph two with enough length for shell detection here.',
        'Paragraph three with enough length for shell detection.',
        'Paragraph four with enough length for shell detection.',
      ].join(' '),
      children: [span, p1, p2, p3, p4],
    })
    main.querySelectorAll = ((selector: string) => {
      if (selector.includes('p,')) return [p1, p2, p3, p4]
      return []
    }) as unknown as typeof main.querySelectorAll
    Object.defineProperty(span, 'parentElement', { get: () => main })

    expect(extractLensBlockAtElement(span, 1)).toMatchObject({
      el: span,
      text: 'Hover this phrase only',
    })
  })

  it('lens deep extract can read code/pre that page mode skips', () => {
    vi.stubGlobal('window', {
      innerHeight: 800,
      innerWidth: 1200,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    })
    const code = fakeEl({
      tag: 'code',
      text: 'npm install lens-translator',
    })
    Object.defineProperty(code, 'children', {
      get: () => [] as unknown as HTMLCollection,
    })
    // Page skip list treats bare code as non-candidate.
    expect(extractBlockAtElement(code, 2)).toBeUndefined()
    expect(extractLensBlockAtElement(code, 1)).toMatchObject({
      el: code,
      text: 'npm install lens-translator',
    })
  })

  it('extracts rendered offscreen blocks for full-page translation', () => {
    vi.stubGlobal('window', {
      innerHeight: 800,
      innerWidth: 1200,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    })
    const paragraph = fakeEl({
      tag: 'p',
      text: 'This paragraph is rendered far below the current viewport.',
    })
    paragraph.getBoundingClientRect = () => ({
      width: 600,
      height: 40,
      top: 5000,
      left: 0,
      bottom: 5040,
      right: 600,
      x: 0,
      y: 5000,
      toJSON: () => ({}),
    })
    vi.stubGlobal('document', {
      querySelectorAll: (selector: string) =>
        selector.startsWith('p,h1') ? [paragraph] : [],
      createTreeWalker: () => ({ nextNode: () => null }),
    })

    expect(extractVisibleBlocks(10, 0)).toHaveLength(0)
    expect(extractPageBlocks(10)).toMatchObject([{ el: paragraph }])
  })

  it('extracts plain navigation links as separate rows', () => {
    vi.stubGlobal('window', {
      innerHeight: 800,
      innerWidth: 1200,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    })
    const first = fakeEl({ tag: 'a', text: 'Quickstart' })
    const second = fakeEl({ tag: 'a', text: 'Features overview' })
    vi.stubGlobal('document', {
      querySelectorAll: (selector: string) =>
        selector === 'a, [role="link"]' ? [first, second] : [],
      createTreeWalker: () => ({ nextNode: () => null }),
    })

    expect(extractPageBlocks(2).map((block) => block.text)).toEqual([
      'Quickstart',
      'Features overview',
    ])
  })

  it('falls back to deeply nested text nodes with no semantic selectors', () => {
    vi.stubGlobal('window', {
      innerHeight: 800,
      innerWidth: 1200,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    })
    const host = fakeEl({ tag: 'div' })
    const span = fakeEl({ tag: 'span' })
    const strong = fakeEl({ tag: 'strong' })
    Object.defineProperty(span, 'parentElement', { get: () => host })
    Object.defineProperty(strong, 'parentElement', { get: () => span })
    const textNode = {
      data: 'Deep framework wrappers should still expose this sentence for translation.',
      parentElement: strong,
    } as unknown as Text
    let returned = false
    vi.stubGlobal('document', {
      querySelectorAll: () => [],
      createTreeWalker: () => ({
        nextNode: () => {
          if (returned) return null
          returned = true
          return textNode
        },
      }),
    })

    expect(extractPageBlocks(10)).toMatchObject([
      {
        el: host,
        text: 'Deep framework wrappers should still expose this sentence for translation.',
      },
    ])
  })

describe('elementText excludes embedded non-content subtrees', () => {
  it('drops <script type="application/json"> text next to visible UI', () => {
    const container = { tagName: 'DIV', parentElement: null } as unknown as Element
    const button = { tagName: 'BUTTON', parentElement: container } as unknown as Element
    const script = { tagName: 'SCRIPT', parentElement: container } as unknown as Element
    const visibleText = { nodeValue: 'Watch 13', parentElement: button }
    const jsonText = {
      nodeValue: '{"props":{"SubscriptionType":"None","RepositoryId":1053118194}}',
      parentElement: script,
    }
    ;(container as unknown as { querySelector: () => Element }).querySelector = () => script

    vi.stubGlobal('document', {
      createTreeWalker: (
        _root: Node,
        _show: number,
        filter: { acceptNode: (node: Node) => number },
      ) => {
        const yielded = [visibleText, jsonText].filter(
          (n) => filter.acceptNode(n as unknown as Node) === 1,
        )
        let i = 0
        return { nextNode: () => (yielded[i++] ?? null) as unknown as Node }
      },
    })

    expect(elementText(container)).toBe('Watch 13')
  })

  it('returns textContent directly when there is no embedded script/style', () => {
    const el = {
      tagName: 'P',
      textContent: 'Plain readable prose.',
      querySelector: () => null,
    } as unknown as Element
    expect(elementText(el)).toBe('Plain readable prose.')
  })
})

describe('dedupeNestedBlocks', () => {
  it('drops parent when child covers most text', () => {
    const childEl = fakeEl({
      tag: 'p',
      text: 'Child paragraph with enough length for reading unit.',
    })
    const parentEl = fakeEl({
      tag: 'div',
      text: 'Child paragraph with enough length for reading unit.',
      children: [childEl],
    })
    // parent contains child
    parentEl.contains = (o: Node) => o === (childEl as unknown as Node)
    childEl.contains = () => false
    Object.defineProperty(childEl, 'parentElement', { get: () => parentEl })

    const blocks: ExtractedBlock[] = [
      {
        id: 'p1',
        el: parentEl,
        tag: 'div',
        text: 'Child paragraph with enough length for reading unit.',
      },
      {
        id: 'c1',
        el: childEl,
        tag: 'p',
        text: 'Child paragraph with enough length for reading unit.',
      },
    ]
    const out = dedupeNestedBlocks(blocks)
    expect(out.some((b) => b.id === 'c1')).toBe(true)
    expect(out.some((b) => b.id === 'p1')).toBe(false)
  })
})

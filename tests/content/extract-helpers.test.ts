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

  it('treats semantic text nested inside a button as compact UI', () => {
    const button = fakeEl({ tag: 'button', text: 'Continue' })
    const label = fakeEl({ tag: 'p', text: 'Continue', parent: button })
    label.closest = ((selector: string) =>
      selector.includes('button') ? button : null) as typeof label.closest

    expect(isUiLabelElement(label)).toBe(true)
  })

  it('does not treat a model link inside a table cell as standalone UI', () => {
    const cell = fakeEl({ tag: 'td' })
    const link = fakeEl({ tag: 'a', text: 'claude-opus-5-max', parent: cell })
    link.closest = ((selector: string) =>
      selector.includes('td') ? cell : null) as typeof link.closest

    expect(isUiLabelElement(link)).toBe(false)
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

  it('falls back to deeply nested text nodes with no semantic selectors', () => {
    vi.stubGlobal('window', {
      innerHeight: 800,
      innerWidth: 1200,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    })
    const host = fakeEl({ tag: 'div', text: 'Deep framework wrappers should still expose this sentence for translation.' })
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

  it('extracts malformed bare list text as a reading block', () => {
    vi.stubGlobal('window', {
      innerHeight: 800,
      innerWidth: 1200,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    })
    const host = fakeEl({ tag: 'ul', text: '6.5.1. Advisory Council Chairs will serve 3-year terms.' })
    const textNode = {
      data: '6.5.1. Advisory Council Chairs will serve 3-year terms.',
      parentElement: host,
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

    expect(extractPageBlocks(3)).toMatchObject([
      {
        el: host,
        text: '6.5.1. Advisory Council Chairs will serve 3-year terms.',
      },
    ])
  })

  it('keeps a content list item with multiple inline links as one block', () => {
    vi.stubGlobal('window', {
      innerHeight: 800,
      innerWidth: 1200,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    })
    const first = fakeEl({ tag: 'a', text: 'NetSuite' })
    const second = fakeEl({ tag: 'a', text: 'Learning Cloud Support' })
    const item = fakeEl({
      tag: 'li',
      text: 'Access to NetSuite, SuiteAnswers, Help Center, and Learning Cloud Support.',
      children: [first, second],
    })
    item.querySelectorAll = ((selector: string) =>
      selector.startsWith('a, button') ? [first, second] : []) as unknown as typeof item.querySelectorAll
    vi.stubGlobal('document', {
      querySelectorAll: (selector: string) => (selector.startsWith('p,h1') ? [item] : []),
      createTreeWalker: () => ({ nextNode: () => null }),
    })

    expect(extractPageBlocks(3)).toMatchObject([
      {
        el: item,
        text: 'Access to NetSuite, SuiteAnswers, Help Center, and Learning Cloud Support.',
      },
    ])
  })

  it('uses rendered spacing for table cell text', () => {
    vi.stubGlobal('window', {
      innerHeight: 800,
      innerWidth: 1200,
      getComputedStyle: () => ({ display: 'table-cell', visibility: 'visible', opacity: '1' }),
    })
    const cell = Object.assign(
      fakeEl({
        tag: 'td',
        text: 'claude-opus-5-maxAnthropic · Proprietary',
      }),
      { innerText: 'claude-opus-5-max\nAnthropic · Proprietary' },
    )
    vi.stubGlobal('document', {
      querySelectorAll: (selector: string) => (selector.startsWith('p,h1') ? [cell] : []),
      createTreeWalker: () => ({ nextNode: () => null }),
    })

    expect(extractPageBlocks(3).map((block) => block.text)).toEqual([
      'claude-opus-5-max Anthropic · Proprietary',
    ])
  })

  it('splits hard-break footnotes into independent page blocks', () => {
    vi.stubGlobal('window', {
      innerHeight: 800,
      innerWidth: 1200,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    })
    const sup1 = Object.assign(fakeEl({ tag: 'sup', text: '1' }), {
      nodeType: 1,
      isConnected: true,
    })
    const break1 = Object.assign(fakeEl({ tag: 'br' }), { nodeType: 1, isConnected: true })
    const break2 = Object.assign(fakeEl({ tag: 'br' }), { nodeType: 1, isConnected: true })
    const sup2 = Object.assign(fakeEl({ tag: 'sup', text: '2' }), {
      nodeType: 1,
      isConnected: true,
    })
    const break3 = Object.assign(fakeEl({ tag: 'br' }), { nodeType: 1, isConnected: true })
    const break4 = Object.assign(fakeEl({ tag: 'br' }), { nodeType: 1, isConnected: true })
    const strong = fakeEl({
      tag: 'strong',
      children: [sup1, break1, break2, sup2, break3, break4],
    })
    const firstText = {
      nodeType: 3,
      textContent: 'First institutional membership footnote.',
      parentElement: strong,
    }
    const secondText = {
      nodeType: 3,
      textContent: 'Second cloud program membership footnote.',
      parentElement: strong,
    }
    const nodes = [sup1, firstText, break1, break2, sup2, secondText, break3, break4]
    for (let index = 0; index < nodes.length; index++) {
      Object.assign(nodes[index], {
        parentNode: strong,
        parentElement: strong,
        nextSibling: nodes[index + 1] ?? null,
      })
    }
    Object.assign(strong, { childNodes: nodes })
    const paragraph = fakeEl({
      tag: 'p',
      text: '1 First institutional membership footnote. 2 Second cloud program membership footnote.',
      children: [strong],
    })
    Object.assign(strong, { parentElement: paragraph, parentNode: paragraph })
    paragraph.querySelector = ((selector: string) =>
      selector === 'br + br' ? break2 : null) as typeof paragraph.querySelector
    vi.stubGlobal('document', {
      querySelectorAll: (selector: string) => (selector.startsWith('p,h1') ? [paragraph] : []),
      createTreeWalker: () => ({ nextNode: () => null }),
    })

    expect(extractPageBlocks(3).map(({ text, segmentNodes }) => ({ text, segmentNodes }))).toEqual([
      {
        text: '1First institutional membership footnote.',
        segmentNodes: [sup1, firstText],
      },
      {
        text: '2Second cloud program membership footnote.',
        segmentNodes: [sup2, secondText],
      },
    ])
  })

  it('extracts short controls inside page chrome regardless of prose minimum', () => {
    vi.stubGlobal('window', {
      innerHeight: 800,
      innerWidth: 1200,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    })
    const header = fakeEl({ tag: 'header' })
    const iconWrapper = fakeEl({ tag: 'div' })
    const control = fakeEl({
      tag: 'a',
      text: 'Home',
      children: [iconWrapper],
      parent: header,
    })
    control.closest = ((selector: string) =>
      selector.includes('header') ? header : null) as typeof control.closest
    vi.stubGlobal('document', {
      querySelectorAll: (selector: string) =>
        selector.includes('[role="menuitemcheckbox"]') ? [control] : [],
      createTreeWalker: () => ({ nextNode: () => null }),
    })

    expect(extractPageBlocks(10).map((block) => block.text)).toEqual(['Home'])
  })

  it('extracts Reddit comment prose and actions but skips author metadata', () => {
    vi.stubGlobal('window', {
      innerHeight: 800,
      innerWidth: 1200,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    })
    const paragraph = fakeEl({
      tag: 'p',
      text: 'Same thoughts. I am doubting the bang for the buck.',
    })
    const content = fakeEl({
      tag: 'div',
      attrs: { slot: 'comment' },
      children: [paragraph],
    })
    const metadata = fakeEl({ tag: 'div', text: 'TBHProbablyNot · 1d ago' })
    const reply = fakeEl({ tag: 'button', text: 'Reply' })
    const share = fakeEl({ tag: 'button', text: 'Share' })
    const actions = fakeEl({
      tag: 'shreddit-comment-action-row',
      text: 'Reply Share',
      attrs: { slot: 'comment-action-row' },
      children: [reply, share],
    })
    const comment = fakeEl({
      tag: 'shreddit-comment',
      children: [metadata, content, actions],
    })
    Object.assign(paragraph, { parentElement: content, parentNode: content })
    for (const child of [metadata, content, actions]) {
      Object.assign(child, { parentElement: comment, parentNode: comment })
    }
    for (const control of [reply, share]) {
      Object.assign(control, { parentElement: actions, parentNode: actions })
    }
    const commentShadowQuery = vi.fn(() => [] as Element[])
    Object.assign(comment, { shadowRoot: { querySelectorAll: commentShadowQuery } })
    for (const el of [comment, metadata, content, paragraph, actions, reply, share]) {
      el.closest = ((selector: string) => {
        if (selector === 'shreddit-comment') return comment
        if (selector === '[slot="comment"]') {
          return el === content || el === paragraph ? content : null
        }
        if (
          selector ===
          'shreddit-comment-action-row, [slot="comment-action-row"], [slot="actionRow"]'
        ) {
          return el === actions || el === reply || el === share ? actions : null
        }
        return null
      }) as typeof el.closest
    }
    const textNodes = [
      { data: paragraph.textContent, parentElement: paragraph },
      { data: metadata.textContent, parentElement: metadata },
      { data: reply.textContent, parentElement: reply },
      { data: share.textContent, parentElement: share },
    ]
    vi.stubGlobal('document', {
      querySelectorAll: (selector: string) => {
        if (selector === '*') return [comment]
        if (selector.startsWith('p,h1')) return [paragraph]
        if (selector.includes('[role="menuitemcheckbox"]')) return [reply, share]
        return []
      },
      createTreeWalker: () => {
        let index = 0
        return { nextNode: () => textNodes[index++] ?? null }
      },
    })

    expect(extractPageBlocks(3).map((block) => block.text)).toEqual([
      'Same thoughts. I am doubting the bang for the buck.',
      'Reply',
      'Share',
    ])
    expect(commentShadowQuery).not.toHaveBeenCalled()
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
    const svg = { tagName: 'SVG', parentElement: container } as unknown as Element
    const title = { tagName: 'TITLE', parentElement: svg } as unknown as Element
    const iconTitle = { nodeValue: 'Decorative provider name', parentElement: title }
    ;(container as unknown as { querySelector: () => Element }).querySelector = () => script

    vi.stubGlobal('document', {
      createTreeWalker: (
        _root: Node,
        _show: number,
        filter: { acceptNode: (node: Node) => number },
      ) => {
        const yielded = [visibleText, jsonText, iconTitle].filter(
          (n) => filter.acceptNode(n as unknown as Node) === 1,
        )
        let i = 0
        return { nextNode: () => (yielded[i++] ?? null) as unknown as Node }
      },
    })

    expect(elementText(container)).toBe('Watch 13')
  })

  it('drops translator-owned text from a translated parent', () => {
    const container = {
      tagName: 'LI',
      parentElement: null,
      hasAttribute: () => false,
    } as unknown as Element
    const source = {
      tagName: 'A',
      parentElement: container,
      hasAttribute: () => false,
    } as unknown as Element
    const inserted = {
      tagName: 'DIV',
      parentElement: container,
      hasAttribute: (name: string) => name === 'data-lens-ignore',
    } as unknown as Element
    const sourceText = { nodeValue: 'Home', parentElement: source }
    const translatedText = { nodeValue: '首页', parentElement: inserted }
    // Minimal DOM stub: querySelector advertises the ignored child.
    const containerWithQuery = container as unknown as { querySelector: () => Element }
    containerWithQuery.querySelector = () => inserted

    vi.stubGlobal('document', {
      createTreeWalker: (
        _root: Node,
        _show: number,
        filter: { acceptNode: (node: Node) => number },
      ) => {
        const yielded = [sourceText, translatedText].filter(
          (node) => filter.acceptNode(node as unknown as Node) === 1,
        )
        let index = 0
        return { nextNode: () => (yielded[index++] ?? null) as unknown as Node }
      },
    })

    expect(elementText(container)).toBe('Home')
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
  it('drops parent when child covers all its text', () => {
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
    const intro = dedupeNestedBlocks([{ ...blocks[0], text: `Note: ${blocks[0].text}` }, blocks[1]])
    expect(intro.map(block => block.id)).toEqual(['p1'])
  })

  it('drops a shell covered by several nested leaves (union coverage)', () => {
    // Feed-item shell (e.g. <article>) made of div/span lines: no single line
    // dominates and there are no p/li/h descendants, but the lines together
    // cover the shell text — the shell must not be translated a second time.
    const lineA = fakeEl({ tag: 'div', text: 'First line of the post body.' })
    const lineB = fakeEl({ tag: 'div', text: 'Second line follows right here.' })
    const lineC = fakeEl({ tag: 'span', text: 'Third line closes the post.' })
    const shell = fakeEl({
      tag: 'article',
      text:
        'First line of the post body. Second line follows right here. Third line closes the post.',
      children: [lineA, lineB, lineC],
    })
    for (const line of [lineA, lineB, lineC]) {
      Object.defineProperty(line, 'parentElement', { get: () => shell })
      line.contains = () => false
    }
    shell.contains = (o: Node) => [lineA, lineB, lineC].includes(o as unknown as Element)

    const blocks: ExtractedBlock[] = [
      {
        id: 'shell',
        el: shell,
        tag: 'article',
        text: 'First line of the post body. Second line follows right here. Third line closes the post.',
      },
      { id: 'a', el: lineA, tag: 'div', text: 'First line of the post body.' },
      { id: 'b', el: lineB, tag: 'div', text: 'Second line follows right here.' },
      { id: 'c', el: lineC, tag: 'span', text: 'Third line closes the post.' },
    ]
    const out = dedupeNestedBlocks(blocks)
    expect(out.map((b) => b.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('keeps a container with its own text as the sole owner of its nested text', () => {
    // The wrapper carries a long intro the leaves do not cover — dropping it
    // would lose that text, so its nested leaf must yield ownership instead.
    const leaf = fakeEl({ tag: 'div', text: 'Quoted reply text.' })
    const wrapper = fakeEl({
      tag: 'div',
      text:
        'A long introduction paragraph that stands on its own and is not part of any nested leaf block at all. Quoted reply text.',
      children: [leaf],
    })
    Object.defineProperty(leaf, 'parentElement', { get: () => wrapper })
    leaf.contains = () => false
    wrapper.contains = (o: Node) => o === (leaf as unknown as Node)

    const blocks: ExtractedBlock[] = [
      {
        id: 'wrap',
        el: wrapper,
        tag: 'div',
        text: 'A long introduction paragraph that stands on its own and is not part of any nested leaf block at all. Quoted reply text.',
      },
      { id: 'leaf', el: leaf, tag: 'div', text: 'Quoted reply text.' },
    ]
    const out = dedupeNestedBlocks(blocks)
    expect(out.some((b) => b.id === 'wrap')).toBe(true)
    expect(out.some((b) => b.id === 'leaf')).toBe(false)
  })
})

describe('extractEditableTarget', () => {
  function editableHost(
    tag: string,
    opts: {
      value?: string
      type?: string
      disabled?: boolean
      readOnly?: boolean
      contentEditable?: boolean
      textContent?: string
    },
  ): Element {
    const host = {
      tagName: tag.toUpperCase(),
      value: opts.value ?? '',
      type: opts.type ?? '',
      disabled: Boolean(opts.disabled),
      readOnly: Boolean(opts.readOnly),
      isContentEditable: Boolean(opts.contentEditable),
      textContent: opts.textContent ?? '',
      closest: (selector: string) => {
        if (selector.includes('[data-lens-ignore]')) return null
        if (
          selector.includes('textarea') ||
          selector.includes('input') ||
          selector.includes('contenteditable')
        ) {
          return host
        }
        return null
      },
    }
    return host as unknown as Element
  }

  it('reads textarea and plain-text input values with writability', async () => {
    const { extractEditableTarget } = await import('../../src/content/extract')

    const textarea = extractEditableTarget(
      editableHost('textarea', { value: '  你好，世界  ' }),
    )
    expect(textarea).toMatchObject({ kind: 'textarea', text: '你好，世界', writable: true })

    const input = extractEditableTarget(editableHost('input', { value: 'hello', type: 'text' }))
    expect(input).toMatchObject({ kind: 'input', text: 'hello', writable: true })

    const locked = extractEditableTarget(
      editableHost('textarea', { value: 'locked', readOnly: true }),
    )
    expect(locked).toMatchObject({ writable: false })
  })

  it('skips non-text inputs, empty values and non-editables', async () => {
    const { extractEditableTarget } = await import('../../src/content/extract')

    expect(
      extractEditableTarget(editableHost('input', { value: 'secret', type: 'password' })),
    ).toBeNull()
    expect(extractEditableTarget(editableHost('textarea', { value: '   ' }))).toBeNull()

    const div = editableHost('div', {})
    ;(div as { closest: unknown }).closest = () => null
    expect(extractEditableTarget(div)).toBeNull()
  })

  it('reads contenteditable text', async () => {
    const { extractEditableTarget } = await import('../../src/content/extract')
    const host = editableHost('div', {
      contentEditable: true,
      textContent: '  draft message  ',
    })
    expect(extractEditableTarget(host)).toMatchObject({
      kind: 'contenteditable',
      text: 'draft message',
      writable: true,
    })
  })
})

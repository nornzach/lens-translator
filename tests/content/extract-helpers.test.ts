import { describe, it, expect } from 'vitest'
import { isTranslatableText, normalizeText } from '../../src/shared/text'
import {
  classNameOf,
  hasTextBlockHint,
  isPhrasingOnly,
  isLeafTextContainer,
  dedupeNestedBlocks,
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

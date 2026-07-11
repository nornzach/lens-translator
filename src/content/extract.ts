import { makeBlockId } from '../shared/block-id'
import { isTranslatableText, normalizeText } from '../shared/text'

const SEMANTIC_SELECTOR = [
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'blockquote',
  'figcaption',
  'td',
  'th',
  'dt',
  'dd',
  'summary',
].join(',')

/** Inline / phrasing tags allowed inside conservative div/span text containers. */
const PHRASING_TAGS = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'br',
  'cite',
  'code',
  'data',
  'dfn',
  'em',
  'i',
  'kbd',
  'mark',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
  'var',
  'wbr',
  'svg',
  'img',
])

const SKIP_CLOSEST =
  'nav, script, style, noscript, code, pre, textarea, input, button, select, option, [contenteditable="true"], [aria-hidden="true"]'

export type ExtractedBlock = {
  id: string
  el: Element
  tag: string
  text: string
}

function coarsePath(el: Element): string {
  const parts: string[] = []
  let cur: Element | null = el
  let depth = 0
  while (cur && depth < 6) {
    const parent: Element | null = cur.parentElement
    let idx = 0
    if (parent) {
      const siblings = [...parent.children].filter((c) => c.tagName === cur!.tagName)
      idx = Math.max(0, siblings.indexOf(cur))
    }
    parts.push(`${cur.tagName.toLowerCase()}[${idx}]`)
    cur = parent
    depth++
  }
  return '/' + parts.reverse().join('/')
}

function isVisible(el: Element, margin: number): boolean {
  const rect = el.getBoundingClientRect()
  if (rect.width < 2 || rect.height < 2) return false
  const vh = window.innerHeight
  const vw = window.innerWidth
  if (rect.bottom < -margin || rect.top > vh + margin) return false
  if (rect.right < 0 || rect.left > vw) return false
  const style = window.getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false
  }
  return true
}

function isPhrasingOnly(el: Element): boolean {
  for (const child of el.children) {
    const t = child.tagName.toLowerCase()
    if (!PHRASING_TAGS.has(t)) return false
    if (t !== 'br' && t !== 'img' && t !== 'svg' && !isPhrasingOnly(child)) return false
  }
  return true
}

/** Conservative div/span: long enough text, no semantic block descendants, phrasing-only children. */
export function isConservativeTextContainer(el: Element, minTextLength: number): boolean {
  const tag = el.tagName.toLowerCase()
  if (tag !== 'div' && tag !== 'span') return false
  if (el.querySelector(SEMANTIC_SELECTOR)) return false
  if (!isPhrasingOnly(el)) return false
  const text = normalizeText(el.textContent ?? '')
  return isTranslatableText(text, minTextLength)
}

function shouldSkipAsContainer(el: Element, minTextLength: number): boolean {
  const nested = el.querySelector(SEMANTIC_SELECTOR)
  if (!nested || nested === el) return false
  const text = normalizeText(el.textContent ?? '')
  const nestedText = normalizeText(nested.textContent ?? '')
  if (nestedText.length >= minTextLength && nestedText.length > text.length * 0.5) {
    const childBlocks = el.querySelectorAll(SEMANTIC_SELECTOR)
    if (childBlocks.length > 1) return true
  }
  return false
}

export function extractVisibleBlocks(
  minTextLength: number,
  prefetchMarginPx: number,
): ExtractedBlock[] {
  const semantic = document.querySelectorAll(SEMANTIC_SELECTOR)
  const loose = document.querySelectorAll('div, span')
  const out: ExtractedBlock[] = []
  const seen = new Set<string>()
  const seenEl = new Set<Element>()

  const consider = (el: Element, requireConservative: boolean) => {
    if (seenEl.has(el)) return
    if (el.closest(SKIP_CLOSEST)) return
    if (el.closest('#lens-translator-root')) return
    if (!isVisible(el, prefetchMarginPx)) return

    if (requireConservative) {
      if (!isConservativeTextContainer(el, minTextLength)) return
    } else {
      const text = normalizeText(el.textContent ?? '')
      if (!isTranslatableText(text, minTextLength)) return
      if (shouldSkipAsContainer(el, minTextLength)) return
    }

    const text = normalizeText(el.textContent ?? '')
    const tag = el.tagName.toLowerCase()
    const id = makeBlockId(tag, text, coarsePath(el))
    if (seen.has(id)) return
    seen.add(id)
    seenEl.add(el)
    out.push({ id, el, tag, text })
  }

  for (const el of semantic) consider(el, false)
  for (const el of loose) consider(el, true)

  return out
}

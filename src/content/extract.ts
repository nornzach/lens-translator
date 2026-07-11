import { makeBlockId } from '../shared/block-id'
import { isTranslatableText, normalizeText } from '../shared/text'

const BLOCK_SELECTOR = [
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

const SKIP_CLOSEST =
  'nav, script, style, noscript, code, pre, textarea, input, [contenteditable="true"], [aria-hidden="true"]'

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

export function extractVisibleBlocks(
  minTextLength: number,
  prefetchMarginPx: number,
): ExtractedBlock[] {
  const nodes = document.querySelectorAll(BLOCK_SELECTOR)
  const out: ExtractedBlock[] = []
  const seen = new Set<string>()

  for (const el of nodes) {
    if (el.closest(SKIP_CLOSEST)) continue
    if (el.closest('#lens-translator-root')) continue
    if (!isVisible(el, prefetchMarginPx)) continue

    const text = normalizeText(el.textContent ?? '')
    if (!isTranslatableText(text, minTextLength)) continue

    // Prefer leaf-ish blocks: skip containers with multiple substantial nested blocks
    const nested = el.querySelector(BLOCK_SELECTOR)
    if (nested && nested !== el) {
      const nestedText = normalizeText(nested.textContent ?? '')
      if (nestedText.length >= minTextLength && nestedText.length > text.length * 0.5) {
        const childBlocks = el.querySelectorAll(BLOCK_SELECTOR)
        if (childBlocks.length > 1) continue
      }
    }

    const tag = el.tagName.toLowerCase()
    const id = makeBlockId(tag, text, coarsePath(el))
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, el, tag, text })
  }
  return out
}

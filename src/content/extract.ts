import { makeBlockId } from '../shared/block-id'
import { isTranslatableText, normalizeText } from '../shared/text'

/**
 * Primary block-level candidates: HTML semantics + common rich-text / markdown hosts.
 * Markdown renderers (GitHub, CommonMark, MDX, VuePress, Docusaurus, etc.) emit these tags.
 */
const SEMANTIC_TAGS = [
  // Core prose
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
  'caption',
  'td',
  'th',
  'dt',
  'dd',
  'summary',
  'label',
  'legend',
  'address',
  // Less common but real content
  'article',
  // Note: section/main/aside are often huge wrappers — handled via leaf heuristics
] as const

/** Role-based content (ARIA / virtualized UIs). */
const ROLE_SELECTORS = [
  '[role="heading"]',
  '[role="listitem"]',
  '[role="paragraph"]',
  '[role="article"]',
  '[role="text"]',
]

/**
 * Host surfaces that usually contain markdown / rich HTML.
 * We still extract child semantic nodes; these help when prose is plain divs.
 */
const RICH_HOST_SELECTORS = [
  '.markdown-body',
  '.markdown-content',
  '.markdown',
  '.md-content',
  '.md-typeset', // Material / MkDocs
  '.prose', // Tailwind Typography
  '.Post-body',
  '.post-content',
  '.entry-content',
  '.article-content',
  '.article-body',
  '.post-body',
  '.rich-text',
  '.RichText',
  '.notion-page-content',
  '[data-testid="post_message"]', // Slack-like
  '.message-body',
  '.comment-body',
  '.js-comment-body',
  '.wiki-body',
  '.doc-content',
  '.docs-content',
  '.content__default', // VuePress
  '.theme-default-content',
  '.vp-doc', // VitePress
  '.mdx-content',
  '[class*="Markdown"]',
  '[class*="markdown"]',
  '[class*="ProseMirror"]',
  '[class*="DraftEditor"]',
  '[class*="ql-editor"]', // Quill
  '[class*="tiptap"]',
  '[class*="slate-"]',
  '[data-slate-editor]',
]

/**
 * Class / attribute hints that a div/section is a *leaf-ish* text block
 * (Notion, Medium, Linear, Coda, custom CMS, etc.).
 */
const TEXT_BLOCK_HINT_RE =
  /(?:^|[\s_-])(?:paragraph|text-block|textblock|richtext|rich-text|post-body|postbody|entry-content|article-body|md-p|md-block|markdown-p|block-paragraph|block-text|notion-text|notion-page-block|pw-post-body|reader-word|transcript|caption-text|message-text|comment-text|answer-text|question-title|issue-body)(?:$|[\s_-])/i

const DATA_BLOCK_HINT_RE = /paragraph|text|heading|list.?item|quote|callout|toggle|bulleted|numbered|to.?do/i

/** Inline / phrasing tags allowed inside leaf text containers. */
export const PHRASING_TAGS = new Set([
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
  'picture',
  'source',
  'font', // legacy mail HTML
  'strike',
  'big',
  'tt',
  'acronym',
  'del',
  'ins',
  'math', // keep as phrasing host; we may still skip pure math leaves later
  'mi',
  'mo',
  'mn',
  'mrow',
  'msup',
  'msub',
])

/**
 * Skip if *this* element is inside chrome/noise.
 * Note: do NOT put `code` here as closest() — that would skip paragraphs containing inline code.
 */
const SKIP_CLOSEST =
  [
    'script',
    'style',
    'noscript',
    'template',
    'svg',
    'canvas',
    'video',
    'audio',
    'iframe',
    'object',
    'embed',
    'textarea',
    'input',
    'select',
    'option',
    'button',
    'nav',
    'pre', // fenced code / preformatted — usually not continuous reading target
    '[contenteditable="true"]',
    '[aria-hidden="true"]',
    '[role="navigation"]',
    '[role="banner"]',
    '[role="search"]',
    '[role="menu"]',
    '[role="menubar"]',
    '[role="toolbar"]',
    '[role="tablist"]',
    '[data-lens-ignore]',
    '#lens-translator-root',
  ].join(', ')

const SKIP_SELF_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'video',
  'audio',
  'iframe',
  'object',
  'embed',
  'textarea',
  'input',
  'select',
  'option',
  'button',
  'nav',
  'pre',
  'code', // bare code element (inline is still readable via parent p)
  'br',
  'hr',
  'img',
  'path',
  'meta',
  'link',
  'head',
  'html',
  'body',
])

export type ExtractedBlock = {
  id: string
  el: Element
  tag: string
  text: string
}

export function coarsePath(el: Element): string {
  const parts: string[] = []
  let cur: Element | null = el
  let depth = 0
  while (cur && depth < 8) {
    const parent: Element | null = cur.parentElement
    let idx = 0
    if (parent) {
      const siblings = [...parent.children].filter((c) => c.tagName === cur!.tagName)
      idx = Math.max(0, siblings.indexOf(cur))
    }
    const name = cur.tagName.toLowerCase()
    parts.push(`${name}[${idx}]`)
    cur = parent
    depth++
  }
  return '/' + parts.reverse().join('/')
}

export function isVisible(el: Element, margin: number): boolean {
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

export function isPhrasingOnly(el: Element): boolean {
  for (const child of el.children) {
    const t = child.tagName.toLowerCase()
    // Custom elements used as inline wrappers (rare) — treat as non-phrasing
    if (t.includes('-')) return false
    if (!PHRASING_TAGS.has(t)) return false
    if (
      t !== 'br' &&
      t !== 'img' &&
      t !== 'source' &&
      t !== 'wbr' &&
      t !== 'path' &&
      !isPhrasingOnly(child)
    ) {
      return false
    }
  }
  return true
}

export function classNameOf(el: Element): string {
  if (typeof el.className === 'string') return el.className
  // SVGAnimatedString etc.
  const attr = el.getAttribute('class')
  return attr ?? ''
}

export function hasTextBlockHint(el: Element): boolean {
  const cls = classNameOf(el)
  if (TEXT_BLOCK_HINT_RE.test(cls)) return true
  const testId = el.getAttribute('data-testid') || el.getAttribute('data-test') || ''
  if (TEXT_BLOCK_HINT_RE.test(testId)) return true
  const blockType =
    el.getAttribute('data-block-type') ||
    el.getAttribute('data-type') ||
    el.getAttribute('data-slate-type') ||
    el.getAttribute('data-text-type') ||
    ''
  if (blockType && DATA_BLOCK_HINT_RE.test(blockType)) return true
  const role = el.getAttribute('role') || ''
  if (role === 'heading' || role === 'listitem' || role === 'paragraph' || role === 'text') {
    return true
  }
  return false
}

function isCustomElement(el: Element): boolean {
  return el.tagName.includes('-')
}

function childSemanticCount(el: Element): number {
  let n = 0
  for (const tag of SEMANTIC_TAGS) {
    n += el.querySelectorAll(tag).length
    if (n > 3) return n
  }
  for (const sel of ROLE_SELECTORS) {
    n += el.querySelectorAll(sel).length
    if (n > 3) return n
  }
  return n
}

/**
 * Leaf-ish container: enough text, not a huge multi-block shell.
 * Used for div/span/section/article/custom elements.
 */
export function isLeafTextContainer(el: Element, minTextLength: number): boolean {
  const tag = el.tagName.toLowerCase()
  if (SKIP_SELF_TAGS.has(tag)) return false

  const text = normalizeText(el.textContent ?? '')
  if (!isTranslatableText(text, minTextLength)) return false

  // Prefer phrasing-only leaves
  if (isPhrasingOnly(el)) return true

  // Hinted CMS / markdown leaf blocks may wrap a single inner structure
  if (hasTextBlockHint(el)) {
    const kids = childSemanticCount(el)
    // One heading/paragraph inside is OK; a whole article shell is not
    if (kids <= 2 && text.length <= 2000) return true
    if (kids === 0 && text.length >= minTextLength && text.length <= 1500) return true
  }

  // Custom elements that are small text hosts (e.g. <yt-formatted-string>, <markdown-text>)
  if (isCustomElement(el)) {
    const kids = childSemanticCount(el)
    if (kids === 0 && isPhrasingOnly(el)) return true
    if (kids <= 1 && text.length <= 1200 && text.length >= minTextLength) return true
  }

  return false
}

function shouldSkipAsNestedContainer(el: Element, minTextLength: number): boolean {
  // If this node contains multiple semantic blocks, prefer the children
  const count = childSemanticCount(el)
  if (count > 1) {
    const text = normalizeText(el.textContent ?? '')
    // Large wrappers (article, div.content) — skip as unit
    if (text.length > minTextLength * 2) return true
  }
  return false
}

function shouldSkipElement(el: Element): boolean {
  if (el.closest(SKIP_CLOSEST)) return true
  if (el.closest('#lens-translator-root')) return true
  const tag = el.tagName.toLowerCase()
  if (SKIP_SELF_TAGS.has(tag)) return true
  // Hidden by HTML attribute
  if (el.hasAttribute('hidden')) return true
  if (el.getAttribute('aria-hidden') === 'true') return true
  return false
}

function collectCandidates(root: ParentNode = document): Element[] {
  const list: Element[] = []
  const seen = new Set<Element>()

  const addAll = (nodes: NodeListOf<Element> | Element[]) => {
    for (const el of nodes) {
      if (!seen.has(el)) {
        seen.add(el)
        list.push(el)
      }
    }
  }

  // 1) Semantic HTML
  addAll(root.querySelectorAll(SEMANTIC_TAGS.join(',')))

  // 2) ARIA roles
  addAll(root.querySelectorAll(ROLE_SELECTORS.join(',')))

  // 3) Inside rich hosts: also grab direct leaf-ish children (div/span)
  for (const host of root.querySelectorAll(RICH_HOST_SELECTORS.join(','))) {
    addAll(host.querySelectorAll(SEMANTIC_TAGS.join(',')))
    addAll(host.querySelectorAll(':scope > div, :scope > span, :scope > section'))
    // Nested one level of div wrappers common in MDX
    addAll(host.querySelectorAll('div > p, div > li, div > h1, div > h2, div > h3, section > p'))
  }

  // 4) Hinted text blocks
  addAll(
    root.querySelectorAll(
      [
        '[data-block-type]',
        '[data-slate-type]',
        '[data-text-type]',
        '[class*="paragraph"]',
        '[class*="Paragraph"]',
        '[class*="text-block"]',
        '[class*="TextBlock"]',
        '[class*="notion-text"]',
        '[class*="markdown"] p',
        '[class*="Markdown"] p',
        '[class*="prose"] p',
        '[class*="prose"] li',
      ].join(','),
    ),
  )

  // 5) Generic leaves: div/span/section/article + custom elements (sampled via query)
  addAll(root.querySelectorAll('div, span, section, article, main'))
  // Custom elements: any tag with a hyphen (web components)
  // querySelectorAll('*') is heavy — limit to visible area callers already margin-filter
  for (const el of root.querySelectorAll('*')) {
    if (el.tagName.includes('-') && !seen.has(el)) {
      seen.add(el)
      list.push(el)
    }
  }

  return list
}

export function extractVisibleBlocks(
  minTextLength: number,
  prefetchMarginPx: number,
): ExtractedBlock[] {
  const candidates = collectCandidates(document)
  const out: ExtractedBlock[] = []
  const seenIds = new Set<string>()
  const seenEls = new Set<Element>()

  for (const el of candidates) {
    if (seenEls.has(el)) continue
    if (shouldSkipElement(el)) continue
    if (!isVisible(el, prefetchMarginPx)) continue

    const tag = el.tagName.toLowerCase()
    const isSemantic = (SEMANTIC_TAGS as readonly string[]).includes(tag)
    const role = el.getAttribute('role') || ''
    const isRoleBlock =
      role === 'heading' || role === 'listitem' || role === 'paragraph' || role === 'text'

    if (isSemantic || isRoleBlock) {
      const text = normalizeText(el.textContent ?? '')
      if (!isTranslatableText(text, minTextLength)) continue
      if (shouldSkipAsNestedContainer(el, minTextLength)) continue
    } else {
      // div / span / section / custom: only leaf text containers
      if (!isLeafTextContainer(el, minTextLength)) continue
    }

    const text = normalizeText(el.textContent ?? '')
    if (!isTranslatableText(text, minTextLength)) continue

    // Prefer not registering both parent and child when child is a better unit
    // If parent already added a child that is fully this text — skip duplicates via id
    const id = makeBlockId(tag, text, coarsePath(el))
    if (seenIds.has(id)) continue

    seenIds.add(id)
    seenEls.add(el)
    out.push({ id, el, tag, text })
  }

  // Drop parent blocks that fully contain a smaller registered child (same text prefix noise)
  return dedupeNestedBlocks(out)
}

/** Remove outer wrappers when a nested block already covers the same reading unit. */
export function dedupeNestedBlocks(blocks: ExtractedBlock[]): ExtractedBlock[] {
  if (blocks.length <= 1) return blocks
  const keep: ExtractedBlock[] = []

  for (const b of blocks) {
    let dominated = false
    for (const other of blocks) {
      if (other === b) continue
      if (!b.el.contains(other.el)) continue
      // If child is a real sub-block with substantial text, drop parent
      if (other.text.length >= Math.min(b.text.length * 0.5, b.text.length - 1)) {
        // Parent that only wraps this one child text unit
        if (b.text.length <= other.text.length + 40 || b.el.querySelectorAll('p,li,h1,h2,h3,h4,h5,h6').length >= 1) {
          dominated = true
          break
        }
      }
    }
    if (!dominated) keep.push(b)
  }
  return keep
}

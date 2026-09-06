import { makeBlockId } from '../shared/block-id'
import { isTranslatableText, normalizeText } from '../shared/text'

export const PAGE_SOURCE_ATTR = 'data-lens-translator-source'
export const PAGE_SEGMENT_ATTR = 'data-lens-page-segment'

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

const UI_PLACEHOLDER_SELECTOR =
  '[class*="DraftEditorPlaceholder"], [class*="EditorPlaceholder"], [class*="editor-placeholder"]'

const UI_LABEL_SELECTOR = [
  'a',
  'button',
  'label',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="menuitemcheckbox"]',
  '[role="option"]',
  '[role="switch"]',
].join(', ')

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

/** Hard skip ancestors containing no safe visible text. Page chrome itself is translatable. */
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
    '[contenteditable]:not([contenteditable="false"])',
    '[role="textbox"]',
    UI_PLACEHOLDER_SELECTOR,
    '[aria-hidden="true"]',
    '[class*="author-name"]',
    '[data-testid="User-Name"]',
    // Transient overlays positioned over other content; an inserted translation
    // would cover whatever the tooltip points at (e.g. GitHub's <tool-tip>).
    '[role="tooltip"]',
    'tool-tip',
    '[data-lens-ignore]',
    '[data-lens-page-translation]',
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
  /** Direct sibling nodes forming one paragraph separated by <br><br>. */
  segmentNodes?: Node[]
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
  if (!isRendered(el, rect)) return false
  const vh = window.innerHeight
  const vw = window.innerWidth
  if (rect.bottom < -margin || rect.top > vh + margin) return false
  if (rect.right < 0 || rect.left > vw) return false
  return true
}

function isRendered(el: Element, rect = el.getBoundingClientRect()): boolean {
  if (rect.width < 2 || rect.height < 2) return false
  const style = window.getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false
  }
  return true
}

/** Subtrees whose text must never be translated even when nested inside a content block. */
const NON_CONTENT_TEXT_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg'])
const NON_CONTENT_TEXT_SELECTOR =
  'script, style, noscript, template, svg, [data-lens-ignore]'

/**
 * Element text excluding embedded non-content and translator-owned subtrees.
 *
 * `Element.textContent` concatenates script/style/template payloads and our
 * inserted translations. Feeding either back into extraction corrupts the
 * source text and can recursively translate a whole parent container.
 *
 * `maxChars` stops the walk early (returning an over-limit string). For threshold
 * checks only — e.g. the lens rejects blocks over 4000 chars, so walking a huge
 * SPA root per mousemove frame just to learn "too big" was pure GC churn.
 */
export function elementText(el: Element, maxChars?: number): string {
  if (el.hasAttribute?.('data-lens-ignore')) return ''
  const canWalk =
    typeof document !== 'undefined' && typeof document.createTreeWalker === 'function'
  if (
    !canWalk ||
    (maxChars === undefined &&
      (typeof el.querySelector !== 'function' ||
        !el.querySelector(NON_CONTENT_TEXT_SELECTOR)))
  ) {
    const text = el.textContent ?? ''
    return maxChars !== undefined && text.length > maxChars ? text.slice(0, maxChars) : text
  }
  const walker = document.createTreeWalker(el, 4 /* SHOW_TEXT */, {
    acceptNode(node) {
      let ancestor = node.parentElement
      while (ancestor && ancestor !== el) {
        if (
          NON_CONTENT_TEXT_TAGS.has(ancestor.tagName.toLowerCase()) ||
          ancestor.hasAttribute?.('data-lens-ignore')
        ) {
          return 2 // FILTER_REJECT
        }
        ancestor = ancestor.parentElement
      }
      return 1 // FILTER_ACCEPT
    },
  })
  let text = ''
  let node = walker.nextNode()
  while (node) {
    text += node.nodeValue ?? ''
    if (maxChars !== undefined && text.length > maxChars) return text
    node = walker.nextNode()
  }
  return text
}

/** One source traversal for extraction, mutation checks, and highlight offsets. */
export function* pageSourceTextNodes(root: Element): Generator<{ node: Text; separator: boolean }> {
  let separator = false
  function* visit(node: Node): Generator<{ node: Text; separator: boolean }> {
    if (node.nodeType === 3) {
      if (node.textContent?.trim()) {
        yield { node: node as Text, separator }
        separator = false
      } else if (node.textContent) separator = true
      return
    }
    if (node.nodeType !== 1) return
    const el = node as Element
    if (el.matches(SKIP_CLOSEST)) return
    const display = window.getComputedStyle(el).display
    if (display === 'none') return
    const boundary = el.tagName === 'BR' || /^(block|flow-root|list-item|table|flex|grid)/.test(display)
    if (boundary) separator = true
    for (const child of el.childNodes) yield* visit(child)
    if (boundary) separator = true
  }
  yield* visit(root)
}

export function pageSourceText(el: Element): string {
  // Geometry-free consumers can still provide plain element text.
  if (!el.ownerDocument?.createTreeWalker) {
    return normalizeText((el as HTMLElement).innerText ?? elementText(el))
  }
  let text = ''
  for (const part of pageSourceTextNodes(el)) {
    text += (part.separator ? ' ' : '') + part.node.data
  }
  return normalizeText(text)
}

function sourceTextOf(el: Element): string {
  const stored = el.getAttribute(PAGE_SOURCE_ATTR)
  return stored !== null ? normalizeText(stored) : pageSourceText(el)
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

function hasMultipleUiLabelDescendants(el: Element): boolean {
  return el.querySelectorAll(
    'a, button, [role="link"], [role="button"], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="option"]',
  ).length > 1
}

/**
 * Tab labels, menu items, plain text buttons — short UI copy that learners may want.
 * e.g. POWERSHELL / CURL tabs on marketing pages.
 */
export function isUiLabelElement(el: Element): boolean {
  const role = (el.getAttribute('role') || '').toLowerCase()
  const tag = el.tagName.toLowerCase()
  const containingControl = el.closest(UI_LABEL_SELECTOR)
  if (
    containingControl &&
    containingControl !== el &&
    isUiLabelElement(containingControl)
  ) {
    return true
  }
  const embeddedLink =
    (tag === 'a' || role === 'link') &&
    (Boolean(el.closest('p, blockquote, td, th, h1, h2, h3, h4, h5, h6')) ||
      (Boolean(el.closest('li')) && !el.closest('nav, [role="navigation"], [role="menu"]')))
  if (embeddedLink) return false
  if (tag === 'a' || role === 'link') {
    // A clickable card is a container, not a control label. Keep its title and
    // metadata as separate reading rows, even when it has role="link".
    const rows = [...el.querySelectorAll('div, p, h1, h2, h3, h4, h5, h6')]
      .filter(child => isPhrasingOnly(child) && normalizeText(elementText(child)))
    if (sourceTextOf(el).length > 80 || rows.length > 1) return false
  }
  if (
    role === 'tab' ||
    role === 'menuitem' ||
    role === 'menuitemradio' ||
    role === 'menuitemcheckbox' ||
    role === 'option' ||
    role === 'button' ||
    role === 'link' ||
    role === 'switch'
  ) {
    return true
  }
  if (tag === 'button' || tag === 'summary' || tag === 'label') return true
  // Short anchors are navigation/chip labels even when an icon wrapper is block-like.
  if (tag === 'a') {
    const text = sourceTextOf(el)
    if (text.length > 0 && text.length <= 48) return true
  }
  // Div/span chips inside a tablist
  if (
    el.closest('[role="tablist"]') &&
    (tag === 'div' || tag === 'span' || tag === 'li') &&
    (isPhrasingOnly(el) || el.children.length === 0)
  ) {
    const text = sourceTextOf(el)
    if (text.length > 0 && text.length <= 48) return true
  }
  return false
}

/** Put compact translations beside the label, not beside its icon or wrapper. */
function uiTextHost(el: Element): Element {
  const walker = el.ownerDocument?.createTreeWalker?.(el, 4)
  if (!walker) return el
  let label: Element | null = null
  let node = walker.nextNode()
  while (node) {
    const parent = node.parentElement
    if (parent && normalizeText(node.textContent ?? '') && !parent.closest(SKIP_CLOSEST)) {
      if (label && label !== parent) return el
      label = parent
    }
    node = walker.nextNode()
  }
  return label ?? el
}

/**
 * Leaf-ish container: enough text, not a huge multi-block shell.
 * Used for div/span/section/article/custom elements + UI labels.
 */
export function isLeafTextContainer(el: Element, minTextLength: number): boolean {
  const tag = el.tagName.toLowerCase()
  const text = sourceTextOf(el)
  if (SKIP_SELF_TAGS.has(tag)) return false

  if (!isTranslatableText(text, minTextLength)) return false

  // A wrapper around several links/buttons is a menu, not one reading unit.
  if (isPhrasingOnly(el)) return !hasMultipleUiLabelDescendants(el)

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
    const text = sourceTextOf(el)
    // Large wrappers (article, div.content) — skip as unit
    if (text.length > minTextLength * 2) return true
  }
  return false
}

function shouldSkipElement(el: Element, allowSegmentContainer = false): boolean {
  if (el.closest('#lens-translator-root')) return true
  const redditComment = el.closest('shreddit-comment')
  if (redditComment) {
    const commentContent = el.closest('[slot="comment"]')
    const actionRow = el.closest(
      'shreddit-comment-action-row, [slot="comment-action-row"], [slot="actionRow"]',
    )
    if (
      (!commentContent || commentContent.closest('shreddit-comment') !== redditComment) &&
      !actionRow
    ) {
      return true
    }
  }
  if (
    !allowSegmentContainer && !el.hasAttribute(PAGE_SOURCE_ATTR) &&
    el.querySelector('[data-lens-page-inserted]')
  ) {
    return true
  }
  if (el.parentElement?.closest('[data-lens-page-translated], [data-lens-page-pending]')) return true
  if (el.hasAttribute('hidden')) return true
  if (el.getAttribute('aria-hidden') === 'true') return true

  if (el.closest(SKIP_CLOSEST)) return true
  const tag = el.tagName.toLowerCase()
  if (SKIP_SELF_TAGS.has(tag)) return true
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

  // 2) ARIA content roles
  addAll(root.querySelectorAll(ROLE_SELECTORS.join(',')))
  // Short controls need their own hosts so translations stay inside the control
  // instead of becoming detached blocks after an entire toolbar or menu.
  addAll(root.querySelectorAll(UI_LABEL_SELECTOR))
  addAll(root.querySelectorAll(`[${PAGE_SEGMENT_ATTR}]`))


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

  return list
}

function extractCandidate(
  el: Element,
  minTextLength: number,
  prefetchMarginPx: number | null,
): ExtractedBlock | undefined {
  const uiLabel = isUiLabelElement(el)
  if (uiLabel) el = uiTextHost(el)
  const textMinLength = uiLabel ? 1 : minTextLength
  if (
    shouldSkipElement(el) ||
    (prefetchMarginPx === null ? !isRendered(el) : !isVisible(el, prefetchMarginPx))
  ) {
    return undefined
  }

  const tag = el.tagName.toLowerCase()
  const isSemantic = (SEMANTIC_TAGS as readonly string[]).includes(tag)
  const role = el.getAttribute('role') || ''
  // A horizontal row carrying several text-bearing children is a tab strip or
  // toolbar; its items are UI labels, not prose (HF's "Discussions / Pull
  // requests" tabs, checkbox labels). Single-text rows (truncated titles) pass.
  const parent = el.parentElement
  if (
    !uiLabel &&
    parent &&
    typeof window !== 'undefined' &&
    typeof window.getComputedStyle === 'function'
  ) {
    const parentStyle = window.getComputedStyle(parent)
    if (parentStyle.display?.includes('flex') && parentStyle.flexDirection?.startsWith('row')) {
      let textCarriers = 0
      for (const child of parent.children) {
        if (normalizeText(elementText(child)).length > 0) textCarriers++
        if (textCarriers > 1) return undefined
      }
    }
  }
  const isRoleBlock =
    role === 'heading' ||
    role === 'listitem' ||
    role === 'paragraph' ||
    role === 'text'

  if (isSemantic || isRoleBlock) {
    const text = sourceTextOf(el)
    if (!isTranslatableText(text, textMinLength)) return undefined
    if (shouldSkipAsNestedContainer(el, minTextLength)) return undefined
    // Article shells with action controls are containers, not prose. A <li>
    // with several links is still prose unless it belongs to navigation.
    if (
      hasMultipleUiLabelDescendants(el) &&
      (tag === 'article' ||
        (tag === 'li' &&
          Boolean(el.closest('nav, aside, [role="navigation"], [role="complementary"]'))))
    ) {
      return undefined
    }
  } else if (!uiLabel && !isLeafTextContainer(el, textMinLength)) {
    return undefined
  }

  const text = sourceTextOf(el)
  if (!isTranslatableText(text, textMinLength)) return undefined
  return { id: makeBlockId(tag, text, coarsePath(el)), el, tag, text }
}

/**
 * Some CMS pages encode several paragraphs as one semantic element separated
 * only by <br><br>. Return each paragraph with the nodes the renderer must wrap
 * into its own source host; otherwise all translations land after the group.
 */
function extractHardBreakSegments(
  el: Element,
  minTextLength: number,
  prefetchMarginPx: number | null,
): ExtractedBlock[] | null {
  const secondBreak = el.querySelector('br + br')
  if (!secondBreak) return null
  if (
    shouldSkipElement(el, true) ||
    (prefetchMarginPx === null ? !isRendered(el) : !isVisible(el, prefetchMarginPx))
  ) {
    return []
  }

  const container = secondBreak.parentElement
  if (!container) return null
  const nodes = [...container.childNodes]
  const groups: Node[][] = []
  let start = 0
  for (let index = 0; index < nodes.length - 1; index++) {
    if (
      nodes[index].nodeType === 1 &&
      (nodes[index] as Element).tagName.toLowerCase() === 'br' &&
      nodes[index + 1].nodeType === 1 &&
      (nodes[index + 1] as Element).tagName.toLowerCase() === 'br'
    ) {
      groups.push(nodes.slice(start, index))
      index++
      start = index + 1
    }
  }
  groups.push(nodes.slice(start))

  const tag = el.tagName.toLowerCase()
  const blocks: ExtractedBlock[] = []
  for (const group of groups) {
    const sourceNodes = group.filter(
      (node) =>
        !(
          node.nodeType === 1 &&
          (node as Element).hasAttribute?.('data-lens-ignore')
        ),
    )
    const existing = sourceNodes.find(
      (node) =>
        node.nodeType === 1 &&
        (node as Element).hasAttribute?.(PAGE_SEGMENT_ATTR),
    ) as Element | undefined
    if (existing) {
      const block = extractCandidate(existing, minTextLength, prefetchMarginPx)
      if (block) blocks.push(block)
      continue
    }
    const text = normalizeText(sourceNodes.map((node) => node.textContent ?? '').join(''))
    if (!isTranslatableText(text, minTextLength)) continue
    const anchor =
      (sourceNodes.find(
        (node) =>
          node.nodeType === 1 &&
          (node as Element).tagName.toLowerCase() !== 'br',
      ) as Element | undefined) ?? secondBreak
    blocks.push({
      id: makeBlockId(tag, text, coarsePath(anchor)),
      el: anchor,
      tag,
      text,
      segmentNodes: sourceNodes,
    })
  }
  return blocks.length >= 2 ? blocks : null
}

// ---------------------------------------------------------------------------
// Lens-only deep pointer resolution (independent of full-page extract policy)
// ---------------------------------------------------------------------------

/** Lens accepts single letters / short UI tokens; full-page stays conservative. */
export const LENS_MIN_TEXT_LENGTH = 1
/** Hard cap so a mis-hit on <main> does not dump the whole page into the lens. */
export const LENS_MAX_TEXT_LENGTH = 4000

/**
 * Lens must not inherit page-mode skips (nav, pre, tooltips, toolbars, …).
 * Only hard noise and extension chrome are excluded.
 */
const LENS_SKIP_SELF = new Set([
  'script',
  'style',
  'noscript',
  'template',
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
  'br',
  'hr',
  'img',
  'path',
  'meta',
  'link',
  'head',
  'html',
  'body',
  'svg',
])

const LENS_SKIP_CLOSEST =
  'script, style, noscript, template, canvas, video, audio, iframe, object, embed, textarea, input, select, [data-lens-ignore], #lens-translator-root, #lens-translator-bubble-root, #lens-translator-selection-root, #lens-translator-setup-prompt'

function shouldSkipForLens(el: Element): boolean {
  if (el.closest(LENS_SKIP_CLOSEST)) return true
  if (el.hasAttribute('hidden')) return true
  if (el.getAttribute('aria-hidden') === 'true') return true
  const tag = el.tagName.toLowerCase()
  if (LENS_SKIP_SELF.has(tag)) return true
  // Pure decoration without letters (icon fonts sometimes leave empty spans)
  return false
}

/** Giant multi-block shells are never a single lens reading unit. */
function isOversizedLensShell(el: Element, text: string): boolean {
  if (text.length < 280) return false
  const blocks = el.querySelectorAll(
    'p, li, h1, h2, h3, h4, h5, h6, tr, blockquote, pre, section, article',
  ).length
  return blocks >= 4
}

function lensMinFor(el: Element, minTextLength: number): number {
  if (isUiLabelElement(el)) return 1
  return Math.max(1, Math.min(minTextLength, LENS_MIN_TEXT_LENGTH + 1))
}

/**
 * Walk from the deepest hit upward and pick the **tightest** translatable unit.
 * Does not use extractCandidate / page leaf heuristics / page skip lists.
 */
export function extractLensBlockAtElement(
  hit: Element | null,
  minTextLength: number = LENS_MIN_TEXT_LENGTH,
): ExtractedBlock | undefined {
  let current: Element | null = hit
  while (current !== null) {
    const el: Element = current
    const tag = el.tagName.toLowerCase()
    if (tag === 'html' || tag === 'body') break

    let rendered = true
    if (!shouldSkipForLens(el)) {
      try {
        rendered = isRendered(el)
      } catch {
        // Test stubs may lack getComputedStyle.
        rendered = true
      }
      if (rendered) {
        // Over-limit blocks are rejected below anyway — never materialize a
        // whole subtree's text on the pointer hot path (see elementText).
        const text = normalizeText(elementText(el, LENS_MAX_TEXT_LENGTH + 1))
        const min = lensMinFor(el, minTextLength)
        if (
          isTranslatableText(text, min) &&
          text.length <= LENS_MAX_TEXT_LENGTH &&
          !isOversizedLensShell(el, text)
        ) {
          return {
            id: makeBlockId(tag, text, coarsePath(el)),
            el,
            tag,
            text,
          }
        }
      }
    }
    current = el.parentElement
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Lens-only editable-field resolution (input back-translation)
// ---------------------------------------------------------------------------

export type EditableTarget = {
  el: HTMLElement
  kind: 'textarea' | 'input' | 'contenteditable'
  text: string
  /** False for disabled/readOnly fields — the replace action must stay hidden. */
  writable: boolean
}

/** Input types that hold free text; everything else (password, number, …) is skipped. */
const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'url', 'email'])

/**
 * Resolve an editable field at/above the pointer hit for the lens' writing
 * mode. Full-page and auto-scan paths keep skipping editables — this is only
 * reachable through explicit lens activation.
 */
export function extractEditableTarget(
  hit: Element | null,
  maxChars = LENS_MAX_TEXT_LENGTH,
): EditableTarget | null {
  const host = hit?.closest(
    'textarea, input, [contenteditable]:not([contenteditable="false"])',
  ) as HTMLElement | null
  if (!host) return null
  if (host.closest('[data-lens-ignore], #lens-translator-root, #lens-translator-bubble-root, #lens-translator-selection-root, #lens-translator-setup-prompt')) {
    return null
  }

  const tag = host.tagName.toLowerCase()
  if (tag === 'textarea') {
    const field = host as HTMLTextAreaElement
    const text = normalizeText(field.value)
    if (!text || text.length > maxChars) return null
    return { el: field, kind: 'textarea', text, writable: !field.disabled && !field.readOnly }
  }
  if (tag === 'input') {
    const field = host as HTMLInputElement
    if (!TEXT_INPUT_TYPES.has(field.type)) return null
    const text = normalizeText(field.value)
    if (!text || text.length > maxChars) return null
    return { el: field, kind: 'input', text, writable: !field.disabled && !field.readOnly }
  }
  if (host.isContentEditable) {
    const text = normalizeText(elementText(host, maxChars + 1))
    if (!text || text.length > maxChars) return null
    return { el: host, kind: 'contenteditable', text, writable: true }
  }
  return null
}

/**
 * Deep pointer target for the lens: prefer the text node under the caret, then
 * the element stack. Full-page scanners must not call this.
 */
export function extractLensTargetAt(
  clientX: number,
  clientY: number,
  minTextLength: number = LENS_MIN_TEXT_LENGTH,
): ExtractedBlock | undefined {
  let start: Element | null = null

  try {
    const doc = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node } | null
    }
    if (typeof doc.caretRangeFromPoint === 'function') {
      const range = doc.caretRangeFromPoint(clientX, clientY)
      const node = range?.startContainer
      if (node) {
        start =
          node.nodeType === Node.TEXT_NODE
            ? node.parentElement
            : node instanceof Element
              ? node
              : null
      }
    } else if (typeof doc.caretPositionFromPoint === 'function') {
      const pos = doc.caretPositionFromPoint(clientX, clientY)
      const node = pos?.offsetNode
      if (node) {
        start =
          node.nodeType === Node.TEXT_NODE
            ? node.parentElement
            : node instanceof Element
              ? node
              : null
      }
    }
  } catch {
    // Some origins / embedders block caret APIs.
  }

  if (!start) {
    try {
      const stack = document.elementsFromPoint(clientX, clientY)
      start =
        stack.find(
          (el) =>
            el.id !== 'lens-translator-root' &&
            !el.closest?.(
              '#lens-translator-root, #lens-translator-bubble-root, #lens-translator-selection-root',
            ) &&
            !shouldSkipForLens(el),
        ) ?? null
    } catch {
      start = null
    }
  }

  const fromDeep = extractLensBlockAtElement(start, minTextLength)
  if (fromDeep) return fromDeep

  // Fallback: page-style candidate walk (still pointer-local, no full scan).
  return extractBlockAtElementPagePolicy(start, minTextLength)
}

/**
 * Page-oriented pointer resolution (shared extractCandidate + skip lists).
 * Prefer extractLensTargetAt for the translation lens.
 */
export function extractBlockAtElement(
  hit: Element | null,
  minTextLength: number,
): ExtractedBlock | undefined {
  return extractBlockAtElementPagePolicy(hit, minTextLength)
}

function extractBlockAtElementPagePolicy(
  hit: Element | null,
  minTextLength: number,
): ExtractedBlock | undefined {
  let current = hit
  while (current && current.tagName.toLowerCase() !== 'html') {
    const block = extractCandidate(current, minTextLength, 0)
    if (block) return block
    current = current.parentElement
  }
  return undefined
}

export function extractVisibleBlocks(
  minTextLength: number,
  prefetchMarginPx: number,
): ExtractedBlock[] {
  return extractBlocks(document, minTextLength, prefetchMarginPx)
}

/** Extract all currently rendered DOM text blocks, including content below the viewport. */
export function extractPageBlocks(
  minTextLength: number,
  root: ParentNode = document,
): ExtractedBlock[] {
  const roots = collectPageRoots(root)
  const semanticBlocks = roots.flatMap((root) => extractBlocks(root, minTextLength, null))
  const coveredElements = new Set(
    semanticBlocks.map((block) => block.segmentNodes?.[0]?.parentElement ?? block.el),
  )
  const fallbackBlocks = roots.flatMap((root) =>
    extractTextNodeFallbacks(root, minTextLength, coveredElements),
  )
  return dedupeNestedBlocks([...semanticBlocks, ...fallbackBlocks])
}

/** Include open web-component roots; closed shadow roots are inaccessible by platform design. */
export function collectPageRoots(root: ParentNode = document): ParentNode[] {
  const roots: ParentNode[] = [root]
  if (
    'shadowRoot' in root &&
    (root as Element).shadowRoot &&
    !shouldSkipElement(root as Element)
  ) {
    roots.push((root as Element).shadowRoot!)
  }
  for (let index = 0; index < roots.length; index++) {
    for (const el of roots[index].querySelectorAll('*')) {
      if (el.shadowRoot && !shouldSkipElement(el)) roots.push(el.shadowRoot)
    }
  }
  return roots
}

function fallbackHostForTextNode(node: Text): Element | null {
  const initialHost = node.parentElement
  if (!initialHost) return null
  let host: Element = initialHost

  while (PHRASING_TAGS.has(host.tagName.toLowerCase())) {
    const parent: Element | null = host.parentElement
    if (!parent || parent.tagName.toLowerCase() === 'body') break
    host = parent
  }
  const tag = host.tagName.toLowerCase()
  return tag === 'html' || tag === 'body' ? null : host
}

function hasCoveredAncestor(el: Element, coveredElements: Set<Element>): boolean {
  let current: Element | null = el
  while (current) {
    if (coveredElements.has(current)) return true
    current = current.parentElement
  }
  return false
}

/**
 * Fallback for deeply nested or framework-generated markup that has no semantic
 * block selectors. Text nodes are grouped at their nearest non-inline host.
 */
function extractTextNodeFallbacks(
  root: ParentNode,
  minTextLength: number,
  coveredElements: Set<Element>,
): ExtractedBlock[] {
  const hosts = new Set<Element>()
  const walker = document.createTreeWalker(root, 4)
  let node = walker.nextNode()

  while (node) {
    const textNode = node as Text
    const text = normalizeText(textNode.data)
    const parent = textNode.parentElement
    if (
      text &&
      parent &&
      !parent.closest?.('[data-lens-ignore]') &&
      !hasCoveredAncestor(parent, coveredElements)
    ) {
      const host = fallbackHostForTextNode(textNode)
      if (host && !shouldSkipElement(host)) {
        hosts.add(host)
      }
    }
    node = walker.nextNode()
  }

  const blocks: ExtractedBlock[] = []
  for (const el of hosts) {
    if (!isRendered(el)) continue
    // A fallback still owns its entire host. Partial text here would disagree
    // with mutation validation and overlap semantic descendants on rescans.
    const text = sourceTextOf(el)
    if (!isTranslatableText(text, minTextLength)) continue
    const tag = el.tagName.toLowerCase()
    // Some markdown renderers emit numbered prose as a bare <ul>/<ol> text
    // node with no <li> children (arXiv operational guidelines). Treat only
    // that malformed leaf-list shape as a block; normal lists still use <li>.
    const isBareTextList =
      (tag === 'ul' || tag === 'ol') && !el.querySelector('li, ul, ol')
    // Only block-ish wrappers are reading units; anything else (flex rows,
    // chips) is UI chrome the generic walker latched onto.
    if (
      tag !== 'div' &&
      tag !== 'section' &&
      tag !== 'article' &&
      !isBareTextList
    ) {
      continue
    }
    // Multi-control wrappers are menus/toolbars. Only a real article with
    // substantial prose may also contain its action buttons.
    if (
      hasMultipleUiLabelDescendants(el) &&
      (!el.matches('article, [role="article"]') || text.length < 20)
    ) {
      continue
    }
    // A horizontal row (or a direct item of one) is a toolbar / tab strip,
    // not a reading unit — the same physical check the renderer relies on.
    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
      const own = window.getComputedStyle(el)
      if (own.display?.includes('flex') && own.flexDirection?.startsWith('row')) continue
      const parent = el.parentElement
      if (parent) {
        const parentStyle = window.getComputedStyle(parent)
        if (parentStyle.display?.includes('flex') && parentStyle.flexDirection?.startsWith('row')) {
          continue
        }
      }
    }
    const block = { id: makeBlockId(tag, text, coarsePath(el)), el, tag, text }
    blocks.push(block)
    coveredElements.add(el)
  }
  return blocks
}

function extractBlocks(
  root: ParentNode,
  minTextLength: number,
  prefetchMarginPx: number | null,
): ExtractedBlock[] {
  const candidates = collectCandidates(root)
  // querySelectorAll never matches the root itself — a dirty root enqueued from
  // a mutation IS the newly added element, so check it as a candidate too.
  if (typeof Element !== 'undefined' && root instanceof Element) candidates.unshift(root)
  const out: ExtractedBlock[] = []
  const seenIds = new Set<string>()
  const seenEls = new Set<Node>()

  for (const el of candidates) {
    if (seenEls.has(el)) continue
    const splitBlocks = extractHardBreakSegments(el, minTextLength, prefetchMarginPx)
    const blocks =
      splitBlocks ??
      [extractCandidate(el, minTextLength, prefetchMarginPx)].filter(
        (block): block is ExtractedBlock => block !== undefined,
      )
    for (const block of blocks) {
      const source = block.segmentNodes?.[0] ?? block.el
      if (seenIds.has(block.id) || seenEls.has(source)) continue
      seenIds.add(block.id)
      seenEls.add(source)
      out.push(block)
    }
  }

  // Drop parent blocks that fully contain a smaller registered child (same text prefix noise)
  return dedupeNestedBlocks(out)
}

/**
 * Remove outer wrappers when nested blocks already cover the same reading unit.
 *
 * Prose owns its inline links. Structural wrappers yield to their leaves only
 * when those leaves cover all meaningful text; even a short introduction must
 * survive. Finally remove descendants of every retained owner.
 */
export function dedupeNestedBlocks(blocks: ExtractedBlock[]): ExtractedBlock[] {
  if (blocks.length <= 1) return blocks
  const byElement = new Map(blocks.map((block) => [block.el, block]))
  const dominated = new Set<ExtractedBlock>()
  const inlineReadingUnits = new Set(blocks.filter(block =>
    (SEMANTIC_TAGS as readonly string[]).includes(block.tag) && isPhrasingOnly(block.el),
  ))

  // Pass 1: mark every block that owns at least one nested block, so pass 2 can
  // tell leaves (blocks with no nested blocks) from containers.
  const hasNestedBlock = new Set<ExtractedBlock>()
  for (const child of blocks) {
    let ancestor = child.el.parentElement
    while (ancestor) {
      const parent = byElement.get(ancestor)
      if (parent) hasNestedBlock.add(parent)
      ancestor = ancestor.parentElement
    }
  }

  // Pass 2: accumulate leaf text coverage into each container. Only leaves
  // contribute — counting nested intermediates would double-count the same text.
  const uncovered = new Map<ExtractedBlock, string>()
  for (const leaf of blocks) {
    if (hasNestedBlock.has(leaf)) continue
    let ancestor = leaf.el.parentElement
    while (ancestor) {
      const container = byElement.get(ancestor)
      if (container) {
        // ponytail: scan small compound blocks per leaf; use DOM ranges if very
        // large compound blocks make this a measured extraction bottleneck.
        uncovered.set(container, (uncovered.get(container) ?? container.text).replace(leaf.text, ' '))
      }
      ancestor = ancestor.parentElement
    }
  }
  for (const container of hasNestedBlock) {
    if (inlineReadingUnits.has(container)) continue
    if (!/[\p{L}\p{N}]/u.test(uncovered.get(container) ?? container.text)) dominated.add(container)
  }

  const retained = blocks.filter(block => !dominated.has(block))
  const owners = new Set(retained.filter(block => !block.segmentNodes).map(block => block.el))
  return retained.filter(block => {
    let parent = block.el.parentElement
    while (parent) {
      if (owners.has(parent)) return false
      parent = parent.parentElement
    }
    return true
  })
}

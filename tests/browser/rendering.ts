import { PageTranslator } from '../../src/content/page-translator'
import { BrowserTranslator } from '../../src/content/browser-translator'
import { extractPageBlocks } from '../../src/content/extract'
import { DEFAULT_SETTINGS } from '../../src/shared/settings-defaults'

const settings = { ...DEFAULT_SETTINGS, pageTranslationEngine: 'external' as const }
const translator = new PageTranslator(new BrowserTranslator())
const pause = (ms = 350) => new Promise(resolve => setTimeout(resolve, ms))
const results: Array<{ name: string; ok: boolean; error?: string }> = []
let requests: string[] = []
let latency = 5
const translations: Record<string, string> = {
  Extensions: '扩展', 'Get Started': '开始使用', 'User Guide': '用户指南', Hardware: '硬件',
  Cookbook: '手册', 'SGLang Diffusion': 'SGLang 扩散', Post: '发布', 'Key Features': '主要特点',
  'Original article before refresh.': '刷新前的旧文章。',
  'Updated article after refresh.': '刷新后的新文章。',
}
Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
  runtime: { async sendMessage(message: { type: string; blocks: Array<{ id: string; text: string }> }) {
    if (message.type !== 'translate-batch') return null
    requests.push(...message.blocks.map(block => block.text))
    await pause(latency)
    return { type: 'translate-batch-result', ok: true, translations: message.blocks.map(block => ({
      id: block.id, translation: translations[block.text] ?? '这段中文译文用于检查页面排版。',
    })) }
  } },
} })
const inserted = (root: ParentNode = document) => [...root.querySelectorAll<HTMLElement>('[data-lens-page-inserted]')]
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
async function run(name: string, html: string, test: () => Promise<void>) {
  translator.deactivate()
  document.body.innerHTML = html
  document.body.style.cssText = 'margin:24px;font:16px/1.5 Arial;width:1100px'
  requests = []
  latency = 5
  try { await test(); results.push({ name, ok: true }) }
  catch (error) { results.push({ name, ok: false, error: String(error) }) }
}
async function activate() { await translator.activate(settings, true); await pause() }

async function main() {
  await run('list links are translated exactly once with their prose', '<ul><li id="item"><a href="#">Extensions</a> - TypeScript modules for tools, commands, events, and custom UI.</li></ul>', async () => {
    await activate()
    check(requests.length === 1, `expected one source block, got ${JSON.stringify(requests)}`)
    check(inserted().length === 1 && inserted()[0].parentElement?.id === 'item', 'expected one translation in the list item')
    check(!document.querySelector('a [data-lens-page-inserted]'), 'inline link translated twice')
  })

  const nav = '<header id="header" style="height:120px"><nav id="nav" style="display:flex;gap:12px;height:44px;width:1000px;overflow:hidden">' +
    ['Get Started', 'User Guide', 'Hardware', 'Cookbook', 'SGLang Diffusion'].map((text, i) =>
      `<a id="nav${i}" href="#" style="display:flex;align-items:center;height:36px;padding:0 6px;font:14px/20px Arial"><span>${text}</span></a>`).join('') + '</nav></header>'
  await run('navigation stays in its own controls, in source order, without resizing ancestors', nav, async () => {
    await activate()
    check(inserted().length === 5, `expected all five compact labels, got ${inserted().length}`)
    check(inserted().every((node, i) => node.closest('a')?.id === `nav${i}`), 'translation escaped or changed order')
    check(document.getElementById('header')!.getBoundingClientRect().height === 120, 'header height changed')
    check(document.getElementById('nav')!.getBoundingClientRect().height === 44, 'navigation height changed')
  })

  await run('source typography and custom style updates agree', '<main id="shell" style="height:600px;width:700px"><h1 style="font:700 40px/1.2 Georgia;text-align:center">Key Features</h1><button style="width:400px;padding:8px;font:700 20px/28px Arial;text-align:center;background:black;color:white"><span>Post</span></button></main>', async () => {
    await activate()
    const heading = inserted(document.querySelector('h1')!)[0]
    const button = inserted(document.querySelector('button')!)[0]
    check(heading && button, 'missing heading or button translation')
    const initial = getComputedStyle(heading)
    check(initial.fontSize === '40px' && initial.fontWeight === '700' && initial.textAlign === 'center', 'source typography was reset')
    check(getComputedStyle(button).textAlign === 'center', 'button lost centering')
    check(document.getElementById('shell')!.getBoundingClientRect().height === 600, 'ancestor height overwritten')
    translator.restyle({ ...settings, pageTranslationUseOriginalFontSize: false, pageTranslationFontSizePx: 28, pageTranslationUseCustomColor: true, pageTranslationTextColor: '#ff0000' })
    await pause()
    const updated = inserted(document.querySelector('button')!)[0]
    check(updated && getComputedStyle(updated).fontSize === '28px', 'button ignores custom font size')
    check(getComputedStyle(updated).color === 'rgb(255, 0, 0)', 'button retains stale inline color')
    translator.restyle(settings)
    await pause()
    check(getComputedStyle(inserted(document.querySelector('button')!)[0]).color === 'rgb(255, 255, 255)', 'inherited color not restored')
    check(requests.length === 2, 'appearance update requested fresh translations')
  })

  await run('late responses cannot translate replacement source text', '<p id="changing">Original article before refresh.</p>', async () => {
    latency = 200
    const pending = translator.activate(settings, true)
    await pause(20)
    document.getElementById('changing')!.firstChild!.textContent = 'Updated article after refresh.'
    await pending
    await pause(800)
    check(requests.includes('Updated article after refresh.'), 'updated text was never requested')
    check(inserted().length === 1 && inserted()[0].textContent === '刷新后的新文章。', 'stale response rendered')
  })

  await run('news card rows stay separate and editor placeholders stay untouched', '<a href="#" role="link" style="display:block"><div>OpenAI Releases GPT-6 Astra with Game-Changing Computer Abilities</div><div><span>21 hours ago</span> · <span>News</span> · <span>10.4K posts</span></div></a><div class="DraftEditorPlaceholder-root">What’s happening?</div>', async () => {
    await activate()
    check(requests.some(text => text === 'OpenAI Releases GPT-6 Astra with Game-Changing Computer Abilities'), 'title was not isolated')
    check(!requests.some(text => text.includes('Abilities21') || (text.includes('Abilities') && text.includes('hours'))), 'title and metadata merged')
    check(!requests.includes('What’s happening?'), 'editor placeholder was extracted')
  })

  await run('reordering a source carries its translation without extra insertion', nav, async () => {
    await activate()
    const control = document.getElementById('nav0')!
    const node = inserted(control)[0]
    check(node, 'compact label missing')
    document.getElementById('nav')!.append(control)
    await pause()
    check(inserted(control)[0] === node && inserted().length === 5, 'reordering recreated or detached translation')
    check(requests.length === 5, 'reordering caused new requests')
  })

  await run('repeated framework removal is bounded and changed text can recover', '<p id="stripped">Original article before refresh.</p>', async () => {
    await activate()
    for (let index = 0; index < 4; index++) { inserted()[0]?.remove(); await pause() }
    check(inserted().length === 0 && requests.length === 1, 'framework removal causes unbounded work')
    document.getElementById('stripped')!.textContent = 'Updated article after refresh.'
    await pause(650)
    check(inserted().length === 1 && inserted()[0].textContent === '刷新后的新文章。', 'suppression never recovers for new source')
  })

  await run('translation text never becomes source on incremental rescans', '<p id="body">A paragraph with <a href="#">linked prose</a> and ordinary text.</p>', async () => {
    await activate()
    for (let index = 0; index < 3; index++) {
      document.getElementById('body')!.append(document.createElement('span'))
      await pause()
    }
    check(requests.length === 1 && inserted().length === 1, 'incremental scans duplicate source ownership')
    check(!requests.some(text => text.includes('中文译文')), 'translation fed back into extraction')
  })

  await run('hard breaks retain all paragraphs and teardown restores source DOM', '<p id="paragraphs">First paragraph has useful prose.<br><br>Second paragraph has different useful prose.<br><br>Third paragraph completes this useful documentation.</p>', async () => {
    const original = document.getElementById('paragraphs')!.innerHTML
    await activate()
    await pause(700)
    check(requests.length === 3 && inserted().length === 3, 'hard-break paragraph missing or repeated')
    translator.deactivate()
    check(document.getElementById('paragraphs')!.innerHTML === original, 'teardown did not restore original markup')
  })

  await run('narrow controls do not leak translations into nearby content', '<div id="row" style="height:24px;width:120px"><button id="narrow" style="width:20px;height:22px;overflow:hidden;padding:0">Go</button></div><p>Ordinary prose stays readable.</p>', async () => {
    await activate()
    check(inserted(document.getElementById('row')!).length === 0, 'translation forced into an unreadable control')
    check(inserted().length === 1 && inserted()[0].parentElement?.tagName === 'P', 'translation escaped narrow control')
  })

  await run('open shadow roots preserve ownership, style updates, and teardown', '<div id="component"></div>', async () => {
    const shadow = document.getElementById('component')!.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<p style="font:18px/28px Arial">A paragraph inside a web component.</p>'
    await activate()
    check(inserted(shadow).length === 1 && inserted().length === 0, 'translation crossed shadow boundary')
    translator.deactivate()
    check(inserted(shadow).length === 0 && !shadow.querySelector('[data-lens-ignore]'), 'shadow artifacts leaked')
  })

  await run('translation-only and learning modes preserve reversible source content', '<p id="mode">A paragraph containing <code>literal_code</code> and prose.</p>', async () => {
    const original = document.getElementById('mode')!.innerHTML
    await translator.activate({ ...settings, pageTranslationDisplayMode: 'translation-only' }, true)
    const node = inserted()[0]
    check(node && getComputedStyle(node).visibility === 'visible', 'translation-only hides its own translation')
    translator.restyle({ ...settings, pageTranslationDisplayMode: 'learning' })
    check(getComputedStyle(node).filter.includes('blur'), 'learning mode lost its blur')
    translator.deactivate()
    check(document.getElementById('mode')!.innerHTML === original, 'display mode destroyed original content')
  })

  await run('newly visible source is detected without unrelated DOM changes', '<p>Visible source paragraph.</p><p id="hidden" hidden>Initially hidden source paragraph.</p>', async () => {
    await activate()
    document.getElementById('hidden')!.hidden = false
    await pause(650)
    check(requests.includes('Initially hidden source paragraph.'), 'visibility change was not observed')
  })

  await run('table source spacing agrees with rendering and later mutation checks', '<table><tbody><tr><td id="cell"><a href="#" style="display:block">Cloud model</a><span style="display:block">Updated model description</span></td><td>Other information</td></tr></tbody></table>', async () => {
    await activate()
    check(requests.includes('Cloud model Updated model description'), `table source lost rendered boundaries: ${requests}`)
    const cell = document.getElementById('cell')!
    check(inserted(cell).length === 1, 'table translation was rejected as stale')
    cell.append(document.createElement('span'))
    await pause()
    check(requests.length === 2 && inserted(cell).length === 1, 'unchanged table source was invalidated')
  })

  await run('source highlights exclude inserted translation text', '<p>A paragraph with <strong>important words</strong> for learning.</p>', async () => {
    await activate()
    const node = inserted()[0]
    const box = node.getBoundingClientRect()
    node.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: box.x + 8, clientY: box.y + box.height / 2 }))
    await pause()
    const registry = CSS as typeof CSS & { highlights: Map<string, Set<Range>> }
    const ranges = registry.highlights.get('lens-page-alignment-match')
    check(ranges && ranges.size > 0, 'word alignment fell back because source included translated text')
    check([...ranges].every(range => !range.toString().includes('中文译文')), 'highlight selected inserted text')
  })

  await run('resizing can suppress and restore cached translation without source loss', '<div id="box" style="width:500px"><p id="resized">A paragraph that needs a readable translation width.</p></div>', async () => {
    await activate()
    check(inserted().length === 1, 'wide paragraph was not translated')
    document.getElementById('box')!.style.width = '16px'
    window.dispatchEvent(new Event('resize'))
    await pause(600)
    check(inserted().length === 0, 'narrow layout keeps a vertical glyph column')
    document.getElementById('box')!.style.width = '500px'
    window.dispatchEvent(new Event('resize'))
    await pause(600)
    check(inserted().length === 1 && requests.length === 1, 'wide layout did not recover from cache')
  })

  await run('short Latin target labels remain readable and clickable', '<button id="ok" style="width:140px;font:16px/24px Arial">Continue</button>', async () => {
    translations.Continue = 'OK'
    await activate()
    const node = inserted()[0]
    check(node?.textContent === 'OK', 'short Latin translation incorrectly rejected by CJK width heuristic')
    let clicked = false
    document.getElementById('ok')!.addEventListener('click', () => { clicked = true })
    node.click()
    check(clicked, 'translation broke the native control click')
  })

  translator.deactivate()
  Object.assign(window, { __renderingPreview: async () => {
    document.body.style.cssText = 'margin:30px auto;width:1040px;font:16px/1.6 Arial;color:#18212f;background:#f8fafc'
    document.body.innerHTML = '<div data-lens-ignore style="margin-bottom:16px;font-weight:bold">本地渲染回归预览 · 模拟译文</div>' + nav +
      '<main style="width:850px;padding:24px;background:white;border:1px solid #dce3ec;border-radius:12px">' +
      '<h1 style="text-align:center;font:700 36px/1.4 Georgia">Key Features</h1>' +
      '<ul><li><a href="#">Extensions</a> - TypeScript modules for tools, commands, events, and custom UI.</li></ul>' +
      '<p>A paragraph with <strong>important words</strong> and <code>literal_code</code> stays in its own reading block.</p>' +
      '<button style="width:220px;padding:10px;background:#0f1419;color:white;border-radius:24px;font:700 20px/28px Arial"><span>Post</span></button>' +
      '<table style="margin-top:24px;width:100%;border-top:1px solid #ccc"><tr><td><a href="#" style="display:block">Cloud model</a><span style="display:block">Updated model description</span></td><td>Other information</td></tr></table></main>'
    await translator.activate(settings, true)
    await pause()
  } })
  document.body.textContent = results.map(result => `${result.ok ? 'PASS' : 'FAIL'} ${result.name}: ${result.error ?? ''}`).join('\n')
  document.documentElement.dataset.testResults = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(results))))
}
void main().catch(error => {
  results.push({ name: 'browser runner', ok: false, error: String(error) })
  document.documentElement.dataset.testResults = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(results))))
})

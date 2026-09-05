import { build } from 'vite'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const output = await mkdtemp(join(tmpdir(), 'lens-rendering-test-'))
const browser = process.env.CHROME_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : 'google-chrome')
let chrome
let socket
try {
  await build({
    configFile: false,
    logLevel: 'error',
    build: {
      outDir: output,
      emptyOutDir: false,
      lib: { entry: resolve('tests/browser/rendering.ts'), name: 'RenderingTest', formats: ['iife'], fileName: () => 'test.js' },
    },
  })
  await writeFile(join(output, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Rendering regression checks</title><body><script src="test.js"></script>')
  chrome = spawn(browser, [
    '--headless=new', `--user-data-dir=${join(output, 'profile')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--allow-file-access-from-files',
    '--window-size=1200,1000', '--remote-debugging-port=0', 'about:blank',
  ], { stdio: 'ignore' })
  let launchError
  chrome.on('error', error => { launchError = error })
  let port
  for (let attempt = 0; attempt < 100; attempt++) {
    if (launchError) throw launchError
    try { port = (await readFile(join(output, 'profile/DevToolsActivePort'), 'utf8')).split('\n')[0]; break } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (!port) throw new Error('Chrome did not start; set CHROME_PATH to its executable')
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  let nextId = 0
  const pending = new Map()
  let pageLoaded
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.method === 'Page.loadEventFired') pageLoaded?.()
    const call = pending.get(message.id)
    if (!call) return
    pending.delete(message.id)
    clearTimeout(call.timer)
    if (message.error) call.reject(new Error(message.error.message))
    else call.resolve(message.result)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Chrome timeout: ${method}`)) }, 45000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
  await send('Page.enable')
  const loaded = new Promise(resolve => { pageLoaded = resolve })
  await send('Page.navigate', { url: pathToFileURL(join(output, 'index.html')).href })
  await loaded
  // Use real animation frames. Virtual-time --dump-dom can finish timers before
  // requestAnimationFrame, which misses resize and hover behavior entirely.
  const evaluation = await send('Runtime.evaluate', { expression: `new Promise(resolve => {
    const done = () => document.documentElement.dataset.testResults;
    if (done()) return resolve(done());
    const observer = new MutationObserver(() => { if (done()) { observer.disconnect(); resolve(done()); } });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-test-results'] });
  })`, awaitPromise: true, returnByValue: true })
  const encoded = evaluation.result?.value
  if (!encoded) throw new Error(`Browser did not finish: ${JSON.stringify(evaluation)}`)
  const results = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
  await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2))
  for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}${result.error ? `: ${result.error}` : ''}`)
  if (results.every(result => result.ok)) {
    await send('Runtime.evaluate', { expression: 'window.__renderingPreview()', awaitPromise: true })
    const screenshot = await send('Page.captureScreenshot', { captureBeyondViewport: true })
    await writeFile(join(output, 'preview.png'), Buffer.from(screenshot.data, 'base64'))
  }
  console.log(`Browser evidence: ${output}`)
  if (results.some(result => !result.ok)) process.exitCode = 1
} finally {
  socket?.close()
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise(resolve => chrome.once('exit', resolve))
    chrome.kill()
    await exited
  }
  await rm(join(output, 'profile'), { recursive: true, force: true })
}

/* Browser-level correctness checks for the real Tau canvas/input surface (no PTY).
 * Invoked by `bun run test:surface` after bundling tau-terminal.ts into .bench-cache.
 */
import { app, BrowserWindow } from 'electron'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve } from 'node:path'

// run-electron compiles this entry in .bench-cache/electron-*, so use the working directory.
const desktop = process.cwd()
const script = readFileSync(resolve(desktop, '.bench-cache/tau-surface.js'))
const wasm = readFileSync(resolve(desktop, 'public/ghostty-vt.wasm'))

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body { margin: 0; background: #151515; }
#terminal { width: 480px; height: 200px; }
</style></head><body><div id="terminal"></div><script src="/renderer.js"></script>
<script>
const results = []
const unexpected = []
window.addEventListener('error', event => unexpected.push(String(event.error || event.message)))
window.addEventListener('unhandledrejection', event => unexpected.push(String(event.reason)))
function check(name, condition, detail = '') {
  if (!condition) throw new Error(name + (detail ? ': ' + detail : ''))
  results.push(name)
}
const painted = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
function rgb(canvas, x, y) {
  return [...canvas.getContext('2d').getImageData(x, y, 1, 1).data].slice(0, 3).join(',')
}
function firstCellHasInk(canvas, blank) {
  for (let y = 1; y < 18; y++) for (let x = 1; x < 8; x++) {
    if (rgb(canvas, x, y) !== blank) return true
  }
  return false
}
async function run() {
  const host = document.querySelector('#terminal')
  let clipboard = ''
  let opened = ''
  window.confirm = () => true
  window.electronAPI = {
    writeClipboardText: async value => { clipboard = value },
    openExternalUrl: async url => { opened = url },
  }
  const term = await TauSurfaceTest.TauTerminal.create()
  term.open(host)
  term.resize(30, 5)
  await painted()
  const canvas = host.querySelector('canvas')
  const input = host.querySelector('textarea')
  const reader = host.querySelector('pre')
  check('mounted canvas and hidden accessible input', !!canvas && !!input && canvas.getAttribute('aria-hidden') === 'true' && input.getAttribute('aria-label') === 'Terminal input')
  check('canvas has real backing pixels', canvas.width > 0 && canvas.height > 0)
  term.write('\\x1b[?25l')
  await painted()
  const blank = rgb(canvas, 3, 3)
  document.documentElement.dataset.theme = 'light'
  window.dispatchEvent(new Event('tau:appearance'))
  await painted()
  check('light appearance repaints terminal canvas', rgb(canvas, 3, 3) === '251,252,254', rgb(canvas, 3, 3))
  document.documentElement.dataset.theme = 'dark'
  window.dispatchEvent(new Event('tau:appearance'))
  await painted()
  check('dark appearance restores terminal canvas', rgb(canvas, 3, 3) === blank)
  let applied = false
  term.write('hello 🥝e\u0301', () => { applied = true })
  check('write callback acknowledges parsing before presentation', applied && !reader.textContent.includes('hello'))
  await painted()
  check('accessible viewport contains wide grapheme and combining text', reader.textContent.includes('hello 🥝e\u0301'), reader.textContent)
  check('glyphs change canvas pixels', firstCellHasInk(canvas, blank))
  term.write('\\x1b[?25l\\x1b[2J\\x1b[H')
  await painted()
  check('erase clears viewport and accessible text', !reader.textContent.includes('hello') && rgb(canvas, 3, 3) === blank, JSON.stringify({ pixel: rgb(canvas, 3, 3), blank, reader: reader.textContent }))
  term.write('\\x1b[41mX\\x1b[0m')
  await painted()
  check('SGR background paints actual pixels', rgb(canvas, 1, 1) !== blank)
  term.write('\\x1b[H\\x1b[48;2;12;34;56mX\\x1b[0m')
  await painted()
  check('truecolor background reaches canvas unchanged', rgb(canvas, 1, 1) === '12,34,56', rgb(canvas, 1, 1))
  term.write('\\x1b[?1049hALT\\x1b[?1049l')
  await painted()
  check('alternate screen restores previous viewport', reader.textContent.includes('X') && !reader.textContent.includes('ALT'))
  term.resize(20, 4)
  await painted()
  check('resize repaints canvas and reader', term.cols === 20 && term.rows === 4 && reader.textContent.includes('X'))
  term.write('\\x1b[2J\\x1b[Hhello world')
  await painted()
  check('search reports actual VT matches', term.search('world', 'next', false))
  term.clearSearch()
  // Search highlights are JS-only pixels: they must appear on rows Ghostty does not report dirty.
  term.write('\\x1b[?25l\\x1b[2J\\x1b[Hfind-me\\r\\n\\r\\nprompt')
  await painted()
  const hyphen = () => rgb(canvas, Math.floor(term.cellWidth * 4.5), 1)
  const beforeHighlight = hyphen()
  term.search('find-me', 'next', false)
  await painted()
  check('search highlights a clean row away from the cursor', hyphen() === '107,74,53', hyphen())
  term.clearSearch()
  await painted()
  check('clearing search removes the highlight', hyphen() === beforeHighlight, hyphen())
  // A parked surface (1x1, off-screen, as terminal.ts hides runtimes) keeps parsing but defers
  // painting; reattaching repaints what changed while hidden.
  const parking = document.createElement('div')
  parking.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;overflow:hidden'
  document.body.appendChild(parking)
  const canvasSize = canvas.width + 'x' + canvas.height
  host.style.width = host.style.height = '100%'
  parking.appendChild(host)
  term.write('\\x1b[2J\\x1b[H\\x1b[42mPARKED\\x1b[0m')
  await painted()
  check('parked surface skips painting', term.hidden && canvas.width + 'x' + canvas.height === canvasSize && !reader.textContent.includes('PARKED'))
  host.style.width = host.style.height = ''
  document.body.insertBefore(host, document.body.firstChild)
  parking.remove()
  term.refresh(0, term.rows - 1)
  await painted()
  check('reattached surface repaints output written while parked', !term.hidden && reader.textContent.includes('PARKED') && rgb(canvas, 1, 1) !== blank, reader.textContent)
  const emitted = []
  const received = term.onData(text => emitted.push(text))
  term.focus()
  check('focus remains on keyboard input', document.activeElement === input)
  await fetch('/action', { method: 'POST', body: 'key' })
  await painted()
  check('real Chromium key emits exactly once', emitted.filter(value => value === 'a').length === 1, JSON.stringify(emitted))
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', code: 'ArrowUp', bubbles: true }))
  check('keyboard emits encoded arrow key', emitted.at(-1) === '\\x1b[A', JSON.stringify(emitted))
  const beforeComposition = emitted.length
  input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true }))
  input.dispatchEvent(new CompositionEvent('compositionend', { data: 'あ', bubbles: true }))
  check('composition emits once and suppresses intermediate keys', JSON.stringify(emitted.slice(beforeComposition)) === JSON.stringify(['あ']), JSON.stringify(emitted))
  term.write('\\x1b[?2004h')
  const paste = new DataTransfer()
  paste.setData('text/plain', 'one\\ntwo')
  input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: paste }))
  check('paste respects negotiated bracketed mode', emitted.at(-1) === '\\x1b[200~one\\ntwo\\x1b[201~')
  term.write('\\x1b[?2004l')
  window.confirm = () => false
  const beforeDeniedPaste = emitted.length
  input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: paste }))
  check('unbracketed multiline paste requires consent', emitted.length === beforeDeniedPaste)
  window.confirm = () => true
  term.write('\\x1b[2J\\x1b[Hhello world')
  await painted()
  const titles = []
  term.onTitleChange(title => titles.push(title))
  term.write('\\x1b]2;surface-title\\x07')
  check('OSC title reaches surface listeners', titles.at(-1) === 'surface-title')
  const binary = []
  term.onBinary(data => binary.push(data))
  term.write('\\x1b[6n')
  check('VT replies reach binary listeners', binary.at(-1) === '\\x1b[1;12R', JSON.stringify(binary))
  term.write('\\x1b]52;c;Y2xpcGJvYXJkLXByb29m\\x07')
  await Promise.resolve()
  check('OSC 52 obeys clipboard confirmation and host bridge', clipboard === 'clipboard-proof')
  window.confirm = () => false
  term.write('\\x1b]52;c;ZGVuaWVk\\x07')
  await Promise.resolve()
  check('denied OSC 52 cannot write clipboard', clipboard === 'clipboard-proof')
  window.confirm = () => true
  term.write('\\x1b[?2026h\\x1b[2J\\x1b[Hheld')
  await painted()
  check('synchronized output holds canvas and reader', reader.textContent.includes('hello') && !reader.textContent.includes('held'))
  term.write('\\x1b[?2026l')
  await painted()
  check('synchronized output presents after release', reader.textContent.includes('held'))
  term.write('\\x1b[2J\\x1b[H\\x1b]8;;https://example.org/safe\\x1b\\\\link\\x1b]8;;\\x1b\\\\')
  await painted()
  canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 0, ctrlKey: true, clientX: 4, clientY: 4, bubbles: true }))
  await Promise.resolve()
  check('OSC 8 link activation uses host URL policy', opened === 'https://example.org/safe', opened)
  term.write('\\x1b[2J\\x1b[H\\x1b]8;;javascript:alert(1)\\x1b\\\\bad\\x1b]8;;\\x1b\\\\')
  await painted()
  await fetch('/action', { method: 'POST', body: 'ctrlClick' })
  await painted()
  check('unsafe OSC 8 URL is not opened', opened === 'https://example.org/safe')
  term.write('\\x1b[2J\\x1b[Hselect me')
  await painted()
  await fetch('/action', { method: 'POST', body: 'drag' })
  await painted()
  const copy = new DataTransfer()
  input.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, clipboardData: copy }))
  check('real pointer drag selects and copies viewport text', /^sele/u.test(copy.getData('text/plain')), copy.getData('text/plain'))
  check('selection highlight reaches canvas pixels', rgb(canvas, Math.floor(term.cellWidth * 2.5), 1) === '38,79,120', rgb(canvas, Math.floor(term.cellWidth * 2.5), 1))
  term.write('\\x1b[?1000h\\x1b[?1006h')
  await fetch('/action', { method: 'POST', body: 'click' })
  await painted()
  check('real pointer click uses Ghostty mouse-reporting mode', emitted.some(value => value.startsWith('\\x1b[<0;1;1M')), JSON.stringify(emitted))
  term.write('\\x1b[?1000l\\x1b[2J\\x1b[H')
  term.write(Array.from({ length: 15 }, (_, index) => 'line-' + index + '\\r\\n').join(''))
  await painted()
  const recent = reader.textContent
  canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -90, bubbles: true, cancelable: true }))
  await painted()
  check('wheel scroll updates visible viewport and accessible text', reader.textContent !== recent && reader.textContent.includes('line-'), reader.textContent)
  await term.resetCore()
  await painted()
  term.write('\\x1b[2J\\x1b[H\\x1b_Ga=T,f=32,s=1,v=1,i=1;/wAA/w==\\x1b\\\\')
  await painted()
  check('inline Kitty image reaches canvas pixels', rgb(canvas, 0, 0) === '255,0,0', rgb(canvas, 0, 0))
  term.setCursorVisible(false)
  await painted()
  await term.resetCore()
  await painted()
  check('reset clears stale viewport text and image', !reader.textContent.includes('held') && rgb(canvas, 0, 0) === blank)
  received.dispose()
  term.dispose()
  check('dispose removes surface and events', host.childElementCount === 0)
  check('no browser event errors or unhandled rejections', unexpected.length === 0, JSON.stringify(unexpected))
  return results
}
run().then(
  checks => fetch('/result', { method: 'POST', body: JSON.stringify({ checks }) }),
  error => fetch('/result', { method: 'POST', body: JSON.stringify({ error: String(error.stack || error), checks: results }) }),
)
</script></body></html>`

async function main(): Promise<void> {
  let win: BrowserWindow | null = null
  let complete!: (value: { checks: string[]; error?: string }) => void
  const result = new Promise<{ checks: string[]; error?: string }>(
    (resolve) => (complete = resolve),
  )
  const server = createServer((req, res) => {
    if (req.url === '/action' && req.method === 'POST') {
      const actions = {
        drag: [
          { type: 'mouseMove', x: 3, y: 9 },
          { type: 'mouseDown', x: 3, y: 9, button: 'left', clickCount: 1 },
          { type: 'mouseMove', x: 45, y: 9, button: 'left' },
          { type: 'mouseUp', x: 45, y: 9, button: 'left', clickCount: 1 },
        ],
        click: [
          { type: 'mouseMove', x: 3, y: 9 },
          { type: 'mouseDown', x: 3, y: 9, button: 'left', clickCount: 1 },
          { type: 'mouseUp', x: 3, y: 9, button: 'left', clickCount: 1 },
        ],
        ctrlClick: [
          { type: 'mouseMove', x: 3, y: 9 },
          { type: 'mouseDown', x: 3, y: 9, button: 'left', clickCount: 1, modifiers: ['control'] },
          { type: 'mouseUp', x: 3, y: 9, button: 'left', clickCount: 1, modifiers: ['control'] },
        ],
      } as const
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const name = Buffer.concat(chunks).toString() as keyof typeof actions | 'key'
        if (!win) return void res.writeHead(400).end()
        if (name === 'key') {
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A' })
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A' })
        } else if (actions[name]) {
          for (const event of actions[name]) win.webContents.sendInputEvent(event)
        } else return void res.writeHead(400).end()
        res.writeHead(200).end('ok')
      })
      return
    }
    if (req.url === '/result' && req.method === 'POST') {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        complete(JSON.parse(Buffer.concat(chunks).toString()))
        res.writeHead(200).end('ok')
      })
      return
    }
    if (req.url === '/ghostty-vt.wasm') {
      res.writeHead(200, { 'Content-Type': 'application/wasm' }).end(wasm)
    } else if (req.url === '/renderer.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(script)
    } else if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(html)
    } else {
      res.writeHead(404).end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  await app.whenReady()
  win = new BrowserWindow({
    show: true,
    width: 600,
    height: 320,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  try {
    await win.loadURL(`http://127.0.0.1:${(server.address() as { port: number }).port}/`)
    const reply = await Promise.race([
      result,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Surface test timed out')), 30000),
      ),
    ])
    for (const name of reply.checks) console.log(`PASS ${name}`)
    if (reply.error) throw new Error(reply.error)
    console.log(`${reply.checks.length} surface checks passed`)
  } finally {
    win.destroy()
    server.close()
    app.quit()
  }
}

main().catch((error) => {
  console.error(error)
  app.exit(1)
})

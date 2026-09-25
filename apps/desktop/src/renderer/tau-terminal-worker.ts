/* SPIKE: one dedicated worker per pane owns the Ghostty VT core and paints an OffscreenCanvas,
 * so output parsing and canvas work leave the renderer main thread and panes run in parallel.
 * Messages are defined in tau-terminal.ts. Not production-complete: OSC 52 clipboard writes are
 * denied and a failed VT parse is reported but not recovered. */
import { GhosttyVt, type GhosttyCell, type GhosttyFrame } from './ghostty-vt'

type Metrics = {
  cellWidth: number
  cellHeight: number
  baseline: number
  fontSize: number
  fonts: string[]
}
type Point = { x: number; y: number }
type Incoming =
  | {
      t: 'init'
      canvas: OffscreenCanvas
      module: WebAssembly.Module
      cols: number
      rows: number
      metrics: Metrics
    }
  | { t: 'write'; id: number; data: ArrayBuffer }
  | { t: 'resize'; cols: number; rows: number }
  | { t: 'size'; width: number; height: number; dpr: number }
  | { t: 'metrics'; metrics: Metrics; light: boolean }
  | { t: 'refresh' }
  | { t: 'active'; value: boolean }
  | { t: 'cursorVisible'; value: boolean }
  | { t: 'key'; event: Parameters<GhosttyVt['encodeKey']>[0] }
  | { t: 'selection'; start: Point | null; end?: Point | null }
  | { t: 'search'; query: string; direction: 'next' | 'previous' }
  | { t: 'scroll'; delta: number }
  | { t: 'paste'; text: string }
  | {
      t: 'mouse'
      action: 'press' | 'release' | 'motion'
      button: number | null
      x: number
      y: number
      mods: number
      id: number
    }
  | { t: 'link'; id: number; x: number; y: number }
  | { t: 'reset' }
  | { t: 'dispose' }

// The renderer tsconfig has DOM, not WebWorker, typings; declare the worker scope we use.
const scope = self as unknown as {
  location: Location
  onmessage: ((event: MessageEvent<Incoming>) => void) | null
  postMessage(message: unknown, transfer: Transferable[]): void
  requestAnimationFrame(callback: FrameRequestCallback): number
  close(): void
}
const post = (message: unknown, transfer: Transferable[] = []) =>
  scope.postMessage(message, transfer)
const decoder = new TextDecoder()
const clock = () => performance.timeOrigin + performance.now()
// Compiled once on the page and shared, so a new pane's worker only instantiates it.
let wasmModule: WebAssembly.Module

const FONT_VARIANT_COUNT = 4
let vt: GhosttyVt
let canvas: OffscreenCanvas
let metrics: Metrics
let cssWidth = 0
let cssHeight = 0
let dpr = 1
let active = true
let cursorVisible = true
let renderHeld = false
let frameRequested = false
let hiddenStale = false
let appliedWrites = 0
let searchQuery = ''
let lastFrame: GhosttyFrame | null = null
let lastImageSignature = ''
const rowsCache: GhosttyCell[][] = []
const rowText: string[] = []
const foregrounds: string[] = []
const imageCanvases = new Map<string, OffscreenCanvas>()

function installEffects(core: GhosttyVt): void {
  core.onSizeReport()
  core.onRenderHold((held) => {
    renderHeld = held
    if (!held) refresh()
  })
  core.onTitleChange((title) => post({ t: 'title', title }))
  core.onPtyResponse((bytes) => {
    for (let offset = 0; offset < bytes.length; offset += 8192)
      post({ t: 'binary', data: String.fromCharCode(...bytes.subarray(offset, offset + 8192)) })
  })
  core.onClipboardWrite(() => false)
}

function clearRowCaches(): void {
  rowsCache.length = 0
  rowText.length = 0
  lastFrame = null
  lastImageSignature = ''
}

function refresh(): void {
  if (renderHeld || frameRequested || !canvas) return
  frameRequested = true
  scope.requestAnimationFrame(() => {
    frameRequested = false
    if (!renderHeld) draw()
  })
}

function draw(): void {
  const { cellWidth, cellHeight } = metrics
  if (cssWidth < cellWidth || cssHeight < cellHeight) {
    if (!hiddenStale) {
      hiddenStale = true
      canvas.width = 1
      canvas.height = 1
      clearRowCaches()
    }
    return
  }
  if (hiddenStale) {
    hiddenStale = false
    vt.invalidate()
  }
  const started = performance.now()
  const width = Math.max(1, Math.ceil(cssWidth * dpr))
  const height = Math.max(1, Math.ceil(cssHeight * dpr))
  let reset = false
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
    reset = true
  }
  const ctx = canvas.getContext('2d', { alpha: false })!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.textBaseline = 'alphabetic'
  ctx.font = metrics.fonts[0]!
  const renderStart = performance.now()
  const frame = vt.render()
  const renderMs = performance.now() - renderStart
  const previousCursor = lastFrame?.cursor
  lastFrame = frame
  if (reset || frame.dirty === 2) {
    ctx.fillStyle = frame.background
    ctx.fillRect(0, 0, cssWidth, cssHeight)
  }
  for (const row of frame.rows) rowsCache[row.y] = row.cells
  const dirty = new Set(frame.rows.map((row) => row.y))
  const imageSignature =
    frame.images.length === 0
      ? ''
      : frame.images
          .map(
            (image) =>
              `${image.id}:${image.generation}:${image.x}:${image.y}:${image.offsetX}:${image.offsetY}:${image.pixelWidth}:${image.pixelHeight}:${image.z}`,
          )
          .join('|')
  if (reset || imageSignature !== lastImageSignature)
    for (let row = 0; row < vt.rows; row++) dirty.add(row)
  lastImageSignature = imageSignature
  if (previousCursor?.visible) dirty.add(previousCursor.y)
  if (frame.cursor.visible) dirty.add(frame.cursor.y)
  const changed: Array<[number, string]> = []
  for (const row of dirty) {
    paintRow(ctx, row, frame)
    if (row < 0 || row >= vt.rows) continue
    const text = accessibleRowText(row)
    if (text !== rowText[row]) {
      rowText[row] = text
      changed.push([row, text])
    }
  }
  if (imageCanvases.size > 0) {
    const live = new Set(frame.images.map((image) => `${image.id}:${image.generation}`))
    for (const key of imageCanvases.keys()) if (!live.has(key)) imageCanvases.delete(key)
  }
  post({
    t: 'frame',
    rows: vt.rows,
    changed,
    at: clock(),
    drawMs: performance.now() - started,
    renderMs,
    appliedWrites,
    wasmBytes: vt.api.memory.buffer.byteLength,
  })
}

function accessibleRowText(y: number): string {
  const cells = rowsCache[y]
  if (!cells) return ''
  let text = ''
  for (const cell of cells) if (cell.wide < 2) text += cell.text || ' '
  return text.trimEnd()
}

function paintImages(
  ctx: OffscreenCanvasRenderingContext2D,
  y: number,
  frame: GhosttyFrame,
  aboveText: boolean,
): void {
  if (frame.images.length === 0) return
  const { cellWidth, cellHeight } = metrics
  const top = y * cellHeight
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, top, vt.cols * cellWidth, cellHeight)
  ctx.clip()
  for (const image of frame.images) {
    if (image.z >= 0 !== aboveText) continue
    const left = image.x * cellWidth + image.offsetX
    const imageTop = image.y * cellHeight + image.offsetY
    if (imageTop >= top + cellHeight || imageTop + image.pixelHeight <= top) continue
    const key = `${image.id}:${image.generation}`
    let source = imageCanvases.get(key)
    if (!source) {
      source = new OffscreenCanvas(image.width, image.height)
      source
        .getContext('2d')!
        .putImageData(
          new ImageData(new Uint8ClampedArray(image.rgba), image.width, image.height),
          0,
          0,
        )
      imageCanvases.set(key, source)
    }
    ctx.drawImage(
      source,
      image.sourceX,
      image.sourceY,
      image.sourceWidth,
      image.sourceHeight,
      left,
      imageTop,
      image.pixelWidth,
      image.pixelHeight,
    )
  }
  ctx.restore()
}

function paintRow(ctx: OffscreenCanvasRenderingContext2D, y: number, frame: GhosttyFrame): void {
  if (y < 0 || y >= vt.rows) return
  const { cellWidth, cellHeight, baseline, fonts } = metrics
  ctx.fillStyle = frame.background
  ctx.fillRect(0, y * cellHeight, vt.cols * cellWidth, cellHeight)
  const cells = rowsCache[y] ?? []
  const search = searchQuery.toLocaleLowerCase()
  let highlighted: Uint8Array | null = null
  if (search) {
    const line = cells
      .map((cell) => cell.text || ' ')
      .join('')
      .toLocaleLowerCase()
    for (let start = line.indexOf(search); start >= 0; start = line.indexOf(search, start + 1)) {
      highlighted ??= new Uint8Array(cells.length)
      highlighted.fill(1, start, Math.min(cells.length, start + search.length))
    }
  }
  foregrounds.length = cells.length
  const py = y * cellHeight
  for (let x = 0; x < cells.length; x++) {
    const cell = cells[x]!
    if (cell.wide === 2 || cell.wide === 3) continue
    let fg = cell.inverse ? cell.bg : cell.fg
    let bg = cell.inverse ? cell.fg : cell.bg
    if (highlighted?.[x]) bg = '#6b4a35'
    if (cell.selected) {
      bg = '#264f78'
      fg = '#ffffff'
    }
    if (bg !== frame.background) {
      ctx.fillStyle = bg
      ctx.fillRect(x * cellWidth, py, (cell.wide === 1 ? 2 : 1) * cellWidth, cellHeight)
    }
    foregrounds[x] = fg
  }
  paintImages(ctx, y, frame, false)
  let font = -1
  let faint = false
  let fill = ''
  for (let x = 0; x < cells.length; x++) {
    const cell = cells[x]!
    if (cell.wide === 2 || cell.wide === 3 || !cell.text) continue
    const px = x * cellWidth
    if (fill !== foregrounds[x]) {
      fill = foregrounds[x]!
      ctx.fillStyle = fill
    }
    if (faint !== cell.faint) {
      faint = cell.faint
      ctx.globalAlpha = faint ? 0.6 : 1
    }
    const variant = ((cell.bold ? 1 : 0) | (cell.italic ? 2 : 0)) % FONT_VARIANT_COUNT
    if (font !== variant) {
      font = variant
      ctx.font = fonts[variant]!
    }
    ctx.fillText(cell.text, px, py + baseline)
    if (cell.underline || cell.strikethrough) {
      if (faint) ctx.globalAlpha = 1
      ctx.fillRect(px, py + (cell.strikethrough ? cellHeight / 2 : cellHeight - 2), cellWidth, 1)
      if (faint) ctx.globalAlpha = 0.6
    }
  }
  if (faint) ctx.globalAlpha = 1
  paintImages(ctx, y, frame, true)
  if (frame.cursor.visible && frame.cursor.y === y && cursorVisible) {
    const x = frame.cursor.x * cellWidth
    ctx.fillStyle = active ? '#d4d4d4' : '#666666'
    if (frame.cursor.style === 0) ctx.fillRect(x, py, 2, cellHeight)
    else if (frame.cursor.style === 2) ctx.fillRect(x, py + cellHeight - 2, cellWidth, 2)
    else {
      ctx.fillRect(x, py, cellWidth, cellHeight)
      const text = cells[frame.cursor.x]?.text
      if (text) {
        ctx.fillStyle = '#151515'
        ctx.font = fonts[0]!
        ctx.fillText(text, x, py + baseline)
      }
    }
  }
}

async function createCore(cols: number, rows: number): Promise<GhosttyVt> {
  const core = await GhosttyVt.create(wasmModule, cols, rows)
  core.resize(cols, rows, Math.round(metrics.cellWidth), Math.round(metrics.cellHeight))
  installEffects(core)
  return core
}

let queue = Promise.resolve()
scope.onmessage = (event: MessageEvent<Incoming>) => {
  const message = event.data
  // `init` and `reset` are asynchronous; keep every later message ordered behind them.
  queue = queue
    .then(() => handle(message))
    .catch((error: unknown) => {
      post({ t: 'error', message: String(error instanceof Error ? error.stack : error) })
    })
}

async function handle(message: Incoming): Promise<void> {
  switch (message.t) {
    case 'init':
      canvas = message.canvas
      wasmModule = message.module
      metrics = message.metrics
      vt = await createCore(message.cols, message.rows)
      post({ t: 'ready' })
      return
    case 'write': {
      const started = performance.now()
      try {
        vt.write(new Uint8Array(message.data))
      } catch (error) {
        post({ t: 'failed', id: message.id, message: String(error) })
        return
      }
      appliedWrites++
      post({ t: 'applied', id: message.id, parseMs: performance.now() - started })
      refresh()
      return
    }
    case 'resize':
      vt.resize(
        message.cols,
        message.rows,
        Math.round(metrics.cellWidth),
        Math.round(metrics.cellHeight),
      )
      clearRowCaches()
      refresh()
      return
    case 'size':
      cssWidth = message.width
      cssHeight = message.height
      dpr = message.dpr
      refresh()
      return
    case 'metrics':
      metrics = message.metrics
      vt.setDefaultColors(
        message.light ? '#fbfcfe' : '#151515',
        message.light ? '#202633' : '#d4d4d4',
        message.light,
      )
      vt.resize(vt.cols, vt.rows, Math.round(metrics.cellWidth), Math.round(metrics.cellHeight))
      clearRowCaches()
      refresh()
      return
    case 'refresh':
      refresh()
      return
    case 'active':
      active = message.value
      refresh()
      return
    case 'cursorVisible':
      cursorVisible = message.value
      refresh()
      return
    case 'key': {
      const encoded = vt.encodeKey(message.event)
      if (encoded.length > 0) post({ t: 'data', text: decoder.decode(encoded) })
      return
    }
    case 'selection':
      vt.setSelection(message.start, message.end ?? undefined)
      post({ t: 'selectedText', text: vt.selectedText() })
      refresh()
      return
    case 'search': {
      searchQuery = message.query
      const result = vt.search(message.query, message.direction)
      post({ t: 'searchResult', ...result })
      refresh()
      return
    }
    case 'scroll':
      vt.scrollRows(message.delta)
      refresh()
      return
    case 'paste': {
      const encoded = vt.encodePaste(message.text)
      post({ t: 'pasteEncoded', text: decoder.decode(encoded.bytes), bracketed: encoded.bracketed })
      return
    }
    case 'mouse': {
      const data = vt.encodeMouse(
        message.action,
        message.button,
        message.x,
        message.y,
        Math.round(metrics.cellWidth),
        Math.round(metrics.cellHeight),
        message.mods,
      )
      post({ t: 'mouseEncoded', id: message.id, text: data.length ? decoder.decode(data) : '' })
      return
    }
    case 'link':
      post({ t: 'linkResolved', id: message.id, href: vt.linkAt(message.x, message.y) })
      return
    case 'dispose':
      // Release WASM memory and the canvas backing store before the page terminates us.
      vt?.dispose()
      imageCanvases.clear()
      clearRowCaches()
      if (canvas) {
        canvas.width = 1
        canvas.height = 1
      }
      scope.close()
      return
    case 'reset': {
      const next = await createCore(vt.cols, vt.rows)
      vt.dispose()
      vt = next
      renderHeld = false
      searchQuery = ''
      clearRowCaches()
      post({ t: 'resetDone' })
      refresh()
      return
    }
  }
}

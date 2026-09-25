import { GhosttyVt, type GhosttyCell, type GhosttyFrame } from './ghostty-vt'

const decoder = new TextDecoder()
let wasmBytes: Promise<ArrayBuffer> | null = null

function loadWasm(): Promise<ArrayBuffer> {
  // Vite serves public assets at the document root in development and beside index.html in the
  // packaged file:// renderer. Keep one compiled binary but separate WASM memories per pane.
  wasmBytes ??= fetch(new URL('ghostty-vt.wasm', window.location.href)).then((response) => {
    if (!response.ok) throw new Error(`Ghostty WASM loading failed: HTTP ${response.status}`)
    return response.arrayBuffer()
  })
  return wasmBytes
}

const FONT_VARIANTS = ['', 'bold ', 'italic ', 'italic bold '] as const
/** Glyphs that may share one fillText call. Coding-font ligatures (->, !=, <=, ...) are built from
 * punctuation, which canvas cannot disable, so runs are limited to letters, digits and spaces. */
const RUN_CHARACTERS = ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const RUNNABLE = new Set(RUN_CHARACTERS)

function runnable(cell: GhosttyCell): boolean {
  return cell.wide === 0 && RUNNABLE.has(cell.text)
}

type Listener<T> = (value: T) => void
function subscribe<T>(listeners: Set<Listener<T>>, listener: Listener<T>): { dispose(): void } {
  listeners.add(listener)
  return { dispose: () => listeners.delete(listener) }
}

type Point = { x: number; y: number }

/** Tau-owned canvas and input surface around the pinned libghostty-vt WASM C ABI. */
export class TauTerminal {
  private vt: GhosttyVt
  private wrapper: HTMLElement | null = null
  private canvas: HTMLCanvasElement | null = null
  private textarea: HTMLTextAreaElement | null = null
  private screenReader: HTMLPreElement | null = null
  private readonly dataListeners = new Set<Listener<string>>()
  private readonly binaryListeners = new Set<Listener<string>>()
  private readonly resizeListeners = new Set<Listener<{ cols: number; rows: number }>>()
  private readonly titleListeners = new Set<Listener<string>>()
  private readonly searchListeners = new Set<
    Listener<{ resultIndex: number; resultCount: number }>
  >()
  private readonly rowsCache: GhosttyCell[][] = []
  /** Accessible text per viewport row; the reader is rewritten only when a row changes. */
  private readonly rowText: string[] = []
  private readonly foregrounds: string[] = []
  private readonly imageCanvases = new Map<string, HTMLCanvasElement>()
  private lastFrame: GhosttyFrame | null = null
  private lastImageSignature = ''
  /** Drawing was skipped while no cell was visible; the next visible draw re-reads every row. */
  private hiddenStale = false
  // Search highlights are JS-only pixels that Ghostty's dirty rows cannot report.
  private repaintAll = false
  private fontSize = 14
  private fonts: string[] = []
  /** Per font variant: ASCII advances equal the cell width, so runs of cells can be drawn as one
   * string at identical glyph positions. Otherwise that variant is drawn cell by cell. */
  private asciiRuns: boolean[] = []
  private fontFamily = '"SF Mono", Menlo, Monaco, "JetBrains Mono", monospace'
  private cellWidth = 8
  private cellHeight = 18
  private baseline = 14
  private animationFrame: number | null = null
  private disposed = false
  private active = true
  private composing = false
  private cursorVisible = true
  private renderHeld = false
  private anchor: Point | null = null
  private selectionEnd: Point | null = null
  /** Whether the VT core holds a selection (search matches are separate from it). */
  private hasSelection = false
  /** Draw eligible ASCII runs with one fillText; tests compare against per-cell drawing. */
  private textRuns = true
  private drag = false
  private mouseReporting = false
  private searchQuery = ''
  private searchIndex = -1

  static async create(): Promise<TauTerminal> {
    return new TauTerminal(await GhosttyVt.create(await loadWasm()))
  }

  private constructor(vt: GhosttyVt) {
    this.vt = vt
    this.installEffects(vt)
  }

  private installEffects(vt: GhosttyVt): void {
    vt.onSizeReport()
    vt.onRenderHold((held) => {
      this.renderHeld = held
      if (!held) this.refresh()
    })
    vt.onTitleChange((title) => {
      for (const listener of this.titleListeners) listener(title)
    })
    vt.onPtyResponse((bytes) => {
      for (let offset = 0; offset < bytes.length; offset += 8192) {
        const binary = String.fromCharCode(...bytes.subarray(offset, offset + 8192))
        for (const listener of this.binaryListeners) listener(binary)
      }
    })
    vt.onClipboardWrite((text) => {
      if (!window.confirm('Allow this terminal program to write to your clipboard?')) return false
      void window.electronAPI.writeClipboardText(text).catch((error) => {
        console.warn('[terminal] clipboard write was rejected by the host:', error)
      })
      return true
    })
  }

  get cols(): number {
    return this.vt.cols
  }

  get rows(): number {
    return this.vt.rows
  }

  open(wrapper: HTMLElement): void {
    this.wrapper = wrapper
    wrapper.classList.add('tau-native-terminal')
    wrapper.style.position = 'relative'
    wrapper.style.overflow = 'hidden'
    wrapper.style.background = 'var(--tau-terminal-background)'
    const canvas = document.createElement('canvas')
    canvas.className = 'tau-native-terminal-canvas'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.style.display = 'block'
    canvas.style.cursor = 'text'
    canvas.setAttribute('aria-hidden', 'true')
    this.canvas = canvas
    const textarea = document.createElement('textarea')
    textarea.className = 'tau-native-terminal-input'
    textarea.setAttribute('aria-label', 'Terminal input')
    textarea.setAttribute('autocomplete', 'off')
    textarea.setAttribute('autocorrect', 'off')
    textarea.setAttribute('autocapitalize', 'off')
    textarea.spellcheck = false
    Object.assign(textarea.style, {
      position: 'absolute',
      width: '1px',
      height: '1px',
      padding: '0',
      margin: '0',
      border: '0',
      opacity: '0',
      left: '0',
      top: '0',
      resize: 'none',
    })
    this.textarea = textarea
    // Canvas pixels are hidden from assistive technology. Expose the same viewport text as a
    // separately navigable, non-live region; never announce every frame of shell output.
    const screenReader = document.createElement('pre')
    screenReader.className = 'tau-native-terminal-screen-reader'
    screenReader.setAttribute('role', 'region')
    screenReader.setAttribute('aria-label', 'Terminal screen')
    screenReader.setAttribute('aria-live', 'off')
    screenReader.tabIndex = 0
    Object.assign(screenReader.style, {
      position: 'absolute',
      width: '1px',
      height: '1px',
      overflow: 'hidden',
      clipPath: 'inset(50%)',
    })
    this.screenReader = screenReader
    wrapper.replaceChildren(canvas, textarea, screenReader)
    const metrics = canvas.getContext('2d', { alpha: false })
    if (!metrics) throw new Error('Canvas 2D renderer unavailable')
    this.updateFontMetrics(metrics)
    // terminal_new does not know browser cell pixels; set them even when the fitted grid is
    // exactly 80x24 and no later column/row resize occurs (Kitty placement needs geometry).
    this.vt.resize(this.cols, this.rows, Math.round(this.cellWidth), Math.round(this.cellHeight))

    canvas.addEventListener('pointerdown', this.pointerDown)
    canvas.addEventListener('mousedown', this.mouseDown)
    canvas.addEventListener('pointermove', this.pointerMove)
    canvas.addEventListener('pointerup', this.pointerUp)
    canvas.addEventListener('pointercancel', this.pointerUp)
    canvas.addEventListener('dblclick', this.doubleClick)
    canvas.addEventListener('wheel', this.wheel, { passive: false })
    textarea.addEventListener('keydown', this.keyDown)
    textarea.addEventListener('beforeinput', this.beforeInput)
    textarea.addEventListener('compositionstart', this.compositionStart)
    textarea.addEventListener('compositionend', this.compositionEnd)
    textarea.addEventListener('paste', this.paste)
    textarea.addEventListener('copy', this.copy)
    window.addEventListener('tau:appearance', this.appearanceChanged)
    this.appearanceChanged()
  }

  private updateFontMetrics(ctx: CanvasRenderingContext2D): void {
    const css = getComputedStyle(document.documentElement)
    const size = Number.parseInt(css.getPropertyValue('--terminal-font-size'), 10)
    this.fontSize = Number.isFinite(size) && size >= 10 && size <= 28 ? size : 14
    this.fontFamily =
      css.getPropertyValue('--terminal-font-family').trim() ||
      '"SF Mono", Menlo, Monaco, "JetBrains Mono", monospace'
    ctx.font = `${this.fontSize}px ${this.fontFamily}`
    this.fonts = FONT_VARIANTS.map((variant) => `${variant}${this.fontSize}px ${this.fontFamily}`)
    const measurement = ctx.measureText('M')
    this.cellWidth = Math.max(1, measurement.width)
    this.configureText(ctx)
    this.asciiRuns = this.fonts.map((font) => {
      ctx.font = font
      const width = ctx.measureText(RUN_CHARACTERS).width
      return Math.abs(width - RUN_CHARACTERS.length * this.cellWidth) < 0.01
    })
    ctx.font = this.fonts[0]!
    this.cellHeight = Math.ceil(
      Math.max(
        this.fontSize + 4,
        measurement.actualBoundingBoxAscent + measurement.actualBoundingBoxDescent + 3,
      ),
    )
    this.baseline = Math.round((this.cellHeight - this.fontSize) / 2 + this.fontSize - 2)
  }

  /** Runs must not kern; single-glyph draws are unaffected. (Do not use textRendering:
   * optimizeSpeed; Chromium then changes glyph advances and the cell grid.) */
  private configureText(ctx: CanvasRenderingContext2D): void {
    ctx.fontKerning = 'none'
  }

  private appearanceChanged = () => {
    if (!this.canvas || this.disposed) return
    const ctx = this.canvas.getContext('2d', { alpha: false })
    if (!ctx) return
    const light = document.documentElement.dataset.theme === 'light'
    this.vt.setDefaultColors(light ? '#fbfcfe' : '#151515', light ? '#202633' : '#d4d4d4', light)
    this.updateFontMetrics(ctx)
    this.clearRowCaches()
    const size = this.proposeDimensions()
    const gridChanged = size && (size.cols !== this.cols || size.rows !== this.rows)
    if (size) this.resize(size.cols, size.rows)
    if (!gridChanged)
      this.vt.resize(this.cols, this.rows, Math.round(this.cellWidth), Math.round(this.cellHeight))
    this.refresh()
  }

  proposeDimensions(): { cols: number; rows: number } | null {
    if (!this.wrapper || this.wrapper.clientWidth <= 0 || this.wrapper.clientHeight <= 0)
      return null
    return {
      cols: Math.max(2, Math.floor(this.wrapper.clientWidth / this.cellWidth)),
      rows: Math.max(1, Math.floor(this.wrapper.clientHeight / this.cellHeight)),
    }
  }

  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return
    this.vt.resize(cols, rows, Math.round(this.cellWidth), Math.round(this.cellHeight))
    this.clearRowCaches()
    this.refresh()
    for (const listener of this.resizeListeners) listener({ cols, rows })
  }

  async resetCore(): Promise<void> {
    if (this.disposed) return
    const next = await GhosttyVt.create(await loadWasm(), this.cols, this.rows)
    if (this.disposed) {
      next.dispose()
      return
    }
    next.resize(this.cols, this.rows, Math.round(this.cellWidth), Math.round(this.cellHeight))
    this.installEffects(next)
    this.vt.dispose()
    this.vt = next
    this.renderHeld = false
    this.clearRowCaches()
    this.searchQuery = ''
    this.anchor = null
    this.selectionEnd = null
    this.hasSelection = false
    this.refresh()
  }

  write(data: string | Uint8Array, callback?: () => void): void {
    this.vt.write(data)
    // Acknowledge only after the VT core has synchronously consumed the complete bytes, not after
    // a browser paint. Output ordering is owned by the existing sequenced writer.
    callback?.()
    this.refresh()
  }

  refresh(_start?: number, _end?: number): void {
    if (this.disposed || this.renderHeld || this.animationFrame !== null || !this.canvas) return
    this.animationFrame = window.requestAnimationFrame(() => {
      this.animationFrame = null
      if (!this.disposed && !this.renderHeld) this.draw()
    })
  }

  private clearRowCaches(): void {
    this.rowsCache.length = 0
    this.rowText.length = 0
    this.lastFrame = null
    this.lastImageSignature = ''
  }

  private draw(): void {
    const canvas = this.canvas
    if (!canvas) return
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return
    // A parked (hidden-tab) or collapsed pane cannot show a single cell. Leave the VT's dirty
    // state accumulated, release the backing store, and re-read every row once it is visible.
    if (canvas.clientWidth < this.cellWidth || canvas.clientHeight < this.cellHeight) {
      if (!this.hiddenStale) {
        this.hiddenStale = true
        canvas.width = 1
        canvas.height = 1
        this.clearRowCaches()
      }
      return
    }
    if (this.hiddenStale) {
      this.hiddenStale = false
      this.vt.invalidate()
    }
    const scale = window.devicePixelRatio || 1
    const width = Math.max(1, Math.ceil(canvas.clientWidth * scale))
    const height = Math.max(1, Math.ceil(canvas.clientHeight * scale))
    let reset = this.repaintAll
    this.repaintAll = false
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
      reset = true
    }
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    ctx.textBaseline = 'alphabetic'
    this.configureText(ctx)
    ctx.font = `${this.fontSize}px ${this.fontFamily}`
    const frame = this.vt.render()
    const previousCursor = this.lastFrame?.cursor
    this.lastFrame = frame
    if (reset || frame.dirty === 2) {
      ctx.fillStyle = frame.background
      ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight)
    }
    for (const row of frame.rows) this.rowsCache[row.y] = row.cells
    // Selection changes, scrolling and screen switches arrive as full-dirty frames from Ghostty.
    const dirty = new Set(frame.rows.map((row) => row.y))
    const imageSignature = frame.images.length === 0 ? '' : this.imageSignature(frame.images)
    if (reset || imageSignature !== this.lastImageSignature)
      for (let row = 0; row < this.rows; row++) dirty.add(row)
    this.lastImageSignature = imageSignature
    if (previousCursor?.visible) dirty.add(previousCursor.y)
    if (frame.cursor.visible) dirty.add(frame.cursor.y)
    let textChanged = false
    for (const row of dirty) {
      this.paintRow(ctx, row, frame)
      if (row < 0 || row >= this.rows) continue
      const text = this.accessibleRowText(row)
      if (text !== this.rowText[row]) {
        this.rowText[row] = text
        textChanged = true
      }
    }
    if (textChanged && this.screenReader) {
      for (let row = 0; row < this.rows; row++) this.rowText[row] ??= ''
      this.rowText.length = this.rows
      this.screenReader.textContent = this.rowText.join('\n')
    }
    if (this.imageCanvases.size > 0) {
      const active = new Set(frame.images.map((image) => `${image.id}:${image.generation}`))
      for (const key of this.imageCanvases.keys())
        if (!active.has(key)) this.imageCanvases.delete(key)
    }
  }

  private accessibleRowText(y: number): string {
    const cells = this.rowsCache[y]
    if (!cells) return ''
    let text = ''
    for (const cell of cells) if (cell.wide < 2) text += cell.text || ' '
    return text.trimEnd()
  }

  private imageSignature(images: GhosttyFrame['images']): string {
    return images
      .map(
        (image) =>
          `${image.id}:${image.generation}:${image.x}:${image.y}:${image.offsetX}:${image.offsetY}:${image.pixelWidth}:${image.pixelHeight}:${image.z}`,
      )
      .join('|')
  }

  private paintImages(
    ctx: CanvasRenderingContext2D,
    y: number,
    frame: GhosttyFrame,
    aboveText: boolean,
  ): void {
    if (frame.images.length === 0) return
    const top = y * this.cellHeight
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, top, this.cols * this.cellWidth, this.cellHeight)
    ctx.clip()
    for (const image of frame.images) {
      if (image.z >= 0 !== aboveText) continue
      const left = image.x * this.cellWidth + image.offsetX
      const imageTop = image.y * this.cellHeight + image.offsetY
      if (imageTop >= top + this.cellHeight || imageTop + image.pixelHeight <= top) continue
      const key = `${image.id}:${image.generation}`
      let canvas = this.imageCanvases.get(key)
      if (!canvas) {
        canvas = document.createElement('canvas')
        canvas.width = image.width
        canvas.height = image.height
        canvas
          .getContext('2d')!
          .putImageData(
            new ImageData(new Uint8ClampedArray(image.rgba), image.width, image.height),
            0,
            0,
          )
        this.imageCanvases.set(key, canvas)
      }
      ctx.drawImage(
        canvas,
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

  private paintRow(ctx: CanvasRenderingContext2D, y: number, frame: GhosttyFrame): void {
    if (y < 0 || y >= this.rows) return
    ctx.fillStyle = frame.background
    ctx.fillRect(0, y * this.cellHeight, this.cols * this.cellWidth, this.cellHeight)
    const cells = this.rowsCache[y] ?? []
    const search = this.searchQuery.toLocaleLowerCase()
    // Per-column search highlight, built only while a search query is active.
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
    const foregrounds = this.foregrounds
    foregrounds.length = cells.length
    for (let x = 0; x < cells.length; x++) {
      const cell = cells[x]
      if (cell.wide === 2 || cell.wide === 3) continue
      const px = x * this.cellWidth
      const py = y * this.cellHeight
      let fg = cell.inverse ? cell.bg : cell.fg
      let bg = cell.inverse ? cell.fg : cell.bg
      if (highlighted?.[x]) bg = '#6b4a35'
      if (cell.selected) {
        bg = '#264f78'
        fg = '#ffffff'
      }
      if (bg !== frame.background) {
        ctx.fillStyle = bg
        ctx.fillRect(px, py, (cell.wide === 1 ? 2 : 1) * this.cellWidth, this.cellHeight)
      }
      foregrounds[x] = fg
    }
    this.paintImages(ctx, y, frame, false)
    // Canvas state setters parse their arguments; only change font/alpha/fill when they differ.
    const fonts = this.fonts
    let font = -1
    let faint = false
    let fill = ''
    const py = y * this.cellHeight
    for (let x = 0; x < cells.length;) {
      const cell = cells[x]
      if (cell.wide === 2 || cell.wide === 3 || !cell.text) {
        x++
        continue
      }
      if (fill !== foregrounds[x]) {
        fill = foregrounds[x]!
        ctx.fillStyle = fill
      }
      if (faint !== cell.faint) {
        faint = cell.faint
        ctx.globalAlpha = faint ? 0.6 : 1
      }
      const variant = (cell.bold ? 1 : 0) | (cell.italic ? 2 : 0)
      if (font !== variant) {
        font = variant
        ctx.font = fonts[variant]!
      }
      // Extend a run over following cells that share every property affecting the glyph.
      let end = x + 1
      let text = cell.text
      if (this.textRuns && this.asciiRuns[variant] && runnable(cell)) {
        while (end < cells.length) {
          const next = cells[end]
          if (
            !runnable(next) ||
            foregrounds[end] !== fill ||
            next.faint !== faint ||
            ((next.bold ? 1 : 0) | (next.italic ? 2 : 0)) !== variant
          )
            break
          text += next.text
          end++
        }
      }
      ctx.fillText(text, x * this.cellWidth, py + this.baseline)
      for (let at = x; at < end; at++) {
        const decorated = cells[at]
        if (!decorated.underline && !decorated.strikethrough) continue
        // Decorations are opaque even on faint text.
        if (faint) ctx.globalAlpha = 1
        ctx.fillRect(
          at * this.cellWidth,
          py + (decorated.strikethrough ? this.cellHeight / 2 : this.cellHeight - 2),
          this.cellWidth,
          1,
        )
        if (faint) ctx.globalAlpha = 0.6
      }
      x = end
    }
    if (faint) ctx.globalAlpha = 1
    this.paintImages(ctx, y, frame, true)
    if (frame.cursor.visible && frame.cursor.y === y && this.cursorVisible) {
      const x = frame.cursor.x * this.cellWidth
      const top = y * this.cellHeight
      ctx.fillStyle = this.active ? '#d4d4d4' : '#666666'
      if (frame.cursor.style === 0) ctx.fillRect(x, top, 2, this.cellHeight)
      else if (frame.cursor.style === 2)
        ctx.fillRect(x, top + this.cellHeight - 2, this.cellWidth, 2)
      else {
        ctx.fillRect(x, top, this.cellWidth, this.cellHeight)
        const text = cells[frame.cursor.x]?.text
        if (text) {
          ctx.fillStyle = '#151515'
          ctx.font = `${this.fontSize}px ${this.fontFamily}`
          ctx.fillText(text, x, top + this.baseline)
        }
      }
    }
  }

  private point(event: PointerEvent | MouseEvent): Point {
    const bounds = this.canvas!.getBoundingClientRect()
    return {
      x: Math.max(
        0,
        Math.min(this.cols - 1, Math.floor((event.clientX - bounds.left) / this.cellWidth)),
      ),
      y: Math.max(
        0,
        Math.min(this.rows - 1, Math.floor((event.clientY - bounds.top) / this.cellHeight)),
      ),
    }
  }

  private selectedText(): string {
    return this.vt.selectedText()
  }

  /** Changing a selection marks Ghostty's screen dirty; repaint now rather than waiting for
   * output, so a cleared highlight disappears on the keypress that cleared it. */
  private select(start: Point | null, end?: Point | null): void {
    if (start && end) {
      this.vt.setSelection(start, end)
      this.hasSelection = true
    } else if (this.hasSelection) {
      this.vt.setSelection(null)
      this.hasSelection = false
    } else return
    this.refresh()
  }

  private sendMouse(
    action: 'press' | 'release' | 'motion',
    button: number | null,
    event: MouseEvent | PointerEvent | WheelEvent,
  ): boolean {
    const bounds = this.canvas!.getBoundingClientRect()
    const mods =
      (event.shiftKey ? 1 : 0) |
      (event.ctrlKey ? 2 : 0) |
      (event.altKey ? 4 : 0) |
      (event.metaKey ? 8 : 0)
    const data = this.vt.encodeMouse(
      action,
      button,
      event.clientX - bounds.left,
      event.clientY - bounds.top,
      Math.round(this.cellWidth),
      Math.round(this.cellHeight),
      mods,
    )
    if (data.length === 0) return false
    this.emit(decoder.decode(data))
    return true
  }

  private openLink(point: Point): boolean {
    const linked = this.vt.linkAt(point.x, point.y)
    const text = (this.rowsCache[point.y] ?? []).map((cell) => cell.text || ' ').join('')
    const plain = [...text.matchAll(/https?:\/\/[^\s<>'"`]+/gu)].find(
      (item) => item.index <= point.x && point.x < item.index + item[0].length,
    )?.[0]
    const href = linked ?? plain
    if (!href) return false
    try {
      const url = new URL(href)
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
      void window.electronAPI.openExternalUrl(url.href).catch(console.warn)
      return true
    } catch {
      return false
    }
  }

  private readonly pointerDown = (event: PointerEvent): void => {
    // A user selecting or scrolling should see live content even during an app's hold.
    this.renderHeld = false
    this.focus()
    if (
      event.button === 0 &&
      (event.ctrlKey || event.metaKey) &&
      this.openLink(this.point(event))
    ) {
      event.preventDefault()
      return
    }
    const button = [1, 3, 2][event.button] ?? 0
    if (!event.shiftKey && button !== 0 && this.sendMouse('press', button, event)) {
      event.preventDefault()
      this.mouseReporting = true
      this.canvas?.setPointerCapture(event.pointerId)
      return
    }
    if (event.button !== 0) return
    this.drag = true
    this.select(null)
    this.anchor = this.point(event)
    this.selectionEnd = this.anchor
    this.canvas?.setPointerCapture(event.pointerId)
  }

  private readonly mouseDown = (event: MouseEvent): void => {
    // Focusing on pointerdown alone loses a race with Chromium's subsequent default mousedown:
    // it focuses the non-focusable canvas/body and steals keys from the hidden textarea.
    event.preventDefault()
    this.focus()
  }

  private readonly pointerMove = (event: PointerEvent): void => {
    if (this.mouseReporting) {
      const button = (event.buttons & 1) !== 0 ? 1 : (event.buttons & 2) !== 0 ? 2 : null
      this.sendMouse('motion', button, event)
      return
    }
    if (!this.drag) {
      // Applications can request all-motion mouse reports without a held button.
      this.sendMouse('motion', null, event)
      return
    }
    this.selectionEnd = this.point(event)
    this.select(this.anchor, this.selectionEnd)
  }

  private readonly pointerUp = (event: PointerEvent): void => {
    if (this.mouseReporting) {
      const button = [1, 3, 2][event.button] ?? null
      this.sendMouse('release', button, event)
      this.mouseReporting = false
    }
    this.drag = false
    if (this.canvas?.hasPointerCapture(event.pointerId))
      this.canvas.releasePointerCapture(event.pointerId)
  }

  private readonly doubleClick = (event: MouseEvent): void => {
    const row = this.rowsCache[this.point(event).y] ?? []
    const text = row.map((cell) => cell.text || ' ').join('')
    const cursor = this.point(event).x
    const word = /[^\s]+/gu
    const hit = [...text.matchAll(word)].find(
      (item) => item.index <= cursor && cursor < item.index + item[0].length,
    )
    if (hit) {
      this.anchor = { x: hit.index, y: this.point(event).y }
      this.selectionEnd = { x: hit.index + hit[0].length - 1, y: this.point(event).y }
      this.select(this.anchor, this.selectionEnd)
    }
  }

  private readonly wheel = (event: WheelEvent): void => {
    this.renderHeld = false
    event.preventDefault()
    if (this.sendMouse('press', event.deltaY < 0 ? 4 : 5, event)) return
    this.vt.scrollRows(Math.round(event.deltaY / this.cellHeight) || Math.sign(event.deltaY))
    this.refresh()
  }

  private emit(data: string): void {
    if (!data) return
    for (const listener of this.dataListeners) listener(data)
  }

  private readonly keyDown = (event: KeyboardEvent): void => {
    if (event.isComposing || this.composing) return
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === 'c' &&
      this.selectedText()
    ) {
      event.preventDefault()
      void window.electronAPI.writeClipboardText(this.selectedText())
      return
    }
    if (event.key === 'Dead') return
    const encoded = this.vt.encodeKey(event)
    if (encoded.length === 0) return
    event.preventDefault()
    this.anchor = null
    this.selectionEnd = null
    this.select(null)
    this.emit(decoder.decode(encoded))
  }

  private readonly beforeInput = (event: InputEvent): void => {
    if (!this.composing && event.data && event.inputType === 'insertText') {
      event.preventDefault()
      this.emit(event.data)
    }
    if (this.textarea) this.textarea.value = ''
  }

  private readonly compositionStart = (): void => {
    this.composing = true
  }

  private readonly compositionEnd = (event: CompositionEvent): void => {
    this.composing = false
    this.emit(event.data)
    if (this.textarea) this.textarea.value = ''
  }

  private readonly paste = (event: ClipboardEvent): void => {
    event.preventDefault()
    const text = event.clipboardData?.getData('text/plain') ?? ''
    if (!text) return
    const encoded = this.vt.encodePaste(text.replace(/\r\n?/gu, '\n'))
    if (
      !encoded.bracketed &&
      /[\r\n]/u.test(text) &&
      !window.confirm('Paste multiple lines into the shell? They may execute commands.')
    )
      return
    this.emit(decoder.decode(encoded.bytes))
  }

  private readonly copy = (event: ClipboardEvent): void => {
    const text = this.selectedText()
    if (!text) return
    event.preventDefault()
    event.clipboardData?.setData('text/plain', text)
  }

  focus(): void {
    this.active = true
    this.textarea?.focus({ preventScroll: true })
    this.refresh()
  }

  blur(): void {
    this.active = false
    this.textarea?.blur()
    this.refresh()
  }

  setCursorVisible(visible: boolean): void {
    this.cursorVisible = visible
    this.refresh()
  }

  search(query: string, direction: 'next' | 'previous', _incremental: boolean): boolean {
    this.searchQuery = query
    this.repaintAll = true
    const result = this.vt.search(query, direction)
    this.searchIndex = result.resultIndex
    for (const listener of this.searchListeners) listener(result)
    this.refresh()
    return result.resultCount > 0
  }

  clearSearch(): void {
    this.searchQuery = ''
    this.repaintAll = true
    this.searchIndex = -1
    this.anchor = null
    this.selectionEnd = null
    this.select(null)
    this.vt.search('')
    this.refresh()
  }

  onData(listener: Listener<string>): { dispose(): void } {
    return subscribe(this.dataListeners, listener)
  }
  onBinary(listener: Listener<string>): { dispose(): void } {
    return subscribe(this.binaryListeners, listener)
  }
  onResize(listener: Listener<{ cols: number; rows: number }>): { dispose(): void } {
    return subscribe(this.resizeListeners, listener)
  }
  onTitleChange(listener: Listener<string>): { dispose(): void } {
    return subscribe(this.titleListeners, listener)
  }
  onSearchResults(listener: Listener<{ resultIndex: number; resultCount: number }>): {
    dispose(): void
  } {
    return subscribe(this.searchListeners, listener)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.animationFrame !== null) window.cancelAnimationFrame(this.animationFrame)
    this.canvas?.removeEventListener('pointerdown', this.pointerDown)
    this.canvas?.removeEventListener('mousedown', this.mouseDown)
    this.canvas?.removeEventListener('pointermove', this.pointerMove)
    this.canvas?.removeEventListener('pointerup', this.pointerUp)
    this.canvas?.removeEventListener('pointercancel', this.pointerUp)
    this.canvas?.removeEventListener('dblclick', this.doubleClick)
    this.canvas?.removeEventListener('wheel', this.wheel)
    this.textarea?.removeEventListener('keydown', this.keyDown)
    this.textarea?.removeEventListener('beforeinput', this.beforeInput)
    this.textarea?.removeEventListener('compositionstart', this.compositionStart)
    this.textarea?.removeEventListener('compositionend', this.compositionEnd)
    this.textarea?.removeEventListener('paste', this.paste)
    this.textarea?.removeEventListener('copy', this.copy)
    window.removeEventListener('tau:appearance', this.appearanceChanged)
    this.vt.dispose()
    this.imageCanvases.clear()
    this.wrapper?.replaceChildren()
    this.dataListeners.clear()
    this.binaryListeners.clear()
    this.resizeListeners.clear()
    this.titleListeners.clear()
    this.searchListeners.clear()
  }
}

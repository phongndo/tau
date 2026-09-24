import { GhosttyVt, type GhosttyCell, type GhosttyFrame } from './ghostty-vt'

const FONT_FAMILY = '"SF Mono", Menlo, Monaco, "JetBrains Mono", monospace'
const FONT_SIZE = 14
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
  private readonly imageCanvases = new Map<string, HTMLCanvasElement>()
  private lastFrame: GhosttyFrame | null = null
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
    wrapper.style.background = '#151515'
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
    metrics.font = `${FONT_SIZE}px ${FONT_FAMILY}`
    const size = metrics.measureText('M')
    this.cellWidth = Math.max(1, size.width)
    this.cellHeight = Math.ceil(
      Math.max(FONT_SIZE + 4, size.actualBoundingBoxAscent + size.actualBoundingBoxDescent + 3),
    )
    this.baseline = Math.round((this.cellHeight - FONT_SIZE) / 2 + FONT_SIZE - 2)
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
    this.rowsCache.length = 0
    this.lastFrame = null
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
    this.rowsCache.length = 0
    this.lastFrame = null
    this.searchQuery = ''
    this.anchor = null
    this.selectionEnd = null
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

  private draw(): void {
    const canvas = this.canvas
    if (!canvas) return
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return
    const scale = window.devicePixelRatio || 1
    const width = Math.max(1, Math.ceil(canvas.clientWidth * scale))
    const height = Math.max(1, Math.ceil(canvas.clientHeight * scale))
    let reset = false
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
      reset = true
    }
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    ctx.textBaseline = 'alphabetic'
    ctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`
    const frame = this.vt.render()
    const previous = this.lastFrame
    const previousCursor = previous?.cursor
    this.lastFrame = frame
    if (reset || frame.dirty === 2) {
      ctx.fillStyle = frame.background
      ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight)
    }
    for (const row of frame.rows) this.rowsCache[row.y] = row.cells
    const dirty = new Set(frame.rows.map((row) => row.y))
    if (reset || this.imageSignature(previous?.images) !== this.imageSignature(frame.images))
      for (let row = 0; row < this.rows; row++) dirty.add(row)
    if (previousCursor?.visible) dirty.add(previousCursor.y)
    if (frame.cursor.visible) dirty.add(frame.cursor.y)
    if (this.anchor) for (let row = 0; row < this.rows; row++) dirty.add(row)
    for (const row of dirty) this.paintRow(ctx, row, frame)
    if (dirty.size > 0 && this.screenReader) {
      this.screenReader.textContent = Array.from({ length: this.rows }, (_, y) =>
        (this.rowsCache[y] ?? [])
          .map((cell) => (cell.wide >= 2 ? '' : cell.text || ' '))
          .join('')
          .trimEnd(),
      ).join('\n')
    }
    const active = new Set(frame.images.map((image) => `${image.id}:${image.generation}`))
    for (const key of this.imageCanvases.keys())
      if (!active.has(key)) this.imageCanvases.delete(key)
  }

  private imageSignature(images: GhosttyFrame['images'] | undefined): string {
    return (
      images
        ?.map(
          (image) =>
            `${image.id}:${image.generation}:${image.x}:${image.y}:${image.offsetX}:${image.offsetY}:${image.pixelWidth}:${image.pixelHeight}:${image.z}`,
        )
        .join('|') ?? ''
    )
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
    const line = cells
      .map((cell) => cell.text || ' ')
      .join('')
      .toLocaleLowerCase()
    const matches: number[] = []
    if (search) {
      for (let start = line.indexOf(search); start >= 0; start = line.indexOf(search, start + 1))
        matches.push(start)
    }
    const foregrounds: string[] = []
    for (let x = 0; x < cells.length; x++) {
      const cell = cells[x]
      if (cell.wide === 2 || cell.wide === 3) continue
      const px = x * this.cellWidth
      const py = y * this.cellHeight
      let fg = cell.inverse ? cell.bg : cell.fg
      let bg = cell.inverse ? cell.fg : cell.bg
      if (matches.some((start) => x >= start && x < start + search.length)) bg = '#6b4a35'
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
    for (let x = 0; x < cells.length; x++) {
      const cell = cells[x]
      if (cell.wide === 2 || cell.wide === 3 || !cell.text) continue
      const px = x * this.cellWidth
      const py = y * this.cellHeight
      ctx.fillStyle = foregrounds[x]
      ctx.globalAlpha = cell.faint ? 0.6 : 1
      ctx.font = `${cell.italic ? 'italic ' : ''}${cell.bold ? 'bold ' : ''}${FONT_SIZE}px ${FONT_FAMILY}`
      ctx.fillText(cell.text, px, py + this.baseline)
      ctx.globalAlpha = 1
      if (cell.underline || cell.strikethrough) {
        ctx.fillRect(
          px,
          py + (cell.strikethrough ? this.cellHeight / 2 : this.cellHeight - 2),
          this.cellWidth,
          1,
        )
      }
    }
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
          ctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`
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
    this.vt.setSelection(null)
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
    this.vt.setSelection(this.anchor, this.selectionEnd)
    this.refresh()
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
      this.vt.setSelection(this.anchor, this.selectionEnd)
      this.refresh()
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
    this.vt.setSelection(null)
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
    const result = this.vt.search(query, direction)
    this.searchIndex = result.resultIndex
    for (const listener of this.searchListeners) listener(result)
    this.refresh()
    return result.resultCount > 0
  }

  clearSearch(): void {
    this.searchQuery = ''
    this.searchIndex = -1
    this.anchor = null
    this.selectionEnd = null
    this.vt.setSelection(null)
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

/* SPIKE: main-thread facade for a TauTerminal whose Ghostty VT core and canvas painting live in a
 * dedicated worker (tau-terminal-worker.ts). The public API matches the synchronous surface so
 * terminal.ts and the sequenced writer are unchanged; `write` callbacks resolve when the worker has
 * parsed the batch, preserving the parse-before-acknowledge rule. */
const FONT_VARIANTS = ['', 'bold ', 'italic ', 'italic bold '] as const
let wasmModule: Promise<WebAssembly.Module> | null = null

/** Compile once per page; every pane's worker instantiates its own memory from the module. */
function loadWasm(): Promise<WebAssembly.Module> {
  wasmModule ??= fetch(new URL('ghostty-vt.wasm', window.location.href))
    .then((response) => {
      if (!response.ok) throw new Error(`Ghostty WASM loading failed: HTTP ${response.status}`)
      return response.arrayBuffer()
    })
    .then((bytes) => WebAssembly.compile(bytes))
  return wasmModule
}
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Dead'])

type Listener<T> = (value: T) => void
function subscribe<T>(listeners: Set<Listener<T>>, listener: Listener<T>): { dispose(): void } {
  listeners.add(listener)
  return { dispose: () => listeners.delete(listener) }
}

type Point = { x: number; y: number }
type Metrics = {
  cellWidth: number
  cellHeight: number
  baseline: number
  fontSize: number
  fonts: string[]
}
type FrameMessage = {
  t: 'frame'
  rows: number
  changed: Array<[number, string]>
  at: number
  drawMs: number
  renderMs: number
  appliedWrites: number
  wasmBytes: number
}
type Outgoing =
  | { t: 'ready' }
  | { t: 'applied'; id: number; parseMs: number }
  | { t: 'failed'; id: number; message: string }
  | FrameMessage
  | { t: 'title'; title: string }
  | { t: 'binary'; data: string }
  | { t: 'data'; text: string }
  | { t: 'selectedText'; text: string }
  | { t: 'searchResult'; resultIndex: number; resultCount: number }
  | { t: 'pasteEncoded'; text: string; bracketed: boolean }
  | { t: 'mouseEncoded'; id: number; text: string }
  | { t: 'linkResolved'; id: number; href: string | null }
  | { t: 'resetDone' }
  | { t: 'error'; message: string }

/** Diagnostic hooks for bench:surface; timestamps are on the page's performance clock. */
export type TauTerminalFrameStats = {
  at: number
  drawMs: number
  renderMs: number
  appliedWrites: number
}

export class TauTerminal {
  private readonly worker: Worker
  private wrapper: HTMLElement | null = null
  private canvas: HTMLCanvasElement | null = null
  private textarea: HTMLTextAreaElement | null = null
  private screenReader: HTMLPreElement | null = null
  private resizeObserver: ResizeObserver | null = null
  private readonly dataListeners = new Set<Listener<string>>()
  private readonly binaryListeners = new Set<Listener<string>>()
  private readonly resizeListeners = new Set<Listener<{ cols: number; rows: number }>>()
  private readonly titleListeners = new Set<Listener<string>>()
  private readonly searchListeners = new Set<
    Listener<{ resultIndex: number; resultCount: number }>
  >()
  private readonly frameListeners = new Set<Listener<TauTerminalFrameStats>>()
  private readonly parseListeners = new Set<Listener<number>>()
  private readonly pendingWrites = new Map<number, (() => void) | undefined>()
  private readonly pendingMouse = new Map<number, (text: string) => void>()
  private readonly pendingLinks = new Map<number, (href: string | null) => void>()
  private readonly rowText: string[] = []
  private nextId = 1
  /** Writes the worker has parsed (diagnostics; frames report the count they include). */
  appliedWriteCount = 0
  /** The worker's WASM memory size as of its latest frame (diagnostics). */
  wasmBytes = 0
  private resetWaiter: (() => void) | null = null
  private metrics: Metrics = { cellWidth: 8, cellHeight: 18, baseline: 14, fontSize: 14, fonts: [] }
  private fontFamily = '"SF Mono", Menlo, Monaco, "JetBrains Mono", monospace'
  private selection = ''
  private disposed = false
  private composing = false
  private anchor: Point | null = null
  private selectionEnd: Point | null = null
  private hasSelection = false
  private drag = false
  private mouseReporting = false
  private searchQuery = ''
  private lastSearch = { resultIndex: -1, resultCount: 0 }
  cols: number
  rows: number

  static async create(): Promise<TauTerminal> {
    return new TauTerminal(await loadWasm(), 80, 24)
  }

  private constructor(
    private readonly module: WebAssembly.Module,
    cols: number,
    rows: number,
  ) {
    this.cols = cols
    this.rows = rows
    this.worker = new Worker(new URL('tau-terminal-worker.js', window.location.href))
    this.worker.onmessage = (event: MessageEvent<Outgoing>) => this.receive(event.data)
  }

  private receive(message: Outgoing): void {
    switch (message.t) {
      case 'applied': {
        const callback = this.pendingWrites.get(message.id)
        this.pendingWrites.delete(message.id)
        this.appliedWriteCount++
        for (const listener of this.parseListeners) listener(message.parseMs)
        callback?.()
        return
      }
      case 'failed':
        this.pendingWrites.delete(message.id)
        console.error('[terminal] Ghostty VT write failed in worker:', message.message)
        return
      case 'frame':
        this.applyFrame(message)
        return
      case 'title':
        for (const listener of this.titleListeners) listener(message.title)
        return
      case 'binary':
        for (const listener of this.binaryListeners) listener(message.data)
        return
      case 'data':
        this.emit(message.text)
        return
      case 'selectedText':
        this.selection = message.text
        return
      case 'searchResult':
        this.lastSearch = { resultIndex: message.resultIndex, resultCount: message.resultCount }
        for (const listener of this.searchListeners) listener(this.lastSearch)
        return
      case 'pasteEncoded':
        if (
          !message.bracketed &&
          /[\r\n]/u.test(message.text) &&
          !window.confirm('Paste multiple lines into the shell? They may execute commands.')
        )
          return
        this.emit(message.text)
        return
      case 'mouseEncoded':
        this.pendingMouse.get(message.id)?.(message.text)
        this.pendingMouse.delete(message.id)
        return
      case 'linkResolved':
        this.pendingLinks.get(message.id)?.(message.href)
        this.pendingLinks.delete(message.id)
        return
      case 'resetDone':
        this.resetWaiter?.()
        this.resetWaiter = null
        return
      case 'error':
        console.error('[terminal] worker error:', message.message)
        return
      case 'ready':
        return
    }
  }

  private applyFrame(message: FrameMessage): void {
    this.wasmBytes = message.wasmBytes
    if (message.changed.length > 0 && this.screenReader) {
      for (const [row, text] of message.changed) this.rowText[row] = text
      for (let row = 0; row < message.rows; row++) this.rowText[row] ??= ''
      this.rowText.length = message.rows
      this.screenReader.textContent = this.rowText.join('\n')
    }
    const stats = {
      at: message.at - performance.timeOrigin,
      drawMs: message.drawMs,
      renderMs: message.renderMs,
      appliedWrites: message.appliedWrites,
    }
    for (const listener of this.frameListeners) listener(stats)
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
    this.measureFont()
    const offscreen = canvas.transferControlToOffscreen()
    this.worker.postMessage(
      {
        t: 'init',
        canvas: offscreen,
        module: this.module,
        cols: this.cols,
        rows: this.rows,
        metrics: this.metrics,
      },
      [offscreen],
    )
    this.resizeObserver = new ResizeObserver(() => this.postSize())
    this.resizeObserver.observe(canvas)
    this.postSize()

    canvas.addEventListener('pointerdown', this.pointerDown)
    canvas.addEventListener('mousedown', this.mouseDown)
    canvas.addEventListener('pointermove', this.pointerMove)
    canvas.addEventListener('pointerup', this.pointerUp)
    canvas.addEventListener('pointercancel', this.pointerUp)
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

  private postSize(): void {
    if (!this.canvas || this.disposed) return
    this.worker.postMessage({
      t: 'size',
      width: this.canvas.clientWidth,
      height: this.canvas.clientHeight,
      dpr: window.devicePixelRatio || 1,
    })
  }

  private measureFont(): void {
    const css = getComputedStyle(document.documentElement)
    const size = Number.parseInt(css.getPropertyValue('--terminal-font-size'), 10)
    const fontSize = Number.isFinite(size) && size >= 10 && size <= 28 ? size : 14
    this.fontFamily =
      css.getPropertyValue('--terminal-font-family').trim() ||
      '"SF Mono", Menlo, Monaco, "JetBrains Mono", monospace'
    const ctx = document.createElement('canvas').getContext('2d')!
    ctx.font = `${fontSize}px ${this.fontFamily}`
    const measurement = ctx.measureText('M')
    const cellWidth = Math.max(1, measurement.width)
    const cellHeight = Math.ceil(
      Math.max(
        fontSize + 4,
        measurement.actualBoundingBoxAscent + measurement.actualBoundingBoxDescent + 3,
      ),
    )
    this.metrics = {
      cellWidth,
      cellHeight,
      baseline: Math.round((cellHeight - fontSize) / 2 + fontSize - 2),
      fontSize,
      fonts: FONT_VARIANTS.map((variant) => `${variant}${fontSize}px ${this.fontFamily}`),
    }
  }

  private appearanceChanged = () => {
    if (!this.canvas || this.disposed) return
    this.measureFont()
    const light = document.documentElement.dataset.theme === 'light'
    this.worker.postMessage({ t: 'metrics', metrics: this.metrics, light })
    this.rowText.length = 0
    const size = this.proposeDimensions()
    if (size) this.resize(size.cols, size.rows)
  }

  proposeDimensions(): { cols: number; rows: number } | null {
    if (!this.wrapper || this.wrapper.clientWidth <= 0 || this.wrapper.clientHeight <= 0)
      return null
    return {
      cols: Math.max(2, Math.floor(this.wrapper.clientWidth / this.metrics.cellWidth)),
      rows: Math.max(1, Math.floor(this.wrapper.clientHeight / this.metrics.cellHeight)),
    }
  }

  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return
    this.cols = cols
    this.rows = rows
    this.rowText.length = 0
    this.worker.postMessage({ t: 'resize', cols, rows })
    for (const listener of this.resizeListeners) listener({ cols, rows })
  }

  async resetCore(): Promise<void> {
    if (this.disposed) return
    await new Promise<void>((resolve) => {
      this.resetWaiter = resolve
      this.worker.postMessage({ t: 'reset' })
    })
    this.searchQuery = ''
    this.anchor = null
    this.selectionEnd = null
    this.hasSelection = false
    this.selection = ''
  }

  write(data: string | Uint8Array, callback?: () => void): void {
    if (this.disposed) return
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
    // The writer hands over exact-sized owned buffers; transfer those, copy anything else.
    const owned =
      bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? (bytes.buffer as ArrayBuffer)
        : bytes.slice().buffer
    const id = this.nextId++
    this.pendingWrites.set(id, callback)
    this.worker.postMessage({ t: 'write', id, data: owned }, [owned])
  }

  refresh(_start?: number, _end?: number): void {
    if (!this.disposed) this.worker.postMessage({ t: 'refresh' })
  }

  private point(event: PointerEvent | MouseEvent): Point {
    const bounds = this.canvas!.getBoundingClientRect()
    return {
      x: Math.max(
        0,
        Math.min(this.cols - 1, Math.floor((event.clientX - bounds.left) / this.metrics.cellWidth)),
      ),
      y: Math.max(
        0,
        Math.min(this.rows - 1, Math.floor((event.clientY - bounds.top) / this.metrics.cellHeight)),
      ),
    }
  }

  private select(start: Point | null, end?: Point | null): void {
    if (start && end) this.hasSelection = true
    else if (this.hasSelection) this.hasSelection = false
    else return
    if (!this.hasSelection) this.selection = ''
    this.worker.postMessage({ t: 'selection', start, end })
  }

  private encodeMouse(
    action: 'press' | 'release' | 'motion',
    button: number | null,
    event: MouseEvent,
  ): Promise<string> {
    const bounds = this.canvas!.getBoundingClientRect()
    const id = this.nextId++
    const mods =
      (event.shiftKey ? 1 : 0) |
      (event.ctrlKey ? 2 : 0) |
      (event.altKey ? 4 : 0) |
      (event.metaKey ? 8 : 0)
    return new Promise((resolve) => {
      this.pendingMouse.set(id, resolve)
      this.worker.postMessage({
        t: 'mouse',
        id,
        action,
        button,
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
        mods,
      })
    })
  }

  private readonly pointerDown = (event: PointerEvent): void => {
    this.focus()
    if (event.button === 0 && (event.ctrlKey || event.metaKey)) {
      const point = this.point(event)
      const id = this.nextId++
      this.pendingLinks.set(id, (href) => {
        if (!href) return
        try {
          const url = new URL(href)
          if (url.protocol === 'https:' || url.protocol === 'http:')
            void window.electronAPI.openExternalUrl(url.href).catch(console.warn)
        } catch {
          // Not a URL.
        }
      })
      this.worker.postMessage({ t: 'link', id, x: point.x, y: point.y })
      event.preventDefault()
      return
    }
    const button = [1, 3, 2][event.button] ?? 0
    if (!event.shiftKey && button !== 0) {
      void this.encodeMouse('press', button, event).then((text) => {
        if (!text) return
        this.mouseReporting = true
        this.emit(text)
      })
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
    event.preventDefault()
    this.focus()
  }

  private readonly pointerMove = (event: PointerEvent): void => {
    if (this.mouseReporting || !this.drag) {
      const button = (event.buttons & 1) !== 0 ? 1 : (event.buttons & 2) !== 0 ? 2 : null
      void this.encodeMouse('motion', this.mouseReporting ? button : null, event).then((text) =>
        this.emit(text),
      )
      return
    }
    this.selectionEnd = this.point(event)
    this.select(this.anchor, this.selectionEnd)
  }

  private readonly pointerUp = (event: PointerEvent): void => {
    if (this.mouseReporting) {
      void this.encodeMouse('release', [1, 3, 2][event.button] ?? null, event).then((text) =>
        this.emit(text),
      )
      this.mouseReporting = false
    }
    this.drag = false
    if (this.canvas?.hasPointerCapture(event.pointerId))
      this.canvas.releasePointerCapture(event.pointerId)
  }

  private readonly wheel = (event: WheelEvent): void => {
    event.preventDefault()
    this.worker.postMessage({
      t: 'scroll',
      delta: Math.round(event.deltaY / this.metrics.cellHeight) || Math.sign(event.deltaY),
    })
  }

  private emit(data: string): void {
    if (!data) return
    for (const listener of this.dataListeners) listener(data)
  }

  private readonly keyDown = (event: KeyboardEvent): void => {
    if (event.isComposing || this.composing) return
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && this.selection) {
      event.preventDefault()
      void window.electronAPI.writeClipboardText(this.selection)
      return
    }
    if (MODIFIER_KEYS.has(event.key)) return
    // Encoding depends on VT modes owned by the worker; the result arrives as a `data` message.
    event.preventDefault()
    this.anchor = null
    this.selectionEnd = null
    this.select(null)
    this.worker.postMessage({
      t: 'key',
      event: {
        code: event.code,
        key: event.key,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        repeat: event.repeat,
      },
    })
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
    if (text) this.worker.postMessage({ t: 'paste', text: text.replace(/\r\n?/gu, '\n') })
  }

  private readonly copy = (event: ClipboardEvent): void => {
    if (!this.selection) return
    event.preventDefault()
    event.clipboardData?.setData('text/plain', this.selection)
  }

  focus(): void {
    this.worker.postMessage({ t: 'active', value: true })
    this.textarea?.focus({ preventScroll: true })
  }

  blur(): void {
    this.worker.postMessage({ t: 'active', value: false })
    this.textarea?.blur()
  }

  setCursorVisible(visible: boolean): void {
    this.worker.postMessage({ t: 'cursorVisible', value: visible })
  }

  /** Results arrive through onSearchResults; the return value reflects the previous search. */
  search(query: string, direction: 'next' | 'previous', _incremental: boolean): boolean {
    this.searchQuery = query
    this.worker.postMessage({ t: 'search', query, direction })
    return this.lastSearch.resultCount > 0
  }

  clearSearch(): void {
    this.searchQuery = ''
    this.anchor = null
    this.selectionEnd = null
    this.select(null)
    this.worker.postMessage({ t: 'search', query: '', direction: 'next' })
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
  onFrameStats(listener: Listener<TauTerminalFrameStats>): { dispose(): void } {
    return subscribe(this.frameListeners, listener)
  }
  onParseStats(listener: Listener<number>): { dispose(): void } {
    return subscribe(this.parseListeners, listener)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.resizeObserver?.disconnect()
    this.canvas?.removeEventListener('pointerdown', this.pointerDown)
    this.canvas?.removeEventListener('mousedown', this.mouseDown)
    this.canvas?.removeEventListener('pointermove', this.pointerMove)
    this.canvas?.removeEventListener('pointerup', this.pointerUp)
    this.canvas?.removeEventListener('pointercancel', this.pointerUp)
    this.canvas?.removeEventListener('wheel', this.wheel)
    this.textarea?.removeEventListener('keydown', this.keyDown)
    this.textarea?.removeEventListener('beforeinput', this.beforeInput)
    this.textarea?.removeEventListener('compositionstart', this.compositionStart)
    this.textarea?.removeEventListener('compositionend', this.compositionEnd)
    this.textarea?.removeEventListener('paste', this.paste)
    this.textarea?.removeEventListener('copy', this.copy)
    window.removeEventListener('tau:appearance', this.appearanceChanged)
    this.worker.postMessage({ t: 'dispose' })
    this.worker.onmessage = null
    this.pendingWrites.clear()
    this.pendingMouse.clear()
    this.pendingLinks.clear()
    this.wrapper?.replaceChildren()
    // A retained facade must not pin the placeholder canvas and its last committed frame.
    this.canvas = null
    this.textarea = null
    this.screenReader = null
    this.wrapper = null
    this.resizeObserver = null
    this.dataListeners.clear()
    this.binaryListeners.clear()
    this.resizeListeners.clear()
    this.titleListeners.clear()
    this.searchListeners.clear()
    this.frameListeners.clear()
    this.parseListeners.clear()
  }
}

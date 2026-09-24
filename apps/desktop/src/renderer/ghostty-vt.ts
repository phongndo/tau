/* Direct libghostty-vt C/WASM ABI. No ghostty-web terminal wrapper. */

type Fn = (...args: number[]) => number
type Api = Record<string, Fn> & { memory: WebAssembly.Memory }
type Layout = {
  size: number
  fields: Record<string, { offset: number; size: number }>
  values?: Record<string, number>
}
type Manifest = {
  abi: { pointer_size: number; endian: string }
  types: Record<string, Layout & { bits?: Record<string, { lsb: number; width: number }> }>
}

export type GhosttyCell = {
  text: string
  fg: string
  bg: string
  bold: boolean
  italic: boolean
  faint: boolean
  underline: boolean
  strikethrough: boolean
  inverse: boolean
  selected: boolean
  wide: number
}
export type GhosttyRow = { y: number; cells: GhosttyCell[] }
export type GhosttyImage = {
  id: number
  generation: bigint
  width: number
  height: number
  rgba: Uint8ClampedArray
  x: number
  y: number
  offsetX: number
  offsetY: number
  pixelWidth: number
  pixelHeight: number
  sourceX: number
  sourceY: number
  sourceWidth: number
  sourceHeight: number
  z: number
}
export type GhosttyFrame = {
  dirty: number
  rows: GhosttyRow[]
  images: GhosttyImage[]
  cursor: { x: number; y: number; visible: boolean; style: number }
  background: string
  foreground: string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export class GhosttyVt {
  readonly api: Api
  readonly layout: Manifest
  readonly slot: number
  readonly scratch: number
  readonly terminal: number
  readonly renderState: number
  readonly rowIterator: number
  readonly cells: number
  readonly keyEvent: number
  readonly keyEncoder: number
  readonly searchHandle: number
  readonly mouseEvent: number
  readonly mouseEncoder: number
  readonly imageIterator: number
  private readonly imageCache = new Map<string, Pick<GhosttyImage, 'rgba' | 'width' | 'height'>>()
  cols: number
  rows: number
  private cellWidth = 8
  private cellHeight = 16
  private disposed = false
  private readonly effectBridges: WebAssembly.Instance[] = []
  private clipboardListener: ((text: string) => boolean) | null = null

  static async create(bytes: BufferSource, cols = 80, rows = 24): Promise<GhosttyVt> {
    const { instance } = await WebAssembly.instantiate(bytes)
    return new GhosttyVt(instance.exports as unknown as Api, cols, rows)
  }

  constructor(api: Api, cols: number, rows: number) {
    this.api = api
    const ptr = api.ghostty_type_json()
    const source = new Uint8Array(api.memory.buffer)
    let end = ptr
    while (end < source.length && source[end] !== 0) end++
    this.layout = JSON.parse(decoder.decode(source.subarray(ptr, end))) as Manifest
    if (this.layout.abi.pointer_size !== 4 || this.layout.abi.endian !== 'little') {
      throw new Error('Unsupported Ghostty WASM ABI')
    }
    this.cols = cols
    this.rows = rows
    this.slot = api.ghostty_wasm_alloc_opaque()
    this.scratch = api.ghostty_wasm_alloc(4096)
    if (!this.slot || !this.scratch) throw new Error('Ghostty WASM memory exhausted')
    let terminal = 0
    let renderState = 0
    let rowIterator = 0
    let cells = 0
    let keyEvent = 0
    let keyEncoder = 0
    let searchHandle = 0
    let mouseEvent = 0
    let mouseEncoder = 0
    let imageIterator = 0
    try {
      this.check(api.ghostty_terminal_new(0, this.slot, cols, rows), 'terminal init')
      terminal = api.ghostty_wasm_take_opaque(this.slot)
      this.check(api.ghostty_render_state_new(0, this.slot), 'render state init')
      renderState = api.ghostty_wasm_take_opaque(this.slot)
      this.check(api.ghostty_render_state_row_iterator_new(0, this.slot), 'row iterator init')
      rowIterator = api.ghostty_wasm_take_opaque(this.slot)
      this.check(api.ghostty_render_state_row_cells_new(0, this.slot), 'cell iterator init')
      cells = api.ghostty_wasm_take_opaque(this.slot)
      this.check(api.ghostty_key_event_new(0, this.slot), 'key event init')
      keyEvent = api.ghostty_wasm_take_opaque(this.slot)
      this.check(api.ghostty_key_encoder_new(0, this.slot), 'key encoder init')
      keyEncoder = api.ghostty_wasm_take_opaque(this.slot)
      this.check(api.ghostty_search_new(0, this.slot, terminal), 'search init')
      searchHandle = api.ghostty_wasm_take_opaque(this.slot)
      this.check(api.ghostty_mouse_event_new(0, this.slot), 'mouse event init')
      mouseEvent = api.ghostty_wasm_take_opaque(this.slot)
      this.check(api.ghostty_mouse_encoder_new(0, this.slot), 'mouse encoder init')
      mouseEncoder = api.ghostty_wasm_take_opaque(this.slot)
      this.check(
        api.ghostty_kitty_graphics_placement_iterator_new(0, this.slot),
        'image iterator init',
      )
      imageIterator = api.ghostty_wasm_take_opaque(this.slot)
      this.imageIterator = imageIterator
      this.mouseEvent = mouseEvent
      this.mouseEncoder = mouseEncoder
      this.searchHandle = searchHandle
      this.keyEvent = keyEvent
      this.keyEncoder = keyEncoder
      this.terminal = terminal
      this.renderState = renderState
      this.rowIterator = rowIterator
      this.cells = cells
      // Tau controls scrollback independently of daemon's screen-only snapshot.
      const view = this.view()
      view.setUint32(this.scratch, 10000, true)
      this.check(api.ghostty_terminal_set(terminal, 28, this.scratch), 'scrollback limit')
      new Uint8Array(api.memory.buffer).set([0x15, 0x15, 0x15], this.scratch)
      this.check(api.ghostty_terminal_set(terminal, 12, this.scratch), 'background color')
      new Uint8Array(api.memory.buffer).set([0xd4, 0xd4, 0xd4], this.scratch)
      this.check(api.ghostty_terminal_set(terminal, 11, this.scratch), 'foreground color')
      // Only inline Kitty image transmissions are allowed. No file/shared-memory media or
      // host file access exists in this browser build. Cap per-terminal image storage at 16 MiB.
      this.view().setBigUint64(this.scratch, 16n * 1024n * 1024n, true)
      this.check(api.ghostty_terminal_set(terminal, 15, this.scratch), 'image storage limit')
    } catch (error) {
      if (imageIterator) api.ghostty_kitty_graphics_placement_iterator_free(imageIterator)
      if (mouseEncoder) api.ghostty_mouse_encoder_free(mouseEncoder)
      if (mouseEvent) api.ghostty_mouse_event_free(mouseEvent)
      if (searchHandle) api.ghostty_search_free(searchHandle)
      if (keyEncoder) api.ghostty_key_encoder_free(keyEncoder)
      if (keyEvent) api.ghostty_key_event_free(keyEvent)
      if (cells) api.ghostty_render_state_row_cells_free(cells)
      if (rowIterator) api.ghostty_render_state_row_iterator_free(rowIterator)
      if (renderState) api.ghostty_render_state_free(renderState)
      if (terminal) api.ghostty_terminal_free(terminal)
      api.ghostty_wasm_free(this.scratch, 4096)
      api.ghostty_wasm_free_opaque(this.slot)
      throw error
    }
  }

  private view(): DataView {
    return new DataView(this.api.memory.buffer)
  }

  private check(result: number, operation: string): void {
    if (result !== 0) throw new Error(`Ghostty ${operation} failed (${result})`)
  }

  private readRgb(ptr: number): string {
    const data = new Uint8Array(this.api.memory.buffer, ptr, 3)
    return `#${[...data].map((component) => component.toString(16).padStart(2, '0')).join('')}`
  }

  write(bytes: string | Uint8Array): void {
    if (this.disposed) throw new Error('Ghostty terminal is disposed')
    const data = typeof bytes === 'string' ? encoder.encode(bytes) : bytes
    if (data.length === 0) return
    const ptr = this.api.ghostty_wasm_alloc(data.length)
    if (!ptr) throw new Error('Ghostty VT input allocation failed')
    try {
      new Uint8Array(this.api.memory.buffer).set(data, ptr)
      // Upstream consumes untrusted VT synchronously and never reports malformed input as failure.
      this.api.ghostty_terminal_vt_write(this.terminal, ptr, data.length)
      this.check(this.api.ghostty_terminal_get(this.terminal, 33, this.scratch), 'VT status')
      if (this.view().getUint8(this.scratch) !== 0) {
        throw new Error('Ghostty VT processing failed; the screen requires resynchronization')
      }
    } finally {
      this.api.ghostty_wasm_free(ptr, data.length)
    }
  }

  encodeKey(
    event: Pick<
      KeyboardEvent,
      'code' | 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey' | 'repeat'
    >,
  ): Uint8Array {
    if (this.disposed) return new Uint8Array()
    const keyName = event.code
      .replace(/^Key(?=[A-Z]$)/u, '')
      .replace(/^Digit(?=\d$)/u, 'DIGIT_')
      .replace(/^Arrow/u, 'ARROW_')
      .replace(/^Numpad/u, 'NUMPAD_')
      .replace(/^Intl/u, 'INTL_')
      .replace(/^Page/u, 'PAGE_')
      .replace(/^Bracket/u, 'BRACKET_')
      .replace(/^Control/u, 'CONTROL_')
      .replace(/^Shift/u, 'SHIFT_')
      .replace(/^Alt/u, 'ALT_')
      .replace(/^Meta/u, 'META_')
      .replace(/([a-z])([A-Z])/gu, '$1_$2')
      .toUpperCase()
    const key = this.layout.types.GhosttyKey.values?.[keyName] ?? 0
    const text =
      event.key.length === 1 && event.key.codePointAt(0)! >= 32 ? encoder.encode(event.key) : null
    if (key === 0 && !text) return new Uint8Array()
    let mods = 0
    if (event.shiftKey) mods |= 1
    if (event.ctrlKey) mods |= 2
    if (event.altKey) mods |= 4
    if (event.metaKey) mods |= 8
    const api = this.api
    api.ghostty_key_event_set_key(this.keyEvent, key)
    // The Kitty encoder needs the *unshifted* physical key even when UTF-8 text is supplied.
    // Without it, report-all mode silently falls back to plain text for printable keys.
    const letter = /^Key([A-Z])$/u.exec(event.code)?.[1]
    const digit = /^Digit([0-9])$/u.exec(event.code)?.[1]
    const unshifted = letter?.toLowerCase() ?? digit ?? (text && !event.shiftKey ? event.key : '')
    api.ghostty_key_event_set_unshifted_codepoint(
      this.keyEvent,
      unshifted.length === 1 ? unshifted.codePointAt(0)! : 0,
    )
    api.ghostty_key_event_set_mods(this.keyEvent, mods)
    api.ghostty_key_event_set_action(this.keyEvent, event.repeat ? 2 : 1)
    api.ghostty_key_encoder_setopt_from_terminal(this.keyEncoder, this.terminal)
    if (text) {
      const ptr = api.ghostty_wasm_alloc(text.length)
      if (!ptr) throw new Error('Ghostty key allocation failed')
      try {
        new Uint8Array(api.memory.buffer).set(text, ptr)
        api.ghostty_key_event_set_utf8(this.keyEvent, ptr, text.length)
        return this.encodeKeyEvent()
      } finally {
        api.ghostty_key_event_set_utf8(this.keyEvent, 0, 0)
        api.ghostty_wasm_free(ptr, text.length)
      }
    }
    api.ghostty_key_event_set_utf8(this.keyEvent, 0, 0)
    return this.encodeKeyEvent()
  }

  private encodeKeyEvent(): Uint8Array {
    const buf = this.scratch
    const len = this.scratch + 2048
    this.check(
      this.api.ghostty_key_encoder_encode(this.keyEncoder, this.keyEvent, buf, 2048, len),
      'key encode',
    )
    const size = this.view().getUint32(len, true)
    return Uint8Array.from(new Uint8Array(this.api.memory.buffer, buf, size))
  }

  /** A tiny import-only WASM module turns a host callback into a funcref in Ghostty's exported
   * table. Upstream's C ABI and binary remain untouched; the sandbox imports no host functions. */
  private setEffect(
    option: number,
    arity: number,
    callback: (...args: number[]) => number | void,
    returnsBool = false,
  ): void {
    const name = Array.from(encoder.encode('callback'))
    const imported = Array.from(encoder.encode('host'))
    const section = (id: number, bytes: number[]) => [id, bytes.length, ...bytes]
    const bridgeBytes = Uint8Array.from([
      0,
      97,
      115,
      109,
      1,
      0,
      0,
      0,
      ...section(1, [
        1,
        0x60,
        arity,
        ...Array(arity).fill(0x7f),
        returnsBool ? 1 : 0,
        ...(returnsBool ? [0x7f] : []),
      ]),
      ...section(2, [1, imported.length, ...imported, name.length, ...name, 0, 0]),
      ...section(7, [1, name.length, ...name, 0, 0]),
    ])
    const bridge = new WebAssembly.Instance(new WebAssembly.Module(bridgeBytes), {
      host: { callback },
    })
    const table = this.api.__indirect_function_table as unknown as WebAssembly.Table
    const index = table.grow(1)
    table.set(index, bridge.exports.callback)
    this.effectBridges.push(bridge)
    this.check(this.api.ghostty_terminal_set(this.terminal, option, index), `effect ${option}`)
  }

  onClipboardWrite(listener: (text: string) => boolean): void {
    this.clipboardListener = listener
    this.setEffect(26, 3, (_terminal, _userdata, request) => this.handleClipboardWrite(request))
  }

  onTitleChange(listener: (title: string) => void): void {
    this.setEffect(5, 2, () => {
      const string = this.layout.types.GhosttyString
      this.check(this.api.ghostty_terminal_get(this.terminal, 12, this.scratch), 'title')
      const ptr = this.view().getUint32(this.scratch + string.fields.ptr.offset, true)
      const len = this.view().getUint32(this.scratch + string.fields.len.offset, true)
      if (len <= 4096) listener(decoder.decode(new Uint8Array(this.api.memory.buffer, ptr, len)))
    })
  }

  onPtyResponse(listener: (data: Uint8Array) => void): void {
    this.setEffect(1, 4, (_terminal, _userdata, ptr, len) => {
      if (len > 0 && len <= 64 * 1024)
        listener(Uint8Array.from(new Uint8Array(this.api.memory.buffer, ptr, len)))
    })
  }

  onRenderHold(listener: (held: boolean) => void): void {
    this.setEffect(41, 3, (_terminal, _userdata, held) => listener(held !== 0))
  }

  onSizeReport(): void {
    this.setEffect(
      6,
      3,
      (_terminal, _userdata, ptr) => {
        const size = this.layout.types.GhosttySizeReportSize
        const view = this.view()
        view.setUint16(ptr + size.fields.rows.offset, this.rows, true)
        view.setUint16(ptr + size.fields.columns.offset, this.cols, true)
        view.setUint32(ptr + size.fields.cell_width.offset, this.cellWidth, true)
        view.setUint32(ptr + size.fields.cell_height.offset, this.cellHeight, true)
        return 1
      },
      true,
    )
    this.setEffect(
      7,
      3,
      (_terminal, _userdata, ptr) => {
        this.view().setUint32(ptr, 1, true) // GHOSTTY_COLOR_SCHEME_DARK
        return 1
      },
      true,
    )
  }

  private handleClipboardWrite(request: number): void {
    const info = this.layout.types.GhosttyClipboardWrite
    const reply = this.layout.types.GhosttyClipboardWriteReply
    const contents = this.layout.types.GhosttyClipboardContent
    const string = this.layout.types.GhosttyString
    const view = this.view()
    let accepted = false
    try {
      const destination = view.getUint32(request + info.fields.location.offset, true)
      const count = view.getUint32(request + info.fields.contents_len.offset, true)
      const ptr = view.getUint32(request + info.fields.contents.offset, true)
      // Electron's privileged boundary writes only one plain-text representation atomically.
      if (destination === 0 && count <= 1 && this.clipboardListener) {
        if (count === 0) accepted = this.clipboardListener('')
        for (let i = 0; i < count; i++) {
          const item = ptr + i * contents.size
          const mimePtr = view.getUint32(
            item + contents.fields.mime.offset + string.fields.ptr.offset,
            true,
          )
          const mimeLen = view.getUint32(
            item + contents.fields.mime.offset + string.fields.len.offset,
            true,
          )
          if (mimeLen > 64) continue
          const mime = decoder.decode(new Uint8Array(this.api.memory.buffer, mimePtr, mimeLen))
          if (mime !== 'text/plain' && mime !== 'text/plain;charset=utf-8') continue
          const dataPtr = view.getUint32(
            item + contents.fields.data.offset + string.fields.ptr.offset,
            true,
          )
          const dataLen = view.getUint32(
            item + contents.fields.data.offset + string.fields.len.offset,
            true,
          )
          if (dataLen > 16 * 1024 * 1024) continue
          const text = decoder.decode(new Uint8Array(this.api.memory.buffer, dataPtr, dataLen))
          accepted = this.clipboardListener(text)
          break
        }
      }
    } catch (error) {
      console.warn('[terminal] rejected invalid Ghostty clipboard request:', error)
    } finally {
      const resultPtr = this.scratch + 512
      this.view().setUint32(resultPtr + reply.fields.size.offset, reply.size, true)
      this.view().setUint32(resultPtr + reply.fields.result.offset, accepted ? 0 : 1, true)
      this.view().setUint8(resultPtr + reply.fields.remember.offset, 0)
      const index = this.view().getUint32(request + info.fields.reply.offset, true)
      const table = this.api.__indirect_function_table as unknown as WebAssembly.Table
      const callback = table.get(index) as ((write: number, result: number) => void) | null
      callback?.(request, resultPtr)
    }
  }

  encodePaste(text: string): { bytes: Uint8Array; bracketed: boolean } {
    const source = encoder.encode(text)
    if (source.length === 0) return { bytes: new Uint8Array(), bracketed: false }
    if (source.length > 16 * 1024 * 1024) throw new Error('Paste exceeds the terminal limit')
    const mode = this.layout.types.GhosttyTerminalModeConfig
    this.view().setUint16(this.scratch + mode.fields.mode.offset, 2004, true)
    this.check(
      this.api.ghostty_terminal_get(this.terminal, 37, this.scratch),
      'bracketed paste mode',
    )
    const bracketed = this.view().getUint8(this.scratch + mode.fields.value.offset) !== 0
    const input = this.api.ghostty_wasm_alloc(source.length)
    const output = this.api.ghostty_wasm_alloc(source.length + 16)
    if (!input || !output) {
      if (input) this.api.ghostty_wasm_free(input, source.length)
      if (output) this.api.ghostty_wasm_free(output, source.length + 16)
      throw new Error('Ghostty paste allocation failed')
    }
    try {
      new Uint8Array(this.api.memory.buffer).set(source, input)
      this.check(
        this.api.ghostty_paste_encode(
          input,
          source.length,
          Number(bracketed),
          output,
          source.length + 16,
          this.scratch + 16,
        ),
        'paste encode',
      )
      const len = this.view().getUint32(this.scratch + 16, true)
      return {
        bytes: Uint8Array.from(new Uint8Array(this.api.memory.buffer, output, len)),
        bracketed,
      }
    } finally {
      this.api.ghostty_wasm_free(input, source.length)
      this.api.ghostty_wasm_free(output, source.length + 16)
    }
  }

  encodeMouse(
    action: 'press' | 'release' | 'motion',
    button: number | null,
    x: number,
    y: number,
    cellWidth: number,
    cellHeight: number,
    mods = 0,
  ): Uint8Array {
    const api = this.api
    const geom = this.layout.types.GhosttyMouseEncoderSize
    this.view().setUint32(this.scratch, geom.size, true)
    for (const [name, value] of [
      ['screen_width', this.cols * cellWidth],
      ['screen_height', this.rows * cellHeight],
      ['cell_width', cellWidth],
      ['cell_height', cellHeight],
      ['padding_top', 0],
      ['padding_bottom', 0],
      ['padding_right', 0],
      ['padding_left', 0],
    ] as const)
      this.view().setUint32(this.scratch + geom.fields[name].offset, Math.round(value), true)
    api.ghostty_mouse_encoder_setopt_from_terminal(this.mouseEncoder, this.terminal)
    api.ghostty_mouse_encoder_setopt(this.mouseEncoder, 2, this.scratch)
    api.ghostty_mouse_event_set_action(
      this.mouseEvent,
      action === 'press' ? 0 : action === 'release' ? 1 : 2,
    )
    if (button !== null) api.ghostty_mouse_event_set_button(this.mouseEvent, button)
    else api.ghostty_mouse_event_clear_button(this.mouseEvent)
    api.ghostty_mouse_event_set_mods(this.mouseEvent, mods)
    this.view().setFloat32(this.scratch, x, true)
    this.view().setFloat32(this.scratch + 4, y, true)
    api.ghostty_mouse_event_set_position(this.mouseEvent, this.scratch)
    this.check(
      api.ghostty_mouse_encoder_encode(
        this.mouseEncoder,
        this.mouseEvent,
        this.scratch + 128,
        512,
        this.scratch + 640,
      ),
      'mouse encode',
    )
    const length = this.view().getUint32(this.scratch + 640, true)
    return Uint8Array.from(new Uint8Array(api.memory.buffer, this.scratch + 128, length))
  }

  search(
    query: string,
    direction: 'next' | 'previous' = 'next',
  ): { resultIndex: number; resultCount: number } {
    const data = encoder.encode(query)
    const ptr = data.length ? this.api.ghostty_wasm_alloc(data.length) : 0
    if (data.length && !ptr) throw new Error('Ghostty search allocation failed')
    try {
      if (ptr) new Uint8Array(this.api.memory.buffer).set(data, ptr)
      this.view().setUint32(this.scratch, ptr, true)
      this.view().setUint32(this.scratch + 4, data.length, true)
      this.check(
        this.api.ghostty_search_set(this.searchHandle, 0, data.length ? this.scratch : 0),
        'search needle',
      )
      if (!data.length) return { resultIndex: -1, resultCount: 0 }
      this.check(this.api.ghostty_search_run(this.searchHandle), 'search run')
      const selected = this.api.ghostty_search_set(
        this.searchHandle,
        direction === 'next' ? 1 : 2,
        0,
      )
      if (selected !== 0 && selected !== -4) this.check(selected, 'select search result')
      this.check(this.api.ghostty_search_get(this.searchHandle, 2, this.scratch), 'search count')
      const resultCount = this.view().getUint32(this.scratch, true)
      const indexStatus = this.api.ghostty_search_get(this.searchHandle, 3, this.scratch)
      if (indexStatus !== 0 && indexStatus !== -4) this.check(indexStatus, 'search index')
      const resultIndex = indexStatus === 0 ? this.view().getUint32(this.scratch, true) : -1
      return { resultIndex, resultCount }
    } finally {
      if (ptr) this.api.ghostty_wasm_free(ptr, data.length)
    }
  }

  setSelection(start: { x: number; y: number } | null, end?: { x: number; y: number }): void {
    if (!start || !end) {
      this.check(this.api.ghostty_terminal_set(this.terminal, 21, 0), 'clear selection')
      return
    }
    const ref = this.layout.types.GhosttyGridRef
    const selection = this.layout.types.GhosttySelection
    const point = this.layout.types.GhosttyPoint
    const coordinate = this.layout.types.GhosttyPointCoordinate
    const writeRef = (position: { x: number; y: number }, out: number) => {
      const view = this.view()
      view.setUint32(this.scratch + point.fields.tag.offset, 1, true) // VIEWPORT
      view.setUint16(
        this.scratch + point.fields.value.offset + coordinate.fields.x.offset,
        position.x,
        true,
      )
      view.setUint32(
        this.scratch + point.fields.value.offset + coordinate.fields.y.offset,
        position.y,
        true,
      )
      view.setUint32(out + ref.fields.size.offset, ref.size, true)
      this.check(
        this.api.ghostty_terminal_grid_ref(this.terminal, this.scratch, out),
        'selection grid ref',
      )
    }
    const out = this.scratch + 64
    this.view().setUint32(out + selection.fields.size.offset, selection.size, true)
    writeRef(start, out + selection.fields.start.offset)
    writeRef(end, out + selection.fields.end.offset)
    this.view().setUint8(out + selection.fields.rectangle.offset, 0)
    this.check(this.api.ghostty_terminal_set(this.terminal, 21, out), 'selection')
  }

  /** Resolve an OSC 8 link only at the user-activated cell; grid refs are borrowed until the
   * next VT mutation, so return a copied string rather than exposing WASM memory. */
  linkAt(x: number, y: number): string | null {
    if (x < 0 || x >= this.cols || y < 0 || y >= this.rows) return null
    const ref = this.layout.types.GhosttyGridRef
    const point = this.layout.types.GhosttyPoint
    const coordinate = this.layout.types.GhosttyPointCoordinate
    const out = this.scratch + 64
    const view = this.view()
    view.setUint32(this.scratch + point.fields.tag.offset, 1, true) // VIEWPORT
    view.setUint16(this.scratch + point.fields.value.offset + coordinate.fields.x.offset, x, true)
    view.setUint32(this.scratch + point.fields.value.offset + coordinate.fields.y.offset, y, true)
    view.setUint32(out + ref.fields.size.offset, ref.size, true)
    if (this.api.ghostty_terminal_grid_ref(this.terminal, this.scratch, out) !== 0) return null
    const buffer = this.scratch + 128
    const length = this.scratch + 4092
    if (this.api.ghostty_grid_ref_hyperlink_uri(out, buffer, 2048, length) !== 0) return null
    const size = this.view().getUint32(length, true)
    return size > 0 && size <= 2048
      ? decoder.decode(new Uint8Array(this.api.memory.buffer, buffer, size))
      : null
  }

  selectedText(): string {
    const opts = this.layout.types.GhosttyTerminalSelectionFormatOptions
    const ptr = this.scratch + 128
    const view = this.view()
    view.setUint32(ptr + opts.fields.size.offset, opts.size, true)
    view.setUint32(ptr + opts.fields.emit.offset, 0, true) // PLAIN
    view.setUint8(ptr + opts.fields.unwrap.offset, 1)
    view.setUint8(ptr + opts.fields.trim.offset, 1)
    view.setUint32(ptr + opts.fields.selection.offset, 0, true)
    const status = this.api.ghostty_terminal_selection_format_alloc(
      this.terminal,
      0,
      ptr,
      ptr + 32,
      ptr + 36,
    )
    if (status === -4) return ''
    this.check(status, 'selection copy')
    const data = this.view().getUint32(ptr + 32, true)
    const len = this.view().getUint32(ptr + 36, true)
    if (len > 16 * 1024 * 1024) {
      this.api.ghostty_free(0, data, len)
      throw new Error('Ghostty selection is too large to copy')
    }
    try {
      return decoder.decode(new Uint8Array(this.api.memory.buffer, data, len))
    } finally {
      this.api.ghostty_free(0, data, len)
    }
  }

  scrollRows(delta: number): void {
    const type = this.layout.types.GhosttyTerminalScrollViewport
    const tag = type.fields.tag.offset
    const value = type.fields.value.offset
    const view = this.view()
    view.setUint32(this.scratch + tag, 2, true) // GHOSTTY_SCROLL_VIEWPORT_DELTA
    view.setInt32(this.scratch + value, Math.trunc(delta), true)
    this.api.ghostty_terminal_scroll_viewport(this.terminal, this.scratch)
  }

  resize(cols: number, rows: number, cellWidth = 8, cellHeight = 16): void {
    this.check(
      this.api.ghostty_terminal_resize(this.terminal, cols, rows, cellWidth, cellHeight),
      'resize',
    )
    this.cols = cols
    this.rows = rows
    this.cellWidth = cellWidth
    this.cellHeight = cellHeight
  }

  render(): GhosttyFrame {
    const api = this.api
    this.check(api.ghostty_render_state_update(this.renderState, this.terminal), 'render update')
    this.check(api.ghostty_render_state_get(this.renderState, 3, this.scratch), 'dirty state')
    const dirty = this.view().getUint32(this.scratch, true)
    const colors = this.layout.types.GhosttyRenderStateColors
    this.view().setUint32(this.scratch, colors.size, true)
    this.check(api.ghostty_render_state_get(this.renderState, 19, this.scratch), 'colors')
    const background = this.readRgb(this.scratch + colors.fields.background.offset)
    const foreground = this.readRgb(this.scratch + colors.fields.foreground.offset)
    const cursorType = this.layout.types.GhosttyRenderStateCursor
    this.view().setUint32(this.scratch, cursorType.size, true)
    this.check(api.ghostty_render_state_get(this.renderState, 18, this.scratch), 'cursor')
    const cursor = {
      x: this.view().getUint16(this.scratch + cursorType.fields.viewport_x.offset, true),
      y: this.view().getUint16(this.scratch + cursorType.fields.viewport_y.offset, true),
      visible:
        this.view().getUint8(this.scratch + cursorType.fields.visible.offset) !== 0 &&
        this.view().getUint8(this.scratch + cursorType.fields.viewport_has_value.offset) !== 0,
      style: this.view().getUint32(this.scratch + cursorType.fields.visual_style.offset, true),
    }
    const rows: GhosttyRow[] = []
    if (dirty !== 0) {
      this.view().setUint32(this.slot, this.rowIterator, true)
      this.check(api.ghostty_render_state_get(this.renderState, 4, this.slot), 'rows')
      while (api.ghostty_render_state_row_iterator_next_dirty(this.rowIterator, this.scratch)) {
        const y = this.view().getUint16(this.scratch, true)
        rows.push({ y, cells: this.readRow(background, foreground) })
      }
    }
    const images = this.readImages()
    this.check(api.ghostty_render_state_clean(this.renderState), 'render clean')
    return { dirty, rows, images, cursor, background, foreground }
  }

  private readImages(): GhosttyImage[] {
    const api = this.api
    this.check(api.ghostty_terminal_get(this.terminal, 30, this.scratch), 'image storage')
    const graphics = this.view().getUint32(this.scratch, true)
    this.check(api.ghostty_kitty_graphics_get(graphics, 2, this.scratch), 'image generation')
    if (this.view().getBigUint64(this.scratch, true) === 0n) {
      this.imageCache.clear()
      return []
    }
    this.view().setUint32(this.slot, this.imageIterator, true)
    this.check(api.ghostty_kitty_graphics_get(graphics, 1, this.slot), 'image placements')
    const result: GhosttyImage[] = []
    const keys = new Set<string>()
    const info = this.layout.types.GhosttyKittyGraphicsPlacementRenderInfo
    while (api.ghostty_kitty_graphics_placement_next(this.imageIterator)) {
      this.check(
        api.ghostty_kitty_graphics_placement_get(this.imageIterator, 1, this.scratch),
        'image id',
      )
      const id = this.view().getUint32(this.scratch, true)
      const image = api.ghostty_kitty_graphics_image(graphics, id)
      if (!image) continue
      this.view().setUint32(this.scratch, info.size, true)
      this.check(
        api.ghostty_kitty_graphics_placement_render_info(
          this.imageIterator,
          image,
          this.terminal,
          this.scratch,
        ),
        'image position',
      )
      const field = (name: string) =>
        this.view().getUint32(this.scratch + info.fields[name].offset, true)
      if (!this.view().getUint8(this.scratch + info.fields.viewport_visible.offset)) continue
      const geometry = {
        x: this.view().getInt32(this.scratch + info.fields.viewport_col.offset, true),
        y: this.view().getInt32(this.scratch + info.fields.viewport_row.offset, true),
        pixelWidth: field('pixel_width'),
        pixelHeight: field('pixel_height'),
        sourceX: field('source_x'),
        sourceY: field('source_y'),
        sourceWidth: field('source_width'),
        sourceHeight: field('source_height'),
      }
      this.check(
        api.ghostty_kitty_graphics_placement_get(this.imageIterator, 4, this.scratch),
        'image x offset',
      )
      const offsetX = this.view().getUint32(this.scratch, true)
      this.check(
        api.ghostty_kitty_graphics_placement_get(this.imageIterator, 5, this.scratch),
        'image y offset',
      )
      const offsetY = this.view().getUint32(this.scratch, true)
      this.check(api.ghostty_kitty_graphics_image_get(image, 9, this.scratch), 'image revision')
      const generation = this.view().getBigUint64(this.scratch, true)
      const key = `${id}:${generation}`
      keys.add(key)
      let pixels = this.imageCache.get(key)
      if (!pixels) {
        this.check(api.ghostty_kitty_graphics_image_get(image, 3, this.scratch), 'image width')
        const width = this.view().getUint32(this.scratch, true)
        this.check(api.ghostty_kitty_graphics_image_get(image, 4, this.scratch), 'image height')
        const height = this.view().getUint32(this.scratch, true)
        if (width === 0 || height === 0 || width * height > 4 * 1024 * 1024) continue
        this.check(api.ghostty_kitty_graphics_image_get(image, 5, this.scratch), 'image format')
        const format = this.view().getUint32(this.scratch, true)
        const channels = [3, 4, 0, 2, 1][format]
        if (!channels) continue
        this.check(api.ghostty_kitty_graphics_image_get(image, 8, this.scratch), 'image bytes')
        const len = this.view().getUint32(this.scratch, true)
        if (len !== width * height * channels) continue
        if (api.ghostty_kitty_graphics_image_get(image, 7, this.scratch) !== 0) continue
        const ptr = this.view().getUint32(this.scratch, true)
        const raw = new Uint8Array(api.memory.buffer, ptr, len)
        const rgba = new Uint8ClampedArray(width * height * 4)
        for (let i = 0, j = 0; i < raw.length; i += channels, j += 4) {
          rgba[j] = raw[i]
          rgba[j + 1] = channels <= 2 ? raw[i] : raw[i + 1]
          rgba[j + 2] = channels <= 2 ? raw[i] : raw[i + 2]
          rgba[j + 3] = channels % 2 === 0 ? raw[i + channels - 1] : 255
        }
        pixels = { width, height, rgba }
        this.imageCache.set(key, pixels)
      }
      this.check(
        api.ghostty_kitty_graphics_placement_get(this.imageIterator, 12, this.scratch),
        'image layer',
      )
      result.push({
        id,
        generation,
        ...pixels,
        ...geometry,
        offsetX,
        offsetY,
        z: this.view().getInt32(this.scratch, true),
      })
    }
    for (const key of this.imageCache.keys()) if (!keys.has(key)) this.imageCache.delete(key)
    return result.sort((a, b) => a.z - b.z)
  }

  private readRow(background: string, foreground: string): GhosttyCell[] {
    const api = this.api
    this.check(api.ghostty_render_state_row_get(this.rowIterator, 5, this.scratch), 'row cells')
    const ptr = this.view().getUint32(this.scratch, true)
    const count = this.view().getUint32(this.scratch + 4, true)
    if (count !== this.cols) throw new Error(`Ghostty row width ${count} != ${this.cols}`)
    const bits = this.layout.types.GhosttyCell.bits!
    const selection = this.layout.types.GhosttyRenderStateRowSelection
    this.view().setUint32(this.scratch, selection.size, true)
    const selectionStatus = api.ghostty_render_state_row_get(this.rowIterator, 4, this.scratch)
    if (selectionStatus !== 0 && selectionStatus !== -4)
      this.check(selectionStatus, 'row selection')
    const selectedStart =
      selectionStatus === 0
        ? this.view().getUint16(this.scratch + selection.fields.start_x.offset, true)
        : -1
    const selectedEnd =
      selectionStatus === 0
        ? this.view().getUint16(this.scratch + selection.fields.end_x.offset, true)
        : -1
    const cells: GhosttyCell[] = []
    let iteratorReady = false
    for (let x = 0; x < count; x++) {
      const packed = this.view().getBigUint64(ptr + x * 8, true)
      const field = (name: keyof typeof bits) => {
        const { lsb, width } = bits[name]
        return Number((packed >> BigInt(lsb)) & ((1n << BigInt(width)) - 1n))
      }
      const tag = field('content_tag')
      const styleId = field('style_id')
      const wide = field('wide')
      let text = ''
      if (tag <= 1 && wide !== 2 && wide !== 3) {
        const codepoint = Number((packed >> BigInt(bits.content.lsb)) & 0x1fffffn)
        if (codepoint > 0 && codepoint <= 0x10ffff) text = String.fromCodePoint(codepoint)
      }
      let fg = foreground
      let bg = background
      let bold = false
      let italic = false
      let faint = false
      let underline = false
      let strikethrough = false
      let inverse = false
      if (styleId !== 0 || tag !== 0 || wide !== 0) {
        if (!iteratorReady) {
          this.view().setUint32(this.slot, this.cells, true)
          this.check(
            api.ghostty_render_state_row_get(this.rowIterator, 3, this.slot),
            'cell iterator',
          )
          iteratorReady = true
        }
        this.check(api.ghostty_render_state_row_cells_select(this.cells, x), 'cell select')
        if (tag === 1) {
          this.check(
            api.ghostty_render_state_row_cells_get(this.cells, 3, this.scratch),
            'grapheme length',
          )
          const length = this.view().getUint32(this.scratch, true)
          if (length > 0 && length <= 1024) {
            this.check(
              api.ghostty_render_state_row_cells_get(this.cells, 4, this.scratch),
              'grapheme',
            )
            text = ''
            for (let i = 0; i < length; i++) {
              const cp = this.view().getUint32(this.scratch + i * 4, true)
              if (cp <= 0x10ffff) text += String.fromCodePoint(cp)
            }
          }
        }
        const fgResult = api.ghostty_render_state_row_cells_get(this.cells, 6, this.scratch)
        if (fgResult === 0) fg = this.readRgb(this.scratch)
        else if (fgResult !== -2) this.check(fgResult, 'foreground')
        const bgResult = api.ghostty_render_state_row_cells_get(this.cells, 5, this.scratch)
        if (bgResult === 0) bg = this.readRgb(this.scratch)
        else if (bgResult !== -2) this.check(bgResult, 'background')
        if (styleId !== 0) {
          const style = this.layout.types.GhosttyStyle
          this.view().setUint32(this.scratch, style.size, true)
          this.check(api.ghostty_render_state_row_cells_get(this.cells, 2, this.scratch), 'style')
          const get = (name: string) =>
            this.view().getUint8(this.scratch + style.fields[name].offset) !== 0
          bold = get('bold')
          italic = get('italic')
          faint = get('faint')
          underline =
            this.view().getUint32(this.scratch + style.fields.underline.offset, true) !== 0
          strikethrough = get('strikethrough')
          inverse = get('inverse')
          if (get('invisible')) text = ''
        }
      }
      cells.push({
        text,
        fg,
        bg,
        bold,
        italic,
        faint,
        underline,
        strikethrough,
        inverse,
        selected: x >= selectedStart && x <= selectedEnd,
        wide,
      })
    }
    return cells
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.api.ghostty_kitty_graphics_placement_iterator_free(this.imageIterator)
    this.imageCache.clear()
    this.api.ghostty_mouse_encoder_free(this.mouseEncoder)
    this.api.ghostty_mouse_event_free(this.mouseEvent)
    this.api.ghostty_search_free(this.searchHandle)
    this.api.ghostty_key_encoder_free(this.keyEncoder)
    this.api.ghostty_key_event_free(this.keyEvent)
    this.api.ghostty_render_state_row_cells_free(this.cells)
    this.api.ghostty_render_state_row_iterator_free(this.rowIterator)
    this.api.ghostty_render_state_free(this.renderState)
    this.api.ghostty_terminal_free(this.terminal)
    this.api.ghostty_wasm_free(this.scratch, 4096)
    this.api.ghostty_wasm_free_opaque(this.slot)
  }
}

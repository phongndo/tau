import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { GhosttyVt } from '../src/renderer/ghostty-vt'

const wasmPath = resolve(import.meta.dir, '../public/ghostty-vt.wasm')
const bytes = await Bun.file(wasmPath).arrayBuffer()

async function terminal(cols = 16, rows = 4): Promise<GhosttyVt> {
  return GhosttyVt.create(bytes, cols, rows)
}

test('direct Ghostty WASM preserves split parser state and paints the viewport', async () => {
  const vt = await terminal()
  try {
    vt.write('hello\r\n\x1b[1;3')
    vt.write('1mworld\x1b[0m')
    const frame = vt.render()
    expect(frame.dirty).toBeGreaterThan(0)
    expect(frame.rows[0].cells.map((cell) => cell.text).join('')).toStartWith('hello')
    expect(frame.rows[1].cells.map((cell) => cell.text).join('')).toStartWith('world')
    expect(frame.rows[1].cells[0].bold).toBe(true)
    expect(frame.rows[1].cells[0].fg).not.toBe(frame.foreground)
    expect(vt.render().dirty).toBe(0)
  } finally {
    vt.dispose()
  }
})

test('default terminal colors follow a live appearance change', async () => {
  const vt = await terminal()
  try {
    vt.write('hello')
    vt.render()
    vt.setDefaultColors('#fbfcfe', '#202633', true)
    vt.resize(vt.cols, vt.rows)
    const frame = vt.render()
    expect(frame.background).toBe('#fbfcfe')
    expect(frame.foreground).toBe('#202633')
    expect(frame.rows[0]?.cells[0]?.fg).toBe('#202633')
    vt.write('\x1b[97mX')
    expect(vt.render().rows[0]?.cells[5]?.fg).toBe('#24292f')
    vt.setDefaultColors('#151515', '#d4d4d4')
    vt.resize(vt.cols, vt.rows)
    expect(vt.render().background).toBe('#151515')
  } finally {
    vt.dispose()
  }
})

test('Ghostty keyboard encoder follows cursor mode and controls', async () => {
  const vt = await terminal()
  try {
    const key = (code: string, name: string) => ({
      code,
      key: name,
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      repeat: false,
    })
    expect(decoder.decode(vt.encodeKey(key('ArrowUp', 'ArrowUp')))).toBe('\x1b[A')
    vt.write('\x1b[?1h')
    expect(decoder.decode(vt.encodeKey(key('ArrowUp', 'ArrowUp')))).toBe('\x1bOA')
    expect(decoder.decode(vt.encodeKey(key('KeyA', 'a')))).toBe('a')
    expect([...vt.encodeKey({ ...key('KeyC', 'c'), ctrlKey: true })]).toEqual([3])
    vt.write('\x1b[>10u') // Kitty report-all + key event types
    expect(decoder.decode(vt.encodeKey({ ...key('KeyA', 'a'), repeat: true }))).toBe('\x1b[97;1:2u')
  } finally {
    vt.dispose()
  }
})

const decoder = new TextDecoder()

test('inline Kitty RGBA and PNG are decoded and placed by Ghostty WASM', async () => {
  const vt = await terminal()
  try {
    vt.resize(16, 4, 8, 16)
    vt.write('\x1b_Ga=T,f=32,s=1,v=1,i=1;/wAA/w==\x1b\\')
    let image = vt.render().images[0]
    expect(image.id).toBe(1)
    expect([image.width, image.height, image.x, image.y]).toEqual([1, 1, 0, 0])
    expect([...image.rgba]).toEqual([255, 0, 0, 255])
    // An actual PNG payload, decoded synchronously by upstream's vendored Wuffs.
    vt.write(
      '\x1b_Ga=T,f=100,i=2;iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACXBIWXMAAAsTAAALEwEAmpwYAAAACklEQVQIHWP4DwABAQEANl9ngAAAAABJRU5ErkJggg==\x1b\\',
    )
    image = vt.render().images.find((entry) => entry.id === 2)!
    expect(image.width).toBe(1)
    expect([...image.rgba]).toEqual([255, 255, 255, 255])
  } finally {
    vt.dispose()
  }
})

test('OSC 8 links can be resolved at a viewport cell without trusting rendered text', async () => {
  const vt = await terminal()
  try {
    vt.write('\x1b]8;;https://example.org/safe\x1b\\link\x1b]8;;\x1b\\')
    expect(vt.linkAt(0, 0)).toBe('https://example.org/safe')
    expect(vt.linkAt(3, 0)).toBe('https://example.org/safe')
    expect(vt.linkAt(5, 0)).toBeNull()
  } finally {
    vt.dispose()
  }
})

test('Ghostty title and PTY-query effects cross the direct WASM callback table', async () => {
  const vt = await terminal()
  const titles: string[] = []
  const responses: string[] = []
  try {
    vt.onTitleChange((title) => titles.push(title))
    vt.onPtyResponse((data) => responses.push(decoder.decode(data)))
    vt.write('\x1b]2;Tau direct VT\x07')
    vt.write('\x1b[6n')
    expect(titles).toContain('Tau direct VT')
    expect(responses).toContain('\x1b[1;1R')
  } finally {
    vt.dispose()
  }
})

test('synchronized VT output announces render holds without delaying parse acknowledgements', async () => {
  const vt = await terminal()
  const held: boolean[] = []
  try {
    vt.onRenderHold((value) => held.push(value))
    vt.write('\x1b[?2026habc')
    expect(held).toEqual([true])
    vt.write('def\x1b[?2026l')
    expect(held).toEqual([true, false])
    expect(
      vt
        .render()
        .rows[0].cells.slice(0, 6)
        .map((cell) => cell.text)
        .join(''),
    ).toBe('abcdef')
  } finally {
    vt.dispose()
  }
})

test('VT size and color-scheme queries receive Tau pane geometry and dark theme', async () => {
  const vt = await terminal(16, 4)
  const responses: string[] = []
  try {
    vt.onSizeReport()
    vt.onPtyResponse((data) => responses.push(decoder.decode(data)))
    vt.resize(16, 4, 9, 18)
    vt.write('\x1b[14t\x1b[16t\x1b[18t\x1b[?996n')
    expect(responses).toEqual(['\x1b[4;72;144t', '\x1b[6;18;9t', '\x1b[8;4;16t', '\x1b[?997;1n'])
    vt.setDefaultColors('#fbfcfe', '#202633', true)
    vt.write('\x1b[?996n')
    expect(responses.at(-1)).toBe('\x1b[?997;2n')
  } finally {
    vt.dispose()
  }
})

test('Ghostty OSC 52 writes reach an explicit clipboard host policy; reads stay denied', async () => {
  const vt = await terminal()
  const writes: string[] = []
  try {
    vt.onClipboardWrite((text) => {
      writes.push(text)
      return true
    })
    vt.write('\x1b]52;c;aGVs')
    vt.write('bG8=\x07')
    expect(writes).toEqual(['hello'])
    vt.write('\x1b]52;c;?\x07')
    expect(writes).toEqual(['hello'])
  } finally {
    vt.dispose()
  }
})

test('Ghostty paste encoder sanitizes controls and respects negotiated bracket mode', async () => {
  const vt = await terminal()
  try {
    const legacy = vt.encodePaste('hello\nworld\x1b[201~')
    expect(legacy.bracketed).toBe(false)
    expect(decoder.decode(legacy.bytes)).toBe('hello\rworld [201~')
    vt.write('\x1b[?2004h')
    const modern = vt.encodePaste('hello\nworld')
    expect(modern.bracketed).toBe(true)
    expect(decoder.decode(modern.bytes)).toBe('\x1b[200~hello\nworld\x1b[201~')
  } finally {
    vt.dispose()
  }
})

test('Ghostty selection tracks cells and copies text via native formatter', async () => {
  const vt = await terminal(12, 3)
  try {
    vt.write('hello world')
    vt.setSelection({ x: 0, y: 0 }, { x: 4, y: 0 })
    expect(vt.selectedText()).toBe('hello')
    expect(
      vt
        .render()
        .rows[0].cells.slice(0, 5)
        .every(({ selected }) => selected),
    ).toBe(true)
    vt.setSelection(null)
    expect(vt.selectedText()).toBe('')
  } finally {
    vt.dispose()
  }
})

test('Ghostty mouse encoder follows tracking and SGR mode', async () => {
  const vt = await terminal()
  try {
    expect(vt.encodeMouse('press', 1, 0, 0, 8, 16)).toHaveLength(0)
    vt.write('\x1b[?1000h\x1b[?1006h')
    expect(decoder.decode(vt.encodeMouse('press', 1, 0, 0, 8, 16))).toBe('\x1b[<0;1;1M')
    expect(decoder.decode(vt.encodeMouse('release', 1, 0, 0, 8, 16))).toBe('\x1b[<0;1;1m')
  } finally {
    vt.dispose()
  }
})

test('Ghostty search traverses scrollback and selects the matching viewport', async () => {
  const vt = await terminal(12, 3)
  try {
    vt.write('first\r\nsecond\r\nthird\r\nfourth\r\nfifth')
    expect(vt.search('first')).toEqual({ resultIndex: 0, resultCount: 1 })
    expect(
      vt.render().rows.some(({ cells }) =>
        cells
          .map(({ text }) => text)
          .join('')
          .includes('first'),
      ),
    ).toBe(true)
    expect(vt.search('')).toEqual({ resultIndex: -1, resultCount: 0 })
  } finally {
    vt.dispose()
  }
})

test('direct Ghostty WASM handles non-ASCII graphemes, wide cells and resize', async () => {
  const vt = await terminal(8, 3)
  try {
    vt.write('🥝e\u0301')
    const frame = vt.render()
    expect(frame.rows[0].cells[0].text).toBe('🥝')
    expect(frame.rows[0].cells[0].wide).toBe(1)
    expect(frame.rows[0].cells[2].text).toBe('e\u0301')
    vt.resize(12, 4)
    expect(vt.render().rows.length).toBeGreaterThan(0)
  } finally {
    vt.dispose()
  }
})

/** Uncached per-cell reference: every styled cell asks the Ghostty cell API directly. */
function referenceViewport(vt: GhosttyVt, background: string, foreground: string) {
  const api = vt.api
  const view = () => new DataView(api.memory.buffer)
  const rgb = (ptr: number) =>
    `#${[...new Uint8Array(api.memory.buffer, ptr, 3)].map((c) => c.toString(16).padStart(2, '0')).join('')}`
  const bits = vt.layout.types.GhosttyCell.bits!
  const field = (packed: bigint, name: string) =>
    Number((packed >> BigInt(bits[name].lsb)) & ((1n << BigInt(bits[name].width)) - 1n))
  const style = vt.layout.types.GhosttyStyle
  const selection = vt.layout.types.GhosttyRenderStateRowSelection
  const rows: Array<Record<string, unknown>[]> = []
  view().setUint32(vt.slot, vt.rowIterator, true)
  expect(api.ghostty_render_state_get(vt.renderState, 4, vt.slot)).toBe(0)
  while (api.ghostty_render_state_row_iterator_next(vt.rowIterator)) {
    expect(api.ghostty_render_state_row_get(vt.rowIterator, 5, vt.scratch)).toBe(0)
    const ptr = view().getUint32(vt.scratch, true)
    const count = view().getUint32(vt.scratch + 4, true)
    view().setUint32(vt.scratch, selection.size, true)
    const selected = api.ghostty_render_state_row_get(vt.rowIterator, 4, vt.scratch) === 0
    const start = selected
      ? view().getUint16(vt.scratch + selection.fields.start_x.offset, true)
      : -1
    const end = selected ? view().getUint16(vt.scratch + selection.fields.end_x.offset, true) : -1
    view().setUint32(vt.slot, vt.cells, true)
    expect(api.ghostty_render_state_row_get(vt.rowIterator, 3, vt.slot)).toBe(0)
    const cells: Record<string, unknown>[] = []
    for (let x = 0; x < count; x++) {
      const packed = view().getBigUint64(ptr + x * 8, true)
      const tag = field(packed, 'content_tag')
      const styleId = field(packed, 'style_id')
      const wide = field(packed, 'wide')
      let text = ''
      if (tag <= 1 && wide !== 2 && wide !== 3) {
        const cp = Number((packed >> BigInt(bits.content.lsb)) & 0x1fffffn)
        if (cp > 0 && cp <= 0x10ffff) text = String.fromCodePoint(cp)
      }
      const cell = { text, fg: foreground, bg: background, bold: false, italic: false }
      Object.assign(cell, { faint: false, underline: false, strikethrough: false, inverse: false })
      expect(api.ghostty_render_state_row_cells_select(vt.cells, x)).toBe(0)
      if (tag === 1 && api.ghostty_render_state_row_cells_get(vt.cells, 3, vt.scratch) === 0) {
        const length = view().getUint32(vt.scratch, true)
        expect(api.ghostty_render_state_row_cells_get(vt.cells, 4, vt.scratch)).toBe(0)
        cell.text = ''
        for (let i = 0; i < length; i++)
          cell.text += String.fromCodePoint(view().getUint32(vt.scratch + i * 4, true))
      }
      if (api.ghostty_render_state_row_cells_get(vt.cells, 6, vt.scratch) === 0)
        cell.fg = rgb(vt.scratch)
      if (api.ghostty_render_state_row_cells_get(vt.cells, 5, vt.scratch) === 0)
        cell.bg = rgb(vt.scratch)
      if (styleId !== 0) {
        view().setUint32(vt.scratch, style.size, true)
        expect(api.ghostty_render_state_row_cells_get(vt.cells, 2, vt.scratch)).toBe(0)
        const flag = (name: string) => view().getUint8(vt.scratch + style.fields[name].offset) !== 0
        Object.assign(cell, {
          bold: flag('bold'),
          italic: flag('italic'),
          faint: flag('faint'),
          underline: view().getUint32(vt.scratch + style.fields.underline.offset, true) !== 0,
          strikethrough: flag('strikethrough'),
          inverse: flag('inverse'),
        })
        if (flag('invisible')) cell.text = ''
      }
      cells.push({ ...cell, selected: x >= start && x <= end, wide })
    }
    rows.push(cells)
  }
  return rows
}

test('cached cell extraction matches an uncached per-cell reference across styles', async () => {
  const vt = await terminal(96, 60)
  try {
    let text = '\x1b[1mbold\x1b[0m \x1b[3;4mitalic-under\x1b[0m \x1b[2;9mfaint-strike\x1b[0m '
    text += '\x1b[7minverse\x1b[0m \x1b[8msecret\x1b[0m \x1b[38;5;202m256\x1b[48;5;17mbg\x1b[0m\r\n'
    text += '漢字🥝é👩‍👩‍👧 \x1b[44m\x1b[K\x1b[0m\r\n'
    // >64 distinct styles pushes style ids across the u64 low/high word boundary (bits 26..41),
    // and >4096 truecolor backgrounds overflow the interned color cache.
    for (let row = 0; row < 56; row++) {
      for (let col = 0; col < 96; col++) {
        const value = row * 96 + col
        text += `\x1b[48;2;${value & 0xff};${(value >> 8) & 0xff};${row};38;2;${col};1;2m${col % 10}`
      }
      text += '\x1b[0m'
      if (row < 55) text += '\r\n'
    }
    vt.write(text)
    vt.setSelection({ x: 2, y: 0 }, { x: 10, y: 1 })
    vt.render()
    vt.invalidate()
    const frame = vt.render()
    expect(frame.dirty).toBe(2)
    expect(frame.rows.map(({ y }) => y)).toEqual(Array.from({ length: 60 }, (_, y) => y))
    const reference = referenceViewport(vt, frame.background, frame.foreground)
    expect(frame.rows.map(({ cells }) => cells)).toEqual(reference as never)
    expect(frame.rows[0].cells.some((cell) => cell.selected)).toBe(true)
    expect(frame.rows[1].cells.some((cell) => cell.wide === 1)).toBe(true)
  } finally {
    vt.dispose()
  }
})

test('invalidate re-reports every row once after dirty state was consumed', async () => {
  const vt = await terminal(12, 3)
  try {
    vt.write('one\r\ntwo\r\nthree')
    vt.render()
    expect(vt.render().rows).toHaveLength(0)
    vt.invalidate()
    const frame = vt.render()
    expect(frame.rows.map(({ y }) => y)).toEqual([0, 1, 2])
    expect(frame.rows[2].cells.map(({ text }) => text).join('')).toStartWith('three')
    expect(vt.render().rows).toHaveLength(0)
  } finally {
    vt.dispose()
  }
})

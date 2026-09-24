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

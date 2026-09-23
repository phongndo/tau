import { expect, test } from 'bun:test'
import { preloadHarness } from './helpers/preload-harness'

const bytes = (text: string) => new TextEncoder().encode(text)

test('binary subscribers allocate no compatibility decoder or retained text', () => {
  const h = preloadHarness()
  const session = h.session('binary')
  let received = 0
  const off = h.api.onSessionOutput('binary', (frame) => {
    received += frame.data.byteLength
  })
  const chunk = bytes('x'.repeat(65536))
  for (let seq = 1; seq <= 128; seq++) session.output(chunk, seq)
  expect(received).toBe(8 * 1024 * 1024)
  expect(h.decoding()).toEqual({ decoderCount: 0, decodeCount: 0 })
  expect(h.api.getTerminalPreloadDiagnostics()).toMatchObject({
    pendingDataSessions: 0,
    pendingDataChars: 0,
    pendingDataDroppedCharsTotal: 0,
    pendingOutputSessions: 0,
    pendingOutputChars: 0,
  })
  off()
  session.exit()
})

test('late binary and legacy subscribers use the same bounded startup byte buffer', () => {
  for (const legacy of [false, true]) {
    const h = preloadHarness()
    const session = h.session('startup')
    session.output(bytes('first'), 1)
    session.output(bytes('second'), 2)
    expect(h.decoding().decodeCount).toBe(0)
    expect(h.api.getTerminalPreloadDiagnostics()).toMatchObject({
      pendingOutputChars: 11,
      pendingDataChars: 0,
    })
    let result = ''
    const off = legacy
      ? h.api.onPtyData('startup', (data) => {
          result += data
        })
      : h.api.onSessionOutput('startup', (frame) => {
          result += new TextDecoder().decode(frame.data)
        })
    session.output(bytes('third'), 3)
    expect(result).toBe('firstsecondthird')
    expect(h.api.getTerminalPreloadDiagnostics().pendingOutputChars).toBe(0)
    off()
    session.exit()
  }
})

test('legacy decoding streams UTF-8 per session and releases decoder on last unsubscribe', () => {
  const h = preloadHarness()
  const a = h.session('a')
  const b = h.session('b')
  let textA = ''
  let textB = ''
  const offA = h.api.onPtyData('a', (data) => {
    textA += data
  })
  const offB = h.api.onPtyData('b', (data) => {
    textB += data
  })
  a.output(Uint8Array.of(0xe2, 0x82), 1)
  b.output(bytes('B'), 1)
  a.output(Uint8Array.of(0xac), 2)
  expect(textA).toBe('€')
  expect(textB).toBe('B')
  expect(h.decoding().decoderCount).toBe(2)
  offA()
  const decodes = h.decoding().decodeCount
  a.output(Uint8Array.of(0xe2), 3)
  expect(h.decoding().decodeCount).toBe(decodes)
  a.exit()
  const newA = h.session('a')
  const offNewA = h.api.onPtyData('a', (data) => {
    textA += data
  })
  newA.output(bytes('new'), 1)
  expect(textA).toBe('€new')
  expect(h.decoding().decoderCount).toBe(3)
  offNewA()
  offB()
  newA.exit()
  b.exit()
})

test('removing one legacy subscriber does not reset another subscriber’s decoder', () => {
  const h = preloadHarness()
  const session = h.session('shared')
  const offFirst = h.api.onPtyData('shared', () => {})
  let result = ''
  const offSecond = h.api.onPtyData('shared', (data) => {
    result += data
  })
  session.output(Uint8Array.of(0xe2, 0x82), 1)
  offFirst()
  session.output(Uint8Array.of(0xac), 2)
  expect(result).toBe('€')
  expect(h.decoding().decoderCount).toBe(1)
  offSecond()
  session.exit()
})

test('startup byte overflow requests resync without allocating compatibility strings', () => {
  const h = preloadHarness()
  const session = h.session('overflow')
  session.output(new Uint8Array(1024 * 1024), 1)
  session.output(Uint8Array.of(1), 2)
  expect(h.sent).toContainEqual({ type: 'resync', seq: 0 })
  expect(h.decoding().decodeCount).toBe(0)
  expect(h.api.getTerminalPreloadDiagnostics()).toMatchObject({
    pendingOutputChars: 0,
    pendingOutputDroppedFramesTotal: 2,
  })
  session.exit()
})

test('mixed subscribers receive each frame once without retaining duplicate history', () => {
  const h = preloadHarness()
  const session = h.session('mixed')
  let binaryCount = 0
  let text = ''
  const offBinary = h.api.onSessionOutput('mixed', () => {
    binaryCount++
  })
  const offText = h.api.onPtyData('mixed', (data) => {
    text += data
  })
  session.output(bytes('one'), 1)
  offText()
  session.output(bytes('two'), 2)
  const offLateText = h.api.onPtyData('mixed', (data) => {
    text += data
  })
  session.output(bytes('three'), 3)
  expect(binaryCount).toBe(3)
  expect(text).toBe('onethree') // consumed binary output is not a second scrollback store
  expect(h.api.getTerminalPreloadDiagnostics().pendingOutputChars).toBe(0)
  offLateText()
  offBinary()
  session.exit()
})

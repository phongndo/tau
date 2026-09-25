import { expect, test } from 'bun:test'
import { createSequencedTerminalWriter } from '../src/renderer/terminal-output-writer'

function fixture(options: { maxQueuedBytes?: number } = {}) {
  const writes: Uint8Array[] = []
  const callbacks: Array<() => void> = []
  const acks: number[] = []
  const resyncs: number[] = []
  const writer = createSequencedTerminalWriter(
    {
      write(data, callback) {
        if (!(data instanceof Uint8Array)) throw new Error('Expected bytes')
        writes.push(data)
        callbacks.push(callback!)
      },
    },
    {
      ...options,
      onApplied: (seq) => acks.push(seq),
      onResync: (seq) => resyncs.push(seq),
    },
  )
  return { writer, writes, callbacks, acks, resyncs }
}

test('a failed VT parse never acknowledges rejected bytes and requests resync', async () => {
  const acks: number[] = []
  const failures: Array<{ error: unknown; seq: number }> = []
  const writer = createSequencedTerminalWriter(
    {
      write: () => {
        throw new Error('Ghostty VT semantic failure')
      },
    },
    {
      onApplied: (seq) => acks.push(seq),
      onResync: () => {
        throw new Error('unexpected normal resync')
      },
      onWriteError: (error, seq) => failures.push({ error, seq }),
    },
  )
  try {
    writer.writeOwned(Uint8Array.of(0x1b), 1)
    writer.flush()
    await writer.drain()
    expect(acks).toEqual([])
    expect(failures).toHaveLength(1)
    expect(failures[0].seq).toBe(0)
  } finally {
    writer.dispose()
  }
})

test('a failed parse suspends later writes and acknowledgements until a snapshot is applied', () => {
  let calls = 0
  const acks: number[] = []
  const failed: number[] = []
  const writer = createSequencedTerminalWriter(
    {
      write: (_bytes, callback) => {
        calls++
        if (calls === 1) throw new Error('Ghostty parser failed')
        callback?.()
      },
    },
    {
      onApplied: (seq) => acks.push(seq),
      onResync: () => {
        throw new Error('unexpected resync')
      },
      onWriteError: (_error, seq) => failed.push(seq),
    },
  )
  try {
    writer.writeOwned(Uint8Array.of(1), 1)
    writer.flush()
    writer.writeOwned(Uint8Array.of(2), 2)
    writer.flush()
    expect(calls).toBe(1)
    expect(failed).toEqual([0])
    expect(acks).toEqual([])
    expect(writer.markApplied(1)).toBe(true) // snapshot covers failed frame 1
    writer.flush() // post-failure frame 2 was buffered, not discarded
    expect(calls).toBe(2)
    expect(acks).toEqual([2])
    writer.writeOwned(Uint8Array.of(3), 3)
    writer.flush()
    expect(acks).toEqual([2, 3])
  } finally {
    writer.dispose()
  }
})

test('owned exact-sized output is written without a second byte copy', () => {
  const f = fixture()
  try {
    const bytes = Uint8Array.of(1, 2, 3)
    f.writer.writeOwned(bytes, 1)
    f.writer.flush()
    expect(f.writes[0]).toBe(bytes)
    expect(f.acks).toEqual([])
    f.callbacks.shift()!()
    expect(f.acks).toEqual([1])
  } finally {
    f.writer.dispose()
  }
})

test('borrowed output is snapshotted and owned small views cannot retain large backing buffers', () => {
  const f = fixture()
  try {
    const bytes = Uint8Array.of(1, 2, 3)
    f.writer.write(bytes, 1)
    bytes.fill(0)
    f.writer.flush()
    expect([...f.writes[0]]).toEqual([1, 2, 3])
    f.callbacks.shift()!()
    const large = new Uint8Array(1024 * 1024)
    large.set([4, 5], 100)
    f.writer.writeOwned(large.subarray(100, 102), 2)
    f.writer.flush()
    expect([...f.writes[1]]).toEqual([4, 5])
    expect(f.writes[1].buffer.byteLength).toBe(2)
  } finally {
    f.writer.dispose()
  }
})

test('batches complete frames up to 64 KiB and only acknowledges on parser completion', () => {
  const f = fixture()
  try {
    for (let seq = 1; seq <= 20; seq++) f.writer.writeOwned(new Uint8Array(4096).fill(seq), seq)
    f.writer.flush()
    expect(f.writes.map((data) => data.byteLength)).toEqual([65536])
    expect(f.acks).toEqual([])
    for (let seq = 1; seq <= 16; seq++) expect(f.writes[0][(seq - 1) * 4096]).toBe(seq)
    f.writer.flush() // cannot overlap an outstanding parser write
    expect(f.writes.length).toBe(1)
    f.callbacks.shift()!()
    expect(f.acks).toEqual([16])
    f.writer.flush()
    expect(f.writes.map((data) => data.byteLength)).toEqual([65536, 16384])
    f.callbacks.shift()!()
    expect(f.acks).toEqual([16, 20])
    expect(f.writer.diagnostics().writeQueueChars).toBe(0)
  } finally {
    f.writer.dispose()
  }
})

test('a single large frame is not sliced to meet the batch target', () => {
  const f = fixture()
  try {
    const frame = new Uint8Array(65537)
    f.writer.writeOwned(frame, 1)
    f.writer.writeOwned(Uint8Array.of(2), 2)
    f.writer.flush()
    expect(f.writes[0]).toBe(frame)
    f.callbacks.shift()!()
    expect(f.acks).toEqual([1])
    f.writer.flush()
    expect([...f.writes[1]]).toEqual([2])
  } finally {
    f.writer.dispose()
  }
})

test('batching preserves split UTF-8 and escape sequences byte for byte', () => {
  const f = fixture()
  try {
    f.writer.writeOwned(Uint8Array.of(0xe2, 0x82), 1)
    f.writer.writeOwned(Uint8Array.of(0xac, 0x1b, 0x5b), 2)
    f.writer.writeOwned(Uint8Array.of(0x33, 0x31, 0x6d), 3)
    f.writer.flush()
    expect([...f.writes[0]]).toEqual([0xe2, 0x82, 0xac, 0x1b, 0x5b, 0x33, 0x31, 0x6d])
    f.callbacks.shift()!()
    expect(f.acks).toEqual([3])
  } finally {
    f.writer.dispose()
  }
})

test('overflow clears queued ownership, counts rejected bytes, and requests resync', () => {
  const f = fixture({ maxQueuedBytes: 8 })
  try {
    f.writer.writeOwned(Uint8Array.of(1), 1)
    f.writer.flush()
    f.writer.writeOwned(new Uint8Array(5), 2)
    f.writer.writeOwned(new Uint8Array(5), 3)
    expect(f.resyncs).toEqual([0])
    expect(f.writer.diagnostics()).toMatchObject({
      writeQueueChars: 0,
      writeQueueChunks: 0,
      droppedWriteQueueCharsTotal: 10,
      droppedWriteQueueChunksTotal: 2,
    })
    f.callbacks.shift()!()
    expect(f.acks).toEqual([1]) // discarded frames are never acknowledged
    f.writer.writeOwned(Uint8Array.of(4), 4)
    f.writer.flush()
    expect(f.writes).toHaveLength(1)
    expect(f.resyncs).toEqual([0]) // do not flood resync requests while waiting
    expect(f.writer.markApplied(3)).toBe(true) // frame 4 is buffered for replay
    f.writer.flush()
    expect(f.writes).toHaveLength(2)
    f.callbacks.shift()!()
    expect(f.acks).toEqual([1, 4])
    f.writer.writeOwned(Uint8Array.of(5), 5)
    f.writer.flush()
    f.callbacks.shift()!()
    expect(f.acks).toEqual([1, 4, 5])
  } finally {
    f.writer.dispose()
  }
})

test('a second overflow while waiting rejects older snapshots but replays later output', () => {
  const f = fixture({ maxQueuedBytes: 2 })
  try {
    f.writer.writeOwned(Uint8Array.of(1), 1)
    f.writer.flush()
    f.writer.writeOwned(Uint8Array.of(2, 2), 2)
    f.writer.writeOwned(Uint8Array.of(3, 3), 3) // overflow: snapshot must cover sequence 3
    f.writer.writeOwned(Uint8Array.of(4), 4)
    f.writer.writeOwned(Uint8Array.of(5, 5), 5) // buffer overflows again while paused
    f.writer.writeOwned(Uint8Array.of(6), 6)
    f.callbacks.shift()!()
    expect(f.writer.markApplied(4)).toBe(false)
    expect(f.writer.markApplied(5)).toBe(true)
    f.writer.flush()
    expect([...f.writes[1]]).toEqual([6])
    f.callbacks.shift()!()
    expect(f.acks).toEqual([1, 6])
    expect(f.resyncs).toEqual([0])
  } finally {
    f.writer.dispose()
  }
})

test('snapshot cursor filters queued frames in place without regressing acknowledgements', () => {
  const f = fixture()
  try {
    for (let seq = 1; seq <= 4; seq++) f.writer.writeOwned(Uint8Array.of(seq), seq)
    f.writer.markApplied(3)
    expect(f.writer.diagnostics().writeQueueChunks).toBe(1)
    f.writer.flush()
    expect([...f.writes[0]]).toEqual([4])
    f.writer.markApplied(9)
    f.callbacks.shift()!()
    expect(f.acks).toEqual([9])
    f.writer.writeOwned(Uint8Array.of(8), 8)
    expect(f.acks).toEqual([9, 9])
  } finally {
    f.writer.dispose()
  }
})

test('queue compaction preserves order and accounting across thousands of frames', () => {
  const f = fixture()
  try {
    for (let seq = 1; seq <= 3000; seq++) {
      f.writer.writeOwned(Uint8Array.of(seq & 0xff), seq)
    }
    while (f.writer.diagnostics().writeQueueChunks > 0) {
      f.writer.flush()
      f.callbacks.shift()!()
    }
    const applied = f.writes.flatMap((data) => [...data])
    expect(applied).toEqual(Array.from({ length: 3000 }, (_, index) => (index + 1) & 0xff))
    expect(f.acks.at(-1)).toBe(3000)
    expect(f.writer.diagnostics()).toMatchObject({ writeQueueChars: 0, writeQueueChunks: 0 })
    f.writer.writeOwned(Uint8Array.of(9), 3001)
    f.writer.flush()
    f.callbacks.shift()!()
    expect(f.acks.at(-1)).toBe(3001)
  } finally {
    f.writer.dispose()
  }
})

function synchronousWriter(acks: number[], isBackground?: () => boolean) {
  return createSequencedTerminalWriter(
    { write: (_data, done) => done?.() },
    {
      onApplied: (seq) => acks.push(seq),
      onResync: () => {
        throw new Error('Unexpected resync')
      },
      isBackground,
    },
  )
}

test('synchronous parser callbacks process one bounded batch per yielded task', async () => {
  // Bun drains one MessagePort's queue before other ports, so observe the writer's yields
  // directly: each posted task must run exactly one batch, leaving the event loop in between.
  const posted: Array<() => void> = []
  const RealMessageChannel = globalThis.MessageChannel
  class RecordingChannel {
    readonly port1 = { onmessage: null as (() => void) | null, close() {} }
    readonly port2 = { postMessage: () => posted.push(() => this.port1.onmessage?.()), close() {} }
  }
  globalThis.MessageChannel = RecordingChannel as unknown as typeof MessageChannel
  const acks: number[] = []
  let writer: ReturnType<typeof synchronousWriter>
  try {
    writer = synchronousWriter(acks)
  } finally {
    globalThis.MessageChannel = RealMessageChannel
  }
  try {
    for (let seq = 1; seq <= 1025; seq++) writer.writeOwned(Uint8Array.of(65), seq)
    let drained = false
    const draining = writer.drain().then(() => {
      drained = true
    })
    expect(acks).toEqual([128])
    expect(posted.length).toBeGreaterThan(0)
    for (let task = 0; posted.length > 0; task++) {
      posted.shift()!()
      expect(acks.length).toBeLessThanOrEqual(task + 2)
    }
    await draining
    expect(drained).toBe(true)
    expect(acks.at(-1)).toBe(1025)
    expect(acks.length).toBe(9)
  } finally {
    writer.dispose()
  }
})

test('background writers yield to timers between bounded batches', async () => {
  const acks: number[] = []
  let background = true
  const writer = synchronousWriter(acks, () => background)
  let yielded = false
  const timer = setTimeout(() => {
    yielded = true
  }, 0)
  try {
    for (let seq = 1; seq <= 1025; seq++) writer.writeOwned(Uint8Array.of(65), seq)
    const draining = writer.drain()
    expect(acks).toEqual([128])
    await draining
    expect(yielded).toBe(true)
    expect(acks.at(-1)).toBe(1025)
    // Becoming visible again switches back to message yields without losing ordering.
    background = false
    for (let seq = 1026; seq <= 1300; seq++) writer.writeOwned(Uint8Array.of(66), seq)
    await writer.drain()
    expect(acks.at(-1)).toBe(1300)
  } finally {
    clearTimeout(timer)
    writer.dispose()
  }
})

test('disposing a writer with a pending yield never processes queued output', async () => {
  const acks: number[] = []
  const writer = synchronousWriter(acks)
  for (let seq = 1; seq <= 300; seq++) writer.writeOwned(Uint8Array.of(65), seq)
  expect(acks).toEqual([])
  writer.dispose()
  await new Promise((resolve) => setTimeout(resolve, 5))
  expect(acks).toEqual([])
})

test('disposing while the parser is writing releases drains and suppresses late callbacks', async () => {
  const f = fixture()
  f.writer.writeOwned(Uint8Array.of(1), 1)
  const draining = f.writer.drain()
  f.writer.writeOwned(new Uint8Array(4096), 2)
  f.writer.dispose()
  await draining
  f.callbacks.shift()!()
  expect(f.acks).toEqual([])
  expect(f.writer.diagnostics()).toMatchObject({
    writeQueueChars: 0,
    writeQueueChunks: 0,
    writing: false,
  })
})

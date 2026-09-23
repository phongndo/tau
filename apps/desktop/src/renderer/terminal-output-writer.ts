type TerminalWriteTarget = {
  write(data: string | Uint8Array, callback?: () => void): void
}

export type TerminalOutputWriterDiagnostics = {
  queuedChars: number
  queuedChunks: number
  writeQueueChars: number
  writeQueueChunks: number
  writing: boolean
  drainWaiters: number
  writeCount: number
  totalWrittenChars: number
  lastWriteChars: number
  lastWriteDurationMs: number
  maxWriteDurationMs: number
  maxWriteQueueChars: number
  maxWriteQueueChunks: number
  droppedWriteQueueCharsTotal: number
  droppedWriteQueueChunksTotal: number
  dropNoticeCount: number
}

const OUTPUT_BATCH_MAX_CHARS = 32 * 1024
const OUTPUT_WRITE_CHUNK_MAX_CHARS = 16 * 1024
const OUTPUT_WRITE_QUEUE_MAX_CHARS = 4 * 1024 * 1024
const OUTPUT_WRITE_QUEUE_RESUME_CHARS = 2 * 1024 * 1024
const OUTPUT_WRITE_QUEUE_DROP_NOTICE =
  '\r\n\x1b[33m[Tau dropped terminal output because the renderer write queue exceeded 4 MiB]\x1b[0m\r\n'

export type SequencedTerminalWriter = {
  /** Snapshot borrowed bytes; the caller may reuse them after this returns. */
  write(data: Uint8Array, seq: number): void
  /** Hand off private bytes. The caller must not read or mutate them after this returns. */
  writeOwned(data: Uint8Array, seq: number): void
  /** Advance the applied cursor after a resync snapshot replaces dropped output. */
  markApplied(seq: number): void
  flush(): void
  drain(): Promise<void>
  diagnostics(): TerminalOutputWriterDiagnostics
  dispose(): void
}

/**
 * Production byte writer. Queue entries remain complete daemon frames: bytes are never sliced in
 * the middle of UTF-8 or ANSI sequences. If xterm falls behind, queued presentation frames are
 * replaced by a sequence-aware daemon snapshot instead of pretending dropped bytes were applied.
 */
export function createSequencedTerminalWriter(
  term: TerminalWriteTarget,
  options: {
    onApplied(seq: number): void
    onResync(lastAppliedSeq: number): void
    maxQueuedBytes?: number
  },
): SequencedTerminalWriter {
  type Entry = { data: Uint8Array; seq: number }
  const maxQueuedBytes = options.maxQueuedBytes ?? OUTPUT_WRITE_QUEUE_MAX_CHARS
  const queue: Array<Entry | undefined> = []
  let head = 0
  let queuedBytes = 0
  let writing = false
  let disposed = false
  let scheduled: ReturnType<typeof setTimeout> | null = null
  let lastAppliedSeq = 0
  let drainWaiters: Array<() => void> = []
  let writeCount = 0
  let totalWrittenChars = 0
  let lastWriteChars = 0
  let lastWriteDurationMs = 0
  let maxWriteDurationMs = 0
  let maxWriteQueueChars = 0
  let maxWriteQueueChunks = 0
  let droppedWriteQueueCharsTotal = 0
  let droppedWriteQueueChunksTotal = 0
  let resyncCount = 0

  let inFlightSeq = 0
  let inFlightBytes = 0
  let writeStartedAt = 0
  const now = () => (typeof performance === 'undefined' ? Date.now() : performance.now())
  const resolveDrains = () => {
    if (writing || head < queue.length || drainWaiters.length === 0) return
    const waiters = drainWaiters
    drainWaiters = []
    for (const resolve of waiters) resolve()
  }
  const schedule = () => {
    if (disposed || writing || scheduled !== null || head === queue.length) return
    scheduled = setTimeout(process, 0)
  }
  // Reused for every write; don't retain the completed frame's byte buffer in a closure.
  const onWriteComplete = () => {
    if (disposed) return
    const duration = now() - writeStartedAt
    writing = false
    writeCount += 1
    totalWrittenChars += inFlightBytes
    lastWriteChars = inFlightBytes
    lastWriteDurationMs = duration
    maxWriteDurationMs = Math.max(maxWriteDurationMs, duration)
    lastAppliedSeq = Math.max(lastAppliedSeq, inFlightSeq)
    options.onApplied(lastAppliedSeq)
    schedule()
    resolveDrains()
  }
  const process = () => {
    if (scheduled !== null) clearTimeout(scheduled)
    scheduled = null
    if (disposed || writing) return
    const first = queue[head]
    if (!first) {
      resolveDrains()
      return
    }
    // Coalesce only already-queued complete frames. No additional batching delay; a lone frame
    // takes the no-copy path. Large individual frames remain intact. Yield between batches.
    let end = head + 1
    let bytes = first.data.byteLength
    while (end < queue.length && end - head < 128) {
      const next = queue[end]!
      if (bytes + next.data.byteLength > 64 * 1024) break
      bytes += next.data.byteLength
      end++
    }
    const data = end === head + 1 ? first.data : new Uint8Array(bytes)
    let offset = 0
    inFlightSeq = first.seq
    for (let index = head; index < end; index++) {
      const entry = queue[index]!
      if (end !== head + 1) data.set(entry.data, offset)
      offset += entry.data.byteLength
      inFlightSeq = Math.max(inFlightSeq, entry.seq)
      queue[index] = undefined // Release consumed buffers immediately, not at the next compaction.
    }
    head = end
    if (head === queue.length) {
      queue.length = 0
      head = 0
    } else if (head >= 1024 && head >= queue.length / 2) {
      queue.copyWithin(0, head)
      queue.length -= head
      head = 0
    }
    queuedBytes -= bytes
    writing = true
    inFlightBytes = bytes
    writeStartedAt = now()
    term.write(data, onWriteComplete)
  }
  const enqueue = (data: Uint8Array, seq: number, owned: boolean) => {
    if (disposed || data.byteLength === 0) return
    if (seq <= lastAppliedSeq) {
      // A duplicate still needs an acknowledgement to release main's backlog entry.
      options.onApplied(lastAppliedSeq)
      return
    }
    // Check bounds before copying a rejected frame.
    if (queuedBytes + data.byteLength > maxQueuedBytes) {
      droppedWriteQueueChunksTotal += queue.length - head + 1
      droppedWriteQueueCharsTotal += queuedBytes + data.byteLength
      queue.length = 0
      head = 0
      queuedBytes = 0
      resyncCount += 1
      options.onResync(lastAppliedSeq)
      return
    }
    // Even an owned small view must not pin a large pooled backing buffer.
    const bytes =
      owned && data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
        ? data
        : Uint8Array.from(data)
    queue.push({ data: bytes, seq })
    queuedBytes += bytes.byteLength
    maxWriteQueueChars = Math.max(maxWriteQueueChars, queuedBytes)
    maxWriteQueueChunks = Math.max(maxWriteQueueChunks, queue.length - head)
    schedule()
  }

  return {
    write: (data, seq) => enqueue(data, seq, false),
    writeOwned: (data, seq) => enqueue(data, seq, true),
    markApplied(seq) {
      if (disposed || seq <= 0) return
      lastAppliedSeq = Math.max(lastAppliedSeq, seq)
      let retained = 0
      let retainedBytes = 0
      for (let index = head; index < queue.length; index++) {
        const entry = queue[index]!
        if (entry.seq > lastAppliedSeq) {
          queue[retained++] = entry
          retainedBytes += entry.data.byteLength
        }
      }
      queue.length = retained
      head = 0
      queuedBytes = retainedBytes
      resolveDrains()
    },
    flush: process,
    drain() {
      process()
      if (!writing && head === queue.length) return Promise.resolve()
      return new Promise((resolve) => drainWaiters.push(resolve))
    },
    diagnostics() {
      return {
        queuedChars: 0,
        queuedChunks: 0,
        writeQueueChars: queuedBytes,
        writeQueueChunks: queue.length - head,
        writing,
        drainWaiters: drainWaiters.length,
        writeCount,
        totalWrittenChars,
        lastWriteChars,
        lastWriteDurationMs,
        maxWriteDurationMs,
        maxWriteQueueChars,
        maxWriteQueueChunks,
        droppedWriteQueueCharsTotal,
        droppedWriteQueueChunksTotal,
        dropNoticeCount: resyncCount,
      }
    },
    dispose() {
      disposed = true
      if (scheduled !== null) clearTimeout(scheduled)
      scheduled = null
      queue.length = 0
      head = 0
      queuedBytes = 0
      writing = false
      resolveDrains()
    },
  }
}

/** Compatibility writer retained for benchmark callers; production uses the sequenced byte writer. */
export function createBatchedTerminalWriter(term: TerminalWriteTarget): {
  write(data: string): void
  flush(): void
  drain(): Promise<void>
  diagnostics(): TerminalOutputWriterDiagnostics
  dispose(): void
} {
  let chunks: string[] = []
  let queuedChars = 0
  let writeQueue: string[] = []
  let flushTimer: number | null = null
  let writeTimer: number | null = null
  let writing = false
  let disposed = false
  let drainWaiters: Array<() => void> = []
  let writeStartedAt = 0
  let activeWriteChars = 0
  let writeCount = 0
  let totalWrittenChars = 0
  let lastWriteChars = 0
  let lastWriteDurationMs = 0
  let maxWriteDurationMs = 0
  let maxWriteQueueChars = 0
  let maxWriteQueueChunks = 0
  let currentWriteQueueChars = 0
  let droppedWriteQueueCharsTotal = 0
  let droppedWriteQueueChunksTotal = 0
  let dropNoticePending = false
  let dropNoticeCount = 0

  function nowMs(): number {
    return typeof performance === 'undefined' ? Date.now() : performance.now()
  }

  function writeQueueChars(): number {
    return currentWriteQueueChars
  }

  function recordWriteQueueHighWater(): void {
    maxWriteQueueChars = Math.max(maxWriteQueueChars, currentWriteQueueChars)
    maxWriteQueueChunks = Math.max(maxWriteQueueChunks, writeQueue.length)
  }

  function enqueueWriteQueueChunk(data: string): void {
    writeQueue.push(data)
    currentWriteQueueChars += data.length
  }

  function dequeueWriteQueueChunk(): string | undefined {
    const data = writeQueue.shift()
    if (data) currentWriteQueueChars -= data.length
    return data
  }

  function dropOldestWriteQueueChunk(): boolean {
    const dropped = dequeueWriteQueueChunk()
    if (!dropped) return false
    if (dropped === OUTPUT_WRITE_QUEUE_DROP_NOTICE) dropNoticePending = false
    droppedWriteQueueChunksTotal += 1
    droppedWriteQueueCharsTotal += dropped.length
    return true
  }

  function enforceWriteQueueBudget(): void {
    if (currentWriteQueueChars <= OUTPUT_WRITE_QUEUE_MAX_CHARS) return

    while (
      currentWriteQueueChars > OUTPUT_WRITE_QUEUE_RESUME_CHARS &&
      dropOldestWriteQueueChunk()
    ) {}

    if (!dropNoticePending) {
      enqueueWriteQueueChunk(OUTPUT_WRITE_QUEUE_DROP_NOTICE)
      dropNoticePending = true
      dropNoticeCount += 1
    }

    recordWriteQueueHighWater()
  }

  function clearFlushTimer() {
    if (flushTimer === null) return
    window.clearTimeout(flushTimer)
    flushTimer = null
  }

  function clearWriteTimer() {
    if (writeTimer === null) return
    window.clearTimeout(writeTimer)
    writeTimer = null
  }

  function resolveDrainWaiters() {
    if (writing || chunks.length > 0 || writeQueue.length > 0) return

    const waiters = drainWaiters
    drainWaiters = []
    for (const resolve of waiters) resolve()
  }

  function enqueueWriteData(data: string) {
    for (let offset = 0; offset < data.length; offset += OUTPUT_WRITE_CHUNK_MAX_CHARS) {
      enqueueWriteQueueChunk(data.slice(offset, offset + OUTPUT_WRITE_CHUNK_MAX_CHARS))
    }
    recordWriteQueueHighWater()
    enforceWriteQueueBudget()
  }

  function scheduleWrite() {
    if (disposed || writing || writeTimer !== null) return
    writeTimer = window.setTimeout(() => {
      writeTimer = null
      processWriteQueue()
    }, 0)
  }

  function processWriteQueue() {
    clearWriteTimer()
    if (disposed || writing) return

    const data = dequeueWriteQueueChunk()
    if (!data) {
      resolveDrainWaiters()
      return
    }

    writing = true
    activeWriteChars = data.length
    writeStartedAt = nowMs()
    term.write(data, () => {
      const durationMs = nowMs() - writeStartedAt
      writeCount += 1
      totalWrittenChars += activeWriteChars
      lastWriteChars = activeWriteChars
      lastWriteDurationMs = durationMs
      maxWriteDurationMs = Math.max(maxWriteDurationMs, durationMs)
      if (data === OUTPUT_WRITE_QUEUE_DROP_NOTICE) dropNoticePending = false
      activeWriteChars = 0
      writing = false
      if (disposed) {
        writeQueue = []
        currentWriteQueueChars = 0
        resolveDrainWaiters()
        return
      }

      scheduleWrite()
      resolveDrainWaiters()
    })
  }

  function flush() {
    clearFlushTimer()
    if (disposed || chunks.length === 0) return

    const data = chunks.join('')
    chunks = []
    queuedChars = 0
    enqueueWriteData(data)
    processWriteQueue()
  }

  function scheduleFlush() {
    if (flushTimer !== null) return
    flushTimer = window.setTimeout(flush, 0)
  }

  return {
    write(data: string) {
      if (disposed || data.length === 0) return
      chunks.push(data)
      queuedChars += data.length
      if (queuedChars >= OUTPUT_BATCH_MAX_CHARS) {
        flush()
        return
      }
      scheduleFlush()
    },
    flush,
    drain() {
      flush()
      if (!writing && writeQueue.length === 0) return Promise.resolve()

      return new Promise((resolve) => {
        drainWaiters.push(resolve)
      })
    },
    diagnostics() {
      return {
        queuedChars,
        queuedChunks: chunks.length,
        writeQueueChars: writeQueueChars(),
        writeQueueChunks: writeQueue.length,
        writing,
        drainWaiters: drainWaiters.length,
        writeCount,
        totalWrittenChars,
        lastWriteChars,
        lastWriteDurationMs,
        maxWriteDurationMs,
        maxWriteQueueChars,
        maxWriteQueueChunks,
        droppedWriteQueueCharsTotal,
        droppedWriteQueueChunksTotal,
        dropNoticeCount,
      }
    },
    dispose() {
      disposed = true
      clearFlushTimer()
      clearWriteTimer()
      chunks = []
      queuedChars = 0
      writeQueue = []
      currentWriteQueueChars = 0
      const waiters = drainWaiters
      drainWaiters = []
      for (const resolve of waiters) resolve()
    },
  }
}

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
  write(data: Uint8Array, seq: number): void
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
  let queue: Entry[] = []
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

  const now = () => (typeof performance === 'undefined' ? Date.now() : performance.now())
  const resolveDrains = () => {
    if (writing || queue.length > 0) return
    const waiters = drainWaiters
    drainWaiters = []
    for (const resolve of waiters) resolve()
  }
  const schedule = () => {
    if (disposed || writing || scheduled !== null) return
    scheduled = setTimeout(process, 0)
  }
  const process = () => {
    if (scheduled !== null) clearTimeout(scheduled)
    scheduled = null
    if (disposed || writing) return
    const entry = queue.shift()
    if (!entry) {
      resolveDrains()
      return
    }
    queuedBytes -= entry.data.byteLength
    writing = true
    const started = now()
    term.write(entry.data, () => {
      const duration = now() - started
      writing = false
      writeCount += 1
      totalWrittenChars += entry.data.byteLength
      lastWriteChars = entry.data.byteLength
      lastWriteDurationMs = duration
      maxWriteDurationMs = Math.max(maxWriteDurationMs, duration)
      lastAppliedSeq = Math.max(lastAppliedSeq, entry.seq)
      options.onApplied(lastAppliedSeq)
      schedule()
      resolveDrains()
    })
  }

  return {
    write(data, seq) {
      if (disposed || data.byteLength === 0 || seq <= lastAppliedSeq) return
      const owned = Uint8Array.from(data)
      if (queuedBytes + owned.byteLength > maxQueuedBytes) {
        droppedWriteQueueChunksTotal += queue.length
        droppedWriteQueueCharsTotal += queuedBytes
        queue = []
        queuedBytes = 0
        resyncCount += 1
        options.onResync(lastAppliedSeq)
        return
      }
      queue.push({ data: owned, seq })
      queuedBytes += owned.byteLength
      maxWriteQueueChars = Math.max(maxWriteQueueChars, queuedBytes)
      maxWriteQueueChunks = Math.max(maxWriteQueueChunks, queue.length)
      schedule()
    },
    markApplied(seq) {
      if (disposed || seq <= 0) return
      lastAppliedSeq = Math.max(lastAppliedSeq, seq)
      if (queue.length === 0) {
        resolveDrains()
        return
      }
      const retained: Entry[] = []
      let retainedBytes = 0
      for (const entry of queue) {
        if (entry.seq > lastAppliedSeq) {
          retained.push(entry)
          retainedBytes += entry.data.byteLength
        }
      }
      queue = retained
      queuedBytes = retainedBytes
      resolveDrains()
    },
    flush: process,
    drain() {
      process()
      if (!writing && queue.length === 0) return Promise.resolve()
      return new Promise((resolve) => drainWaiters.push(resolve))
    },
    diagnostics() {
      return {
        queuedChars: 0,
        queuedChunks: 0,
        writeQueueChars: queuedBytes,
        writeQueueChunks: queue.length,
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
      queue = []
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

/* Renderer half of `bun run bench:surface`. Bundled per source tree by surface-benchmark.ts.
 *
 * Drives the production TauTerminal canvas surface, GhosttyVt WASM core and sequenced output
 * writer in a sandboxed renderer. Output frames arrive as MessagePort tasks under the same
 * unacknowledged-frame/byte window that Electron main enforces, and every flood scenario checks
 * the final screen. No PTY, daemon, preload or contextBridge is involved.
 *
 * Timing boundaries: `parse` is GhosttyVt.write (WASM VT parse), `render` is GhosttyVt.render
 * (render-state extraction), `draw` is TauTerminal.draw (render + canvas commands). Canvas
 * rasterization and compositor presentation happen later and are NOT included; under Xvfb they
 * use Chromium's software fallback and establish nothing about GPU presentation.
 */
import { TauTerminal } from '../src/renderer/tau-terminal'
import { createSequencedTerminalWriter } from '../src/renderer/terminal-output-writer'

type Json = Record<string, unknown>
type Pane = {
  term: TauTerminal
  host: HTMLElement
  writer: ReturnType<typeof createSequencedTerminalWriter>
  feeder: Feeder
  resyncs: number
}

const params = new URLSearchParams(location.search)
const scenario = params.get('scenario') ?? 'flood-plain'
const profile = params.get('profile') === '1'
const scale = Number(params.get('scale') ?? '1')
const cycles = Number(params.get('cycles') ?? '30')

const encoder = new TextEncoder()
// Electron main's session channel budget (session-channel-backpressure.ts).
const WINDOW_FRAMES = 512
const WINDOW_BYTES = 4 * 1024 * 1024
const FRAME_BYTES = 4096

// ─── instrumentation ────────────────────────────────────────────────────────────────────────────

const samples = { parse: [] as number[], render: [] as number[], draw: [] as number[] }
const drawsByTerm = new Map<TauTerminal, number>()
/** Render-state extractions per VT core: a hidden pane that skips work shows no renders. */
const rendersByVt = new Map<unknown, number>()
let hookedVt = false
let measuring = false
let longTasks: number[] = []
let onDrawn: ((term: TauTerminal, end: number, appliedWrites?: number) => void) | null = null

type WorkerStats = { at: number; drawMs: number; renderMs: number; appliedWrites: number }
type WorkerSurface = {
  appliedWriteCount: number
  onFrameStats(listener: (stats: WorkerStats) => void): { dispose(): void }
  onParseStats(listener: (ms: number) => void): { dispose(): void }
}
/** Surfaces that paint in a worker report frames and parses by event instead of prototype hooks. */
const workerSurface = (term: TauTerminal): WorkerSurface | null =>
  typeof (term as unknown as Partial<WorkerSurface>).onFrameStats === 'function'
    ? (term as unknown as WorkerSurface)
    : null
const workerFrameWaiters = new Map<TauTerminal, Array<{ writes: number; resolve: () => void }>>()

function hookSurface(term: TauTerminal): void {
  const worker = workerSurface(term)
  if (worker) {
    worker.onParseStats((ms) => {
      if (measuring) samples.parse.push(ms)
    })
    worker.onFrameStats((stats) => {
      if (measuring) {
        samples.draw.push(stats.drawMs)
        samples.render.push(stats.renderMs)
        drawsByTerm.set(term, (drawsByTerm.get(term) ?? 0) + 1)
        rendersByVt.set(term, (rendersByVt.get(term) ?? 0) + 1)
      }
      onDrawn?.(term, stats.at, stats.appliedWrites)
      const waiters = workerFrameWaiters.get(term) ?? []
      workerFrameWaiters.set(
        term,
        waiters.filter((waiter) => {
          if (stats.appliedWrites < waiter.writes) return true
          waiter.resolve()
          return false
        }),
      )
    })
    return
  }
  const proto = TauTerminal.prototype as unknown as Record<string, (...args: unknown[]) => unknown>
  if (!(proto.draw as { hooked?: boolean }).hooked) {
    const draw = proto.draw
    const wrapped = function (this: TauTerminal, ...args: unknown[]) {
      const start = performance.now()
      const result = draw.apply(this, args)
      const end = performance.now()
      if (measuring) {
        samples.draw.push(end - start)
        drawsByTerm.set(this, (drawsByTerm.get(this) ?? 0) + 1)
      }
      onDrawn?.(this, end)
      return result
    }
    ;(wrapped as { hooked?: boolean }).hooked = true
    proto.draw = wrapped
  }
  if (hookedVt) return
  hookedVt = true
  const vtProto = Object.getPrototypeOf((term as unknown as { vt: object }).vt) as Record<
    string,
    (...args: unknown[]) => unknown
  >
  for (const name of ['write', 'render'] as const) {
    const original = vtProto[name]
    vtProto[name] = function (this: unknown, ...args: unknown[]) {
      const start = performance.now()
      const result = original.apply(this, args)
      if (measuring) {
        samples[name === 'write' ? 'parse' : 'render'].push(performance.now() - start)
        if (name === 'render') rendersByVt.set(this, (rendersByVt.get(this) ?? 0) + 1)
      }
      return result
    }
  }
}

new PerformanceObserver((list) => {
  if (measuring) for (const entry of list.getEntries()) longTasks.push(entry.duration)
}).observe({ type: 'longtask', buffered: false })

function frameProbe(): () => number[] {
  const stamps: number[] = []
  let running = true
  const tick = (time: number) => {
    stamps.push(time)
    if (running) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  return () => {
    running = false
    return stamps.slice(1).map((time, index) => time - stamps[index]!)
  }
}

function stats(values: number[]): Json {
  if (values.length === 0) return { n: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
  const sum = values.reduce((total, value) => total + value, 0)
  return {
    n: values.length,
    sum: round(sum),
    mean: round(sum / values.length),
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    p99: round(at(0.99)),
    max: round(sorted.at(-1)!),
  }
}

const round = (value: number) => Math.round(value * 1000) / 1000

function beginMeasure(): void {
  samples.parse.length = 0
  samples.render.length = 0
  samples.draw.length = 0
  drawsByTerm.clear()
  rendersByVt.clear()
  longTasks = []
  measuring = true
}

function endMeasure(): Json {
  measuring = false
  return {
    parseMs: stats(samples.parse),
    renderMs: stats(samples.render),
    drawMs: stats(samples.draw),
    longTasks: { count: longTasks.length, totalMs: round(longTasks.reduce((a, b) => a + b, 0)) },
  }
}

async function host(path: string, body: Json = {}): Promise<Json> {
  const response = await fetch(path, { method: 'POST', body: JSON.stringify(body) })
  if (!response.ok) throw new Error(`${path} failed: ${response.status}`)
  return (await response.json()) as Json
}

const painted = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
/** Until every pane has drawn everything applied so far (a worker frame, or two page frames). */
async function presented(panes: Pane[]): Promise<void> {
  await Promise.all(
    panes.map((pane) => {
      const worker = workerSurface(pane.term)
      if (!worker) return painted()
      const writes = worker.appliedWriteCount
      return new Promise<void>((resolve) => {
        const waiters = workerFrameWaiters.get(pane.term) ?? []
        waiters.push({ writes, resolve })
        workerFrameWaiters.set(pane.term, waiters)
        pane.term.refresh()
      })
    }),
  )
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ─── workloads (deterministic) ──────────────────────────────────────────────────────────────────

function frames(text: string): Uint8Array[] {
  const bytes = encoder.encode(text)
  const result: Uint8Array[] = []
  // Split only at line boundaries so every frame is complete UTF-8 and complete escape sequences.
  let start = 0
  while (start < bytes.length) {
    let end = Math.min(bytes.length, start + FRAME_BYTES)
    if (end < bytes.length) {
      const newline = bytes.lastIndexOf(0x0a, end - 1)
      if (newline >= start) end = newline + 1
    }
    result.push(bytes.slice(start, end))
    start = end
  }
  return result
}

function plainLines(totalBytes: number): { text: string; last: string } {
  const lines: string[] = []
  let size = 0
  let index = 0
  while (size < totalBytes) {
    const line = `line ${String(index).padStart(7, '0')} ${'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(3)}`
    lines.push(line)
    size += line.length + 2
    index++
  }
  return { text: lines.join('\r\n') + '\r\n', last: `line ${String(index - 1).padStart(7, '0')}` }
}

function sgrLines(totalBytes: number): { text: string; last: string } {
  const words = ['error', 'warning:', 'src/main.ts', '42:7', 'note', 'expected', 'found', 'ok']
  const lines: string[] = []
  let size = 0
  let index = 0
  while (size < totalBytes) {
    let line = ''
    for (let word = 0; word < 12; word++) {
      const text = words[(index + word) % words.length]!
      const color = 31 + ((index + word) % 7)
      const bold = word % 3 === 0 ? '1;' : ''
      line += `\x1b[${bold}${color}m${text}\x1b[0m `
    }
    line += `#${index}`
    lines.push(line)
    size += line.length + 2
    index++
  }
  // Narrow panes wrap long lines; the unique trailing index is the final-screen check.
  return { text: lines.join('\r\n') + '\r\n', last: `#${index - 1}` }
}

function unicodeLines(totalBytes: number): { text: string; last: string } {
  const pieces = ['漢字テスト', '🥝🍋', 'é', 'Ωμέγα', '한국어', '👩‍👩‍👧', 'naïve', '→→']
  const lines: string[] = []
  let size = 0
  let index = 0
  while (size < totalBytes) {
    const line = `${index} ${pieces.map((piece, offset) => pieces[(index + offset) % pieces.length]).join(' ')} ${piece(index)}`
    lines.push(line)
    size += encoder.encode(line).length + 2
    index++
  }
  return { text: lines.join('\r\n') + '\r\n', last: piece(index - 1) }
  function piece(value: number) {
    return `end-${value}`
  }
}

function tuiFrames(count: number, cols: number, rows: number): { text: string; last: string } {
  const parts: string[] = []
  let last = ''
  for (let frame = 0; frame < count; frame++) {
    let screen = '\x1b[?2026h\x1b[H'
    for (let row = 0; row < rows; row++) {
      const label = `f${frame} r${row} `
      const body = label + 'x'.repeat(Math.max(0, cols - label.length - 1))
      // Alternate colored segments like htop/vim status and syntax highlighting.
      const cut = (frame + row) % Math.max(1, body.length)
      const color = 31 + ((frame + row) % 7)
      const text = `\x1b[${color}m${body.slice(0, cut)}\x1b[0;4${(row % 7) + 1}m${body.slice(cut)}\x1b[0m`
      screen += row + 1 < rows ? `${text}\r\n` : text
      if (row === 0) last = label.trimEnd()
    }
    parts.push(screen + '\x1b[?2026l')
  }
  return { text: parts.join(''), last }
}

// ─── feeding production-shaped output ───────────────────────────────────────────────────────────

/** Posts frames as MessagePort tasks (as preload receives them) inside main's unacked window. */
class Feeder {
  private readonly channel = new MessageChannel()
  private queue: Uint8Array[] = []
  private cursor = 0
  private seq = 0
  private acked = 0
  private inFlight: Array<{ seq: number; bytes: number }> = []
  private inFlightBytes = 0
  private loop = false
  private waiters: Array<{ seq: number; resolve: () => void }> = []
  lastSeq = 0

  constructor(private readonly writer: Pane['writer']) {
    this.channel.port2.onmessage = (event: MessageEvent<{ seq: number; data: ArrayBuffer }>) => {
      // contextBridge hands the renderer private bytes; production uses writeOwned.
      this.writer.writeOwned(new Uint8Array(event.data.data), event.data.seq)
    }
  }

  start(queue: Uint8Array[], loop = false): void {
    this.queue = queue
    this.cursor = 0
    this.loop = loop
    this.pump()
  }

  stop(): void {
    this.loop = false
    this.cursor = this.queue.length
  }

  /** An open port with a listener is a GC root; release it with the pane. */
  close(): void {
    this.stop()
    this.channel.port1.close()
    this.channel.port2.close()
  }

  /** A PTY echo lands behind output already delivered to main, ahead of unread output. */
  inject(bytes: Uint8Array): number {
    return this.post(bytes)
  }

  onAck(seq: number): void {
    this.acked = Math.max(this.acked, seq)
    while (this.inFlight.length > 0 && this.inFlight[0]!.seq <= this.acked) {
      this.inFlightBytes -= this.inFlight.shift()!.bytes
    }
    this.pump()
    this.settle()
  }

  /** Resolves once the whole (non-looping) queue and every injected frame are applied. */
  applied(): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push({ seq: Number.POSITIVE_INFINITY, resolve })
      this.settle()
    })
  }

  private settle(): void {
    const drained = !this.loop && this.cursor >= this.queue.length && this.acked >= this.lastSeq
    this.waiters = this.waiters.filter((waiter) => {
      if (waiter.seq === Number.POSITIVE_INFINITY ? !drained : waiter.seq > this.acked) return true
      waiter.resolve()
      return false
    })
  }

  private pump(): void {
    while (this.cursor < this.queue.length || (this.loop && this.queue.length > 0)) {
      if (this.cursor >= this.queue.length) this.cursor = 0
      const next = this.queue[this.cursor]!
      if (
        this.inFlight.length > 0 &&
        (this.inFlight.length >= WINDOW_FRAMES || this.inFlightBytes + next.length > WINDOW_BYTES)
      )
        return
      this.cursor++
      this.post(next)
    }
  }

  private post(bytes: Uint8Array): number {
    const seq = ++this.seq
    this.lastSeq = seq
    this.inFlight.push({ seq, bytes: bytes.length })
    this.inFlightBytes += bytes.length
    // Structured clone, as MessagePortMain does for main's exact-sized copy.
    this.channel.port1.postMessage({ seq, data: bytes.slice().buffer })
    return seq
  }
}

async function createPane(container: HTMLElement): Promise<Pane> {
  const term = await TauTerminal.create()
  hookSurface(term)
  term.open(container)
  const size = term.proposeDimensions()
  if (size) term.resize(size.cols, size.rows)
  // Late-bound so the writer and feeder can reference each other.
  const pane = { term, host: container, resyncs: 0 } as Pane
  pane.writer = createSequencedTerminalWriter(term, {
    onApplied: (seq) => pane.feeder.onAck(seq),
    onResync: () => {
      pane.resyncs++
    },
  })
  pane.feeder = new Feeder(pane.writer)
  return pane
}

function layout(count: number, width: number, height: number): HTMLElement[] {
  const root = document.querySelector<HTMLElement>('#root')!
  root.replaceChildren()
  root.style.cssText = `display:grid;grid-template-columns:repeat(${count > 1 ? 2 : 1},1fr);width:${width}px;height:${height}px;`
  return Array.from({ length: count }, () => {
    const cell = document.createElement('div')
    cell.style.cssText = 'position:relative;min-width:0;min-height:0;overflow:hidden;'
    root.append(cell)
    const wrapper = document.createElement('div')
    wrapper.style.cssText = 'width:100%;height:100%;'
    cell.append(wrapper)
    return wrapper
  })
}

function readerText(pane: Pane): string {
  return pane.host.querySelector('pre')?.textContent ?? ''
}

function wasmBytes(pane: Pane): number {
  const worker = pane.term as unknown as { wasmBytes?: number }
  if (typeof worker.wasmBytes === 'number') return worker.wasmBytes
  return (pane.term as unknown as { vt: { api: { memory: WebAssembly.Memory } } }).vt.api.memory
    .buffer.byteLength
}

async function memory(panes: Pane[]): Promise<Json> {
  await host('/cdp', { op: 'gc' })
  const heap = await host('/cdp', { op: 'heap' })
  const metrics = await host('/metrics')
  return { ...heap, ...metrics, wasmBytes: panes.map(wasmBytes) }
}

async function profiled<T>(run: () => Promise<T>): Promise<{ value: T; profile?: Json }> {
  if (!profile) return { value: await run() }
  await host('/cdp', { op: 'profile-start' })
  const value = await run()
  const summary = await host('/cdp', { op: 'profile-stop' })
  return { value, profile: summary }
}

// ─── scenarios ──────────────────────────────────────────────────────────────────────────────────

async function flood(
  name: string,
  build: (cols: number, rows: number) => { text: string; last: string },
  panesCount = 1,
): Promise<Json> {
  const panes = await Promise.all(layout(panesCount, 1200, 760).map(createPane))
  await painted()
  const workload = build(panes[0]!.term.cols, panes[0]!.term.rows)
  const queue = frames(workload.text)
  // Warm JIT and WASM with a small prefix, then measure a fresh screen.
  for (const pane of panes) {
    pane.feeder.start(queue.slice(0, 32))
    await pane.feeder.applied()
    pane.term.write('\x1b[2J\x1b[H')
  }
  await painted()
  const before = await memory(panes)
  const probe = frameProbe()
  beginMeasure()
  const { value: elapsed, profile: cpu } = await profiled(async () => {
    const start = performance.now()
    for (const pane of panes) pane.feeder.start(queue)
    await Promise.all(panes.map((pane) => pane.feeder.applied()))
    const parsed = performance.now() - start
    // Wait for the frame that paints the applied state.
    await presented(panes)
    return { parsed, presented: performance.now() - start }
  })
  const surface = endMeasure()
  const frameIntervals = probe()
  const after = await memory(panes)
  const text = readerText(panes[0]!)
  const correct = panes.every(
    (pane) => pane.resyncs === 0 && readerText(pane).includes(workload.last),
  )
  if (!correct)
    throw new Error(`${name}: final screen mismatch: ${JSON.stringify(text.slice(-400))}`)
  const bytes = queue.reduce((total, frame) => total + frame.length, 0) * panes.length
  return {
    scenario: name,
    panes: panesCount,
    geometry: `${panes[0]!.term.cols}x${panes[0]!.term.rows}`,
    bytes,
    frames: queue.length * panes.length,
    parsedMs: round(elapsed.parsed),
    presentedMs: round(elapsed.presented),
    mibPerSec: round(bytes / 1048576 / (elapsed.presented / 1000)),
    draws: [...drawsByTerm.values()].reduce((a, b) => a + b, 0),
    writes: panes.reduce((total, pane) => total + pane.writer.diagnostics().writeCount, 0),
    frameIntervalMs: stats(frameIntervals),
    slowFrames: frameIntervals.filter((interval) => interval > 34).length,
    ...surface,
    memoryBefore: before,
    memoryAfter: after,
    ...(cpu ? { profile: cpu } : {}),
    correct,
  }
}

async function startup(): Promise<Json> {
  const containers = layout(4, 1200, 760)
  const created: number[] = []
  const firstFrame: number[] = []
  const panes: Pane[] = []
  for (const container of containers) {
    const start = performance.now()
    const pane = await createPane(container)
    created.push(performance.now() - start)
    const drawn = new Promise<number>((resolve) => {
      onDrawn = (term, end) => {
        if (term === pane.term && readerText(pane).includes('user@tau')) resolve(end)
      }
    })
    pane.term.write('user@tau:~$ ')
    firstFrame.push((await drawn) - start)
    onDrawn = null
    panes.push(pane)
  }
  const after = await memory(panes)
  return {
    scenario: 'startup',
    coldCreateMs: round(created[0]!),
    coldFirstFrameMs: round(firstFrame[0]!),
    warmCreateMs: created.slice(1).map(round),
    warmFirstFrameMs: firstFrame.slice(1).map(round),
    memoryAfter: after,
  }
}

async function inputUnderLoad(panesCount: number): Promise<Json> {
  const panes = await Promise.all(layout(panesCount, 1200, 760).map(createPane))
  await painted()
  const workload = sgrLines(8 * 1024 * 1024)
  const queue = frames(workload.text)
  const focused = panes[0]!
  focused.term.focus()
  const dispatchDelay: number[] = []
  const echoLatency: number[] = []
  const pendingEcho = new Map<number, number>()
  let lastKeyStamp = 0
  window.addEventListener(
    'keydown',
    (event) => {
      lastKeyStamp = event.timeStamp
      if (measuring) dispatchDelay.push(performance.now() - event.timeStamp)
    },
    true,
  )
  focused.term.onData((data) => {
    const seq = focused.feeder.inject(encoder.encode(data))
    pendingEcho.set(seq, lastKeyStamp)
  })
  let appliedSeq = 0
  // For worker surfaces: the applied-write count when each echo's batch was acknowledged.
  const echoWrites = new Map<number, number>()
  const focusedWorker = workerSurface(focused.term)
  const originalAck = focused.feeder.onAck.bind(focused.feeder)
  focused.feeder.onAck = (seq) => {
    appliedSeq = Math.max(appliedSeq, seq)
    if (focusedWorker)
      for (const echoSeq of pendingEcho.keys())
        if (echoSeq <= appliedSeq && !echoWrites.has(echoSeq))
          echoWrites.set(echoSeq, focusedWorker.appliedWriteCount)
    originalAck(seq)
  }
  onDrawn = (term, end, appliedWrites) => {
    if (term !== focused.term) return
    for (const [seq, stamp] of pendingEcho) {
      const drawn = focusedWorker
        ? echoWrites.has(seq) && (appliedWrites ?? 0) >= echoWrites.get(seq)!
        : seq <= appliedSeq
      if (drawn) {
        if (measuring) echoLatency.push(end - stamp)
        pendingEcho.delete(seq)
        echoWrites.delete(seq)
      }
    }
  }
  for (const pane of panes) pane.feeder.start(queue, true)
  await sleep(500)
  const probe = frameProbe()
  beginMeasure()
  const keys = 60
  const { profile: cpu } = await profiled(() => host('/input', { count: keys, intervalMs: 50 }))
  await sleep(300)
  const surface = endMeasure()
  const frameIntervals = probe()
  for (const pane of panes) pane.feeder.stop()
  await Promise.all(panes.map((pane) => pane.feeder.applied()))
  const after = await memory(panes)
  return {
    scenario: `input-under-load-${panesCount}`,
    panes: panesCount,
    keys,
    dispatchDelayMs: stats(dispatchDelay),
    echoDrawnMs: stats(echoLatency),
    echoMissing: keys - echoLatency.length,
    frameIntervalMs: stats(frameIntervals),
    slowFrames: frameIntervals.filter((interval) => interval > 34).length,
    bytesParsed: panes.reduce((t, pane) => t + pane.writer.diagnostics().totalWrittenChars, 0),
    ...surface,
    memoryAfter: after,
    ...(cpu ? { profile: cpu } : {}),
  }
}

async function hiddenPanes(): Promise<Json> {
  const containers = layout(4, 1200, 760)
  const panes = await Promise.all(containers.map(createPane))
  await painted()
  const cells = panes.map((pane) => pane.host.parentElement!)
  const parking = document.createElement('div')
  parking.style.cssText =
    'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;overflow:hidden;pointer-events:none'
  document.body.append(parking)
  // Mirror detachTerminalSurface: blur and park three runtimes; they keep receiving output.
  const parked = panes.slice(1)
  for (const pane of parked) {
    pane.term.blur()
    parking.append(pane.host)
  }
  await painted()
  const workload = sgrLines(4 * 1024 * 1024)
  const queue = frames(workload.text)
  const marker = 'resume-marker-visible'
  beginMeasure()
  const start = performance.now()
  for (const pane of panes) pane.feeder.start(queue)
  await Promise.all(panes.map((pane) => pane.feeder.applied()))
  for (const pane of panes) pane.feeder.start([encoder.encode(`\r\n${marker}`)])
  await Promise.all(panes.map((pane) => pane.feeder.applied()))
  await presented(panes.slice(0, 1))
  const elapsed = performance.now() - start
  const surface = endMeasure()
  // Worker surfaces are counted by terminal (they have no page-side VT object).
  const vt = (pane: Pane) =>
    workerSurface(pane.term) ? pane.term : (pane.term as unknown as { vt: unknown }).vt
  const hiddenRenders = parked.reduce((total, pane) => total + (rendersByVt.get(vt(pane)) ?? 0), 0)
  const visibleRenders = rendersByVt.get(vt(panes[0]!)) ?? 0
  // Mirror attachTerminalRuntime: reattach, refit, force a render; state must be current.
  parked.forEach((pane, index) => cells[index + 1]!.append(pane.host))
  for (const pane of parked) {
    const size = pane.term.proposeDimensions()
    if (size) pane.term.resize(size.cols, size.rows)
    pane.term.refresh(0, pane.term.rows - 1)
  }
  await painted()
  await presented(parked)
  const restored = parked.map((pane) => {
    const canvas = pane.host.querySelector('canvas')!
    return {
      reader: readerText(pane).includes(marker),
      // A worker-owned canvas is an OffscreenCanvas placeholder; its frame proves the repaint.
      canvas: workerSurface(pane.term) !== null || (canvas.width > 1 && canvas.height > 1),
    }
  })
  if (!restored.every((item) => item.reader && item.canvas))
    throw new Error(`hidden panes did not restore current state: ${JSON.stringify(restored)}`)
  const after = await memory(panes)
  return {
    scenario: 'hidden-panes',
    elapsedMs: round(elapsed),
    visibleRenders,
    hiddenRenders,
    ...surface,
    restored,
    memoryAfter: after,
  }
}

async function idle(): Promise<Json> {
  const panes = await Promise.all(layout(4, 1200, 760).map(createPane))
  for (const pane of panes) {
    pane.feeder.start(frames(sgrLines(64 * 1024).text))
    await pane.feeder.applied()
  }
  await painted()
  await sleep(200)
  let rafRequests = 0
  const originalRaf = window.requestAnimationFrame.bind(window)
  window.requestAnimationFrame = (callback) => {
    rafRequests++
    return originalRaf(callback)
  }
  beginMeasure()
  await sleep(3000)
  const surface = endMeasure()
  window.requestAnimationFrame = originalRaf
  return { scenario: 'idle', idleMs: 3000, rafRequests, ...surface }
}

async function createClose(): Promise<Json> {
  const [container] = layout(1, 1200, 760)
  const payload = frames(sgrLines(64 * 1024).text)
  const cycle = async () => {
    const start = performance.now()
    const pane = await createPane(container!)
    pane.feeder.start(payload)
    await pane.feeder.applied()
    await painted()
    pane.feeder.close()
    pane.writer.dispose()
    pane.term.dispose()
    return performance.now() - start
  }
  for (let warm = 0; warm < 3; warm++) await cycle()
  const before = await memory([])
  const durations: number[] = []
  for (let index = 0; index < cycles; index++) durations.push(await cycle())
  const after = await memory([])
  return { scenario: 'create-close', cycles, cycleMs: stats(durations), before, after }
}

/** A TUI repainting the whole screen once per display frame (htop, vim scrolling). */
async function tuiRedraw(): Promise<Json> {
  const [pane] = await Promise.all(layout(1, 1200, 760).map(createPane))
  await painted()
  const count = 180
  const workload = tuiFrames(count, pane!.term.cols, pane!.term.rows)
  const screens = workload.text.split('\x1b[?2026l').slice(0, count)
  const probe = frameProbe()
  beginMeasure()
  const { value: elapsed, profile: cpu } = await profiled(async () => {
    const start = performance.now()
    for (const screen of screens) {
      pane!.feeder.start([encoder.encode(`${screen}\x1b[?2026l`)])
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }
    await pane!.feeder.applied()
    await painted()
    return performance.now() - start
  })
  const surface = endMeasure()
  const frameIntervals = probe()
  if (!readerText(pane!).includes(workload.last) || pane!.resyncs !== 0)
    throw new Error(`tui-redraw: final screen mismatch: ${readerText(pane!).slice(0, 200)}`)
  return {
    scenario: 'tui-redraw',
    geometry: `${pane!.term.cols}x${pane!.term.rows}`,
    screens: count,
    presentedMs: round(elapsed),
    draws: [...drawsByTerm.values()].reduce((a, b) => a + b, 0),
    frameIntervalMs: stats(frameIntervals),
    slowFrames: frameIntervals.filter((interval) => interval > 34).length,
    ...surface,
    memoryAfter: await memory([pane!]),
    ...(cpu ? { profile: cpu } : {}),
  }
}

const scenarios: Record<string, () => Promise<Json>> = {
  startup,
  'flood-plain': () => flood('flood-plain', () => plainLines(16 * 1024 * 1024)),
  'flood-sgr': () => flood('flood-sgr', () => sgrLines(8 * 1024 * 1024)),
  'flood-unicode': () => flood('flood-unicode', () => unicodeLines(4 * 1024 * 1024)),
  'tui-redraw': tuiRedraw,
  'flood-sgr-4': () => flood('flood-sgr-4', () => sgrLines(4 * 1024 * 1024), 4),
  'input-under-load-1': () => inputUnderLoad(1),
  'input-under-load-4': () => inputUnderLoad(4),
  'hidden-panes': hiddenPanes,
  idle,
  'create-close': createClose,
}

async function main(): Promise<void> {
  const errors: string[] = []
  window.addEventListener('error', (event) => errors.push(String(event.error ?? event.message)))
  const run = scenarios[scenario]
  if (!run) throw new Error(`Unknown scenario ${scenario}`)
  const result = await run()
  if (errors.length > 0) throw new Error(`Renderer errors: ${errors.join('; ')}`)
  await host('/result', { result: { ...result, devicePixelRatio: devicePixelRatio, scale } })
}

main().catch((error: unknown) =>
  host('/result', { error: String(error instanceof Error ? error.stack : error) }),
)

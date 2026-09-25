/* Browser half of `bun run bench:surface`: drives the production TauTerminal, sequenced writer and
 * packaged Ghostty WASM with synthetic, flow-controlled output frames. No PTY, daemon or preload.
 * Timings are renderer main-thread work: parse acknowledgement and requestAnimationFrame draw
 * callbacks. They do not include compositor rasterization or physical display presentation. */
import { TauTerminal } from '../src/renderer/tau-terminal'
import { createSequencedTerminalWriter } from '../src/renderer/terminal-output-writer'

type Pane = {
  readonly term: TauTerminal
  readonly wrapper: HTMLElement
  readonly writer: ReturnType<typeof createSequencedTerminalWriter>
  readonly frames: Uint8Array[]
  readonly marker: string
  next: number
  sentSeq: number
  ackedSeq: number
  inflightBytes: number
  lastSeq: number
  echoes: Array<{ seq: number; at: number; ackAt: number }>
  done: () => void
}

type ScenarioResult = Record<string, unknown>

// Mirror main's per-session backlog bound (512 frames / 4 MiB) with a smaller byte window so the
// renderer writer's 4 MiB overflow/resync path is never the thing being measured.
const WINDOW_FRAMES = 512
const WINDOW_BYTES = 2 * 1024 * 1024
const encoder = new TextEncoder()

const nativeRaf = window.requestAnimationFrame.bind(window)
const frameWork: number[] = []
let callbackCount = 0
let lastFrameTime = -1
let lastCallbackEnd = 0
window.requestAnimationFrame = (callback) =>
  nativeRaf((time) => {
    const start = performance.now()
    try {
      callback(time)
    } finally {
      const end = performance.now()
      callbackCount += 1
      lastCallbackEnd = end
      if (time !== lastFrameTime) frameWork.push(0)
      frameWork[frameWork.length - 1]! += end - start
      lastFrameTime = time
    }
  })

const painted = () => new Promise((resolve) => nativeRaf(() => nativeRaf(resolve)))
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const gc = () => (window as unknown as { gc?: () => void }).gc?.()

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
}

function summary(values: number[]) {
  const round = (value: number) => Math.round(value * 1000) / 1000
  return {
    n: values.length,
    p50: round(percentile(values, 50)),
    p95: round(percentile(values, 95)),
    p99: round(percentile(values, 99)),
    max: round(values.length ? Math.max(...values) : 0),
    total: round(values.reduce((sum, value) => sum + value, 0)),
  }
}

async function heapBytes(): Promise<number> {
  return ((await control('/heap')) as { usedSize: number }).usedSize
}

function wasmBytes(term: TauTerminal): number {
  const vt = (term as unknown as { vt: { api: { memory: WebAssembly.Memory } } }).vt
  return vt.api.memory.buffer.byteLength
}

function screenText(pane: { wrapper: HTMLElement }): string {
  return pane.wrapper.querySelector('pre')?.textContent ?? ''
}

function canvasHasInk(pane: { wrapper: HTMLElement }): boolean {
  const canvas = pane.wrapper.querySelector('canvas')
  if (!canvas || canvas.width < 4 || canvas.height < 4) return false
  const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
  for (let i = 4; i < data.length; i += 4) {
    if (data[i] !== data[0] || data[i + 1] !== data[1] || data[i + 2] !== data[2]) return true
  }
  return false
}

/** Deterministic plain or SGR-heavy lines, cut into complete frames at line boundaries. */
function makeFrames(
  totalBytes: number,
  frameBytes: number,
  style: 'plain' | 'ansi',
  marker: string,
): Uint8Array[] {
  const frames: Uint8Array[] = []
  let chunk = ''
  let bytes = 0
  for (let line = 0; bytes < totalBytes; line++) {
    let text: string
    if (style === 'plain') {
      text = `${String(line).padStart(8, '0')} ${'the quick brown fox jumps over the lazy dog '.repeat(2)}\r\n`
    } else {
      text = `\x1b[1;38;5;${line % 216}m${String(line).padStart(8, '0')}\x1b[0m `
      for (let word = 0; word < 8; word++) {
        text += `\x1b[${31 + ((line + word) % 7)}m${word % 3 === 0 ? '\x1b[4m' : ''}token${word}\x1b[0m `
      }
      text += `\x1b[48;2;${line % 256};40;60m bg \x1b[0m\r\n`
    }
    if (chunk.length + text.length > frameBytes && chunk) {
      frames.push(encoder.encode(chunk))
      chunk = ''
    }
    chunk += text
    bytes += text.length
  }
  frames.push(encoder.encode(`${chunk}\r\n${marker}\r\n`))
  return frames
}

function layout(host: HTMLElement, count: number, width: number, height: number): HTMLElement[] {
  host.replaceChildren()
  const columns = count === 1 ? 1 : 2
  const rows = Math.ceil(count / columns)
  host.style.cssText = `display:grid;grid-template-columns:repeat(${columns},1fr);grid-template-rows:repeat(${rows},1fr);width:${width}px;height:${height}px;gap:0`
  return Array.from({ length: count }, () => {
    const cell = document.createElement('div')
    cell.style.cssText = 'width:100%;height:100%;min-width:0;min-height:0'
    host.appendChild(cell)
    return cell
  })
}

/** Production parks hidden runtimes in a fixed 1x1 off-screen container (terminal.ts). */
function parking(): HTMLElement {
  let element = document.getElementById('parking')
  if (!element) {
    element = document.createElement('div')
    element.id = 'parking'
    element.setAttribute('aria-hidden', 'true')
    element.style.cssText =
      'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;overflow:hidden;pointer-events:none'
    document.body.appendChild(element)
  }
  return element
}

async function openPane(container: HTMLElement, marker: string, frames: Uint8Array[]) {
  const term = await TauTerminal.create()
  const wrapper = document.createElement('div')
  wrapper.style.cssText = 'width:100%;height:100%'
  container.appendChild(wrapper)
  term.open(wrapper)
  const size = term.proposeDimensions()
  if (size) term.resize(size.cols, size.rows)
  const pane = {
    term,
    wrapper,
    frames,
    marker,
    next: 0,
    sentSeq: 0,
    ackedSeq: 0,
    inflightBytes: 0,
    lastSeq: frames.length,
    echoes: [],
    done: () => {},
  } as unknown as Pane
  const sizes = new Map<number, number>()
  const port = new MessageChannel()
  port.port2.onmessage = (event: MessageEvent<{ seq: number; data: Uint8Array }>) => {
    // A fresh exact-sized buffer per message, as contextBridge hands the renderer.
    pane.writer.writeOwned(Uint8Array.from(event.data.data), event.data.seq)
  }
  const send = (data: Uint8Array) => {
    pane.sentSeq += 1
    sizes.set(pane.sentSeq, data.byteLength)
    pane.inflightBytes += data.byteLength
    port.port1.postMessage({ seq: pane.sentSeq, data })
    return pane.sentSeq
  }
  ;(pane as { writer: Pane['writer'] }).writer = createSequencedTerminalWriter(term, {
    onApplied(seq) {
      for (let acked = pane.ackedSeq + 1; acked <= seq; acked++) {
        pane.inflightBytes -= sizes.get(acked) ?? 0
        sizes.delete(acked)
      }
      pane.ackedSeq = Math.max(pane.ackedSeq, seq)
      const now = performance.now()
      for (const echo of pane.echoes) if (echo.ackAt === 0 && seq >= echo.seq) echo.ackAt = now
      pump()
    },
    onResync() {
      throw new Error(`${marker}: writer requested a resync (overflow) during the benchmark`)
    },
    onWriteError(error) {
      throw error
    },
    // Mirrors terminal.ts; the baseline writer ignores the option.
    isBackground: () => (term as unknown as { hidden?: boolean }).hidden === true,
  })
  const pump = () => {
    while (
      pane.next < pane.frames.length &&
      pane.sentSeq - pane.ackedSeq < WINDOW_FRAMES &&
      pane.inflightBytes < WINDOW_BYTES
    ) {
      send(pane.frames[pane.next++]!)
    }
    if (pane.next === pane.frames.length && pane.ackedSeq >= pane.sentSeq) pane.done()
  }
  ;(pane as { pump?: () => void }).pump = pump
  ;(pane as { close?: () => void }).close = () => {
    port.port1.close()
    port.port2.close()
    pane.writer.dispose()
    term.dispose()
  }
  ;(pane as { echo?: () => void }).echo = () => {
    // A PTY echo enters the stream now: behind in-flight output, ahead of unsent output.
    pane.echoes.push({ seq: send(encoder.encode('a')), at: performance.now(), ackAt: 0 })
  }
  return pane as Pane & { pump(): void; echo(): void; close(): void }
}

async function control(path: string, body: unknown = {}): Promise<unknown> {
  const response = await fetch(path, { method: 'POST', body: JSON.stringify(body) })
  return response.json()
}

function lagProbe() {
  const lags: number[] = []
  let expected = performance.now() + 4
  let stopped = false
  const tick = () => {
    if (stopped) return
    const now = performance.now()
    lags.push(Math.max(0, now - expected))
    expected = now + 4
    setTimeout(tick, 4)
  }
  setTimeout(tick, 4)
  return () => {
    stopped = true
    return lags
  }
}

type FloodOptions = {
  name: string
  visible: number
  parked: number
  bytesPerPane: number
  frameBytes: number
  style: 'plain' | 'ansi'
  width: number
  height: number
  inputIntervalMs: number
}

async function flood(host: HTMLElement, options: FloodOptions): Promise<ScenarioResult> {
  const containers = layout(host, Math.max(1, options.visible), options.width, options.height)
  const panes: Array<Awaited<ReturnType<typeof openPane>>> = []
  const idleVisible = options.visible === 0
  for (let index = 0; index < Math.max(1, options.visible); index++) {
    const marker = `END-${options.name}-${index}`
    const bytes = idleVisible ? 0 : options.bytesPerPane
    panes.push(
      await openPane(
        containers[index]!,
        marker,
        makeFrames(bytes, options.frameBytes, options.style, marker),
      ),
    )
  }
  const parked: typeof panes = []
  for (let index = 0; index < options.parked; index++) {
    const slot = document.createElement('div')
    slot.style.cssText = 'width:600px;height:360px'
    host.appendChild(slot)
    const marker = `END-${options.name}-parked-${index}`
    const pane = await openPane(
      slot,
      marker,
      makeFrames(options.bytesPerPane, options.frameBytes, options.style, marker),
    )
    await painted()
    pane.term.blur()
    parking().appendChild(pane.wrapper)
    slot.remove()
    parked.push(pane)
  }
  const target = panes[0]!
  target.term.focus()
  const received: number[] = []
  const pendingKeys: number[] = []
  const onKey = (event: KeyboardEvent) => pendingKeys.push(event.timeStamp)
  window.addEventListener('keydown', onKey, true)
  const dataSubscription = target.term.onData(() => {
    const at = pendingKeys.shift()
    if (at !== undefined) received.push(performance.now() - at)
    target.echo()
  })
  const flooding = idleVisible ? parked : [...panes, ...parked]
  await painted()
  gc()
  const heapBefore = await heapBytes()
  const wasmBefore = [...panes, ...parked].reduce((sum, pane) => sum + wasmBytes(pane.term), 0)
  const startFrames = frameWork.length
  const startCallbacks = callbackCount
  const metricsBefore = await control('/metrics')
  const stopLag = lagProbe()
  const longTasks: number[] = []
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longTasks.push(entry.duration)
  })
  observer.observe({ type: 'longtask', buffered: false })
  await control('/input/start', { intervalMs: options.inputIntervalMs })
  const started = performance.now()
  await Promise.all(
    flooding.map(
      (pane) =>
        new Promise<void>((resolve) => {
          pane.done = resolve
          pane.pump()
        }),
    ),
  )
  const parsedMs = performance.now() - started
  await control('/input/stop')
  // Let echoes emitted by the final input events drain before closing the input window.
  const settleDeadline = performance.now() + 2000
  while (performance.now() < settleDeadline && target.echoes.some((echo) => echo.ackAt === 0)) {
    await sleep(5)
  }
  await painted()
  const drawEnd = lastCallbackEnd
  const lags = stopLag()
  observer.disconnect()
  window.removeEventListener('keydown', onKey, true)
  dataSubscription.dispose()
  const metricsAfter = (await control('/metrics')) as Record<string, number>
  const frames = frameWork.slice(startFrames)
  gc()
  const heapAfter = await heapBytes()
  const wasmAfter = [...panes, ...parked].reduce((sum, pane) => sum + wasmBytes(pane.term), 0)

  // Correctness: every visible pane shows its end marker; the writer never dropped output.
  const failures: string[] = []
  for (const pane of flooding) {
    const diagnostics = pane.writer.diagnostics()
    if (diagnostics.droppedWriteQueueChunksTotal > 0 || diagnostics.dropNoticeCount > 0)
      failures.push(`${pane.marker}: dropped output`)
    if (pane.ackedSeq !== pane.sentSeq) failures.push(`${pane.marker}: unacknowledged output`)
  }
  for (const pane of idleVisible ? [] : panes) {
    if (!screenText(pane).includes(pane.marker)) failures.push(`${pane.marker}: missing on screen`)
    if (!canvasHasInk(pane)) failures.push(`${pane.marker}: blank canvas`)
  }
  // Reattach parked panes one at a time into a visible slot and verify their final screen.
  let reattachMs = 0
  for (const pane of parked) {
    const slot = document.createElement('div')
    slot.style.cssText = 'width:600px;height:360px'
    host.appendChild(slot)
    const firstFrame = frameWork.length
    slot.appendChild(pane.wrapper)
    pane.term.refresh(0, pane.term.rows - 1)
    await painted()
    reattachMs += frameWork.slice(firstFrame).reduce((sum, value) => sum + value, 0)
    if (!screenText(pane).includes(pane.marker))
      failures.push(`${pane.marker}: missing after reattach`)
    if (!canvasHasInk(pane)) failures.push(`${pane.marker}: blank canvas after reattach`)
    slot.remove()
  }
  const echoAck = target.echoes.filter((echo) => echo.ackAt > 0).map((echo) => echo.ackAt - echo.at)
  const totalBytes = flooding.reduce(
    (sum, pane) => sum + pane.frames.reduce((bytes, frame) => bytes + frame.byteLength, 0),
    0,
  )
  const result: ScenarioResult = {
    name: options.name,
    geometry: panes.map((pane) => `${pane.term.cols}x${pane.term.rows}`),
    parked: parked.length,
    bytes: totalBytes,
    parsedMs: Math.round(parsedMs * 10) / 10,
    mibPerSec: Math.round((totalBytes / 1048576 / (parsedMs / 1000)) * 10) / 10,
    drawWindowMs: Math.round((drawEnd - started) * 10) / 10,
    rafCallbacks: callbackCount - startCallbacks,
    frameWorkMs: summary(frames),
    keyToDataMs: summary(received),
    echoParsedMs: summary(echoAck),
    eventLoopLagMs: summary(lags),
    longTasks: summary(longTasks),
    rendererTaskMs: Math.round(
      (metricsAfter.TaskDuration - (metricsBefore as Record<string, number>).TaskDuration) * 1000,
    ),
    rendererScriptMs: Math.round(
      (metricsAfter.ScriptDuration - (metricsBefore as Record<string, number>).ScriptDuration) *
        1000,
    ),
    layoutMs: Math.round(
      (metricsAfter.LayoutDuration - (metricsBefore as Record<string, number>).LayoutDuration) *
        1000,
    ),
    styleMs: Math.round(
      (metricsAfter.RecalcStyleDuration -
        (metricsBefore as Record<string, number>).RecalcStyleDuration) *
        1000,
    ),
    jsHeapDeltaKiB: Math.round((heapAfter - heapBefore) / 1024),
    wasmBytesBefore: wasmBefore,
    wasmBytesAfter: wasmAfter,
    reattachMs: Math.round(reattachMs * 10) / 10,
    failures,
  }
  for (const pane of [...panes, ...parked]) pane.close()
  host.replaceChildren()
  return result
}

/** A one-line progress update at ~120 Hz after a click (which leaves a selection anchor). */
async function progress(host: HTMLElement, width: number, height: number): Promise<ScenarioResult> {
  const [container] = layout(host, 1, width, height)
  const pane = await openPane(container!, 'progress', makeFrames(64 * 1024, 4096, 'ansi', 'ready'))
  await new Promise<void>((resolve) => {
    pane.done = resolve
    pane.pump()
  })
  await painted()
  await control('/click')
  await painted()
  const startCallbacks = callbackCount
  const startFrames = frameWork.length
  const before = (await control('/metrics')) as Record<string, number>
  const updates = 360
  for (let step = 1; step <= updates; step++) {
    pane.frames.push(encoder.encode(`\r\x1b[K\x1b[32mprogress ${step}/${updates}\x1b[0m`))
    pane.pump()
    await sleep(8)
  }
  await painted()
  const after = (await control('/metrics')) as Record<string, number>
  const result = {
    name: 'progress-after-click',
    rafCallbacks: callbackCount - startCallbacks,
    frameWorkMs: summary(frameWork.slice(startFrames)),
    rendererTaskMs: Math.round((after.TaskDuration - before.TaskDuration) * 1000),
    layoutMs: Math.round((after.LayoutDuration - before.LayoutDuration) * 1000),
    failures: screenText(pane).includes(`progress ${updates}/${updates}`)
      ? []
      : ['progress line missing'],
  }
  pane.close()
  host.replaceChildren()
  return result
}

async function idle(host: HTMLElement, width: number, height: number): Promise<ScenarioResult> {
  const [container] = layout(host, 1, width, height)
  const pane = await openPane(container!, 'idle', [encoder.encode('user@host:~$ ')])
  pane.term.focus()
  await new Promise<void>((resolve) => {
    pane.done = resolve
    pane.pump()
  })
  await painted()
  await sleep(200)
  const startCallbacks = callbackCount
  const startFrames = frameWork.length
  const before = (await control('/metrics')) as Record<string, number>
  await sleep(3000)
  const after = (await control('/metrics')) as Record<string, number>
  const result = {
    name: 'idle-3s',
    rafCallbacks: callbackCount - startCallbacks,
    frameWorkMs: summary(frameWork.slice(startFrames)),
    rendererTaskMs: Math.round((after.TaskDuration - before.TaskDuration) * 1000),
    failures: screenText(pane).includes('user@host') ? [] : ['idle prompt missing'],
  }
  pane.close()
  host.replaceChildren()
  return result
}

async function lifecycle(host: HTMLElement, cycles: number): Promise<ScenarioResult> {
  const [container] = layout(host, 1, 600, 360)
  gc()
  await sleep(50)
  gc()
  const heapBefore = await heapBytes()
  const rssBefore = ((await control('/metrics')) as Record<string, number>).rendererRssKiB
  const createMs: number[] = []
  const firstDrawMs: number[] = []
  const failures: string[] = []
  const payload = makeFrames(256 * 1024, 16 * 1024, 'ansi', 'cycle-end')
  for (let cycle = 0; cycle < cycles; cycle++) {
    const begin = performance.now()
    const pane = await openPane(container!, `cycle-${cycle}`, payload)
    createMs.push(performance.now() - begin)
    await new Promise<void>((resolve) => {
      pane.done = resolve
      pane.pump()
    })
    await painted()
    firstDrawMs.push(performance.now() - begin)
    if (!screenText(pane).includes('cycle-end')) failures.push(`cycle ${cycle}: missing output`)
    pane.close()
    container!.replaceChildren()
  }
  gc()
  await sleep(50)
  gc()
  const rssAfter = ((await control('/metrics')) as Record<string, number>).rendererRssKiB
  const result = {
    name: `create-close-x${cycles}`,
    createMs: summary(createMs),
    createAndDrawMs: summary(firstDrawMs),
    jsHeapDeltaKiB: Math.round(((await heapBytes()) - heapBefore) / 1024),
    rendererRssDeltaKiB: rssAfter - rssBefore,
    failures,
  }
  host.replaceChildren()
  return result
}

async function startup(host: HTMLElement): Promise<ScenarioResult> {
  // Cold path of the first pane: fetch + compile WASM, instantiate, open canvas, first prompt draw.
  const [container] = layout(host, 1, 1200, 720)
  const begin = performance.now()
  const term = await TauTerminal.create()
  const created = performance.now()
  term.open(container!)
  const size = term.proposeDimensions()
  if (size) term.resize(size.cols, size.rows)
  term.write('user@host:~$ ')
  await new Promise((resolve) => nativeRaf(resolve))
  await new Promise((resolve) => nativeRaf(resolve))
  const drawn = lastCallbackEnd
  const text = container!.querySelector('pre')?.textContent ?? ''
  term.dispose()
  host.replaceChildren()
  return {
    name: 'startup-first-pane',
    createMs: Math.round((created - begin) * 10) / 10,
    firstDrawMs: Math.round((drawn - begin) * 10) / 10,
    failures: text.includes('user@host') ? [] : ['startup prompt missing'],
  }
}

async function run(config: { mib: number; scenarios: string[]; cycles: number }) {
  const host = document.getElementById('host')!
  const mib = config.mib * 1024 * 1024
  const want = (name: string) => config.scenarios.length === 0 || config.scenarios.includes(name)
  const results: ScenarioResult[] = []
  if (want('startup')) results.push(await startup(host))
  const common = { frameBytes: 4096, width: 1200, height: 720, inputIntervalMs: 50 }
  if (want('single-plain'))
    results.push(
      await flood(host, {
        ...common,
        name: 'single-plain',
        visible: 1,
        parked: 0,
        bytesPerPane: mib,
        style: 'plain',
      }),
    )
  if (want('single-ansi'))
    results.push(
      await flood(host, {
        ...common,
        name: 'single-ansi',
        visible: 1,
        parked: 0,
        bytesPerPane: mib / 2,
        style: 'ansi',
      }),
    )
  if (want('quad-ansi'))
    results.push(
      await flood(host, {
        ...common,
        name: 'quad-ansi',
        visible: 4,
        parked: 0,
        bytesPerPane: mib / 4,
        style: 'ansi',
      }),
    )
  if (want('parked-ansi'))
    results.push(
      await flood(host, {
        ...common,
        name: 'parked-ansi',
        visible: 0,
        parked: 4,
        bytesPerPane: mib / 4,
        style: 'ansi',
      }),
    )
  if (want('progress')) results.push(await progress(host, 1200, 720))
  if (want('idle')) results.push(await idle(host, 1200, 720))
  if (want('lifecycle')) results.push(await lifecycle(host, config.cycles))
  return results
}

Object.assign(window, { TauSurfaceBench: { run } })

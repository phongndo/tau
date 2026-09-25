/* Electron main half of `bun run bench:surface`: one scenario per process for isolation.
 * Serves the bundled page and packaged Ghostty WASM, injects real Chromium input events, and
 * exposes CDP GC/heap/profiler and per-process metrics to the page. */
import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'

const arg = (name: string) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const bundlePath = arg('bundle')
const wasmPath = arg('wasm')
const scenario = arg('scenario')
const output = arg('out')
const profile = arg('profile') === '1'
const cycles = arg('cycles') ?? '30'
if (!bundlePath || !wasmPath || !scenario || !output) {
  throw new Error('Usage: --bundle= --wasm= --scenario= --out= [--profile=1]')
}
const bundle = readFileSync(bundlePath)
const wasm = readFileSync(wasmPath)

// Keep the production renderer switches that affect canvas/GPU and V8 heap behavior.
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('enable-zero-copy')
app.commandLine.appendSwitch('enable-native-gpu-memory-buffers')
app.commandLine.appendSwitch('enable-accelerated-2d-canvas')
app.commandLine.appendSwitch('enable-features', 'Canvas2dRenderingTBR,CanvasOopRasterization')
app.commandLine.appendSwitch('disable-features', 'PaintHolding,FlushTasksBetweenFrameIntervals')
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=256')
app.commandLine.appendSwitch('force-device-scale-factor', '1')

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
:root { --terminal-font-size: 14px; --terminal-font-family: monospace; }
body { margin: 0; background: #151515; }
</style></head><body><div id="root"></div><script src="/bench.js"></script></body></html>`

function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {})
      } catch (error) {
        reject(error)
      }
    })
  })
}

type ProfileNode = {
  id: number
  callFrame: { functionName: string; url: string; lineNumber: number }
  hitCount?: number
  selfSize?: number
  children?: Array<ProfileNode | number>
}

function frameName(node: ProfileNode): string {
  const { functionName, url, lineNumber } = node.callFrame
  const file = url.split('/').at(-1) ?? ''
  return `${functionName || '(anonymous)'}${file ? ` ${file}:${lineNumber + 1}` : ''}`
}

function top(entries: Map<string, number>, count: number): Array<[string, number]> {
  return [...entries].sort((a, b) => b[1] - a[1]).slice(0, count)
}

function summarizeCpu(profile: {
  nodes: ProfileNode[]
  samples: number[]
  timeDeltas: number[]
  startTime: number
  endTime: number
}) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]))
  const self = new Map<string, number>()
  const interval = (profile.endTime - profile.startTime) / Math.max(1, profile.samples.length)
  for (const id of profile.samples) {
    const name = frameName(byId.get(id)!)
    self.set(name, (self.get(name) ?? 0) + interval / 1000)
  }
  const total = (profile.endTime - profile.startTime) / 1000
  return {
    totalMs: Math.round(total),
    idleMs: Math.round(self.get('(idle)') ?? 0),
    gcMs: Math.round(self.get('(garbage collector)') ?? 0),
    programMs: Math.round(self.get('(program)') ?? 0),
    topSelfMs: top(self, 14).map(([name, ms]) => [name, Math.round(ms * 10) / 10]),
  }
}

function summarizeHeap(profile: { head: ProfileNode }) {
  const bySite = new Map<string, number>()
  let total = 0
  const visit = (node: ProfileNode) => {
    const size = node.selfSize ?? 0
    total += size
    if (size > 0) bySite.set(frameName(node), (bySite.get(frameName(node)) ?? 0) + size)
    for (const child of node.children ?? []) if (typeof child !== 'number') visit(child)
  }
  visit(profile.head)
  return {
    sampledAllocatedMiB: Math.round((total / 1048576) * 10) / 10,
    topAllocatingMiB: top(bySite, 12).map(([name, bytes]) => [
      name,
      Math.round((bytes / 1048576) * 10) / 10,
    ]),
  }
}

async function main(): Promise<void> {
  let win: BrowserWindow | null = null
  let complete!: (value: Record<string, unknown>) => void
  const result = new Promise<Record<string, unknown>>((resolve) => (complete = resolve))
  const cdp = (method: string, params: Record<string, unknown> = {}) =>
    win!.webContents.debugger.sendCommand(method, params)

  const handlers: Record<string, (input: Record<string, unknown>) => Promise<unknown>> = {
    '/result': async (input) => {
      complete(input)
      return {}
    },
    '/metrics': async () => {
      const pid = win!.webContents.getOSProcessId()
      const metrics = app.getAppMetrics()
      const kb = (type: string, filter?: (pid: number) => boolean) =>
        metrics
          .filter((metric) => metric.type === type && (!filter || filter(metric.pid)))
          .reduce((total, metric) => total + metric.memory.workingSetSize, 0)
      return {
        rendererRssKb: kb('Tab', (value) => value === pid),
        gpuRssKb: kb('GPU'),
        mainRssKb: kb('Browser'),
      }
    },
    '/input': async (input) => {
      const count = Number(input.count)
      const intervalMs = Number(input.intervalMs)
      for (let index = 0; index < count; index++) {
        win!.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'a' })
        win!.webContents.sendInputEvent({ type: 'char', keyCode: 'a' })
        win!.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'a' })
        await new Promise((resolve) => setTimeout(resolve, intervalMs))
      }
      return {}
    },
    '/cdp': async (input) => {
      switch (input.op) {
        case 'gc':
          await cdp('HeapProfiler.collectGarbage')
          return {}
        case 'heap': {
          const usage = (await cdp('Runtime.getHeapUsage')) as {
            usedSize: number
            totalSize: number
          }
          return { jsHeapUsedKb: Math.round(usage.usedSize / 1024) }
        }
        case 'profile-start':
          await cdp('Profiler.enable')
          await cdp('Profiler.setSamplingInterval', { interval: 200 })
          await cdp('HeapProfiler.enable')
          await cdp('HeapProfiler.startSampling', {
            samplingInterval: 8192,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          })
          await cdp('Profiler.start')
          return {}
        case 'profile-stop': {
          const cpu = (await cdp('Profiler.stop')) as {
            profile: Parameters<typeof summarizeCpu>[0]
          }
          const heap = (await cdp('HeapProfiler.stopSampling')) as {
            profile: Parameters<typeof summarizeHeap>[0]
          }
          return { cpu: summarizeCpu(cpu.profile), allocation: summarizeHeap(heap.profile) }
        }
      }
      throw new Error(`Unknown CDP op ${String(input.op)}`)
    },
  }

  const server = createServer((req, res) => {
    const handler = req.method === 'POST' && req.url ? handlers[req.url] : undefined
    if (handler) {
      body(req)
        .then(handler)
        .then(
          (value) =>
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value)),
          (error: unknown) => res.writeHead(500).end(String(error)),
        )
      return
    }
    if (req.url === '/ghostty-vt.wasm')
      res.writeHead(200, { 'Content-Type': 'application/wasm' }).end(wasm)
    else if (req.url === '/bench.js')
      res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundle)
    else if (req.url?.startsWith('/?'))
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(html)
    else res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  await app.whenReady()
  win = new BrowserWindow({
    show: true,
    width: 1280,
    height: 800,
    useContentSize: true,
    backgroundColor: '#151515',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  })
  win.webContents.debugger.attach('1.3')
  try {
    const port = (server.address() as { port: number }).port
    await win.loadURL(
      `http://127.0.0.1:${port}/?scenario=${encodeURIComponent(scenario!)}&profile=${profile ? 1 : 0}&cycles=${cycles}`,
    )
    const reply = await Promise.race([
      result,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Surface benchmark ${scenario} timed out`)), 180_000),
      ),
    ])
    if (reply.error) throw new Error(String(reply.error))
    const gpu = app.getGPUFeatureStatus()
    writeFileSync(
      output!,
      JSON.stringify({
        ...(reply.result as Record<string, unknown>),
        gpu: { canvas: gpu['2d_canvas'], rasterization: gpu.rasterization },
      }),
    )
  } finally {
    win.destroy()
    server.close()
    app.quit()
  }
}

main().catch((error) => {
  console.error(error)
  app.exit(1)
})

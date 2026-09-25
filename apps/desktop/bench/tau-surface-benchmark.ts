/* Electron half of `bun run bench:surface`. Serves the bundled TauTerminal benchmark and the
 * packaged Ghostty WASM to a sandboxed renderer, injects real Chromium key events, samples renderer
 * CPU/RSS, and prints one JSON result line. Scenario failures (missing output, drops, resyncs) fail
 * the run. Needs a display; under Xvfb, canvas work is software-rasterized and says nothing about
 * GPU composition or physical presentation. */
import { app, BrowserWindow } from 'electron'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve } from 'node:path'

const desktop = process.cwd()
const scriptPath =
  process.env.TAU_SURFACE_BENCH_SCRIPT || resolve(desktop, '.bench-cache/tau-surface-bench.js')
const script = readFileSync(scriptPath)
const wasm = readFileSync(resolve(desktop, 'public/ghostty-vt.wasm'))
const config = {
  mib: Number(process.env.TAU_SURFACE_BENCH_MIB || 16),
  scenarios: (process.env.TAU_SURFACE_BENCH_SCENARIOS || '').split(',').filter(Boolean),
  cycles: Number(process.env.TAU_SURFACE_BENCH_CYCLES || 30),
}
const heapSampling = process.env.TAU_SURFACE_BENCH_HEAP === '1'

const html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; connect-src 'self'">
<style>
body { margin: 0; background: #151515; overflow: hidden; }
</style></head><body><div id="host"></div><script src="/bench.js"></script><script>
window.TauSurfaceBench.run(${JSON.stringify(config)}).then(
  results => fetch('/result', { method: 'POST', body: JSON.stringify({ results }) }),
  error => fetch('/result', { method: 'POST', body: JSON.stringify({ error: String(error.stack || error) }) }),
)
</script></body></html>`

app.commandLine.appendSwitch('js-flags', '--expose-gc')

async function main(): Promise<void> {
  await app.whenReady()
  const win = new BrowserWindow({
    show: true,
    width: 1280,
    height: 800,
    useContentSize: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  win.webContents.on('console-message', (event) => {
    if (event.level === 'warning' || event.level === 'error')
      console.error(`[renderer] ${event.message}`)
  })
  await win.loadURL('about:blank')
  const cdp = win.webContents.debugger
  cdp.attach('1.3')
  await cdp.sendCommand('Performance.enable')
  let inputTimer: ReturnType<typeof setInterval> | null = null
  let heapSamplingActive = false
  let complete!: (value: { results?: unknown[]; error?: string }) => void
  const result = new Promise<{ results?: unknown[]; error?: string }>((done) => (complete = done))

  const rendererRssKiB = () => {
    const pid = win.webContents.getOSProcessId()
    return app.getAppMetrics().find((metric) => metric.pid === pid)?.memory.workingSetSize ?? 0
  }
  const sampledAllocatedBytes = async () => {
    const { profile } = (await cdp.sendCommand('HeapProfiler.stopSampling')) as {
      profile: { head: { selfSize: number; children: unknown[] } }
    }
    let total = 0
    const visit = (node: { selfSize: number; children: unknown[] }) => {
      total += node.selfSize
      for (const child of node.children) visit(child as typeof node)
    }
    visit(profile.head)
    return total
  }

  const handlers: Record<string, (body: Record<string, number>) => Promise<unknown>> = {
    '/metrics': async () => {
      const { metrics } = (await cdp.sendCommand('Performance.getMetrics')) as {
        metrics: Array<{ name: string; value: number }>
      }
      const values = Object.fromEntries(metrics.map((metric) => [metric.name, metric.value]))
      return { ...values, rendererRssKiB: rendererRssKiB() }
    },
    '/heap': async () => {
      // Precise, unlike performance.memory: full GC, then V8's used heap size.
      await cdp.sendCommand('HeapProfiler.collectGarbage')
      const usage = (await cdp.sendCommand('Runtime.getHeapUsage')) as { usedSize: number }
      return { usedSize: usage.usedSize }
    },
    '/click': async () => {
      win.webContents.sendInputEvent({
        type: 'mouseDown',
        x: 100,
        y: 100,
        button: 'left',
        clickCount: 1,
      })
      win.webContents.sendInputEvent({
        type: 'mouseUp',
        x: 100,
        y: 100,
        button: 'left',
        clickCount: 1,
      })
      return {}
    },
    '/input/start': async (body) => {
      if (heapSampling) {
        await cdp.sendCommand('HeapProfiler.enable')
        await cdp.sendCommand('HeapProfiler.startSampling', {
          samplingInterval: 16384,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        })
        heapSamplingActive = true
      }
      inputTimer = setInterval(() => {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A' })
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A' })
      }, body.intervalMs || 50)
      return {}
    },
    '/input/stop': async () => {
      if (inputTimer) clearInterval(inputTimer)
      inputTimer = null
      if (!heapSamplingActive) return {}
      heapSamplingActive = false
      const allocated = await sampledAllocatedBytes()
      console.log(JSON.stringify({ heapSampledAllocatedBytes: allocated }))
      return { allocated }
    },
  }

  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const url = req.url ?? '/'
      const handler = handlers[url]
      if (handler && req.method === 'POST') {
        const text = Buffer.concat(chunks).toString()
        void handler(text ? JSON.parse(text) : {}).then(
          (value) =>
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value)),
          (error: unknown) => res.writeHead(500).end(String(error)),
        )
      } else if (url === '/result' && req.method === 'POST') {
        complete(JSON.parse(Buffer.concat(chunks).toString()))
        res.writeHead(200).end('{}')
      } else if (url === '/ghostty-vt.wasm') {
        res.writeHead(200, { 'Content-Type': 'application/wasm' }).end(wasm)
      } else if (url === '/bench.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(script)
      } else if (url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' }).end(html)
      } else {
        res.writeHead(404).end()
      }
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  try {
    await win.loadURL(`http://127.0.0.1:${(server.address() as { port: number }).port}/`)
    win.focus()
    const reply = await Promise.race([
      result,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Surface benchmark timed out')), 300_000),
      ),
    ])
    if (reply.error) throw new Error(reply.error)
    const failures = (reply.results ?? []).flatMap(
      (entry) => (entry as { failures?: string[] }).failures ?? [],
    )
    console.log(
      JSON.stringify({
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        script: scriptPath,
        config,
        results: reply.results,
      }),
    )
    if (failures.length > 0)
      throw new Error(`Surface benchmark correctness failures: ${failures.join('; ')}`)
  } finally {
    if (inputTimer) clearInterval(inputTimer)
    win.destroy()
    server.close()
    app.quit()
  }
}

main().catch((error) => {
  console.error(error)
  app.exit(1)
})

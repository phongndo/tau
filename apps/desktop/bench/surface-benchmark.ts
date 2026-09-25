/* Tau surface benchmark driver: the production TauTerminal canvas + Ghostty WASM + sequenced
 * writer in a sandboxed Electron renderer (unlike bench:terminal, which measures xterm.js).
 *
 *   TAU_SURFACE_BENCH_SOURCES="baseline=/path/to/other/apps/desktop,candidate=."   (default: this tree)
 *   TAU_SURFACE_BENCH_SCENARIOS=flood-sgr,input-under-load-4   TAU_SURFACE_BENCH_ROUNDS=3
 *   TAU_SURFACE_BENCH_CYCLES=30   (create-close iterations)
 *   TAU_SURFACE_BENCH_PROFILE=1   (separate attribution run: CPU profile + sampled allocations)
 *
 * Sources run in alternating order each round, one Electron process per scenario. Needs a display
 * (Xvfb on headless Linux). Xvfb/software-canvas results are not GPU or presentation measurements.
 */
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const desktop = resolve(import.meta.dir, '..')
const require = createRequire(import.meta.url)
const electronPath = require('electron') as string
const cache = resolve(desktop, '.bench-cache/surface')
mkdirSync(cache, { recursive: true })

const ALL = [
  'startup',
  'flood-plain',
  'flood-sgr',
  'flood-unicode',
  'tui-redraw',
  'flood-sgr-4',
  'input-under-load-1',
  'input-under-load-4',
  'hidden-panes',
  'idle',
  'create-close',
]
const scenarios = (process.env.TAU_SURFACE_BENCH_SCENARIOS ?? ALL.join(',')).split(',')
const rounds = Number(process.env.TAU_SURFACE_BENCH_ROUNDS ?? '3')
const profile = process.env.TAU_SURFACE_BENCH_PROFILE === '1'
const sources = (process.env.TAU_SURFACE_BENCH_SOURCES ?? `current=${desktop}`)
  .split(',')
  .map((entry) => {
    const [label, root] = entry.split('=')
    return { label: label!, root: resolve(root ?? desktop) }
  })
const outputPath = resolve(process.env.TAU_SURFACE_BENCH_OUT ?? resolve(cache, 'results.json'))
const wasm = resolve(desktop, 'public/ghostty-vt.wasm')

async function bundlePage(label: string, root: string): Promise<string> {
  const rendererDir = resolve(root, 'src/renderer')
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, 'surface-benchmark-page.ts')],
    outdir: cache,
    naming: `page-${label}.js`,
    target: 'browser',
    format: 'iife',
    plugins: [
      {
        name: 'surface-source',
        setup(builder) {
          // Point the page's production imports at the selected source tree.
          builder.onResolve({ filter: /^\.\.\/src\/renderer\// }, (args) => ({
            path: resolve(rendererDir, `${args.path.slice('../src/renderer/'.length)}.ts`),
          }))
        },
      },
    ],
  })
  if (!build.success) throw new AggregateError(build.logs, `bundle ${label} failed`)
  return resolve(cache, `page-${label}.js`)
}

const electronMain = await Bun.build({
  entrypoints: [resolve(import.meta.dir, 'surface-benchmark-electron.ts')],
  outdir: cache,
  naming: 'electron-main.mjs',
  target: 'node',
  format: 'esm',
  packages: 'external',
})
if (!electronMain.success) throw new AggregateError(electronMain.logs, 'electron main build failed')
const bundles = new Map<string, string>()
for (const source of sources) bundles.set(source.label, await bundlePage(source.label, source.root))

async function runScenario(label: string, name: string): Promise<Record<string, unknown>> {
  const out = resolve(cache, `result-${label}-${name}.json`)
  rmSync(out, { force: true })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = Bun.spawn(
    [
      electronPath,
      resolve(cache, 'electron-main.mjs'),
      `--user-data-dir=${resolve(cache, `profile-${label}`)}`,
      `--bundle=${bundles.get(label)}`,
      `--wasm=${wasm}`,
      `--scenario=${name}`,
      `--out=${out}`,
      `--profile=${profile ? 1 : 0}`,
      `--cycles=${process.env.TAU_SURFACE_BENCH_CYCLES ?? '30'}`,
      ...(process.platform === 'linux' && process.env.CI === 'true' ? ['--no-sandbox'] : []),
    ],
    { stdout: 'inherit', stderr: 'pipe', env },
  )
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  if (code !== 0) throw new Error(`${label}/${name} exited ${code}\n${stderr.slice(-2000)}`)
  return JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>
}

const results: Array<{ round: number; source: string; result: Record<string, unknown> }> = []
for (let round = 0; round < rounds; round++) {
  const order = round % 2 === 0 ? sources : [...sources].reverse()
  for (const name of scenarios) {
    for (const source of order) {
      const result = await runScenario(source.label, name)
      results.push({ round, source: source.label, result })
      writeFileSync(outputPath, JSON.stringify({ sources, rounds, profile, results }, null, 2))
      console.log(`[surface] round ${round + 1}/${rounds} ${source.label} ${name} done`)
    }
  }
}
writeFileSync(outputPath, JSON.stringify({ sources, rounds, profile, results }, null, 2))

const METRICS: Record<string, string[]> = {
  startup: ['coldCreateMs', 'coldFirstFrameMs', 'warmCreateMs.1', 'warmFirstFrameMs.1'],
  flood: [
    'presentedMs',
    'mibPerSec',
    'parseMs.sum',
    'renderMs.sum',
    'drawMs.sum',
    'drawMs.p95',
    'draws',
    'longTasks.count',
    'frameIntervalMs.p95',
    'memoryAfter.jsHeapUsedKb',
    'memoryAfter.rendererRssKb',
    'memoryAfter.wasmBytes.0',
  ],
  'tui-redraw': [
    'presentedMs',
    'draws',
    'renderMs.p50',
    'drawMs.p50',
    'drawMs.p95',
    'frameIntervalMs.p95',
    'slowFrames',
  ],
  input: [
    'dispatchDelayMs.p50',
    'dispatchDelayMs.p95',
    'dispatchDelayMs.max',
    'echoDrawnMs.p50',
    'echoDrawnMs.p95',
    'echoMissing',
    'drawMs.p95',
    'frameIntervalMs.p95',
    'bytesParsed',
  ],
  'hidden-panes': ['elapsedMs', 'visibleRenders', 'hiddenRenders', 'drawMs.sum', 'renderMs.sum'],
  idle: ['rafRequests', 'drawMs.n'],
  'create-close': [
    'cycleMs.p50',
    'before.jsHeapUsedKb',
    'after.jsHeapUsedKb',
    'before.rendererRssKb',
    'after.rendererRssKb',
  ],
}

function pick(value: unknown, path: string): number | undefined {
  let current = value
  for (const key of path.split('.')) current = (current as Record<string, unknown>)?.[key]
  return typeof current === 'number' ? current : undefined
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) / 2)]
}

for (const name of scenarios) {
  const group = name.startsWith('input') ? 'input' : name.startsWith('flood') ? 'flood' : name
  console.log(`\n${name} (median of ${rounds}; raw samples in ${outputPath})`)
  for (const metric of METRICS[group] ?? []) {
    const row = sources.map((source) => {
      const values = results
        .filter((item) => item.source === source.label && item.result.scenario === name)
        .map((item) => pick(item.result, metric))
        .filter((value): value is number => value !== undefined)
      return `${source.label}=${values.length ? median(values) : '-'} [${values.join(', ')}]`
    })
    console.log(`  ${metric.padEnd(26)} ${row.join('  ')}`)
  }
  if (profile) {
    for (const item of results.filter((entry) => entry.result.scenario === name)) {
      console.log(`  profile ${item.source}: ${JSON.stringify(item.result.profile)}`)
    }
  }
}

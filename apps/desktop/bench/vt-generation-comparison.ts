/**
 * Reproducible, headless VT ingestion comparison. This does NOT benchmark painting or taud.
 * Run: nix develop -c bun apps/desktop/bench/vt-generation-comparison.ts
 * Override the legacy WASM with TAU_GHOSTTY_WEB_WASM=/path/to/ghostty-vt.wasm.
 * The default is the cached ghostty-web@0.4.0-next.14.g6a1a50d npm artifact.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import xtermPackage from '@xterm/xterm'
import { GhosttyVt } from '../src/renderer/ghostty-vt'

const root = process.env.TAU_BENCH_DESKTOP ?? resolve(import.meta.dir, '..')
const oldWasm = readFileSync(
  process.env.TAU_GHOSTTY_WEB_WASM ??
    resolve(root, '.bench-cache/ghostty-web-0.4.0-next.14.g6a1a50d/package/ghostty-vt.wasm'),
)
const newWasm = readFileSync(resolve(root, 'public/ghostty-vt.wasm'))
const runs = Number(process.env.TAU_VT_BENCH_RUNS ?? 5)
if (!Number.isInteger(runs) || runs < 1 || runs > 30)
  throw new Error('TAU_VT_BENCH_RUNS must be 1..30')
const { Terminal: Xterm } = xtermPackage
const cols = 120
const rows = 40
const encoder = new TextEncoder()

type Runner = { write(data: Uint8Array): Promise<void>; verify(): void; close(): void }
type LegacyExports = {
  memory: WebAssembly.Memory
  ghostty_terminal_new(cols: number, rows: number): number
  ghostty_terminal_write(handle: number, ptr: number, len: number): void
  ghostty_terminal_free(handle: number): void
  ghostty_terminal_get_scrollback_length(handle: number): number
  ghostty_wasm_alloc_u8_array(len: number): number
  ghostty_wasm_free_u8_array(ptr: number, len: number): void
}

async function legacy(): Promise<Runner> {
  const module = await WebAssembly.instantiate(oldWasm, { env: { log: () => {} } })
  const api = module.instance.exports as unknown as LegacyExports
  const term = api.ghostty_terminal_new(cols, rows)
  if (!term) throw new Error('ghostty-web terminal init failed')
  return {
    async write(data) {
      const ptr = api.ghostty_wasm_alloc_u8_array(data.length)
      if (!ptr) throw new Error('ghostty-web allocation failed')
      try {
        new Uint8Array(api.memory.buffer).set(data, ptr)
        api.ghostty_terminal_write(term, ptr, data.length)
      } finally {
        api.ghostty_wasm_free_u8_array(ptr, data.length)
      }
    },
    verify() {
      if (api.ghostty_terminal_get_scrollback_length(term) === 0)
        throw new Error('ghostty-web did not accumulate scrollback')
    },
    close() {
      api.ghostty_terminal_free(term)
    },
  }
}

async function tau(): Promise<Runner> {
  const term = await GhosttyVt.create(newWasm, cols, rows)
  return {
    async write(data) {
      term.write(data)
    },
    verify() {
      if (!term.render().rows.some((row) => row.cells.some((cell) => cell.text === 'b')))
        throw new Error('Tau terminal screen did not contain output')
    },
    close() {
      term.dispose()
    },
  }
}

async function xterm(): Promise<Runner> {
  const term = new Xterm({ cols, rows, scrollback: 10000 })
  return {
    write(data) {
      return new Promise<void>((resolve) => term.write(data, resolve))
    },
    verify() {
      if (term.buffer.active.baseY === 0) throw new Error('xterm did not accumulate scrollback')
    },
    close() {
      term.dispose()
    },
  }
}

// Same reproducible ASCII/ANSI stream for every engine. Keep ASCII so byte counts and
// character counts agree. No random cursor resets that would erase the output being parsed.
function fixture(mib: number, ansi: boolean): Uint8Array {
  const parts: string[] = []
  let size = 0
  for (let i = 0; size < mib * 1024 * 1024; i++) {
    const line = `${ansi ? `\x1b[3${i % 8}m` : ''}build step ${String(i).padStart(7, '0')}: ${'content '.repeat(9)}\r\n`
    parts.push(line)
    size += line.length
  }
  return encoder.encode(parts.join(''))
}

function percentile(samples: number[], fraction: number): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) * fraction)]
}

const engines = [
  ['xterm.js', xterm],
  ['ghostty-web raw WASM', legacy],
  ['Tau GhosttyVt', tau],
] as const
const fixtures = [
  { name: '1MiB plain, 64KiB writes', data: fixture(1, false), chunk: 65536 },
  { name: '1MiB ANSI, 64KiB writes', data: fixture(1, true), chunk: 65536 },
  {
    name: '1000 tiny ANSI writes, await each callback (scheduler-bound)',
    data: fixture(1, true).subarray(0, 128000),
    chunk: 128,
  },
]

console.log(
  `Headless VT ingestion only | ${typeof Bun === 'undefined' ? `Node ${process.version}` : `Bun ${Bun.version}`} | ${process.platform}/${process.arch}`,
)
console.log(
  `WASM sizes: ghostty-web ${oldWasm.length} B, Tau ${newWasm.length} B | ${runs} measured runs + 1 warmup`,
)
console.log(
  'Terminal: 120x40, 10k scrollback for xterm and Tau; legacy default (cannot set via this ABI)',
)
console.log(
  'Timing: per-run fresh terminal, synchronous WASM write+copy+alloc/free; xterm write callback (async). Instantiation excluded.',
)
for (const { name, data, chunk } of fixtures) {
  console.log(`\n${name} (${data.length} bytes, ${Math.ceil(data.length / chunk)} writes)`)
  const results = new Map<string, number[]>()
  for (let round = -1; round < runs; round++) {
    // Rotate to reduce temporal bias; fresh instance and fresh terminal each round.
    const ordered = [...engines.slice((round + 1) % 3), ...engines.slice(0, (round + 1) % 3)]
    for (const [label, create] of ordered) {
      const runner = await create()
      try {
        const start = performance.now()
        for (let offset = 0; offset < data.length; offset += chunk) {
          await runner.write(data.subarray(offset, offset + chunk))
        }
        const elapsed = performance.now() - start
        runner.verify()
        if (round >= 0) results.set(label, [...(results.get(label) ?? []), elapsed])
      } finally {
        runner.close()
      }
    }
  }
  for (const [label] of engines) {
    const samples = results.get(label)!
    const median = percentile(samples, 0.5)
    console.log(
      `${label.padEnd(23)} median ${median.toFixed(1).padStart(8)} ms | ${((data.length / 1048576 / median) * 1000).toFixed(1).padStart(7)} MiB/s | range ${Math.min(...samples).toFixed(1)}–${Math.max(...samples).toFixed(1)} ms | [${samples.map((n) => n.toFixed(1)).join(', ')}]`,
    )
  }
}
// xterm's browser-oriented scheduler can keep a headless Bun process alive after disposal.
process.exit(0)

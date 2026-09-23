#!/usr/bin/env bun
// Uses Node-compatible APIs so the same harness can measure the pre-Bun revision.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir, cpus, platform, release, arch } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    manager: { type: 'string' },
    cwd: { type: 'string', default: process.cwd() },
    output: { type: 'string' },
    runs: { type: 'string', default: '5' },
    warmups: { type: 'string', default: '1' },
  },
})
const manager = values.manager
if ((manager !== 'pnpm' && manager !== 'bun') || !values.output) {
  throw new Error(
    'Usage: bun scripts/bench-tooling.ts --manager <pnpm|bun> --output <file.json> [--cwd <repo>] [--runs 5] [--warmups 1]',
  )
}
const runs = Number(values.runs)
const warmups = Number(values.warmups)
if (!Number.isInteger(runs) || runs < 1 || !Number.isInteger(warmups) || warmups < 1) {
  throw new Error('runs and warmups must be positive integers')
}
const root = resolve(values.cwd!)
const packageManager = (
  JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { packageManager?: string }
).packageManager
if (!packageManager?.startsWith(`${manager}@`)) {
  throw new Error(
    `Requested ${manager}, but ${root}/package.json declares ${packageManager ?? 'no packageManager'}. Measure the matching revision, not Bun scripts launched through pnpm.`,
  )
}
const output = resolve(values.output)
const scratch = mkdtempSync(join(tmpdir(), 'tau-tooling-bench-'))
const installRoot = join(scratch, 'workspace')
const cache = join(scratch, 'cache')

function command(args: string[], cwd = root, executable: string = manager!): string {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
    timeout: 600_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) {
    throw new Error(
      `${executable} ${args.join(' ')} failed (${result.status ?? result.signal}):\n${result.error ?? ''}\n${result.stdout}\n${result.stderr}`,
    )
  }
  return result.stdout.trim()
}

type Measurement = {
  name: string
  command: string[]
  samplesMs: number[]
  medianMs: number
  minMs: number
  maxMs: number
}
const measurements: Measurement[] = []
function measure(name: string, args: string[], cwd = root, prepare = () => {}): void {
  const samplesMs: number[] = []
  for (let index = 0; index < warmups + runs; index++) {
    prepare()
    const start = performance.now()
    command(args, cwd)
    const elapsed = performance.now() - start
    if (index >= warmups) samplesMs.push(elapsed)
  }
  const sorted = [...samplesMs].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const medianMs = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
  measurements.push({
    name,
    command: [manager!, ...args],
    samplesMs,
    medianMs,
    minMs: sorted[0],
    maxMs: sorted.at(-1)!,
  })
  console.log(
    `${name}: median ${medianMs.toFixed(1)} ms (${sorted[0].toFixed(1)}–${sorted.at(-1)!.toFixed(1)})`,
  )
}

try {
  // Install-only fixture: same manifests/lock/config, no lifecycle scripts, private warmed cache.
  // Never delete the caller's node_modules or clear their global package cache.
  for (const path of [
    'package.json',
    'apps/desktop/package.json',
    'apps/daemon/package.json',
    'packages/shared/package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.pnpmrc',
    '.npmrc',
    'bun.lock',
    'bunfig.toml',
  ]) {
    if (!existsSync(join(root, path))) continue
    mkdirSync(dirname(join(installRoot, path)), { recursive: true })
    cpSync(join(root, path), join(installRoot, path))
  }
  const installArgs = [
    'install',
    '--frozen-lockfile',
    '--ignore-scripts',
    ...(manager === 'pnpm' ? ['--store-dir', cache] : ['--cache-dir', cache]),
  ]
  command(installArgs, installRoot) // Seed cache; network time is deliberately not measured.
  measure('install-clean-warm-cache', installArgs, installRoot, () => {
    for (const workspace of ['', 'apps/desktop', 'apps/daemon', 'packages/shared']) {
      rmSync(join(installRoot, workspace, 'node_modules'), { recursive: true, force: true })
    }
  })
  measure('install-noop', installArgs, installRoot)
  for (const script of ['test:persistence', 'tsc', 'build', 'report:artifacts']) {
    measure(script, ['run', script])
  }
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(
    output,
    `${JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        revision: command(['rev-parse', 'HEAD'], root, 'git'),
        dirty: command(['status', '--porcelain'], root, 'git').length > 0,
        manager,
        managerVersion: command(['--version']),
        nodeVersion: command(['--version'], root, 'node'),
        harnessRuntime: process.version,
        bunVersion: manager === 'bun' ? command(['--version']) : null,
        zigVersion: command(['version'], root, 'zig'),
        host: {
          platform: platform(),
          release: release(),
          arch: arch(),
          cpu: cpus()[0]?.model,
          cpus: cpus().length,
        },
        runs,
        warmups,
        notes: [
          'Wall-clock process time; sequential commands; successful exits required.',
          'Install measurements use isolated manifest copies and private warmed caches; lifecycle scripts disabled; no cold-network claims.',
          'Other commands run in the supplied working tree with installed dependencies and warm compiler caches.',
          'build includes the native Zig daemon; no TAUD_SKIP_NATIVE override is applied by this harness.',
          'Test measurements use the explicit persistence suite, not automatic test discovery.',
        ],
        skipNative: process.env.TAUD_SKIP_NATIVE === '1',
        packageManager,
        measurements,
      },
      null,
      2,
    )}\n`,
  )
  console.log(`Saved ${output}`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

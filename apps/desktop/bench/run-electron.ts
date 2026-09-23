import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const electronPath = require('electron') as string
const [entry, ...args] = process.argv.slice(2)

if (!entry) {
  console.error('Usage: bun bench/run-electron.ts <entry.ts> [...args]')
  process.exit(1)
}

// Compile with Bun, execute with Electron. Bun cannot host Electron's main-process APIs.
// Keep the output under the desktop workspace so external npm imports (and renderer
// require calls) resolve against the same node_modules as the application.
const cache = resolve(import.meta.dir, '../.bench-cache')
await mkdir(cache, { recursive: true })
const outdir = await mkdtemp(resolve(cache, 'electron-'))
let exitCode = 1
try {
  const build = await Bun.build({
    entrypoints: [resolve(entry)],
    outdir,
    naming: 'entry.mjs',
    target: 'node',
    format: 'esm',
    packages: 'external',
    sourcemap: 'inline',
  })
  if (!build.success) throw new AggregateError(build.logs, 'Electron benchmark compilation failed')

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  // Benchmarks need neither a persistent Chromium profile nor macOS Keychain access.
  // Keychain permission prompts can otherwise leave Electron blocked during shutdown.
  const electronArgs = [
    resolve(outdir, 'entry.mjs'),
    `--user-data-dir=${resolve(outdir, 'profile')}`,
    ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
    ...args,
  ]
  const child = Bun.spawn([electronPath, ...electronArgs], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    env,
  })
  const interrupt = () => child.kill('SIGINT')
  const terminate = () => child.kill('SIGTERM')
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  try {
    exitCode = await child.exited
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
  }
} finally {
  await rm(outdir, { recursive: true, force: true })
}
process.exitCode = exitCode

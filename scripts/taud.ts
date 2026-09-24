#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import type { SpawnSyncOptions, SpawnSyncReturns } from 'node:child_process'
import { GHOSTTY_REVISION } from './ghostty-source'

type RunOptions = {
  cwd?: string
  stdio?: SpawnSyncOptions['stdio']
  env?: NodeJS.ProcessEnv
}

type ZonDependency = {
  url: string
  hash: string
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const daemonRoot = resolve(repoRoot, 'apps/daemon')
const [command = 'build', ...rawArgs] = process.argv.slice(2)
const passthroughArgs = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs
const optimizeMode = process.env.TAUD_OPTIMIZE ?? (command === 'build' ? 'ReleaseFast' : 'Debug')
const validOptimizeModes = new Set(['Debug', 'ReleaseFast', 'ReleaseSmall'])
if (!validOptimizeModes.has(optimizeMode)) fail(`Invalid TAUD_OPTIMIZE mode: ${optimizeMode}`)

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function run(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): SpawnSyncReturns<Buffer> {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? daemonRoot,
    stdio: options.stdio ?? 'inherit',
    env: options.env ?? process.env,
  })
  if (result.error) fail(result.error.message)
  if (result.status !== 0) process.exit(result.status ?? 1)
  return result
}

function runForStatus(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): SpawnSyncReturns<Buffer> {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? daemonRoot,
    stdio: options.stdio ?? 'inherit',
    env: options.env ?? process.env,
  })
  if (result.error) throw result.error
  return result
}

function exitFromRunResult(result: SpawnSyncReturns<Buffer>): void {
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function output(command: string, args: readonly string[], cwd = daemonRoot): string {
  const result = spawnSync(command, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
  })
  if (result.error) fail(result.error.message)
  if (result.status !== 0) process.exit(result.status ?? 1)
  return result.stdout.trim()
}

function assertZigVersion(): string {
  const version = output('zig', ['version'])
  if (version !== '0.15.2') {
    fail(`taud requires Zig 0.15.2; found ${version}. Run inside nix develop`)
  }
  return version
}

function ensureGhosttyNative(): string {
  const artifactDir = resolve(daemonRoot, '.ghostty-vt')
  const archive = resolve(artifactDir, 'libghostty-vt.a')
  const revisionFile = resolve(artifactDir, 'revision')
  if (
    !existsSync(archive) ||
    !existsSync(resolve(artifactDir, 'include/ghostty/vt.h')) ||
    !existsSync(revisionFile) ||
    readFileSync(revisionFile, 'utf8').trim() !== GHOSTTY_REVISION
  ) {
    run('nix', ['shell', 'nixpkgs#zig_0_16', '-c', 'bun', 'scripts/build-ghostty-vt-native.ts'], {
      cwd: repoRoot,
    })
  }
  if (!existsSync(archive)) fail('Ghostty native archive is missing after build')
  return archive
}

function zonDependency(zonPath: string, name: string): ZonDependency {
  const zon = readFileSync(zonPath, 'utf8')
  const pattern = new RegExp(
    `\\.${name}\\s*=\\s*\\.\\{[\\s\\S]*?\\.url\\s*=\\s*"([^"]+)"[\\s\\S]*?\\.hash\\s*=\\s*"([^"]+)"`,
    'u',
  )
  const match = zon.match(pattern)
  if (!match) fail(`Could not find .${name} dependency in ${zonPath}`)
  return { url: match[1], hash: match[2] }
}

function ensurePackage(dep: ZonDependency): string {
  const envOutput = output('zig', ['env'])
  const globalCacheDir =
    tryParseJson(envOutput)?.global_cache_dir ??
    envOutput.match(/\.global_cache_dir\s*=\s*"([^"]+)"/)?.[1]
  if (!globalCacheDir) fail('Could not determine Zig global cache dir from `zig env`')
  const packagePath = resolve(globalCacheDir, 'p', dep.hash)
  if (!existsSync(packagePath)) run('zig', ['fetch', dep.url])
  if (!existsSync(packagePath)) fail(`Expected Zig package at ${packagePath}`)
  return packagePath
}

function writeFileIfChanged(path: string, contents: string): void {
  if (existsSync(path) && readFileSync(path, 'utf8') === contents) return
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

function tryParseJson(value: string): { global_cache_dir?: string } | null {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function darwinTarget(): string {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  return `${arch}-macos.15.0`
}

function darwinBuildOptionsPath(): string {
  const cacheDir = resolve(daemonRoot, '.zig-cache')
  mkdirSync(cacheDir, { recursive: true })
  const path = resolve(cacheDir, 'taud-build-options.zig')
  writeFileIfChanged(path, 'pub const vt_backend = "ghostty_native";\n')
  return path
}

function targetArgs(): string[] {
  if (process.platform !== 'darwin') return []
  return ['-target', darwinTarget()]
}

function directCompileArgs({
  root,
  binPath,
}: {
  root: 'main' | 'root'
  binPath?: string
}): string[] {
  const zigSqlite = zonDependency(resolve(daemonRoot, 'build.zig.zon'), 'sqlite')
  const zigSqlitePath = ensurePackage(zigSqlite)
  const sqliteAmalgamation = zonDependency(resolve(zigSqlitePath, 'build.zig.zon'), 'sqlite')
  const sqliteAmalgamationPath = ensurePackage(sqliteAmalgamation)
  const buildOptionsPath = darwinBuildOptionsPath()
  const ghosttyArchive = ensureGhosttyNative()

  const args = [
    root === 'main' ? 'build-exe' : 'test',
    ...targetArgs(),
    '-D',
    'SQLITE_ENABLE_FTS5',
    '-D',
    'SQLITE_THREADSAFE=1',
    resolve(sqliteAmalgamationPath, 'sqlite3.c'),
    resolve(zigSqlitePath, 'c/workaround.c'),
  ]

  if (binPath) args.push(`-femit-bin=${binPath}`)
  args.push(`-O${optimizeMode}`)

  if (root === 'main') {
    args.push(
      '--dep',
      'taud',
      '-Mroot=src/main.zig',
      '--dep',
      'sqlite',
      '--dep',
      'build_options=taud_build_options',
      '-Mtaud=src/root.zig',
    )
  } else {
    args.push('--dep', 'sqlite', '--dep', 'build_options=taud_build_options', '-Mroot=src/root.zig')
  }

  args.push(
    '-I',
    resolve(zigSqlitePath, 'c'),
    '-I',
    sqliteAmalgamationPath,
    `-Msqlite=${resolve(zigSqlitePath, 'sqlite.zig')}`,
    `-Mtaud_build_options=${buildOptionsPath}`,
    '-I',
    resolve(daemonRoot, '.ghostty-vt/include'),
    ghosttyArchive,
    '-lc',
  )
  if (process.platform === 'linux') args.push('-lutil')

  return args
}

function buildDirect(): string {
  const binDir = resolve(daemonRoot, 'zig-out/bin')
  mkdirSync(binDir, { recursive: true })
  const exeName = process.platform === 'win32' ? 'taud.exe' : 'taud'
  const binPath = resolve(binDir, exeName)
  run('zig', directCompileArgs({ root: 'main', binPath }))
  if (optimizeMode !== 'Debug' && process.platform === 'darwin') {
    const symbolsDir = resolve(daemonRoot, 'zig-out/symbols')
    mkdirSync(symbolsDir, { recursive: true })
    runForStatus('dsymutil', [binPath, '-o', resolve(symbolsDir, `${exeName}.dSYM`)], {
      cwd: daemonRoot,
    })
    runForStatus('strip', ['-x', binPath], { cwd: daemonRoot })
  }
  return binPath
}

function withTemporaryHome<T>(callback: (home: string) => T): T {
  const home = mkdtempSync(resolve(tmpdir(), 'taud-home-'))
  try {
    return callback(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

function leakCheckEnv(home: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, TAUD_DEBUG_ALLOC: '1' }
}

function runLeakCheck(command: string, args: readonly string[], options: RunOptions = {}): void {
  const result = (() => {
    try {
      return withTemporaryHome((home) => {
        return runForStatus(command, args, {
          ...options,
          env: leakCheckEnv(home),
        })
      })
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err))
    }
  })()
  exitFromRunResult(result)
}

function testAndBuildDirect(): void {
  const cacheDir = resolve(daemonRoot, '.zig-cache')
  mkdirSync(cacheDir, { recursive: true })
  run('zig', directCompileArgs({ root: 'root', binPath: resolve(cacheDir, 'taud-root-test') }))
  run('zig', directCompileArgs({ root: 'main', binPath: resolve(cacheDir, 'taud-main-test') }))
}

assertZigVersion()

if (process.env.TAUD_SKIP_NATIVE === '1') {
  switch (command) {
    case 'build':
    case 'test':
    case 'check':
    case 'leak-check':
      console.warn(`Skipping taud ${command}; TAUD_SKIP_NATIVE=1`)
      process.exit(0)
    case 'run':
      fail('Cannot run taud when TAUD_SKIP_NATIVE=1')
    default:
      fail(`Unknown taud zig command: ${command}`)
  }
}

if (process.platform === 'win32') {
  switch (command) {
    case 'build':
    case 'test':
    case 'check':
    case 'leak-check':
      console.warn(`Skipping taud ${command} on Windows; taud is POSIX-only`)
      process.exit(0)
    case 'run':
      fail('Cannot run taud on Windows; taud is POSIX-only')
    default:
      fail(`Unknown taud zig command: ${command}`)
  }
}

ensureGhosttyNative()

if (process.platform !== 'darwin' || process.env.TAUD_USE_ZIG_BUILD === '1') {
  switch (command) {
    case 'build':
      run('zig', [
        'build',
        `-Doptimize=${optimizeMode}`,
        ...(optimizeMode === 'Debug' ? [] : ['-Dstrip=true']),
      ])
      break
    case 'test':
      run('zig', ['build', 'test'])
      break
    case 'run':
      run('zig', ['build', 'run', '--', ...passthroughArgs])
      break
    case 'check':
      run('zig', ['build', 'run', '--', '--check'])
      break
    case 'leak-check':
      runLeakCheck('zig', ['build', 'run', '--', '--check'])
      break
    default:
      fail(`Unknown taud zig command: ${command}`)
  }
  process.exit(0)
}

switch (command) {
  case 'build':
    buildDirect()
    break
  case 'test':
    testAndBuildDirect()
    break
  case 'run': {
    const binaryPath = buildDirect()
    run(binaryPath, passthroughArgs, { cwd: daemonRoot })
    break
  }
  case 'check': {
    const binaryPath = buildDirect()
    run(binaryPath, ['--check'], { cwd: daemonRoot })
    break
  }
  case 'leak-check': {
    const binaryPath = buildDirect()
    runLeakCheck(binaryPath, ['--check'], { cwd: daemonRoot })
    break
  }
  default:
    fail(`Unknown taud zig command: ${command}`)
}

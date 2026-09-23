import { test, expect } from 'bun:test'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

async function installerFixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'tau-electron-installer-'))
  try {
    const electron = join(root, 'apps/desktop/node_modules/electron')
    await mkdir(join(electron, 'dist'), { recursive: true })
    await mkdir(join(root, 'scripts'), { recursive: true })
    await cp(
      resolve(import.meta.dir, 'electron-install.ts'),
      join(root, 'scripts/electron-install.ts'),
    )
    // A separate root copy must not distract the installer from the desktop runtime.
    const rootElectron = join(root, 'node_modules/electron')
    await mkdir(rootElectron, { recursive: true })
    await Bun.write(
      join(rootElectron, 'package.json'),
      JSON.stringify({ name: 'electron', version: '1.0.0' }),
    )
    await Bun.write(
      join(electron, 'package.json'),
      JSON.stringify({ name: 'electron', version: '1.0.0' }),
    )
    // Use the Linux layout on every host; no platform binaries are actually executed.
    await Bun.write(join(electron, 'dist/electron'), 'desktop fixture')
    await Bun.write(join(electron, 'dist/version'), '1.0.0')
    await Bun.write(join(electron, 'path.txt'), 'electron')
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function runInstaller(root: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_INSTALL_PLATFORM: 'linux' }
  // The fixture is not an ELF; do not try to patch it in a Nix shell.
  delete env.NIX_CC
  delete env.ELECTRON_OVERRIDE_DIST_PATH
  const child = Bun.spawn([process.execPath, join(root, 'scripts/electron-install.ts')], {
    cwd: root,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  return { exitCode, stderr }
}

test('tooling benchmark refuses to label Bun workspace scripts as a pnpm baseline', async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, 'bench-tooling.ts'),
      '--manager',
      'pnpm',
      '--cwd',
      resolve(import.meta.dir, '..'),
      '--output',
      join(tmpdir(), 'tau-should-not-write-benchmark.json'),
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect(exitCode).not.toBe(0)
  expect(stderr).toContain('Measure the matching revision')
})

test('Bun Electron installer leaves an already complete runtime alone without a downloader', async () => {
  await installerFixture(async (root) => {
    expect(await runInstaller(root)).toEqual({ exitCode: 0, stderr: '' })
    expect(
      await Bun.file(join(root, 'apps/desktop/node_modules/electron/dist/electron')).text(),
    ).toBe('desktop fixture')
    expect(await Bun.file(join(root, 'node_modules/electron/dist/electron')).exists()).toBe(false)
  })
})

test('Bun Electron installer rejects a stale workspace-local Electron version', async () => {
  await installerFixture(async (root) => {
    await Bun.write(
      join(root, 'node_modules/electron/package.json'),
      JSON.stringify({ name: 'electron', version: '2.0.0' }),
    )
    const result = await runInstaller(root)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('Electron version mismatch: desktop 1.0.0')
  })
})

test('Bun Electron installer resolves the downloader relative to Electron and propagates repair failures', async () => {
  await installerFixture(async (root) => {
    const electron = join(root, 'apps/desktop/node_modules/electron')
    await rm(join(electron, 'dist/electron'))
    const downloader = join(electron, 'node_modules/@electron/get')
    await mkdir(downloader, { recursive: true })
    await Bun.write(
      join(downloader, 'package.json'),
      JSON.stringify({ name: '@electron/get', main: 'index.js' }),
    )
    await Bun.write(
      join(downloader, 'index.js'),
      'exports.downloadArtifact = async () => { throw new Error("fixture download failed") }',
    )
    const result = await runInstaller(root)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('fixture download failed')
  })
})

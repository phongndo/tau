#!/usr/bin/env bun

/** Build the same pinned Ghostty C ABI for the daemon's host platform. */
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { GHOSTTY_REVISION, withGhosttySource } from './ghostty-source'

const DAEMON_DIR = resolve(import.meta.dir, '../apps/daemon')
const OUTPUT_DIR = join(DAEMON_DIR, '.ghostty-vt')

withGhosttySource((source) => {
  execFileSync('zig', ['build', '-Demit-lib-vt=true', '-Doptimize=ReleaseFast'], {
    cwd: source,
    stdio: 'inherit',
  })
  const artifact = join(source, 'zig-out/lib/libghostty-vt.a')
  if (!existsSync(artifact)) throw new Error('Ghostty did not emit the native C ABI archive')

  const staging = mkdtempSync(join(DAEMON_DIR, '.ghostty-vt-'))
  try {
    mkdirSync(join(staging, 'include'), { recursive: true })
    copyFileSync(artifact, join(staging, 'libghostty-vt.a'))
    // Keep the C declarations in lockstep with the static library.
    cpSync(join(source, 'include/ghostty'), join(staging, 'include/ghostty'), {
      recursive: true,
    })
    copyFileSync(join(source, 'LICENSE'), join(staging, 'LICENSE'))
    writeFileSync(join(staging, 'revision'), `${GHOSTTY_REVISION}\n`)
    if (
      !readFileSync(join(staging, 'libghostty-vt.a'))
        .subarray(0, 8)
        .equals(Buffer.from('!<arch>\n'))
    ) {
      throw new Error('Ghostty native build did not produce a static archive')
    }
    rmSync(OUTPUT_DIR, { recursive: true, force: true })
    renameSync(staging, OUTPUT_DIR)
    console.log(
      `Built Ghostty ${GHOSTTY_REVISION} native C ABI for ${process.platform}/${process.arch}`,
    )
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
})

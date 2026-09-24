import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Both the daemon's native C ABI and the Tau-owned browser WASM use this exact source.
export const GHOSTTY_REVISION = '622b4eecd7d2ce1a10930537c17f0d61abdba817'
// Bump when the WASM-only browser graphics patch or build options change; do not reuse an
// older, revision-matching artifact that lacks Kitty exports or traps when images arrive.
export const GHOSTTY_WEB_ARTIFACT_ID = `${GHOSTTY_REVISION}/tau-browser-graphics-v1`
const ARCHIVE_SHA256 = '762d7bf7778a5590dee92501e9c246f758b54925401ca6c5f72838009b1379ff'

export function withGhosttySource<T>(build: (source: string) => T): T {
  const version = execFileSync('zig', ['version'], { encoding: 'utf8' }).trim()
  if (version !== '0.16.0') {
    throw new Error(`Ghostty ${GHOSTTY_REVISION} requires Zig 0.16.0; found ${version}`)
  }
  const work = mkdtempSync(join(tmpdir(), 'tau-ghostty-vt-'))
  try {
    const archive = join(work, 'ghostty.tar.gz')
    execFileSync(
      'curl',
      [
        '-fsSL',
        '--retry',
        '2',
        `https://github.com/ghostty-org/ghostty/archive/${GHOSTTY_REVISION}.tar.gz`,
        '-o',
        archive,
      ],
      { stdio: 'inherit' },
    )
    const digest = createHash('sha256').update(readFileSync(archive)).digest('hex')
    if (digest !== ARCHIVE_SHA256) throw new Error(`Ghostty archive checksum mismatch: ${digest}`)
    execFileSync('tar', ['-xzf', archive, '-C', work], { stdio: 'inherit' })
    return build(join(work, `ghostty-${GHOSTTY_REVISION}`))
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

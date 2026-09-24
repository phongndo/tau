#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { GHOSTTY_WEB_ARTIFACT_ID } from './ghostty-source'

const publicDir = resolve(import.meta.dir, '../apps/desktop/public')
const revision = resolve(publicDir, 'ghostty-vt.revision')
if (
  !existsSync(resolve(publicDir, 'ghostty-vt.wasm')) ||
  !existsSync(revision) ||
  readFileSync(revision, 'utf8').trim() !== GHOSTTY_WEB_ARTIFACT_ID
) {
  execFileSync(
    'nix',
    ['shell', 'nixpkgs#zig_0_16', '-c', 'bun', 'scripts/build-ghostty-vt-wasm.ts'],
    {
      cwd: resolve(import.meta.dir, '..'),
      stdio: 'inherit',
    },
  )
}

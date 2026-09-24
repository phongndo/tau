import { test, expect } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { defaultSettings, resolveSettings } from '@tau/shared/preferences'
import { conflictingShortcut, findShortcut, parseBinding } from '../src/main/shortcuts'

test('legacy preferences preserve retention settings while gaining interface defaults', () => {
  const legacy = {
    version: 1,
    persistence: { enabled: false, retainDays: 7, maxSessionBytes: 1024, persistInput: true },
  }
  const value = resolveSettings(legacy)
  expect(value.appearance?.sidebar).toBe(true)
  expect(value.persistence).toEqual(legacy.persistence)
})

test('shortcuts match exact modifiers and allow unbinding', () => {
  expect(parseBinding('Ctrl+H')).toEqual({
    key: 'h',
    control: true,
    meta: false,
    alt: false,
    shift: false,
  })
  expect(parseBinding('H')).toBeNull()
  expect(parseBinding('Ctrl+Ctrl+H')).toBeNull()
  expect(parseBinding('Mod+D')?.meta).toBe(true)
  const input = { key: 'd', control: false, meta: true, alt: false, shift: false }
  expect(findShortcut(input, defaultSettings)).toBe('split-right')
  expect(findShortcut({ ...input, control: true, meta: false }, defaultSettings)).toBeNull()
  expect(findShortcut(input, { ...defaultSettings, keybindings: { 'split-right': '' } })).toBeNull()
  expect(findShortcut({ ...input, shift: true }, defaultSettings)).toBe('split-down')
  expect(conflictingShortcut({ ...defaultSettings, keybindings: { search: 'Meta+D' } })).toBe(
    'search',
  )
})

test('Bun service validates writes and persists preferences across restarts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tau-settings-test-'))
  const run = async (messages: object[]) => {
    const child = spawn(
      process.execPath,
      [resolve(import.meta.dir, '../src/sidecar/settings.ts')],
      { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    const results: any[] = []
    const reader = createInterface({ input: child.stdout })
    const read = new Promise<void>((resolve, reject) => {
      reader.on('line', (line) => {
        results.push(JSON.parse(line))
        if (results.length === messages.length) resolve()
      })
      child.on('error', reject)
      child.on('exit', (code) => {
        if (results.length !== messages.length) reject(new Error(`Service exited: ${code}`))
      })
    })
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`)
    child.stdin.end()
    await read
    return results
  }
  try {
    const first = await run([
      { id: 1, method: 'read' },
      { id: 2, method: 'write', data: { version: 'invalid' } },
      {
        id: 3,
        method: 'write',
        data: {
          ...defaultSettings,
          appearance: { theme: 'slate', accent: 'mint', sidebar: false },
        },
      },
    ])
    expect(first[0].result.appearance).toEqual(defaultSettings.appearance)
    expect(first[1].error).toContain('Invalid settings data')
    expect(first[2].result).toBe(true)
    const second = await run([{ id: 4, method: 'read' }])
    expect(second[0].result.appearance).toEqual({ theme: 'slate', accent: 'mint', sidebar: false })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

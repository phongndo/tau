import { expect, test } from 'bun:test'
import { observeSmokeOutput } from '../src/main/smoke-output'

test('Electron smoke detects a token at the start of an oversized first frame', () => {
  const token = 'tau-electron-smoke-token'
  const output = observeSmokeOutput('', token + 'x'.repeat(5403), token)
  expect(output.sawToken).toBe(true)
  expect(output.tail).toBe('x'.repeat(4096))
})

test('Electron smoke detects a token split across frames', () => {
  const first = observeSmokeOutput('', 'tau-electron-', 'tau-electron-smoke-token')
  const second = observeSmokeOutput(
    first.tail,
    'smoke-token' + 'x'.repeat(5403),
    'tau-electron-smoke-token',
  )
  expect(second.sawToken).toBe(true)
  expect(second.tail).toBe('x'.repeat(4096))
})

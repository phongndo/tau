import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const preload = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8')
const taudBridge = readFileSync(new URL('../src/main/taud-pty-bridge.ts', import.meta.url), 'utf8')
const env = readFileSync(new URL('../src/renderer/env.d.ts', import.meta.url), 'utf8')

test('terminal renderer is sandboxed with no Node integration', () => {
  assert.match(main, /contextIsolation:\s*true/u)
  assert.match(main, /sandbox:\s*true/u)
  assert.match(main, /nodeIntegration:\s*false/u)
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/u)
})

test('privileged IPC and terminal ports are sender-bound', () => {
  assert.match(main, /event\.sender !== mainWindow\?\.webContents/u)
  assert.match(main, /pty:requestSessionPort/u)
  assert.doesNotMatch(preload, /from 'node:(?:fs|child_process|net|process)'/u)
})

test('preload API exposes no raw filesystem process socket or IPC primitives', () => {
  assert.doesNotMatch(env, /\b(?:readFile|writeFile|spawn|exec|socket|ipcRenderer|processEnv)\b/u)
  assert.doesNotMatch(preload, /exposeInMainWorld\([^,]+,\s*ipcRenderer/u)
})

test('terminal MessagePorts transfer renderer input and clone main-process output', () => {
  assert.match(taudBridge, /postMessage\(\{ type, seq, data: bytes\.buffer \}\)/u)
  assert.doesNotMatch(
    taudBridge,
    /postMessage\(\{ type, seq, data: bytes\.buffer \},\s*\[bytes\.buffer\]/u,
  )
  assert.equal(
    preload.match(/postMessage\(\{ type: 'input', data: buffer \},\s*\[buffer\]\)/gu)?.length,
    2,
  )
})

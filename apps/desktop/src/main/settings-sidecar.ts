import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import type { SettingsData } from '@tau/shared/session'

let child: ChildProcessWithoutNullStreams | null = null
let nextId = 0
const pending = new Map<
  number,
  { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
>()

function rejectAll(error: Error) {
  for (const request of pending.values()) {
    clearTimeout(request.timer)
    request.reject(error)
  }
  pending.clear()
  child = null
}

function start() {
  if (child) return child
  const dev = Boolean(process.env.ELECTRON_RENDERER_URL)
  const executable = dev
    ? 'bun'
    : resolve(
        __dirname,
        process.platform === 'win32' ? '../bin/tau-settings.exe' : '../bin/tau-settings',
      )
  const args = dev ? [resolve(__dirname, '../../src/sidecar/settings.ts')] : []
  const proc = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
  child = proc
  proc.once('error', (error) => rejectAll(error))
  proc.once('exit', (code) => rejectAll(new Error(`Settings service exited (${code})`)))
  proc.stderr.on('data', (chunk: Buffer) =>
    console.warn('[settings service]', chunk.toString().slice(0, 2048)),
  )
  const lines = createInterface({ input: proc.stdout })
  lines.on('line', (line) => {
    try {
      const response = JSON.parse(line) as { id: number; result?: unknown; error?: string }
      const request = pending.get(response.id)
      if (!request) return
      pending.delete(response.id)
      clearTimeout(request.timer)
      if (response.error) request.reject(new Error(response.error))
      else request.resolve(response.result)
    } catch (error) {
      console.warn('[settings service] Invalid response:', error)
    }
  })
  return proc
}

function request<T>(method: 'read' | 'write', data?: SettingsData): Promise<T> {
  const proc = start()
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('Settings service timed out'))
      proc.kill()
    }, 5000)
    pending.set(id, { resolve, reject, timer })
    proc.stdin.write(`${JSON.stringify({ id, method, data })}\n`, (error) => {
      if (!error) return
      const request = pending.get(id)
      if (!request) return
      clearTimeout(request.timer)
      pending.delete(id)
      reject(error)
    })
  })
}

export const readSettingsFromBun = () => request<SettingsData>('read')
export const writeSettingsToBun = (data: SettingsData) => request<void>('write', data)

export function stopSettingsService() {
  child?.kill()
  rejectAll(new Error('Settings service stopped'))
}

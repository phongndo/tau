import { runInNewContext } from 'node:vm'
import { resolve } from 'node:path'
import type { ElectronAPI } from '../../src/preload'

// Execute the real preload with only Electron's transport boundary replaced.
const build = await Bun.build({
  entrypoints: [resolve(import.meta.dir, '../../src/preload/index.ts')],
  target: 'node',
  format: 'cjs',
  external: ['electron'],
})
if (!build.success) throw new AggregateError(build.logs, 'Could not compile preload fixture')
const source = await build.outputs[0].text()

type Port = {
  onmessage: ((event: { data: unknown }) => void) | null
  start(): void
  close(): void
  postMessage(message: unknown): void
}

export function preloadHarness() {
  const listeners = new Map<string, (...args: any[]) => void>()
  const sent: unknown[] = []
  let api!: ElectronAPI
  let decoderCount = 0
  let decodeCount = 0
  class CountingDecoder extends TextDecoder {
    constructor() {
      super()
      decoderCount++
    }
    override decode(input?: AllowSharedBufferSource, options?: TextDecodeOptions) {
      decodeCount++
      return super.decode(input, options)
    }
  }
  runInNewContext(source, {
    module: { exports: {} },
    require(name: string) {
      if (name !== 'electron') throw new Error(`Unexpected preload import: ${name}`)
      return {
        contextBridge: {
          exposeInMainWorld: (_name: string, value: ElectronAPI) => {
            api = value
          },
        },
        ipcRenderer: {
          on: (name: string, callback: (...args: any[]) => void) => listeners.set(name, callback),
          send: (...args: unknown[]) => sent.push(args),
        },
      }
    },
    setTimeout,
    clearTimeout,
    TextDecoder: CountingDecoder,
    TextEncoder,
    ArrayBuffer,
    Uint8Array,
  })
  function port(): Port {
    return {
      onmessage: null,
      start() {},
      close() {},
      postMessage(message) {
        sent.push(message)
      },
    }
  }
  const control = port()
  listeners.get('pty:port')!({ ports: [control] })
  return {
    api,
    sent,
    decoding: () => ({ decoderCount, decodeCount }),
    session(id: string) {
      const channel = port()
      listeners.get('pty:session-port')!({ ports: [channel] }, id)
      return {
        output(data: Uint8Array, seq = 1) {
          channel.onmessage!({ data: { type: 'output', seq, data: data.buffer } })
        },
        exit() {
          control.onmessage!({ data: { type: 'exit', sessionId: id, info: { exitCode: 0 } } })
        },
      }
    },
  }
}

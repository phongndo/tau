import { EventEmitter } from 'node:events'
import { expect, test } from 'bun:test'
import type { MessagePortMain } from 'electron'
import { TaudStreamFrameKind } from '@tau/shared/taud-protocol'
import { TaudPtyBridge } from '../src/main/taud-pty-bridge'
import type { TaudClient, TaudSessionStream } from '../src/main/taud-client'

class Port extends EventEmitter {
  messages: unknown[] = []
  closed = false
  start() {}
  postMessage(message: unknown) {
    this.messages.push(message)
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }
  send(data: unknown) {
    this.emit('message', { data })
  }
  main() {
    return this as unknown as MessagePortMain
  }
}

class Stream extends EventEmitter {
  started = false
  closed = false
  input: Uint8Array[] = []
  start() {
    this.started = true
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }
  writeInput(data: Uint8Array) {
    this.input.push(data)
  }
  frame(seq = 1) {
    this.emit('frame', {
      sessionId: 's',
      kind: TaudStreamFrameKind.Output,
      seq,
      payload: Uint8Array.of(65),
    })
  }
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
function fixture() {
  type Attached = { response: { ok: true }; stream: TaudSessionStream }
  const pending: Array<ReturnType<typeof Promise.withResolvers<Attached>>> = []
  const client = {
    attachSession() {
      const call = Promise.withResolvers<Attached>()
      pending.push(call)
      return call.promise
    },
    async detachSession() {},
  }
  const bridge = new TaudPtyBridge({ client: client as unknown as TaudClient })
  const control = new Port()
  bridge.connectPort(control.main())
  const channel = new Port()
  bridge.connectSessionPort('s', channel.main())
  const attach = (port = control) =>
    port.send({ type: 'attach', sessionId: 's', cols: 80, rows: 24 })
  const resolve = async (index: number, stream = new Stream()) => {
    pending[index]!.resolve({
      response: { ok: true },
      stream: stream as unknown as TaudSessionStream,
    })
    await turn()
    return stream
  }
  return { bridge, control, channel, attach, resolve, pending }
}

for (const cancel of ['session-port', 'control-port', 'dispose'] as const) {
  test(`${cancel} teardown cancels an attach RPC before its stream arrives`, async () => {
    const f = fixture()
    try {
      f.attach()
      expect(f.pending.length).toBe(1)
      if (cancel === 'session-port') f.channel.close()
      else if (cancel === 'control-port') f.control.close()
      else f.bridge.dispose()
      const stream = await f.resolve(0)
      expect(stream.closed).toBe(true)
      expect(stream.started).toBe(false)
      expect(f.control.messages).toEqual([])
      expect(f.bridge.getDiagnostics().messagesDroppedNoPortTotal).toBe(0)
    } finally {
      f.bridge.dispose()
    }
  })
}

test('closing a port during first-frame wait closes its stream and suppresses stale frames/errors', async () => {
  const f = fixture()
  try {
    f.attach()
    const stream = await f.resolve(0)
    expect(stream.started).toBe(true)
    f.channel.close()
    expect(stream.closed).toBe(true)
    stream.frame()
    stream.emit('error', new Error('old socket closed'))
    await turn()
    expect(f.control.messages).toEqual([])
    expect(f.bridge.getDiagnostics()).toMatchObject({
      activeStreams: 0,
      messagesDroppedNoPortTotal: 0,
    })
  } finally {
    f.bridge.dispose()
  }
})

test('late attach completion cannot replace the new renderer stream', async () => {
  const f = fixture()
  try {
    f.attach()
    f.channel.close()
    const channel = new Port()
    f.bridge.connectSessionPort('s', channel.main())
    f.attach()
    const current = await f.resolve(1)
    current.frame(2)
    await turn()
    const obsolete = await f.resolve(0)
    expect(obsolete.closed).toBe(true)
    expect(current.closed).toBe(false)
    channel.send({ type: 'input', data: Uint8Array.of(9) })
    expect(current.input.map((bytes) => [...bytes])).toEqual([[9]])
    current.frame(3)
    expect(channel.messages).toHaveLength(2)
    expect(f.control.messages).toHaveLength(1) // only the current ready
  } finally {
    f.bridge.dispose()
  }
})

test('replacing the control port revokes old channels and ignores queued old control requests', async () => {
  const f = fixture()
  try {
    f.attach()
    const control = new Port()
    f.bridge.connectPort(control.main())
    expect(f.channel.closed).toBe(true)
    const obsolete = await f.resolve(0)
    expect(obsolete.closed).toBe(true)
    const channel = new Port()
    f.bridge.connectSessionPort('s', channel.main())
    f.attach(control)
    const current = await f.resolve(1)
    current.frame()
    await turn()
    f.control.send({ type: 'detach', sessionId: 's' })
    f.channel.send({ type: 'resync', seq: 0 })
    expect(current.closed).toBe(false)
    expect(channel.closed).toBe(false)
    expect(f.pending.length).toBe(2)
    expect(control.messages).toHaveLength(1)
  } finally {
    f.bridge.dispose()
  }
})

test('a late failure from an obsolete attach cannot clear the replacement renderer ready state', async () => {
  const f = fixture()
  try {
    f.attach()
    f.channel.close()
    const channel = new Port()
    f.bridge.connectSessionPort('s', channel.main())
    f.attach()
    const current = await f.resolve(1)
    current.frame()
    await turn()
    f.pending[0]!.reject(new Error('old attach failed'))
    await turn()
    expect(f.control.messages).toHaveLength(1)
    expect(current.closed).toBe(false)
  } finally {
    f.bridge.dispose()
  }
})

test('a newer attach on the same channel also supersedes an older pending RPC', async () => {
  const f = fixture()
  try {
    f.attach()
    f.attach()
    const current = await f.resolve(1)
    current.frame()
    await turn()
    const obsolete = await f.resolve(0)
    expect(obsolete.closed).toBe(true)
    expect(current.closed).toBe(false)
    expect(f.control.messages).toHaveLength(1)
  } finally {
    f.bridge.dispose()
  }
})

test('unexpected current attach failures still reach the renderer', async () => {
  const f = fixture()
  try {
    f.attach()
    f.pending[0]!.reject(new Error('current attach failed'))
    await turn()
    expect(f.control.messages).toEqual([
      { type: 'error', sessionId: 's', error: 'current attach failed' },
    ])
  } finally {
    f.bridge.dispose()
  }
})

import { contextBridge, ipcRenderer } from 'electron'
import type {
  PtyClientMessage,
  PtyExitInfo,
  PtySize,
  TaudPtyBridgeDiagnostics,
} from '../main/pty-protocol'
import type { PtyServiceMessage } from '../main/pty-protocol'
import type { AppCommand } from '@tau/shared/app-command'
import type { SettingsData } from '@tau/shared/session'
import type { MuxGraphSnapshot } from '@tau/shared/mux-graph'
import type {
  AttachSessionInput,
  AttachSessionMode,
  AttachSessionResult,
  CreateSessionInput,
  CreateSessionResult,
  CurrentScreenSnapshotFrame,
  ExitInfo,
  OutputFrame,
  TaudLifecycleDiagnostics,
  TaudLifecycleRecoveryInput,
} from '@tau/shared/taud-protocol'

type PtyDataCallback = (data: string) => void

type SessionPortRequest = {
  promise: Promise<MessagePort>
  resolve(port: MessagePort): void
  reject(error: Error): void
  timeout: ReturnType<typeof setTimeout>
}
type SessionOutputCallback = (frame: OutputFrame) => void
type SessionSnapshotCallback = (frame: CurrentScreenSnapshotFrame) => void
type SessionResizeCallback = (cols: number, rows: number) => void
type SessionTitleCallback = (title: string) => void
type SessionExitCallback = (info: ExitInfo) => void
type SessionErrorCallback = (error: string) => void
type PtyErrorCallback = (error: string) => void
type PtyExitCallback = (info: PtyExitInfo) => void
type AppCommandCallback = (command: AppCommand) => void

type PendingDataState = {
  chunks: string[]
  bufferedChars: number
}

type PendingOutputState = {
  frames: OutputFrame[]
  bufferedBytes: number
}

type TerminalPreloadDiagnostics = {
  pendingClientMessages: number
  pendingDataSessions: number
  pendingDataChars: number
  pendingDataDroppedChunksTotal: number
  pendingDataDroppedCharsTotal: number
  pendingDataTruncatedCharsTotal: number
  pendingOutputSessions: number
  pendingOutputChars: number
  pendingOutputDroppedFramesTotal: number
  pendingOutputDroppedCharsTotal: number
  pendingOutputTruncatedCharsTotal: number
  pendingSnapshotSessions: number
  readySessions: number
}

type ReadyState = {
  size: PtySize | null
  seq: number
  archived: boolean
  attachMode: AttachSessionMode
  promise: Promise<PtySize>
  resolve: ((size: PtySize) => void) | null
  reject: ((err: Error) => void) | null
  timeout: ReturnType<typeof setTimeout> | null
}

const INITIAL_SIZE_TIMEOUT_MS = 5000
const PTY_PORT_REQUEST_TIMEOUT_MS = 5000
const MAX_PENDING_DATA_CHARS = 1024 * 1024
const MAX_PENDING_OUTPUT_BYTES = 1024 * 1024

type PtyPortRequest = {
  promise: Promise<void>
  resolve(): void
  reject(error: Error): void
  timeout: ReturnType<typeof setTimeout>
}

let ptyPort: MessagePort | null = null
let ptyPortRequest: PtyPortRequest | null = null
let rendererReadySignaled = false
let rendererShown = false
let pendingClientMessages: PtyClientMessage[] = []
let pendingDataDroppedChunksTotal = 0
let pendingDataDroppedCharsTotal = 0
let pendingDataTruncatedCharsTotal = 0
let pendingOutputDroppedFramesTotal = 0
let pendingOutputDroppedCharsTotal = 0
let pendingOutputTruncatedCharsTotal = 0
const rendererShownWaiters: Array<() => void> = []
const readyStates = new Map<string, ReadyState>()
const pendingData = new Map<string, PendingDataState>()
const pendingSessionOutput = new Map<string, PendingOutputState>()
const sessionPorts = new Map<string, MessagePort>()
const sessionPortRequests = new Map<string, SessionPortRequest>()
const pendingSnapshots = new Map<string, CurrentScreenSnapshotFrame>()
const ptyDataCallbacks = new Map<string, PtyDataCallback[]>()
const sessionOutputCallbacks = new Map<string, SessionOutputCallback[]>()
const sessionSnapshotCallbacks = new Map<string, SessionSnapshotCallback[]>()
const sessionResizeCallbacks = new Map<string, SessionResizeCallback[]>()
const sessionTitleCallbacks = new Map<string, SessionTitleCallback[]>()
const sessionExitCallbacks = new Map<string, SessionExitCallback[]>()
const sessionErrorCallbacks = new Map<string, SessionErrorCallback[]>()
const ptyErrorCallbacks = new Map<string, PtyErrorCallback[]>()
const ptyExitCallbacks = new Map<string, PtyExitCallback[]>()

function base64ToBytes(dataBase64: string): Uint8Array {
  const binary = atob(dataBase64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function isValidTerminalSize(cols: unknown, rows: unknown): cols is number {
  return (
    typeof cols === 'number' &&
    typeof rows === 'number' &&
    Number.isFinite(cols) &&
    Number.isFinite(rows) &&
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols > 0 &&
    rows > 0
  )
}

function createReadyState(): ReadyState {
  let resolveReady: ((size: PtySize) => void) | null = null
  let rejectReady: ((err: Error) => void) | null = null
  const state: ReadyState = {
    size: null,
    seq: 0,
    archived: false,
    attachMode: 'live',
    promise: new Promise<PtySize>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    }),
    resolve: null,
    reject: null,
    timeout: null,
  }
  state.resolve = resolveReady
  state.reject = rejectReady
  return state
}

function beginReadyState(sessionId: string): ReadyState {
  const existingState = readyStates.get(sessionId)
  if (existingState?.resolve || existingState?.reject) return existingState
  if (existingState) clearReadyTimeout(existingState)
  const state = createReadyState()
  readyStates.set(sessionId, state)
  return state
}

function armReadyTimeout(sessionId: string) {
  const state = readyStates.get(sessionId)
  if (!state || state.size || state.timeout !== null || (!state.resolve && !state.reject)) return
  state.timeout = setTimeout(() => {
    rejectPtyReady(sessionId, new Error(`Timed out waiting for PTY ${sessionId} to become ready`))
  }, INITIAL_SIZE_TIMEOUT_MS)
}

function clearReadyTimeout(state: ReadyState) {
  if (state.timeout === null) return
  clearTimeout(state.timeout)
  state.timeout = null
}

function rejectPtyReady(sessionId: string, error: Error) {
  const state = readyStates.get(sessionId)
  if (!state) return
  clearReadyTimeout(state)
  state.reject?.(error)
  state.resolve = null
  state.reject = null
}

function resolvePtyReady(
  sessionId: string,
  size: PtySize,
  seq = 0,
  archived = false,
  attachMode: AttachSessionMode = 'live',
) {
  const state = readyStates.get(sessionId)
  if (!state) return
  state.size = size
  state.seq = seq
  state.archived = archived
  state.attachMode = attachMode
  clearReadyTimeout(state)
  state.resolve?.(size)
  state.resolve = null
  state.reject = null
}

function postToPty(message: PtyClientMessage): boolean {
  if (!ptyPort) return false
  ptyPort.postMessage(message)
  if (message.type === 'spawn' || message.type === 'attach') armReadyTimeout(message.sessionId)
  return true
}

function queuePtyMessage(message: PtyClientMessage) {
  pendingClientMessages.push(message)
  flushPendingClientMessages()
}

function flushPendingClientMessages() {
  if (!ptyPort || pendingClientMessages.length === 0) return
  const messages = pendingClientMessages
  pendingClientMessages = []
  for (const message of messages) postToPty(message)
}

function callbacksFor<T>(callbacksBySession: Map<string, T[]>, sessionId: string): T[] {
  const callbacks = callbacksBySession.get(sessionId)
  if (callbacks) return callbacks
  const nextCallbacks: T[] = []
  callbacksBySession.set(sessionId, nextCallbacks)
  return nextCallbacks
}

function pendingDataFor(sessionId: string): PendingDataState {
  const existingState = pendingData.get(sessionId)
  if (existingState) return existingState
  const state: PendingDataState = { chunks: [], bufferedChars: 0 }
  pendingData.set(sessionId, state)
  return state
}

function pendingOutputFor(sessionId: string): PendingOutputState {
  const existingState = pendingSessionOutput.get(sessionId)
  if (existingState) return existingState
  const state: PendingOutputState = { frames: [], bufferedBytes: 0 }
  pendingSessionOutput.set(sessionId, state)
  return state
}

function removeCallback<T>(callbacksBySession: Map<string, T[]>, sessionId: string, callback: T) {
  const currentCallbacks = callbacksBySession.get(sessionId)
  if (!currentCallbacks) return
  const nextCallbacks = currentCallbacks.filter((registeredCallback) => registeredCallback !== callback)
  if (nextCallbacks.length === 0) {
    callbacksBySession.delete(sessionId)
    return
  }
  callbacksBySession.set(sessionId, nextCallbacks)
}

function clearSessionState(sessionId: string) {
  const state = readyStates.get(sessionId)
  if (state) clearReadyTimeout(state)
  readyStates.delete(sessionId)
  pendingData.delete(sessionId)
  pendingSessionOutput.delete(sessionId)
  pendingSnapshots.delete(sessionId)
  ptyDataCallbacks.delete(sessionId)
  sessionOutputCallbacks.delete(sessionId)
  sessionSnapshotCallbacks.delete(sessionId)
  sessionResizeCallbacks.delete(sessionId)
  sessionTitleCallbacks.delete(sessionId)
  sessionExitCallbacks.delete(sessionId)
  sessionErrorCallbacks.delete(sessionId)
  ptyErrorCallbacks.delete(sessionId)
  ptyExitCallbacks.delete(sessionId)
  // Drop the fast-lane port so main's SessionChannel is released on exit/error as well as detach/kill.
  closeSessionPort(sessionId)
}

function rejectAndClearSessionState(sessionId: string, error: Error) {
  rejectPtyReady(sessionId, error)
  clearSessionState(sessionId)
}

function getTerminalPreloadDiagnostics(): TerminalPreloadDiagnostics {
  let pendingDataChars = 0
  for (const pending of pendingData.values()) pendingDataChars += pending.bufferedChars
  let pendingOutputChars = 0
  for (const pending of pendingSessionOutput.values()) pendingOutputChars += pending.bufferedBytes
  return {
    pendingClientMessages: pendingClientMessages.length,
    pendingDataSessions: pendingData.size,
    pendingDataChars,
    pendingDataDroppedChunksTotal,
    pendingDataDroppedCharsTotal,
    pendingDataTruncatedCharsTotal,
    pendingOutputSessions: pendingSessionOutput.size,
    pendingOutputChars,
    pendingOutputDroppedFramesTotal,
    pendingOutputDroppedCharsTotal,
    pendingOutputTruncatedCharsTotal,
    pendingSnapshotSessions: pendingSnapshots.size,
    readySessions: readyStates.size,
  }
}

function flushPendingData(sessionId: string) {
  const pending = pendingData.get(sessionId)
  const callbacks = ptyDataCallbacks.get(sessionId)
  if (!pending || pending.chunks.length === 0 || !callbacks || callbacks.length === 0) return
  const data = pending.chunks.length === 1 ? pending.chunks[0] : pending.chunks.join('')
  pending.chunks = []
  pending.bufferedChars = 0
  for (const callback of callbacks) callback(data)
}

function flushPendingSessionOutput(sessionId: string) {
  const pending = pendingSessionOutput.get(sessionId)
  const callbacks = sessionOutputCallbacks.get(sessionId)
  if (!pending || pending.frames.length === 0 || !callbacks || callbacks.length === 0) return
  const frames = pending.frames
  pending.frames = []
  pending.bufferedBytes = 0
  for (const frame of frames) {
    for (const callback of callbacks) callback(frame)
  }
}

function handlePtyData(sessionId: string, data: string) {
  const callbacks = ptyDataCallbacks.get(sessionId)
  if (!callbacks || callbacks.length === 0) {
    // Phase 1.7: only buffer for benchmark/compat onPtyData subscribers.
    const pending = pendingDataFor(sessionId)
    pending.chunks.push(data)
    pending.bufferedChars += data.length
    while (pending.bufferedChars > MAX_PENDING_DATA_CHARS && pending.chunks.length > 1) {
      const droppedChars = pending.chunks.shift()?.length ?? 0
      pending.bufferedChars -= droppedChars
      pendingDataDroppedChunksTotal += 1
      pendingDataDroppedCharsTotal += droppedChars
    }
    return
  }
  for (const callback of callbacks) callback(data)
}

function handleSessionOutput(frame: OutputFrame) {
  const callbacks = sessionOutputCallbacks.get(frame.sessionId)
  if (!callbacks || callbacks.length === 0) {
    const pending = pendingOutputFor(frame.sessionId)
    if (pending.bufferedBytes + frame.data.byteLength > MAX_PENDING_OUTPUT_BYTES) {
      pendingOutputDroppedFramesTotal += pending.frames.length + 1
      pendingOutputDroppedCharsTotal += pending.bufferedBytes + frame.data.byteLength
      pending.frames = []
      pending.bufferedBytes = 0
      sessionPorts.get(frame.sessionId)?.postMessage({ type: 'resync', seq: 0 })
      return
    }
    pending.frames.push(frame)
    pending.bufferedBytes += frame.data.byteLength
    return
  }
  for (const callback of callbacks) callback(frame)
}

function handleSessionSnapshot(frame: CurrentScreenSnapshotFrame) {
  const callbacks = sessionSnapshotCallbacks.get(frame.sessionId)
  if (!callbacks || callbacks.length === 0) {
    pendingSnapshots.set(frame.sessionId, frame)
    return
  }
  for (const callback of callbacks) callback(frame)
}

function handleSessionTitle(sessionId: string, title: string) {
  for (const callback of sessionTitleCallbacks.get(sessionId) ?? []) callback(title)
}

function handlePtyMessage(message: PtyServiceMessage) {
  switch (message.type) {
    case 'ready':
      resolvePtyReady(
        message.sessionId,
        message.size,
        message.seq ?? 0,
        message.archived ?? false,
        message.attachMode ?? 'live',
      )
      break
    case 'data': {
      // Compatibility-only path; production output uses a per-session binary MessagePort.
      const bytes = new TextEncoder().encode(message.data)
      handleSessionOutput({
        sessionId: message.sessionId,
        seq: message.seq ?? 0,
        data: bytes,
      })
      if ((ptyDataCallbacks.get(message.sessionId)?.length ?? 0) > 0) {
        handlePtyData(message.sessionId, message.data)
      }
      break
    }
    case 'resize':
      for (const callback of sessionResizeCallbacks.get(message.sessionId) ?? []) {
        callback(message.cols, message.rows)
      }
      break
    case 'title':
      handleSessionTitle(message.sessionId, message.title)
      break
    case 'snapshot':
      handleSessionSnapshot({
        sessionId: message.sessionId,
        seq: message.seq ?? 0,
        data: base64ToBytes(message.dataBase64),
        live: message.live ?? true,
      })
      break
    case 'error':
      rejectPtyReady(message.sessionId, new Error(message.error))
      for (const callback of ptyErrorCallbacks.get(message.sessionId) ?? []) callback(message.error)
      for (const callback of sessionErrorCallbacks.get(message.sessionId) ?? []) callback(message.error)
      clearSessionState(message.sessionId)
      break
    case 'exit': {
      const state = readyStates.get(message.sessionId)
      if (!state?.size) {
        rejectPtyReady(
          message.sessionId,
          new Error(
            `PTY ${message.sessionId} exited before ready (exitCode=${message.info.exitCode}, signal=${message.info.signal ?? 'none'})`,
          ),
        )
      }
      for (const callback of ptyExitCallbacks.get(message.sessionId) ?? []) callback(message.info)
      for (const callback of sessionExitCallbacks.get(message.sessionId) ?? []) callback(message.info)
      clearSessionState(message.sessionId)
      break
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function decodePtyServiceMessage(message: unknown): PtyServiceMessage | null {
  if (!isRecord(message) || typeof message.type !== 'string') return null
  if (typeof message.sessionId !== 'string' || message.sessionId.length === 0) return null
  switch (message.type) {
    case 'ready':
      if (!isRecord(message.size) || !isValidTerminalSize(message.size.cols, message.size.rows)) return null
      break
    case 'data':
      if (typeof message.data !== 'string') return null
      break
    case 'resize':
      if (!isValidTerminalSize(message.cols, message.rows)) return null
      break
    case 'title':
      if (typeof message.title !== 'string') return null
      break
    case 'snapshot':
      if (typeof message.dataBase64 !== 'string') return null
      break
    case 'error':
      if (typeof message.error !== 'string') return null
      break
    case 'exit':
      if (!isRecord(message.info) || typeof message.info.exitCode !== 'number') return null
      break
    default:
      return null
  }
  return message as PtyServiceMessage
}

function assertMuxGraphSnapshot(value: unknown): MuxGraphSnapshot {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error('Invalid mux graph snapshot')
  if (!Number.isSafeInteger(value.graphRev) || !Number.isSafeInteger(value.eventSeq)) {
    throw new Error('Invalid mux graph revision')
  }
  if (!Array.isArray(value.tabs) || !Array.isArray(value.panes)) throw new Error('Invalid mux graph arrays')
  return value as MuxGraphSnapshot
}

function assertLifecycleDiagnostics(value: unknown): TaudLifecycleDiagnostics {
  if (!isRecord(value) || typeof value.state !== 'string') {
    throw new Error('Invalid taud diagnostics payload')
  }
  return value as TaudLifecycleDiagnostics
}

function assertBridgeDiagnostics(value: unknown): TaudPtyBridgeDiagnostics {
  if (!isRecord(value) || typeof value.portConnected !== 'boolean') {
    throw new Error('Invalid taud bridge diagnostics payload')
  }
  return value as TaudPtyBridgeDiagnostics
}

const RECOVERY_ACTIONS = new Set<TaudLifecycleRecoveryInput>([
  'none',
  'start-daemon',
  'wait-for-start',
  'reuse-external-daemon',
  'keep-detached-daemon',
  'clear-stale-socket-and-start',
  'restart-owned-daemon',
  'replace-incompatible-daemon',
])

function createSessionId(): string {
  const randomUUID = globalThis.crypto?.randomUUID?.()
  if (randomUUID) return `session-${randomUUID}`
  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

ipcRenderer.on('pty:port', (event) => {
  const [port] = event.ports
  if (!port) return
  ptyPort = port
  const request = ptyPortRequest
  ptyPortRequest = null
  if (request) {
    clearTimeout(request.timeout)
    request.resolve()
  }
  ptyPort.onmessage = (messageEvent) => {
    const message = decodePtyServiceMessage(messageEvent.data)
    if (!message) return
    handlePtyMessage(message)
  }
  ptyPort.start()
  flushPendingClientMessages()
})

ipcRenderer.on('pty:session-port', (event, sessionId: unknown) => {
  const [port] = event.ports
  if (!port || typeof sessionId !== 'string' || sessionId.length === 0) {
    port?.close()
    return
  }
  sessionPorts.get(sessionId)?.close()
  sessionPorts.set(sessionId, port)
  const request = sessionPortRequests.get(sessionId)
  if (request) {
    clearTimeout(request.timeout)
    sessionPortRequests.delete(sessionId)
    request.resolve(port)
  }
  port.onmessage = (messageEvent) => {
    const message = messageEvent.data as { type?: unknown; seq?: unknown; data?: unknown }
    if (!message || typeof message.seq !== 'number' || !(message.data instanceof ArrayBuffer)) return
    const frame = {
      sessionId,
      seq: message.seq,
      data: new Uint8Array(message.data),
    }
    if (message.type === 'output') {
      handleSessionOutput(frame)
      // Compatibility path: keep onPtyData fed after the fast-lane migration (reload smoke / benches).
      if (frame.data.byteLength > 0) {
        handlePtyData(sessionId, new TextDecoder().decode(frame.data))
      }
    } else if (message.type === 'snapshot') {
      handleSessionSnapshot({ ...frame, live: true })
    }
  }
  port.start()
})

function requestSessionPort(sessionId: string): Promise<MessagePort> {
  const existing = sessionPorts.get(sessionId)
  if (existing) return Promise.resolve(existing)
  const pending = sessionPortRequests.get(sessionId)
  if (pending) return pending.promise

  let resolveRequest!: (port: MessagePort) => void
  let rejectRequest!: (error: Error) => void
  const promise = new Promise<MessagePort>((resolve, reject) => {
    resolveRequest = resolve
    rejectRequest = reject
  })
  const request: SessionPortRequest = {
    promise,
    resolve: resolveRequest,
    reject: rejectRequest,
    timeout: setTimeout(() => {
      if (sessionPortRequests.get(sessionId) !== request) return
      sessionPortRequests.delete(sessionId)
      rejectRequest(new Error(`Timed out waiting for terminal fast lane ${sessionId}`))
    }, PTY_PORT_REQUEST_TIMEOUT_MS),
  }
  sessionPortRequests.set(sessionId, request)
  ipcRenderer.send('pty:requestSessionPort', sessionId)
  return promise
}

function closeSessionPort(sessionId: string): void {
  sessionPorts.get(sessionId)?.close()
  sessionPorts.delete(sessionId)
  const request = sessionPortRequests.get(sessionId)
  if (request) {
    clearTimeout(request.timeout)
    sessionPortRequests.delete(sessionId)
    request.reject(new Error(`Terminal fast lane ${sessionId} closed`))
  }
}

ipcRenderer.on('renderer:shown', () => {
  rendererShown = true
  const waiters = rendererShownWaiters.splice(0)
  for (const resolve of waiters) resolve()
})

function waitForRendererShown(): Promise<void> {
  if (rendererShown) return Promise.resolve()
  return new Promise((resolve) => {
    let wrappedResolve: (() => void) | null = null
    const timeout = setTimeout(() => {
      if (wrappedResolve) removeRendererShownWaiter(wrappedResolve)
      resolve()
    }, 500)
    wrappedResolve = () => {
      clearTimeout(timeout)
      resolve()
    }
    rendererShownWaiters.push(wrappedResolve)
  })
}

function removeRendererShownWaiter(resolve: () => void) {
  const index = rendererShownWaiters.indexOf(resolve)
  if (index >= 0) rendererShownWaiters.splice(index, 1)
}

function requestPtyPort(): Promise<void> {
  if (ptyPort) return Promise.resolve()
  if (ptyPortRequest) return ptyPortRequest.promise
  let resolveRequest: (() => void) | null = null
  let rejectRequest: ((error: Error) => void) | null = null
  const promise = new Promise<void>((resolve, reject) => {
    resolveRequest = resolve
    rejectRequest = reject
  })
  const request: PtyPortRequest = {
    promise,
    resolve: () => resolveRequest?.(),
    reject: (error) => rejectRequest?.(error),
    timeout: setTimeout(() => {
      if (ptyPortRequest !== request) return
      ptyPortRequest = null
      request.reject(new Error('Timed out waiting for PTY bridge port'))
    }, PTY_PORT_REQUEST_TIMEOUT_MS),
  }
  ptyPortRequest = request
  ipcRenderer.send('pty:requestPort')
  return promise
}

const electronAPI = {
  async openExternalUrl(url: string): Promise<void> {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Unsupported external URL protocol: ${parsed.protocol}`)
    }
    await ipcRenderer.invoke('host:openExternal', parsed.href)
  },

  writeClipboardText(text: string): Promise<void> {
    return ipcRenderer.invoke('host:writeClipboard', text) as Promise<void>
  },

  async createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
    if (!input || typeof input.terminalId !== 'string' || input.terminalId.length === 0) {
      return Promise.reject(new Error('terminalId is required'))
    }
    if (!isValidTerminalSize(input.cols, input.rows)) {
      return Promise.reject(new Error('Session size must use positive integer cols and rows'))
    }
    const sessionId = createSessionId()
    const trimmedCwd = typeof input.cwd === 'string' ? input.cwd.trim() : ''
    await requestPtyPort()
    await requestSessionPort(sessionId)
    const state = beginReadyState(sessionId)
    queuePtyMessage({
      type: 'spawn',
      sessionId,
      terminalId: input.terminalId,
      cols: input.cols,
      rows: input.rows,
      ...(trimmedCwd.length > 0 ? { cwd: trimmedCwd } : {}),
      ...(input.argv && input.argv.length > 0 ? { argv: [...input.argv] } : {}),
    })
    await (state.size ? Promise.resolve(state.size) : state.promise)
    return { sessionId }
  },

  async attachSession(
    input: AttachSessionInput & { cols?: number; rows?: number; cwd?: string },
  ): Promise<AttachSessionResult> {
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return Promise.reject(new Error('sessionId is required'))
    }
    const cols = typeof input.cols === 'number' ? input.cols : 80
    const rows = typeof input.rows === 'number' ? input.rows : 24
    if (!isValidTerminalSize(cols, rows)) {
      return Promise.reject(new Error('Session size must use positive integer cols and rows'))
    }
    const trimmedCwd = typeof input.cwd === 'string' ? input.cwd.trim() : ''
    const terminalId = typeof input.terminalId === 'string' ? input.terminalId.trim() : ''
    await requestPtyPort()
    await requestSessionPort(sessionId)
    const state = beginReadyState(sessionId)
    queuePtyMessage({
      type: 'attach',
      sessionId,
      ...(terminalId.length > 0 ? { terminalId } : {}),
      cols,
      rows,
      ...(trimmedCwd.length > 0 ? { cwd: trimmedCwd } : {}),
      ...(input.argv && input.argv.length > 0 ? { argv: [...input.argv] } : {}),
    })
    const size = state.size ?? (await state.promise)
    return {
      sessionId,
      seq: state.seq,
      cols: size.cols,
      rows: size.rows,
      archived: state.archived,
      attachMode: state.attachMode,
    }
  },

  detachSession(sessionId: string): Promise<void> {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return Promise.resolve()
    rejectAndClearSessionState(sessionId, new Error(`Session ${sessionId} detached before ready`))
    queuePtyMessage({ type: 'detach', sessionId })
    closeSessionPort(sessionId)
    return Promise.resolve()
  },

  writeSessionInput(sessionId: string, data: string, encoding: 'utf8' | 'binary' = 'utf8'): void {
    // Keep contextBridge arguments primitive. The session MessagePort carries binary input separately.
    if (typeof data !== 'string' || data.length === 0) return
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    const port = sessionPorts.get(sessionId)
    if (!port) return
    const bytes =
      encoding === 'binary'
        ? Uint8Array.from(data, (character) => character.charCodeAt(0) & 0xff)
        : new TextEncoder().encode(data)
    // Prefer transferable ArrayBuffer over number[] so large pastes are not subject to array limits.
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    port.postMessage({ type: 'input', data: buffer }, [buffer])
  },

  acknowledgeSessionOutput(sessionId: string, seq: number): void {
    if (!Number.isSafeInteger(seq) || seq < 0) return
    sessionPorts.get(sessionId)?.postMessage({ type: 'ack', seq })
  },

  requestSessionResync(sessionId: string, appliedSeq: number): void {
    sessionPorts.get(sessionId)?.postMessage({ type: 'resync', seq: appliedSeq })
  },

  resizeSession(sessionId: string, cols: number, rows: number): void {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    if (!isValidTerminalSize(cols, rows)) return
    queuePtyMessage({ type: 'resize', sessionId, cols, rows })
  },

  killSession(sessionId: string): Promise<void> {
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      rejectAndClearSessionState(sessionId, new Error(`Session ${sessionId} was killed before ready`))
      queuePtyMessage({ type: 'kill', sessionId })
      closeSessionPort(sessionId)
    }
    return Promise.resolve()
  },

  clearSessionHistory(sessionId: string): Promise<void> {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return Promise.resolve()
    queuePtyMessage({ type: 'clear-history', sessionIds: [sessionId] })
    return Promise.resolve()
  },

  clearAllSessionHistory(): Promise<void> {
    queuePtyMessage({ type: 'clear-history' })
    return Promise.resolve()
  },

  onSessionOutput(sessionId: string, callback: (frame: OutputFrame) => void): () => void {
    const callbacks = callbacksFor(sessionOutputCallbacks, sessionId)
    callbacks.push(callback)
    flushPendingSessionOutput(sessionId)
    return () => removeCallback(sessionOutputCallbacks, sessionId, callback)
  },

  onSessionSnapshot(
    sessionId: string,
    callback: (frame: CurrentScreenSnapshotFrame) => void,
  ): () => void {
    const callbacks = callbacksFor(sessionSnapshotCallbacks, sessionId)
    callbacks.push(callback)
    const pendingSnapshot = pendingSnapshots.get(sessionId)
    if (pendingSnapshot) {
      pendingSnapshots.delete(sessionId)
      callback(pendingSnapshot)
    }
    return () => removeCallback(sessionSnapshotCallbacks, sessionId, callback)
  },

  onSessionResize(sessionId: string, callback: (cols: number, rows: number) => void): () => void {
    const callbacks = callbacksFor(sessionResizeCallbacks, sessionId)
    callbacks.push(callback)
    return () => removeCallback(sessionResizeCallbacks, sessionId, callback)
  },

  onSessionTitle(sessionId: string, callback: (title: string) => void): () => void {
    const callbacks = callbacksFor(sessionTitleCallbacks, sessionId)
    callbacks.push(callback)
    return () => removeCallback(sessionTitleCallbacks, sessionId, callback)
  },

  onSessionExit(sessionId: string, callback: (info: ExitInfo) => void): () => void {
    const callbacks = callbacksFor(sessionExitCallbacks, sessionId)
    callbacks.push(callback)
    return () => removeCallback(sessionExitCallbacks, sessionId, callback)
  },

  onSessionError(sessionId: string, callback: (error: string) => void): () => void {
    const callbacks = callbacksFor(sessionErrorCallbacks, sessionId)
    callbacks.push(callback)
    return () => removeCallback(sessionErrorCallbacks, sessionId, callback)
  },

  spawnPty(sessionId: string, _cols: number, _rows: number, _cwd?: string): Promise<PtySize> {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return Promise.reject(new Error('PTY sessionId is required'))
    }
    return Promise.reject(new Error('spawnPty is deprecated; use createSession instead'))
  },

  sendPtyInput(sessionId: string, data: string): void {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    if (typeof data !== 'string' || data.length === 0) return
    const port = sessionPorts.get(sessionId)
    if (!port) return
    const bytes = new TextEncoder().encode(data)
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    port.postMessage({ type: 'input', data: buffer }, [buffer])
  },

  resizePty(sessionId: string, cols: number, rows: number): void {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    if (!isValidTerminalSize(cols, rows)) return
    queuePtyMessage({ type: 'resize', sessionId, cols, rows })
  },

  killPty(sessionId: string): void {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    rejectAndClearSessionState(sessionId, new Error(`PTY ${sessionId} was killed before ready`))
    queuePtyMessage({ type: 'kill', sessionId })
  },

  onPtyData(sessionId: string, callback: (data: string) => void): () => void {
    const callbacks = callbacksFor(ptyDataCallbacks, sessionId)
    callbacks.push(callback)
    flushPendingData(sessionId)
    return () => removeCallback(ptyDataCallbacks, sessionId, callback)
  },

  onPtyError(sessionId: string, callback: (error: string) => void): () => void {
    const callbacks = callbacksFor(ptyErrorCallbacks, sessionId)
    callbacks.push(callback)
    return () => removeCallback(ptyErrorCallbacks, sessionId, callback)
  },

  onPtyExit(sessionId: string, callback: (info: PtyExitInfo) => void): () => void {
    const callbacks = callbacksFor(ptyExitCallbacks, sessionId)
    callbacks.push(callback)
    return () => removeCallback(ptyExitCallbacks, sessionId, callback)
  },

  signalReady(): Promise<void> {
    queuePtyMessage({ type: 'renderer-ready' })
    const shown = waitForRendererShown()
    if (!rendererReadySignaled) {
      rendererReadySignaled = true
      ipcRenderer.send('renderer:ready')
    }
    return shown
  },

  onAppCommand(callback: AppCommandCallback): () => void {
    const listener = (_event: Electron.IpcRendererEvent, command: AppCommand) => {
      callback(command)
    }
    ipcRenderer.on('app:command', listener)
    return () => {
      ipcRenderer.removeListener('app:command', listener)
    }
  },

  getTerminalPreloadDiagnostics(): TerminalPreloadDiagnostics {
    return getTerminalPreloadDiagnostics()
  },

  async getTaudDiagnostics(): Promise<TaudLifecycleDiagnostics | null> {
    const payload = await ipcRenderer.invoke('taud:getDiagnostics')
    return payload === null ? null : assertLifecycleDiagnostics(payload)
  },

  async getTaudPtyBridgeDiagnostics(): Promise<TaudPtyBridgeDiagnostics | null> {
    const payload = await ipcRenderer.invoke('taud:getPtyBridgeDiagnostics')
    return payload === null ? null : assertBridgeDiagnostics(payload)
  },

  async recoverTaud(action: TaudLifecycleRecoveryInput): Promise<TaudLifecycleDiagnostics | null> {
    if (!RECOVERY_ACTIONS.has(action)) throw new Error('Invalid taud recovery action')
    const payload = await ipcRenderer.invoke('taud:recover', action)
    return payload === null ? null : assertLifecycleDiagnostics(payload)
  },

  async getMuxGraph(): Promise<MuxGraphSnapshot> {
    return assertMuxGraphSnapshot(await ipcRenderer.invoke('mux-graph:get'))
  },

  async replaceMuxGraph(
    snapshot: MuxGraphSnapshot,
    expectedRev: number,
  ): Promise<MuxGraphSnapshot> {
    const decoded = assertMuxGraphSnapshot(snapshot)
    return assertMuxGraphSnapshot(
      await ipcRenderer.invoke('mux-graph:replace', decoded, expectedRev),
    )
  },

  async waitMuxGraph(afterEventSeq: number): Promise<MuxGraphSnapshot> {
    return assertMuxGraphSnapshot(await ipcRenderer.invoke('mux-graph:wait', afterEventSeq))
  },

  readSettings(): Promise<SettingsData | null> {
    return ipcRenderer.invoke('settings:read') as Promise<SettingsData | null>
  },

  writeSettings(data: SettingsData): Promise<void> {
    return ipcRenderer.invoke('settings:write', data) as Promise<void>
  },
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

export type ElectronAPI = typeof electronAPI

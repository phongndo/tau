import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import electron from 'electron'
import { resolveTauStoragePaths } from '@tau/shared/storage-path'
import {
  TAUD_CONTROL_CAPABILITIES,
  TAUD_CONTROL_PROTOCOL_VERSION,
  TAUD_STREAM_MAX_PAYLOAD_BYTES,
  TaudStreamFrameKind,
  type TaudControlRequestDiagnostics,
  type TaudDaemonControlDiagnostics,
  type TaudDaemonOwnership,
  type TaudLifecycleDiagnostics,
  type TaudLifecycleEvent,
  type TaudLifecycleRecoveryAction,
  type TaudLifecycleState,
  type TaudStreamDiagnostics,
  type TaudStreamFrameKind as TaudStreamFrameKindValue,
} from '@tau/shared/taud-protocol'
import {
  encodeTaudResizePayload,
  encodeTaudStreamFrame,
  TaudStreamFrameParser,
  type TaudParsedStreamFrame,
} from './taud-stream'


const DEFAULT_CONNECT_TIMEOUT_MS = 500
const DEFAULT_CONTROL_RESPONSE_TIMEOUT_MS = 5000
const DEFAULT_START_TIMEOUT_MS = 3000
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 10_000
const DEFAULT_RESTART_BACKOFF_MS = 750
const DEFAULT_DISPOSE_DAEMON_TIMEOUT_MS = 1000
/** Must cover daemon graph_snapshot_bytes_max after JSON string escaping plus control envelope. */
const CONTROL_RESPONSE_MAX_BYTES = 9 * 1024 * 1024
const TAUD_LIFECYCLE_EVENT_LIMIT = 32

type ElectronAppLike = {
  getAppPath(): string
}

const electronApp =
  typeof electron === 'object' && electron !== null && 'app' in electron
    ? (electron as { app?: ElectronAppLike }).app
    : undefined

type TaudRequest = Record<string, unknown>

export type TaudControlResponse = {
  readonly id?: string
  readonly trace_id?: string
  readonly traceId?: string
  readonly ok: boolean
  readonly protocol_version?: number
  readonly protocolVersion?: number
  readonly daemon_version?: string
  readonly daemonVersion?: string
  readonly capabilities?: unknown
  readonly session_id?: string
  readonly stream_id?: string
  readonly pid?: number
  readonly status?: string
  readonly cwd?: string
  readonly cols?: number
  readonly rows?: number
  readonly last_seq?: number
  readonly attach_kind?: string
  readonly removed_sessions?: number
  readonly removed_bytes?: number
  readonly stream_diagnostics?: unknown
  readonly streamDiagnostics?: unknown
  readonly control_diagnostics?: unknown
  readonly controlDiagnostics?: unknown
  readonly graph_snapshot_json?: unknown
  readonly graph_rev?: unknown
  readonly event_seq?: unknown
  readonly oldest_event_seq?: unknown
  readonly graph_changed?: unknown
  readonly requires_resync?: unknown
  readonly error_code?: string
  readonly error_message?: string
}

type TaudRawControlResponse = TaudControlResponse & Record<string, unknown>

type RawTaudStreamDiagnostics = {
  readonly active_subscribers?: unknown
  readonly activeSubscribers?: unknown
  readonly pending_output_sessions?: unknown
  readonly pendingOutputSessions?: unknown
  readonly pending_output_frames?: unknown
  readonly pendingOutputFrames?: unknown
  readonly pending_output_bytes?: unknown
  readonly pendingOutputBytes?: unknown
  readonly input_frames_total?: unknown
  readonly inputFramesTotal?: unknown
  readonly input_bytes_total?: unknown
  readonly inputBytesTotal?: unknown
  readonly output_frames_total?: unknown
  readonly outputFramesTotal?: unknown
  readonly output_bytes_total?: unknown
  readonly outputBytesTotal?: unknown
  readonly last_pty_read_ns?: unknown
  readonly lastPtyReadNs?: unknown
  readonly slow_subscriber_drops_total?: unknown
  readonly slowSubscriberDropsTotal?: unknown
  readonly pending_output_dropped_frames_total?: unknown
  readonly pendingOutputDroppedFramesTotal?: unknown
  readonly pending_output_dropped_bytes_total?: unknown
  readonly pendingOutputDroppedBytesTotal?: unknown
  readonly pending_output_truncated_bytes_total?: unknown
  readonly pendingOutputTruncatedBytesTotal?: unknown
}

type RawTaudDaemonControlDiagnostics = {
  readonly request_count?: unknown
  readonly requestCount?: unknown
  readonly failure_count?: unknown
  readonly failureCount?: unknown
  readonly last_request_type?: unknown
  readonly lastRequestType?: unknown
  readonly last_trace_id?: unknown
  readonly lastTraceId?: unknown
  readonly last_duration_ms?: unknown
  readonly lastDurationMs?: unknown
  readonly last_ok?: unknown
  readonly lastOk?: unknown
  readonly last_recorded_at_ms?: unknown
  readonly lastRecordedAtMs?: unknown
}

export type TaudCreateSessionInput = {
  readonly sessionId: string
  readonly terminalId: string
  readonly cols: number
  readonly rows: number
  readonly cwd?: string
  readonly argv?: readonly string[]
}

export type TaudAttachSessionInput = {
  readonly sessionId: string
  readonly terminalId?: string
  readonly cols?: number
  readonly rows?: number
  readonly cwd?: string
}

export type TaudCleanupSessionsInput = {
  readonly retainDays: number
  readonly maxSessionBytes: number
  readonly activeSessionIds?: readonly string[]
}

export type TaudPersistenceSettingsInput = {
  readonly enabled: boolean
  readonly persistInput: boolean
}

export type TaudMuxGraphState = {
  readonly snapshotJson: string
  readonly graphRev: number
  readonly eventSeq: number
  readonly oldestEventSeq: number
  readonly changed: boolean
  readonly requiresResync: boolean
}







export type TaudSessionStreamEvents = {
  frame: [TaudParsedStreamFrame]
  error: [Error]
  close: []
}

let nextRequestNumber = 0

function nextRequestId(prefix: string): string {
  nextRequestNumber += 1
  return `${prefix}-${Date.now().toString(36)}-${nextRequestNumber.toString(36)}`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

function requestField(request: TaudRequest, field: string): string {
  const value = request[field]
  return typeof value === 'string' && value.length > 0 ? value : 'unknown'
}

function requestTraceId(clientTraceId: string, request: TaudRequest): string {
  const existing = requestField(request, 'traceId')
  if (existing !== 'unknown') return existing
  return `${clientTraceId}:${requestField(request, 'id')}`
}

function responseTraceId(response: TaudControlResponse): string | undefined {
  const traceId = response.trace_id ?? response.traceId
  return typeof traceId === 'string' && traceId.length > 0 ? traceId : undefined
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (hasExited(child)) return Promise.resolve()

  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      child.off('exit', finish)
      child.off('error', finish)
      resolve()
    }
    const timeout = setTimeout(finish, timeoutMs)
    timeout.unref?.()
    child.once('exit', finish)
    child.once('error', finish)
  })
}

function responseError(response: TaudControlResponse): Error {
  const error = new Error(response.error_message ?? 'taud request failed') as Error & {
    code?: string
    kind?: string
  }
  error.code = response.error_code
  error.kind = response.error_code
  return error
}

class TaudCompatibilityError extends Error {
  readonly code = 'TAUD_PROTOCOL_MISMATCH'
}

function isTaudCompatibilityError(error: unknown): error is TaudCompatibilityError {
  return error instanceof TaudCompatibilityError
}

function formatDaemonVersion(response: TaudControlResponse): string {
  return (
    optionalString(response.daemon_version ?? response.daemonVersion) ??
    `protocol ${String(response.protocol_version ?? response.protocolVersion ?? 'unknown')}`
  )
}

function assertCompatiblePingResponse(response: TaudControlResponse): void {
  if (!response.ok || response.status !== 'ok') throw responseError(response)

  const protocolVersion = numberOr(
    response.protocol_version ?? response.protocolVersion,
    Number.NaN,
  )
  if (protocolVersion !== TAUD_CONTROL_PROTOCOL_VERSION) {
    throw new TaudCompatibilityError(
      `taud protocol mismatch: desktop requires protocol ${TAUD_CONTROL_PROTOCOL_VERSION}, daemon reported ${String(protocolVersion)} (${formatDaemonVersion(response)})`,
    )
  }

  const capabilities = new Set(stringArray(response.capabilities))
  const missingCapabilities = TAUD_CONTROL_CAPABILITIES.filter(
    (capability) => !capabilities.has(capability),
  )
  if (missingCapabilities.length > 0) {
    throw new TaudCompatibilityError(
      `taud protocol mismatch: daemon ${formatDaemonVersion(response)} is missing capabilities ${missingCapabilities.join(', ')}`,
    )
  }
}

function parseControlResponse(line: Buffer): TaudRawControlResponse {
  const parsed = JSON.parse(line.toString('utf8')) as TaudRawControlResponse
  if (!parsed || typeof parsed.ok !== 'boolean') throw new Error('Invalid taud control response')
  return parsed
}

function parseMuxGraphState(response: TaudRawControlResponse): TaudMuxGraphState {
  if (
    typeof response.graph_snapshot_json !== 'string' ||
    typeof response.graph_rev !== 'number' ||
    typeof response.event_seq !== 'number'
  ) {
    throw new Error('Invalid taud mux graph response')
  }
  return {
    snapshotJson: response.graph_snapshot_json,
    graphRev: response.graph_rev,
    eventSeq: response.event_seq,
    oldestEventSeq:
      typeof response.oldest_event_seq === 'number'
        ? response.oldest_event_seq
        : response.event_seq,
    changed: response.graph_changed !== false,
    requiresResync: response.requires_resync === true,
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}


function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function normalizeTaudStreamDiagnostics(value: unknown): TaudStreamDiagnostics | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as RawTaudStreamDiagnostics
  return {
    activeSubscribers: numberOr(raw.active_subscribers ?? raw.activeSubscribers, 0),
    pendingOutputSessions: numberOr(raw.pending_output_sessions ?? raw.pendingOutputSessions, 0),
    pendingOutputFrames: numberOr(raw.pending_output_frames ?? raw.pendingOutputFrames, 0),
    pendingOutputBytes: numberOr(raw.pending_output_bytes ?? raw.pendingOutputBytes, 0),
    inputFramesTotal: numberOr(raw.input_frames_total ?? raw.inputFramesTotal, 0),
    inputBytesTotal: numberOr(raw.input_bytes_total ?? raw.inputBytesTotal, 0),
    outputFramesTotal: numberOr(raw.output_frames_total ?? raw.outputFramesTotal, 0),
    outputBytesTotal: numberOr(raw.output_bytes_total ?? raw.outputBytesTotal, 0),
    lastPtyReadNs: numberOr(raw.last_pty_read_ns ?? raw.lastPtyReadNs, 0),
    slowSubscriberDropsTotal: numberOr(
      raw.slow_subscriber_drops_total ?? raw.slowSubscriberDropsTotal,
      0,
    ),
    pendingOutputDroppedFramesTotal: numberOr(
      raw.pending_output_dropped_frames_total ?? raw.pendingOutputDroppedFramesTotal,
      0,
    ),
    pendingOutputDroppedBytesTotal: numberOr(
      raw.pending_output_dropped_bytes_total ?? raw.pendingOutputDroppedBytesTotal,
      0,
    ),
    pendingOutputTruncatedBytesTotal: numberOr(
      raw.pending_output_truncated_bytes_total ?? raw.pendingOutputTruncatedBytesTotal,
      0,
    ),
  }
}

function normalizeTaudDaemonControlDiagnostics(
  value: unknown,
): TaudDaemonControlDiagnostics | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as RawTaudDaemonControlDiagnostics
  const lastRequestType = optionalString(raw.last_request_type ?? raw.lastRequestType)
  const lastTraceId = optionalString(raw.last_trace_id ?? raw.lastTraceId)
  const lastDurationMs = raw.last_duration_ms ?? raw.lastDurationMs
  const lastOk = raw.last_ok ?? raw.lastOk
  const lastRecordedAtMs = raw.last_recorded_at_ms ?? raw.lastRecordedAtMs
  return {
    requestCount: numberOr(raw.request_count ?? raw.requestCount, 0),
    failureCount: numberOr(raw.failure_count ?? raw.failureCount, 0),
    ...(lastRequestType ? { lastRequestType } : {}),
    ...(lastTraceId ? { lastTraceId } : {}),
    ...(typeof lastDurationMs === 'number' ? { lastDurationMs } : {}),
    ...(typeof lastOk === 'boolean' ? { lastOk } : {}),
    ...(typeof lastRecordedAtMs === 'number' ? { lastRecordedAtMs } : {}),
  }
}

function candidateTaudPaths(): string[] {
  const envPath = process.env.TAUD_PATH?.trim()
  const exeName = process.platform === 'win32' ? 'taud.exe' : 'taud'
  const appPath = safeAppPath()
  const cwd = process.cwd()

  return Array.from(
    new Set(
      [
        envPath,
        join(cwd, 'apps/daemon/zig-out/bin', exeName),
        join(cwd, '../daemon/zig-out/bin', exeName),
        join(cwd, '../../apps/daemon/zig-out/bin', exeName),
        appPath ? join(appPath, '../daemon/zig-out/bin', exeName) : null,
        appPath ? join(appPath, '../../daemon/zig-out/bin', exeName) : null,
        appPath ? join(appPath, 'bin', exeName) : null,
        typeof __dirname === 'string' ? join(__dirname, '../bin', exeName) : null,
        typeof __dirname === 'string'
          ? join(__dirname, '../../../daemon/zig-out/bin', exeName)
          : null,
        typeof __dirname === 'string'
          ? join(__dirname, '../../../../apps/daemon/zig-out/bin', exeName)
          : null,
        process.resourcesPath ? join(process.resourcesPath, exeName) : null,
        process.resourcesPath ? join(process.resourcesPath, 'bin', exeName) : null,
      ]
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .map((value) => resolve(value)),
    ),
  )
}


function safeAppPath(): string | null {
  try {
    return electronApp?.getAppPath() ?? null
  } catch {
    return null
  }
}

function findTaudBinary(): string | null {
  for (const candidate of candidateTaudPaths()) {
    if (existsSync(candidate)) return candidate
  }
  return null
}


function defaultSocketPath(): string {
  return resolveTauStoragePaths(homedir()).socket
}

function connectUnixSocket(socketPath: string, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = net.createConnection(socketPath)
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      rejectSocket(new Error(`Timed out connecting to taud at ${socketPath}`))
    }, timeoutMs)

    socket.once('connect', () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolveSocket(socket)
    })

    socket.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      socket.destroy()
      rejectSocket(error)
    })
  })
}

function writeSocketPayload(
  socket: net.Socket,
  payload: string | Buffer,
  timeoutMs: number,
  context: string,
): Promise<void> {
  return new Promise((resolveWrite, rejectWrite) => {
    let settled = false
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out writing ${context} to taud`))
    }, timeoutMs)

    function cleanup() {
      clearTimeout(timeout)
      socket.off('drain', onDrain)
      socket.off('error', onError)
      socket.off('close', onClose)
    }

    function resolve() {
      if (settled) return
      settled = true
      cleanup()
      resolveWrite()
    }

    function reject(error: Error) {
      if (settled) return
      settled = true
      cleanup()
      rejectWrite(error)
    }

    function onDrain() {
      resolve()
    }

    function onError(error: Error) {
      reject(error)
    }

    function onClose() {
      reject(new Error(`taud closed the socket before accepting ${context}`))
    }

    socket.once('error', onError)
    socket.once('close', onClose)
    const accepted = socket.write(payload, (error) => {
      if (error) reject(error)
    })

    if (!accepted) {
      console.warn(
        `[taud-client] socket write backpressure while writing ${context}; buffered=${socket.writableLength}`,
      )
      socket.once('drain', onDrain)
      return
    }

    resolve()
  })
}

function readNdjsonResponse(
  socket: net.Socket,
  timeoutMs: number,
): Promise<{ response: TaudRawControlResponse; tail: Buffer }> {
  return new Promise((resolveResponse, rejectResponse) => {
    let buffered = Buffer.alloc(0)
    let settled = false
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for taud control response'))
    }, timeoutMs)

    function cleanup() {
      clearTimeout(timeout)
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
    }

    function reject(error: Error) {
      if (settled) return
      settled = true
      cleanup()
      rejectResponse(error)
    }

    function onData(chunk: Buffer) {
      buffered = buffered.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffered, chunk])
      if (buffered.length > CONTROL_RESPONSE_MAX_BYTES) {
        reject(new Error('taud control response too large'))
        return
      }

      const newlineIndex = buffered.indexOf(0x0a)
      if (newlineIndex === -1) return

      try {
        const line = buffered.subarray(0, newlineIndex)
        const tail = Buffer.from(buffered.subarray(newlineIndex + 1))
        const response = parseControlResponse(line)
        if (settled) return
        settled = true
        socket.pause()
        cleanup()
        resolveResponse({ response, tail })
      } catch (error) {
        reject(normalizeError(error))
      }
    }

    function onError(error: Error) {
      reject(error)
    }

    function onClose() {
      reject(new Error('taud closed the control socket before responding'))
    }

    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

/** Bound queued terminal input while the stream socket is write-blocked. */
const SESSION_INPUT_QUEUE_MAX_BYTES = 1024 * 1024
/** Chunk size for direct and queued writes; keeps frames under the daemon payload limit. */
const SESSION_INPUT_CHUNK_MAX_BYTES = Math.min(256 * 1024, TAUD_STREAM_MAX_PAYLOAD_BYTES, SESSION_INPUT_QUEUE_MAX_BYTES)

export class TaudSessionStream extends EventEmitter<TaudSessionStreamEvents> {
  private readonly parser = new TaudStreamFrameParser()
  private clientSeq = 0n
  private started = false
  private waitingForWriteDrain = false
  private inputQueue: Buffer[] = []
  private inputQueueBytes = 0

  constructor(
    private readonly socket: net.Socket,
    private readonly sessionId: string,
    private readonly initialTail: Buffer,
  ) {
    super()
    socket.on('data', (chunk) => this.handleChunk(Buffer.from(chunk)))
    socket.once('error', (error) => this.emit('error', normalizeError(error)))
    socket.once('close', () => this.emit('close'))
  }

  start(): void {
    if (this.started) return
    this.started = true
    if (this.initialTail.length > 0) this.handleChunk(this.initialTail)
    this.socket.resume()
  }

  writeInput(data: string | Buffer | Uint8Array): void {
    const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
    if (payload.length === 0 || this.socket.destroyed) return
    // Always chunk first: a single huge paste must not bypass the queue cap or the stream payload limit.
    let offset = 0
    while (offset < payload.length) {
      const end = Math.min(offset + SESSION_INPUT_CHUNK_MAX_BYTES, payload.length)
      const chunk = Buffer.from(payload.subarray(offset, end))
      offset = end
      if (this.waitingForWriteDrain || this.inputQueue.length > 0) {
        this.enqueueInput(chunk)
        continue
      }
      this.writeFrame(TaudStreamFrameKind.Input, chunk)
    }
  }

  resize(cols: number, rows: number): void {
    if (this.socket.destroyed) return
    this.writeFrame(TaudStreamFrameKind.Resize, encodeTaudResizePayload(cols, rows))
  }

  close(): void {
    this.inputQueue = []
    this.inputQueueBytes = 0
    this.waitingForWriteDrain = false
    this.socket.end()
    this.socket.destroy()
  }

  private enqueueInput(payload: Buffer): void {
    if (payload.length > SESSION_INPUT_QUEUE_MAX_BYTES) {
      console.warn(
        `[taud-client] dropping oversized input frame for ${this.sessionId}; bytes=${payload.length}`,
      )
      return
    }
    // Overflow policy: drop oldest queued chunks so the newest paste can still land.
    while (
      this.inputQueue.length > 0 &&
      this.inputQueueBytes + payload.length > SESSION_INPUT_QUEUE_MAX_BYTES
    ) {
      const dropped = this.inputQueue.shift()!
      this.inputQueueBytes -= dropped.length
      console.warn(
        `[taud-client] input queue overflow for ${this.sessionId}; dropped oldest chunk bytes=${dropped.length}`,
      )
    }
    if (this.inputQueueBytes + payload.length > SESSION_INPUT_QUEUE_MAX_BYTES) return
    this.inputQueue.push(payload)
    this.inputQueueBytes += payload.length
  }

  private flushInputQueue(): void {
    while (this.inputQueue.length > 0 && !this.socket.destroyed && !this.waitingForWriteDrain) {
      const next = this.inputQueue.shift()!
      this.inputQueueBytes -= next.length
      this.writeFrame(TaudStreamFrameKind.Input, next)
    }
  }

  private writeFrame(kind: TaudStreamFrameKindValue, payload: Buffer): void {
    this.clientSeq += 1n
    const frame = encodeTaudStreamFrame({
      kind,
      sessionId: this.sessionId,
      seq: this.clientSeq,
      payload,
    })
    const accepted = this.socket.write(frame)
    if (!accepted && !this.waitingForWriteDrain) {
      this.waitingForWriteDrain = true
      console.warn(
        `[taud-client] stream write backpressure for ${this.sessionId}; buffered=${this.socket.writableLength}`,
      )
      this.socket.once('drain', () => {
        this.waitingForWriteDrain = false
        this.flushInputQueue()
      })
    }
  }

  private handleChunk(chunk: Buffer): void {
    try {
      for (const frame of this.parser.push(chunk)) {
        this.emit('frame', frame)
      }
    } catch (error) {
      this.emit('error', normalizeError(error))
      this.close()
    }
  }
}

export class TaudClient {
  private readonly socketPath: string
  private readonly connectTimeoutMs: number
  private readonly controlResponseTimeoutMs: number
  private readonly startTimeoutMs: number
  private readonly healthCheckIntervalMs: number
  private readonly restartBackoffMs: number
  private readonly detachDaemon: boolean
  private startPromise: Promise<void> | null = null
  private spawnedProcess: ChildProcess | null = null
  private healthTimer: ReturnType<typeof setInterval> | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private lifecycleState: TaudLifecycleState = 'absent'
  private lifecycleReason: string | undefined
  private lifecycleError: string | undefined
  private lifecycleDaemonVersion: string | undefined
  private lifecycleProtocolVersion: number | undefined
  private lifecycleCapabilities: string[] = []
  private lifecycleStreamDiagnostics: TaudStreamDiagnostics | undefined
  private lifecycleDaemonControlDiagnostics: TaudDaemonControlDiagnostics | undefined
  private lifecycleDaemonOwnership: TaudDaemonOwnership = 'none'
  private releasedDetachedPid: number | undefined
  private controlRequestCount = 0
  private controlRequestFailureCount = 0
  private lastControlRequest: TaudControlRequestDiagnostics | undefined
  private readonly clientTraceId = nextRequestId('taud-client')
  private readonly clientCreatedAt = Date.now()
  private lastTransitionAt = this.clientCreatedAt
  private lastPingStartedAt: number | undefined
  private lastPingDurationMs: number | undefined
  private lastSuccessfulPingAt: number | undefined
  private lastFailedPingAt: number | undefined
  private lastStartRequestedAt: number | undefined
  private lastStartDurationMs: number | undefined
  private readonly lifecycleEvents: TaudLifecycleEvent[] = [
    { state: 'absent', at: this.clientCreatedAt, reason: 'client-created' },
  ]

  constructor(
    options: {
      socketPath?: string
      connectTimeoutMs?: number
      controlResponseTimeoutMs?: number
      startTimeoutMs?: number
      healthCheckIntervalMs?: number
      restartBackoffMs?: number
      detachDaemon?: boolean
    } = {},
  ) {
    this.socketPath = options.socketPath ?? defaultSocketPath()
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.controlResponseTimeoutMs =
      options.controlResponseTimeoutMs ?? DEFAULT_CONTROL_RESPONSE_TIMEOUT_MS
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS
    this.healthCheckIntervalMs = options.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS
    this.restartBackoffMs = options.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS
    this.detachDaemon = options.detachDaemon ?? true
  }

  getLifecycleDiagnostics(): TaudLifecycleDiagnostics {
    return {
      clientTraceId: this.clientTraceId,
      state: this.lifecycleState,
      socketPath: this.socketPath,
      detachDaemon: this.detachDaemon,
      healthChecksEnabled: this.healthCheckIntervalMs > 0,
      healthChecksStarted: this.healthTimer !== null,
      startInFlight: this.startPromise !== null,
      restartScheduled: this.restartTimer !== null,
      daemonOwnership: this.lifecycleDaemonOwnership,
      recoveryAction: this.lifecycleRecoveryAction(),
      ...(this.spawnedProcess?.pid ? { spawnedPid: this.spawnedProcess.pid } : {}),
      ...(this.releasedDetachedPid ? { releasedDetachedPid: this.releasedDetachedPid } : {}),
      ...(this.lifecycleDaemonVersion ? { daemonVersion: this.lifecycleDaemonVersion } : {}),
      ...(typeof this.lifecycleProtocolVersion === 'number'
        ? { protocolVersion: this.lifecycleProtocolVersion }
        : {}),
      capabilities: [...this.lifecycleCapabilities],
      ...(this.lifecycleReason ? { lastReason: this.lifecycleReason } : {}),
      ...(this.lifecycleError ? { lastError: this.lifecycleError } : {}),
      controlRequestCount: this.controlRequestCount,
      controlRequestFailureCount: this.controlRequestFailureCount,
      ...(this.lastControlRequest ? { lastControlRequest: this.lastControlRequest } : {}),
      ...(this.lifecycleStreamDiagnostics
        ? { streamDiagnostics: this.lifecycleStreamDiagnostics }
        : {}),
      ...(this.lifecycleDaemonControlDiagnostics
        ? { daemonControlDiagnostics: this.lifecycleDaemonControlDiagnostics }
        : {}),
      timing: {
        clientCreatedAt: this.clientCreatedAt,
        lastTransitionAt: this.lastTransitionAt,
        ...(typeof this.lastPingStartedAt === 'number'
          ? { lastPingStartedAt: this.lastPingStartedAt }
          : {}),
        ...(typeof this.lastPingDurationMs === 'number'
          ? { lastPingDurationMs: this.lastPingDurationMs }
          : {}),
        ...(typeof this.lastSuccessfulPingAt === 'number'
          ? { lastSuccessfulPingAt: this.lastSuccessfulPingAt }
          : {}),
        ...(typeof this.lastFailedPingAt === 'number'
          ? { lastFailedPingAt: this.lastFailedPingAt }
          : {}),
        ...(typeof this.lastStartRequestedAt === 'number'
          ? { lastStartRequestedAt: this.lastStartRequestedAt }
          : {}),
        ...(typeof this.lastStartDurationMs === 'number'
          ? { lastStartDurationMs: this.lastStartDurationMs }
          : {}),
      },
      transitions: [...this.lifecycleEvents],
    }
  }

  private transitionLifecycle(state: TaudLifecycleState, reason?: string, error?: unknown): void {
    const transitionedAt = Date.now()
    this.lifecycleState = state
    this.lifecycleReason = reason
    this.lifecycleError = error == null ? undefined : errorMessage(error)
    this.lastTransitionAt = transitionedAt
    this.lifecycleEvents.push({
      state,
      at: transitionedAt,
      ...(reason ? { reason } : {}),
    })
    if (this.lifecycleEvents.length > TAUD_LIFECYCLE_EVENT_LIMIT) {
      this.lifecycleEvents.splice(0, this.lifecycleEvents.length - TAUD_LIFECYCLE_EVENT_LIMIT)
    }
  }

  private recordLiveDaemon(response: TaudControlResponse): void {
    this.lifecycleDaemonOwnership = this.currentDaemonOwnership()
    this.lifecycleDaemonVersion =
      optionalString(response.daemon_version ?? response.daemonVersion) ??
      this.lifecycleDaemonVersion
    this.lifecycleProtocolVersion = numberOr(
      response.protocol_version ?? response.protocolVersion,
      this.lifecycleProtocolVersion ?? Number.NaN,
    )
    if (!Number.isFinite(this.lifecycleProtocolVersion)) this.lifecycleProtocolVersion = undefined
    this.lifecycleCapabilities = stringArray(response.capabilities)
    this.lifecycleStreamDiagnostics = normalizeTaudStreamDiagnostics(
      response.stream_diagnostics ?? response.streamDiagnostics,
    )
    this.lifecycleDaemonControlDiagnostics = normalizeTaudDaemonControlDiagnostics(
      response.control_diagnostics ?? response.controlDiagnostics,
    )
  }

  private currentDaemonOwnership(): TaudDaemonOwnership {
    if (this.spawnedProcess && !hasExited(this.spawnedProcess)) {
      return this.detachDaemon ? 'owned-detached' : 'owned-attached'
    }
    return 'external'
  }

  private lifecycleRecoveryAction(): TaudLifecycleRecoveryAction {
    if (this.disposed) {
      return this.lifecycleDaemonOwnership === 'released-detached' ? 'keep-detached-daemon' : 'none'
    }
    switch (this.lifecycleState) {
      case 'absent':
        return 'start-daemon'
      case 'starting':
        return 'wait-for-start'
      case 'external-live':
        return 'reuse-external-daemon'
      case 'owned-live':
        return 'none'
      case 'stale-socket':
        return 'clear-stale-socket-and-start'
      case 'crashed':
        return 'restart-owned-daemon'
      case 'version-mismatch':
        return 'replace-incompatible-daemon'
      case 'stopping':
      case 'disposed':
        return 'none'
    }
  }

  async refreshLifecycleDiagnostics(): Promise<TaudLifecycleDiagnostics> {
    if (!this.disposed) {
      try {
        await this.canConnect()
      } catch {
        // canConnect records lifecycle state before returning or throwing. Keep diagnostics readable
        // even when the latest refresh cannot reach a compatible daemon.
      }
    }
    return this.getLifecycleDiagnostics()
  }

  private recordControlRequest(
    request: TaudRequest,
    startedAt: number,
    ok: boolean,
    responseTrace: string | undefined,
    error?: unknown,
  ): void {
    this.controlRequestCount += 1
    if (!ok) this.controlRequestFailureCount += 1
    this.lastControlRequest = {
      id: requestField(request, 'id'),
      traceId: requestTraceId(this.clientTraceId, request),
      ...(responseTrace ? { responseTraceId: responseTrace } : {}),
      type: requestField(request, 'type'),
      at: startedAt,
      durationMs: Date.now() - startedAt,
      ok,
      ...(error == null ? {} : { error: errorMessage(error) }),
    }
  }

  async ensureRunning(): Promise<void> {
    if (this.disposed) throw new Error('taud client is disposed')
    this.startHealthChecks()
    if (await this.canConnect()) {
      if (this.disposed) throw new Error('taud client is disposed')
      return
    }
    if (this.disposed) throw new Error('taud client is disposed')

    this.transitionLifecycle('starting', 'daemon-start-requested')
    this.startPromise ??= this.startDaemon().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  async applyLifecycleRecovery(
    action: TaudLifecycleRecoveryAction,
  ): Promise<TaudLifecycleDiagnostics> {
    if (
      action === 'none' ||
      action === 'reuse-external-daemon' ||
      action === 'keep-detached-daemon'
    ) {
      return this.refreshLifecycleDiagnostics()
    }

    const diagnostics = this.getLifecycleDiagnostics()
    if (diagnostics.recoveryAction !== action) {
      throw new Error(
        `Cannot apply taud recovery action ${action}; current action is ${diagnostics.recoveryAction}`,
      )
    }

    switch (action) {
      case 'start-daemon':
      case 'wait-for-start':
      case 'clear-stale-socket-and-start':
        this.clearScheduledRestart()
        await this.ensureRunning()
        break
      case 'restart-owned-daemon':
        this.clearScheduledRestart()
        await this.restartOwnedDaemon('manual-recovery-restart-owned')
        break
      case 'replace-incompatible-daemon':
        this.clearScheduledRestart()
        await this.restartOwnedDaemon('manual-recovery-replace-incompatible')
        break
    }

    return this.refreshLifecycleDiagnostics()
  }

  async dispose(): Promise<void> {
    this.transitionLifecycle('stopping', 'client-dispose')
    this.disposed = true
    if (this.healthTimer) clearInterval(this.healthTimer)
    this.healthTimer = null
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    const spawnedProcess = this.spawnedProcess
    const releasedDetachedPid =
      this.detachDaemon && spawnedProcess && !hasExited(spawnedProcess)
        ? spawnedProcess.pid
        : undefined
    if (releasedDetachedPid) {
      this.releasedDetachedPid = releasedDetachedPid
      this.lifecycleDaemonOwnership = 'released-detached'
    } else {
      this.lifecycleDaemonOwnership = 'none'
    }
    this.spawnedProcess = null
    // taud is intentionally detached and may keep live PTYs available across Electron restarts.
    // Disposing the client releases this process' handles without terminating the daemon.
    if (!this.detachDaemon && spawnedProcess && !hasExited(spawnedProcess)) {
      spawnedProcess.kill()
      await waitForChildExit(spawnedProcess, DEFAULT_DISPOSE_DAEMON_TIMEOUT_MS)
      if (!hasExited(spawnedProcess)) {
        spawnedProcess.kill('SIGKILL')
        await waitForChildExit(spawnedProcess, DEFAULT_DISPOSE_DAEMON_TIMEOUT_MS)
      }
    }
    spawnedProcess?.removeAllListeners()
    this.transitionLifecycle('disposed', 'client-disposed')
  }

  private clearScheduledRestart(): void {
    if (!this.restartTimer) return
    clearTimeout(this.restartTimer)
    this.restartTimer = null
  }

  private async restartOwnedDaemon(reason: string): Promise<void> {
    if (this.disposed) throw new Error('taud client is disposed')
    const spawnedProcess = this.spawnedProcess
    if (!spawnedProcess || hasExited(spawnedProcess)) {
      throw new Error('Cannot restart taud because this client does not own a running daemon')
    }

    this.transitionLifecycle('stopping', reason)
    spawnedProcess.removeAllListeners('exit')
    spawnedProcess.removeAllListeners('error')
    spawnedProcess.kill()
    await waitForChildExit(spawnedProcess, DEFAULT_DISPOSE_DAEMON_TIMEOUT_MS)
    if (!hasExited(spawnedProcess)) {
      spawnedProcess.kill('SIGKILL')
      await waitForChildExit(spawnedProcess, DEFAULT_DISPOSE_DAEMON_TIMEOUT_MS)
    }
    if (!hasExited(spawnedProcess)) {
      throw new Error('Timed out stopping owned taud for recovery')
    }

    spawnedProcess.removeAllListeners()
    if (this.spawnedProcess === spawnedProcess) this.spawnedProcess = null
    this.lifecycleDaemonOwnership = 'none'
    this.transitionLifecycle('absent', `${reason}:stopped`)
    await this.ensureRunning()
  }

  async createSession(input: TaudCreateSessionInput): Promise<TaudControlResponse> {
    const response = await this.request({
      type: 'create',
      id: nextRequestId('create'),
      sessionId: input.sessionId,
      terminalId: input.terminalId,
      cols: input.cols,
      rows: input.rows,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.argv ? { argv: [...input.argv] } : {}),
    })
    if (!response.ok) throw responseError(response)
    return response
  }

  async attachSession(input: TaudAttachSessionInput): Promise<{
    response: TaudControlResponse
    stream: TaudSessionStream
  }> {
    await this.ensureRunning()
    const socket = await connectUnixSocket(this.socketPath, this.connectTimeoutMs)

    const request = this.withTrace({
      type: 'attach',
      id: nextRequestId('attach'),
      sessionId: input.sessionId,
      ...(input.terminalId ? { terminalId: input.terminalId } : {}),
      ...(input.cols ? { cols: input.cols } : {}),
      ...(input.rows ? { rows: input.rows } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
    })

    let response: TaudControlResponse
    let tail: Buffer
    const startedAt = Date.now()
    try {
      await writeSocketPayload(
        socket,
        `${JSON.stringify(request)}\n`,
        this.controlResponseTimeoutMs,
        'attach request',
      )
      ;({ response, tail } = await readNdjsonResponse(socket, this.controlResponseTimeoutMs))
    } catch (error) {
      this.recordControlRequest(request, startedAt, false, undefined, error)
      socket.end()
      socket.destroy()
      throw error
    }
    this.recordControlRequest(
      request,
      startedAt,
      response.ok,
      responseTraceId(response),
      response.ok ? undefined : responseError(response),
    )
    if (!response.ok) {
      socket.destroy()
      throw responseError(response)
    }

    return {
      response,
      stream: new TaudSessionStream(socket, input.sessionId, tail),
    }
  }

  async resizeSession(sessionId: string, cols: number, rows: number): Promise<TaudControlResponse> {
    const response = await this.request({
      type: 'resize',
      id: nextRequestId('resize'),
      sessionId,
      cols,
      rows,
    })
    if (!response.ok) throw responseError(response)
    return response
  }

  async detachSession(sessionId: string): Promise<void> {
    const response = await this.request({ type: 'detach', id: nextRequestId('detach'), sessionId })
    if (!response.ok) throw responseError(response)
  }

  async killSession(sessionId: string): Promise<void> {
    const response = await this.request({ type: 'kill', id: nextRequestId('kill'), sessionId })
    if (!response.ok) throw responseError(response)
  }

  async clearHistory(sessionIds?: readonly string[]): Promise<TaudControlResponse> {
    const response = await this.request({
      type: 'clear-history',
      id: nextRequestId('clear-history'),
      ...(sessionIds ? { sessionIds: [...sessionIds] } : {}),
    })
    if (!response.ok) throw responseError(response)
    return response
  }

  async cleanupSessions(input: TaudCleanupSessionsInput): Promise<TaudControlResponse> {
    const response = await this.request({
      type: 'cleanup',
      id: nextRequestId('cleanup'),
      retainDays: input.retainDays,
      maxSessionBytes: input.maxSessionBytes,
      ...(input.activeSessionIds ? { activeSessionIds: [...input.activeSessionIds] } : {}),
    })
    if (!response.ok) throw responseError(response)
    return response
  }

  async configurePersistence(input: TaudPersistenceSettingsInput): Promise<TaudControlResponse> {
    const response = await this.request({
      type: 'configure-persistence',
      id: nextRequestId('configure-persistence'),
      persistenceEnabled: input.enabled,
      persistInput: input.persistInput,
    })
    if (!response.ok) throw responseError(response)
    return response
  }

  async getMuxGraph(afterEventSeq?: number): Promise<TaudMuxGraphState> {
    const response = await this.request({
      type: 'graph-get',
      id: nextRequestId('graph-get'),
      ...(afterEventSeq !== undefined ? { afterEventSeq } : {}),
    })
    if (!response.ok) throw responseError(response)
    return parseMuxGraphState(response)
  }

  async replaceMuxGraph(snapshotJson: string, expectedRev: number): Promise<TaudMuxGraphState> {
    const response = await this.request({
      type: 'graph-replace',
      id: nextRequestId('graph-replace'),
      expectedRev,
      graphSnapshotJson: snapshotJson,
    })
    if (!response.ok) {
      const error = responseError(response) as Error & { graph?: TaudMuxGraphState }
      if (typeof response.graph_snapshot_json === 'string') error.graph = parseMuxGraphState(response)
      throw error
    }
    return parseMuxGraphState(response)
  }

  async waitForMuxGraph(afterEventSeq: number): Promise<TaudMuxGraphState> {
    const response = await this.request(
      {
        type: 'graph-wait',
        id: nextRequestId('graph-wait'),
        afterEventSeq,
        waitTimeoutMs: 25_000,
      },
      { responseTimeoutMs: 30_000 },
    )
    if (!response.ok) throw responseError(response)
    return parseMuxGraphState(response)
  }

  private async canConnect(): Promise<boolean> {
    const pingStartedAt = Date.now()
    this.lastPingStartedAt = pingStartedAt
    try {
      const response = await this.request(
        { type: 'ping', id: nextRequestId('ping') },
        { ensure: false },
      )
      const pingFinishedAt = Date.now()
      this.lastPingDurationMs = pingFinishedAt - pingStartedAt
      this.lastSuccessfulPingAt = pingFinishedAt
      assertCompatiblePingResponse(response)
      this.recordLiveDaemon(response)
      this.transitionLifecycle(
        this.spawnedProcess && !hasExited(this.spawnedProcess) ? 'owned-live' : 'external-live',
        'ping-ok',
      )
      return true
    } catch (error) {
      const pingFinishedAt = Date.now()
      this.lastPingDurationMs = pingFinishedAt - pingStartedAt
      this.lastFailedPingAt = pingFinishedAt
      if (isTaudCompatibilityError(error)) {
        this.lifecycleDaemonOwnership = this.currentDaemonOwnership()
        this.transitionLifecycle('version-mismatch', 'ping-version-mismatch', error)
        throw error
      }
      const code = errorCode(error)
      this.lifecycleDaemonOwnership = 'none'
      this.transitionLifecycle(
        code === 'ENOENT' ? 'absent' : 'stale-socket',
        code ? `ping-failed:${code}` : 'ping-failed',
        error,
      )
      return false
    }
  }

  private async startDaemon(): Promise<void> {
    if (this.disposed) throw new Error('taud client is disposed')
    const startRequestedAt = Date.now()
    this.lastStartRequestedAt = startRequestedAt
    if (await this.canConnect()) {
      if (this.disposed) throw new Error('taud client is disposed')
      this.lastStartDurationMs = Date.now() - startRequestedAt
      return
    }
    if (this.disposed) throw new Error('taud client is disposed')

    const binaryPath = findTaudBinary()
    if (!binaryPath) {
      this.lifecycleDaemonOwnership = 'none'
      this.transitionLifecycle('absent', 'binary-not-found')
      throw new Error(
        `taud binary not found. Checked: ${candidateTaudPaths().join(', ') || '(none)'}`,
      )
    }

    if (
      !this.spawnedProcess ||
      this.spawnedProcess.exitCode !== null ||
      this.spawnedProcess.killed
    ) {
      if (this.disposed) throw new Error('taud client is disposed')
      const stdio: StdioOptions = this.detachDaemon ? 'ignore' : ['ignore', 'ignore', 'pipe']
      const child = spawn(binaryPath, [], {
        // Detached/unref'd in normal app runs: taud owns PTYs and should survive Electron restarts.
        // Smoke runs keep it attached so the test can clean up the temporary-home daemon.
        detached: this.detachDaemon,
        stdio,
        env: {
          ...process.env,
        },
        cwd: dirname(binaryPath),
      })
      this.spawnedProcess = child
      this.lifecycleDaemonOwnership = this.currentDaemonOwnership()
      if (!this.detachDaemon) {
        child.stderr?.on('data', (chunk: Buffer) => {
          console.warn('[taud stderr]', chunk.toString('utf8').trimEnd())
        })
      }
      this.transitionLifecycle('starting', `spawned:${child.pid ?? 'unknown'}`)
      child.once('exit', (code, signal) => {
        if (this.spawnedProcess === child) this.spawnedProcess = null
        if (this.lifecycleDaemonOwnership !== 'released-detached') {
          this.lifecycleDaemonOwnership = 'none'
        }
        if (!this.disposed) {
          this.transitionLifecycle('crashed', `process-exit:${code ?? 'null'}:${signal ?? 'null'}`)
          this.scheduleRestart(`taud exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`)
        }
      })
      child.once('error', (error) => {
        if (this.spawnedProcess === child) this.spawnedProcess = null
        if (this.lifecycleDaemonOwnership !== 'released-detached') {
          this.lifecycleDaemonOwnership = 'none'
        }
        if (!this.disposed) {
          this.transitionLifecycle('crashed', 'process-error', error)
          this.scheduleRestart(`taud process error: ${error.message}`)
        }
      })
      if (this.detachDaemon) child.unref()
    }

    const deadline = Date.now() + this.startTimeoutMs
    let lastError: unknown = null
    while (Date.now() < deadline) {
      if (this.disposed) throw new Error('taud client is disposed')
      try {
        if (await this.canConnect()) {
          if (this.disposed) throw new Error('taud client is disposed')
          this.lastStartDurationMs = Date.now() - startRequestedAt
          return
        }
      } catch (error) {
        lastError = error
      }
      await delay(75)
    }

    this.lastStartDurationMs = Date.now() - startRequestedAt
    this.lifecycleDaemonOwnership =
      this.spawnedProcess && !hasExited(this.spawnedProcess)
        ? this.currentDaemonOwnership()
        : 'none'
    this.transitionLifecycle('stale-socket', 'start-timeout', lastError)
    throw new Error(`Timed out waiting for taud to start: ${String(lastError ?? 'no response')}`)
  }

  private startHealthChecks(): void {
    if (this.healthCheckIntervalMs <= 0 || this.healthTimer) return

    this.healthTimer = setInterval(() => {
      void this.runHealthCheck()
    }, this.healthCheckIntervalMs)
    this.healthTimer.unref?.()
  }

  private async runHealthCheck(): Promise<void> {
    if (this.disposed || this.startPromise) return
    try {
      if (await this.canConnect()) return
    } catch (error) {
      if (isTaudCompatibilityError(error)) {
        console.warn('[taud-client] taud compatibility check failed:', error)
        return
      }
      throw error
    }
    this.scheduleRestart('taud health check failed')
  }

  private scheduleRestart(reason: string): void {
    if (this.disposed || this.restartTimer) return

    this.transitionLifecycle('crashed', reason)
    console.warn(`[taud-client] ${reason}; scheduling restart`)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      const recovery =
        this.spawnedProcess && !hasExited(this.spawnedProcess)
          ? this.restartOwnedDaemon('scheduled-restart-owned')
          : this.ensureRunning()
      void recovery.catch((error) => {
        console.warn('[taud-client] taud restart failed:', error)
      })
    }, this.restartBackoffMs)
    this.restartTimer.unref?.()
  }

  private async request(
    request: TaudRequest,
    options: { ensure?: boolean; responseTimeoutMs?: number } = {},
  ): Promise<TaudRawControlResponse> {
    if (options.ensure !== false) await this.ensureRunning()

    const tracedRequest = this.withTrace(request)
    const startedAt = Date.now()
    const socket = await connectUnixSocket(this.socketPath, this.connectTimeoutMs)
    try {
      await writeSocketPayload(
        socket,
        `${JSON.stringify(tracedRequest)}\n`,
        this.controlResponseTimeoutMs,
        'control request',
      )
      const { response } = await readNdjsonResponse(
        socket,
        options.responseTimeoutMs ?? this.controlResponseTimeoutMs,
      )
      this.recordControlRequest(
        tracedRequest,
        startedAt,
        response.ok,
        responseTraceId(response),
        response.ok ? undefined : responseError(response),
      )
      return response
    } catch (error) {
      this.recordControlRequest(tracedRequest, startedAt, false, undefined, error)
      throw error
    } finally {
      socket.end()
      socket.destroy()
    }
  }

  private withTrace(request: TaudRequest): TaudRequest {
    return { ...request, traceId: requestTraceId(this.clientTraceId, request) }
  }


}

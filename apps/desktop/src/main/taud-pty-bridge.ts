import { Schema } from 'effect'
import type { MessagePortMain } from 'electron'
import {
  TaudStreamFrameKind,
  type AttachSessionMode,
} from '@tau/shared/taud-protocol'
import { defaultSettings, readSettings } from './settings-store'
import {
  type PtyClientMessage,
  PtyClientMessageSchema,
  type PtyServiceMessage,
  type TaudPtyBridgeDiagnostics,
} from './pty-protocol'
import type { SettingsData } from '@tau/shared/session'
import { TaudClient, type TaudControlResponse, type TaudSessionStream } from './taud-client'
import { decodeTaudExitPayload, decodeTaudResizePayload } from './taud-stream'

const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000
const ATTACH_STREAM_READY_TIMEOUT_MS = 500
/** Bound MessagePort backlog so a stalled renderer cannot grow main-process memory without limit. */
const SESSION_CHANNEL_MAX_UNACKED_FRAMES = 512
const SESSION_CHANNEL_MAX_UNACKED_BYTES = 4 * 1024 * 1024
const SESSION_CHANNEL_MAX_QUEUE_AGE_MS = 10_000
/** Convert legacy number[] input in bounded chunks instead of dropping large pastes. */
const SESSION_INPUT_ARRAY_CHUNK_BYTES = 64 * 1024

export type TaudPtyBridgeOptions = {
  readonly client?: TaudClient
  readonly defaultShell?: string
}

type BridgeSession = {
  stream: TaudSessionStream | null
  cols: number
  rows: number
  archived: boolean
  attachMode: AttachSessionMode
}

type SessionChannelPendingFrame = {
  seq: number
  bytes: number
  at: number
}

type SessionChannel = {
  port: MessagePortMain
  lastSentSeq: number
  lastAckSeq: number
  lastSentAt: number
  lastAckAt: number
  unackedBytes: number
  oldestUnackedAt: number
  pendingFrames: SessionChannelPendingFrame[]
  backpressured: boolean
}

function decodeClientMessage(message: unknown): PtyClientMessage | null {
  const decoded = Schema.decodeUnknownOption(PtyClientMessageSchema)(message)
  return decoded._tag === 'Some' ? decoded.value : null
}

function markMainTerminalReceipt(): void {
  if (typeof performance === 'undefined' || typeof performance.mark !== 'function') return
  performance.clearMarks('tau:terminal:main-receipt')
  performance.mark('tau:terminal:main-receipt')
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function isNotFoundError(error: unknown): boolean {
  if (typeof error === 'object' && error && 'code' in error) {
    return (error as { code?: unknown }).code === 'session_not_found'
  }
  return false
}

function sanitizeCwd(cwd: unknown): string | undefined {
  if (typeof cwd !== 'string') return undefined
  const trimmed = cwd.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function sanitizeId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function isValidSize(cols: number, rows: number): boolean {
  return Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0
}

function sanitizeArgv(argv: readonly string[] | undefined): string[] | undefined {
  if (!argv) return undefined
  const normalized = argv
    .map((arg) => (typeof arg === 'string' ? arg : ''))
    .filter((arg) => arg.length > 0)

  return normalized.length > 0 ? normalized : undefined
}

function responseSeq(response: TaudControlResponse): number {
  return typeof response.last_seq === 'number' ? response.last_seq : 0
}

function responseSize(response: TaudControlResponse, fallback: { cols: number; rows: number }) {
  const cols =
    typeof response.cols === 'number' && response.cols > 0 ? response.cols : fallback.cols
  const rows =
    typeof response.rows === 'number' && response.rows > 0 ? response.rows : fallback.rows
  return { cols, rows }
}

function defaultShellArgv(defaultShell?: string): string[] {
  const shell =
    defaultShell ?? process.env.SHELL ?? (process.platform === 'win32' ? 'powershell.exe' : 'bash')
  return [shell]
}

function responseAttachMode(response: TaudControlResponse): AttachSessionMode {
  switch (response.attach_kind) {
    case 'command-resume':
      return 'command-resume'
    case 'fresh':
      return 'fresh'
    case 'live':
    default:
      return 'live'
  }
}

function waitForAttachStreamReady(stream: TaudSessionStream): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      settle()
    }, ATTACH_STREAM_READY_TIMEOUT_MS)

    function cleanup() {
      clearTimeout(timeout)
      stream.off('frame', onFrame)
      stream.off('error', onError)
      stream.off('close', onClose)
    }

    function settle(error?: Error) {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve()
    }

    function onFrame() {
      settle()
    }

    function onError(error: Error) {
      settle(error)
    }

    function onClose() {
      settle(new Error('taud attach stream closed before it became ready'))
    }

    stream.on('frame', onFrame)
    stream.once('error', onError)
    stream.once('close', onClose)
  })
}

export class TaudPtyBridge {
  private readonly client: TaudClient
  private readonly ownsClient: boolean
  private readonly defaultShell?: string
  private port: MessagePortMain | null = null
  private readonly sessions = new Map<string, BridgeSession>()
  private readonly sessionChannels = new Map<string, SessionChannel>()
  private readonly supersededAttachStreams = new WeakSet<TaudSessionStream>()
  private readonly sessionAttachGenerations = new Map<string, number>()
  private readonly openingSessionGenerations = new Map<string, number>()
  private readonly detachedBeforeReadySessionGenerations = new Map<string, number>()
  private readonly cleanupTimer: ReturnType<typeof setInterval>
  private messagesPostedTotal = 0
  private dataMessagesPostedTotal = 0
  private dataCharsPostedTotal = 0
  private snapshotMessagesPostedTotal = 0
  private snapshotBytesPostedTotal = 0
  private messagesDroppedNoPortTotal = 0
  private postFailuresTotal = 0
  private lastMessageType: string | undefined
  private lastDataChars: number | undefined
  private lastPostedAt: number | undefined
  private lastFailureAt: number | undefined
  private lastError: string | undefined

  constructor(options: TaudPtyBridgeOptions = {}) {
    this.client = options.client ?? new TaudClient()
    this.ownsClient = !options.client
    this.defaultShell = options.defaultShell
    this.cleanupTimer = setInterval(() => {
      void this.runSessionCleanup()
    }, SESSION_CLEANUP_INTERVAL_MS)
    this.cleanupTimer.unref?.()
  }

  async ensureReady(): Promise<void> {
    await this.client.ensureRunning()
    await this.syncPersistenceSettings()
  }

  async syncPersistenceSettings(settings?: SettingsData): Promise<void> {
    try {
      const resolved = settings ?? (await readSettings()) ?? defaultSettings
      const persistence = resolved.persistence ?? defaultSettings.persistence
      if (!persistence) return
      await this.client.configurePersistence({
        enabled: persistence.enabled,
        persistInput: persistence.persistInput,
      })
    } catch (error) {
      console.warn('[taud-bridge] Failed to sync persistence settings:', error)
    }
  }

  connectPort(port: MessagePortMain): void {
    this.detachAllStreams()
    this.port?.close()
    this.port = port
    port.on('message', (messageEvent) => {
      const message = decodeClientMessage(messageEvent.data)
      if (!message) return
      void this.handleClientMessage(message).catch((error) => {
        const sessionId = 'sessionId' in message ? message.sessionId : null
        if (sessionId) this.postError(sessionId, normalizeError(error).message)
      })
    })
    port.start()
  }

  dispose(): void {
    clearInterval(this.cleanupTimer)
    this.detachAllStreams()
    this.sessions.clear()
    for (const channel of this.sessionChannels.values()) channel.port.close()
    this.sessionChannels.clear()
    this.port?.close()
    this.port = null
    if (this.ownsClient) void this.client.dispose()
  }

  connectSessionPort(sessionId: string, port: MessagePortMain): void {
    if (!sanitizeId(sessionId)) {
      port.close()
      return
    }
    this.sessionChannels.get(sessionId)?.port.close()
    const channel: SessionChannel = {
      port,
      lastSentSeq: 0,
      lastAckSeq: 0,
      lastSentAt: 0,
      lastAckAt: 0,
      unackedBytes: 0,
      oldestUnackedAt: 0,
      pendingFrames: [],
      backpressured: false,
    }
    this.sessionChannels.set(sessionId, channel)
    port.on('message', (event) => {
      const data = event.data
      if (data instanceof ArrayBuffer) {
        if (data.byteLength > 0) this.sessions.get(sessionId)?.stream?.writeInput(new Uint8Array(data))
        return
      }
      if (ArrayBuffer.isView(data)) {
        if (data.byteLength > 0) {
          this.sessions
            .get(sessionId)
            ?.stream?.writeInput(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
        }
        return
      }
      if (!data || typeof data !== 'object') return
      const message = data as { type?: unknown; seq?: unknown; data?: unknown }
      if (message.type === 'input') {
        this.writeSessionInputPayload(sessionId, message.data)
        return
      }
      if (message.type === 'ack' && typeof message.seq === 'number' && Number.isSafeInteger(message.seq)) {
        this.acknowledgeSessionChannel(sessionId, channel, message.seq)
        return
      }
      if (message.type === 'resync') {
        this.resetSessionChannelBacklog(channel)
        const session = this.sessions.get(sessionId)
        if (!session) return
        void this.openSession(sessionId, sessionId, session.cols, session.rows, undefined, {
          forceCreate: false,
        }).catch((error) => this.postError(sessionId, normalizeError(error).message))
      }
    })
    port.on('close', () => {
      if (this.sessionChannels.get(sessionId) === channel) this.sessionChannels.delete(sessionId)
    })
    port.start()
  }

  getDiagnostics(): TaudPtyBridgeDiagnostics {
    let activeStreams = 0
    for (const session of this.sessions.values()) {
      if (session.stream) activeStreams += 1
    }
    let maxUnacknowledgedSeq = 0
    let maxQueueAgeMs = 0
    const now = Date.now()
    for (const channel of this.sessionChannels.values()) {
      maxUnacknowledgedSeq = Math.max(
        maxUnacknowledgedSeq,
        Math.max(0, channel.lastSentSeq - channel.lastAckSeq),
      )
      if (channel.lastSentSeq > channel.lastAckSeq && channel.oldestUnackedAt > 0) {
        maxQueueAgeMs = Math.max(maxQueueAgeMs, now - channel.oldestUnackedAt)
      }
    }

    return {
      portConnected: this.port !== null,
      activeSessions: this.sessions.size,
      activeStreams,
      messagesPostedTotal: this.messagesPostedTotal,
      dataMessagesPostedTotal: this.dataMessagesPostedTotal,
      dataCharsPostedTotal: this.dataCharsPostedTotal,
      snapshotMessagesPostedTotal: this.snapshotMessagesPostedTotal,
      snapshotBytesPostedTotal: this.snapshotBytesPostedTotal,
      messagesDroppedNoPortTotal: this.messagesDroppedNoPortTotal,
      postFailuresTotal: this.postFailuresTotal,
      sessionChannels: this.sessionChannels.size,
      maxUnacknowledgedSeq,
      maxQueueAgeMs,
      ...(this.lastMessageType ? { lastMessageType: this.lastMessageType } : {}),
      ...(this.lastDataChars !== undefined ? { lastDataChars: this.lastDataChars } : {}),
      ...(this.lastPostedAt !== undefined ? { lastPostedAt: this.lastPostedAt } : {}),
      ...(this.lastFailureAt !== undefined ? { lastFailureAt: this.lastFailureAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    }
  }

  private async handleClientMessage(message: PtyClientMessage): Promise<void> {
    switch (message.type) {
      case 'renderer-ready':
        break
      case 'spawn':
        if (!isValidSize(message.cols, message.rows)) return
        await this.openSession(
          message.sessionId,
          message.terminalId ?? message.sessionId,
          message.cols,
          message.rows,
          sanitizeCwd(message.cwd),
          {
            forceCreate: true,
            argv: sanitizeArgv(message.argv),
          },
        )
        break
      case 'attach':
        if (!isValidSize(message.cols, message.rows)) return
        await this.openSession(
          message.sessionId,
          message.terminalId ?? message.sessionId,
          message.cols,
          message.rows,
          sanitizeCwd(message.cwd),
          {
            forceCreate: false,
            argv: sanitizeArgv(message.argv),
          },
        )
        break
      case 'detach':
        await this.detachSession(message.sessionId)
        break
      case 'write':
        if (message.data.length === 0) return
        this.sessions.get(message.sessionId)?.stream?.writeInput(message.data)
        break
      case 'resize':
        if (!isValidSize(message.cols, message.rows)) return
        await this.resizeSession(message.sessionId, message.cols, message.rows)
        break
      case 'kill':
        await this.killSession(message.sessionId)
        break
      case 'clear-history':
        await this.clearSessionHistory(message.sessionIds)
        break
    }
  }

  private async openSession(
    sessionId: string,
    terminalId: string,
    cols: number,
    rows: number,
    cwd: string | undefined,
    options: {
      forceCreate: boolean
      argv?: readonly string[]
    },
  ): Promise<void> {
    const attachGeneration = (this.sessionAttachGenerations.get(sessionId) ?? 0) + 1
    this.sessionAttachGenerations.set(sessionId, attachGeneration)
    this.openingSessionGenerations.set(sessionId, attachGeneration)
    let readyPosted = false
    try {
      const sessionOptions = { argv: options.argv }

      const existing = this.sessions.get(sessionId)
      if (existing?.stream) {
        // A renderer can request attach for an already-streaming session when a terminal view is
        // remounted during tab/layout changes. Returning a bare ready message here leaves the new
        // terminal view with no current-screen snapshot or startup bytes because the previous stream
        // already consumed them. Treat it as a real live reattach instead: close the old subscriber
        // socket and continue through taud attach so the daemon sends a fresh snapshot.
        existing.cols = cols
        existing.rows = rows
        this.supersededAttachStreams.add(existing.stream)
        this.closeSessionStream(sessionId)
      }

      let attachResponse: TaudControlResponse
      let stream: TaudSessionStream
      let attachMode: AttachSessionMode = 'live'
      if (options.forceCreate) {
        await this.createShellSession(sessionId, terminalId, cols, rows, cwd, sessionOptions)
        this.throwIfDetachedBeforeReady(sessionId, attachGeneration)
        attachMode = 'fresh'
        ;({ response: attachResponse, stream } = await this.client.attachSession({
          sessionId,
          terminalId,
          cols,
          rows,
          cwd,
        }))
        if (this.wasDetachedBeforeReady(sessionId, attachGeneration)) {
          stream.close()
          await this.client.detachSession(sessionId).catch(() => {})
          this.throwIfDetachedBeforeReady(sessionId, attachGeneration)
        }
      } else {
        try {
          ;({ response: attachResponse, stream } = await this.client.attachSession({
            sessionId,
            terminalId,
            cols,
            rows,
            cwd,
          }))
          if (this.wasDetachedBeforeReady(sessionId, attachGeneration)) {
            stream.close()
            await this.client.detachSession(sessionId).catch(() => {})
            this.throwIfDetachedBeforeReady(sessionId, attachGeneration)
          }
        } catch (error) {
          if (!isNotFoundError(error)) throw error
          await this.createShellSession(sessionId, terminalId, cols, rows, cwd, sessionOptions)
          this.throwIfDetachedBeforeReady(sessionId, attachGeneration)
          attachMode = 'fresh'
          ;({ response: attachResponse, stream } = await this.client.attachSession({
            sessionId,
            terminalId,
            cols,
            rows,
            cwd,
          }))
          if (this.wasDetachedBeforeReady(sessionId, attachGeneration)) {
            stream.close()
            await this.client.detachSession(sessionId).catch(() => {})
            this.throwIfDetachedBeforeReady(sessionId, attachGeneration)
          }
        }
      }
      if (attachMode === 'live') attachMode = responseAttachMode(attachResponse)

      const archived = false
      const session: BridgeSession = {
        stream,
        cols,
        rows,
        archived,
        attachMode,
      }
      this.sessions.set(sessionId, session)
      this.wireStream(sessionId, session, stream)
      const attachReady = waitForAttachStreamReady(stream)
      stream.start()
      try {
        await attachReady
      } catch (error) {
        // A remount/new renderer can supersede an in-flight attach for the same session. In that
        // case the old stream closes because Tau intentionally replaced it; don't report that stale
        // close to the renderer or it can clear the ready state for the newer attach.
        if (this.supersededAttachStreams.has(stream)) return
        this.closeSessionStream(sessionId)
        throw error
      }
      this.throwIfDetachedBeforeReady(sessionId, attachGeneration)
      const size = responseSize(attachResponse, { cols, rows })
      this.postReady(sessionId, size, responseSeq(attachResponse), session)
      readyPosted = true
    } finally {
      if (this.openingSessionGenerations.get(sessionId) === attachGeneration) {
        this.openingSessionGenerations.delete(sessionId)
      }
      if (
        !readyPosted &&
        this.detachedBeforeReadySessionGenerations.get(sessionId) === attachGeneration
      ) {
        this.detachedBeforeReadySessionGenerations.delete(sessionId)
      }
    }
  }

  private async createShellSession(
    sessionId: string,
    terminalId: string,
    cols: number,
    rows: number,
    cwd: string | undefined,
    options: { argv?: readonly string[] },
  ): Promise<TaudControlResponse> {
    return this.client.createSession({
      sessionId,
      terminalId,
      cols,
      rows,
      cwd,
      argv:
        options.argv && options.argv.length > 0
          ? [...options.argv]
          : defaultShellArgv(this.defaultShell),
    })
  }

  private wireStream(sessionId: string, session: BridgeSession, stream: TaudSessionStream): void {
    stream.on('frame', (frame) => {
      if (frame.sessionId !== sessionId) return

      switch (frame.kind) {
        case TaudStreamFrameKind.Output: {
          markMainTerminalReceipt()
          if (frame.payload.length > 0) this.postData(sessionId, frame.payload, frame.seq)
          break
        }
        case TaudStreamFrameKind.Resize: {
          const resize = decodeTaudResizePayload(frame.payload)
          if (!resize) return
          session.cols = resize.cols
          session.rows = resize.rows
          this.post({
            type: 'resize',
            sessionId,
            cols: resize.cols,
            rows: resize.rows,
            seq: frame.seq,
            replay: true,
          })
          break
        }
        case TaudStreamFrameKind.Snapshot: {
          if (session.archived) return
          this.postSnapshot(sessionId, frame.payload, frame.seq)
          break
        }
        case TaudStreamFrameKind.Exit: {
          const exit = decodeTaudExitPayload(frame.payload) ?? { exitCode: -1 }
          this.post({ type: 'exit', sessionId, info: exit })
          this.closeSessionStream(sessionId)
          break
        }
      }
    })

    stream.once('error', (error) => {
      this.postError(sessionId, normalizeError(error).message)
      this.closeSessionStream(sessionId)
    })

    stream.once('close', () => {
      const current = this.sessions.get(sessionId)
      if (current?.stream === stream) current.stream = null
    })
  }

  private async resizeSession(sessionId: string, cols: number, rows: number): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.cols = cols
      session.rows = rows
      session.stream?.resize(cols, rows)
      return
    }

    await this.client.resizeSession(sessionId, cols, rows).catch(() => {})
  }

  private async detachSession(sessionId: string): Promise<void> {
    const openingGeneration = this.openingSessionGenerations.get(sessionId)
    if (openingGeneration !== undefined) {
      this.detachedBeforeReadySessionGenerations.set(sessionId, openingGeneration)
    } else {
      this.detachedBeforeReadySessionGenerations.delete(sessionId)
    }
    this.closeSessionStream(sessionId)
    this.sessionChannels.get(sessionId)?.port.close()
    this.sessionChannels.delete(sessionId)
    await this.client.detachSession(sessionId).catch(() => {})
  }

  private detachAllStreams(): void {
    for (const [sessionId, session] of this.sessions) {
      session.stream?.close()
      session.stream = null
      void this.client.detachSession(sessionId).catch(() => {})
    }
  }

  private async killSession(sessionId: string): Promise<void> {
    this.sessionAttachGenerations.delete(sessionId)
    this.openingSessionGenerations.delete(sessionId)
    this.detachedBeforeReadySessionGenerations.delete(sessionId)
    this.closeSessionStream(sessionId)
    this.sessions.delete(sessionId)
    this.sessionChannels.get(sessionId)?.port.close()
    this.sessionChannels.delete(sessionId)
    await this.client.killSession(sessionId).catch(() => {})
  }

  private wasDetachedBeforeReady(sessionId: string, attachGeneration: number): boolean {
    return this.detachedBeforeReadySessionGenerations.get(sessionId) === attachGeneration
  }

  private throwIfDetachedBeforeReady(sessionId: string, attachGeneration: number): void {
    if (!this.wasDetachedBeforeReady(sessionId, attachGeneration)) return
    this.detachedBeforeReadySessionGenerations.delete(sessionId)
    throw new Error(`Session ${sessionId} detached before ready`)
  }

  private closeSessionStream(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session?.stream) return
    const stream = session.stream
    session.stream = null
    stream.close()
  }

  private async clearSessionHistory(sessionIds?: readonly string[]): Promise<void> {
    const targetSessionIds = sessionIds ? new Set(sessionIds) : null

    try {
      await this.client.clearHistory(sessionIds)
    } catch (error) {
      console.warn('[taud-bridge] Clear history failed:', error)
      return
    }

    for (const [sessionId, session] of this.sessions) {
      if (targetSessionIds && !targetSessionIds.has(sessionId)) continue
      this.postReady(sessionId, { cols: session.cols, rows: session.rows }, 0, session)
    }
  }

  private async runSessionCleanup(): Promise<void> {
    try {
      const settings = (await readSettings()) ?? defaultSettings
      const persistence = settings.persistence ?? defaultSettings.persistence
      await this.syncPersistenceSettings(settings)
      if (!persistence?.enabled) return

      await this.client.cleanupSessions({
        retainDays: persistence.retainDays,
        maxSessionBytes: persistence.maxSessionBytes,
        activeSessionIds: [...this.sessions.keys()],
      })
    } catch (error) {
      console.warn('[taud-bridge] Session cleanup failed:', error)
    }
  }

  private postReady(
    sessionId: string,
    size: { cols: number; rows: number },
    seq: number,
    session: Pick<BridgeSession, 'archived' | 'attachMode'>,
  ): void {
    this.post({
      type: 'ready',
      sessionId,
      size,
      seq,
      ...(session.archived ? { archived: session.archived } : {}),
      attachMode: session.attachMode,
    })
  }

  private writeSessionInputPayload(sessionId: string, payload: unknown): void {
    const stream = this.sessions.get(sessionId)?.stream
    if (!stream) return
    if (payload instanceof ArrayBuffer) {
      if (payload.byteLength > 0) stream.writeInput(new Uint8Array(payload))
      return
    }
    if (ArrayBuffer.isView(payload)) {
      if (payload.byteLength > 0) {
        stream.writeInput(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength))
      }
      return
    }
    if (!Array.isArray(payload) || payload.length === 0) return

    // Legacy number[] path (contextBridge-safe). Accept any size by converting in chunks;
    // never silently drop large pastes.
    for (let offset = 0; offset < payload.length; offset += SESSION_INPUT_ARRAY_CHUNK_BYTES) {
      const end = Math.min(offset + SESSION_INPUT_ARRAY_CHUNK_BYTES, payload.length)
      const bytes = new Uint8Array(end - offset)
      for (let index = offset, out = 0; index < end; index += 1, out += 1) {
        const value = payload[index]
        if (!Number.isInteger(value) || value < 0 || value > 255) return
        bytes[out] = value
      }
      stream.writeInput(bytes)
    }
  }

  private postData(sessionId: string, data: Uint8Array, seq: number): void {
    this.postBinary(sessionId, 'output', data, seq)
  }

  private postSnapshot(sessionId: string, data: Uint8Array, seq: number): void {
    this.postBinary(sessionId, 'snapshot', data, seq)
  }

  private resetSessionChannelBacklog(channel: SessionChannel): void {
    channel.unackedBytes = 0
    channel.oldestUnackedAt = 0
    channel.pendingFrames.length = 0
    channel.backpressured = false
  }

  private channelBacklogExceeded(channel: SessionChannel, nextBytes: number): boolean {
    // Always allow a single in-flight frame so a large snapshot can land and so
    // backpressure can always be cleared by a later ack (never hard-stuck).
    if (channel.pendingFrames.length === 0) return false
    if (channel.pendingFrames.length >= SESSION_CHANNEL_MAX_UNACKED_FRAMES) return true
    if (channel.unackedBytes + nextBytes > SESSION_CHANNEL_MAX_UNACKED_BYTES) return true
    if (
      channel.oldestUnackedAt > 0 &&
      Date.now() - channel.oldestUnackedAt > SESSION_CHANNEL_MAX_QUEUE_AGE_MS
    ) {
      return true
    }
    return false
  }

  private tripSessionChannelBackpressure(sessionId: string, channel: SessionChannel): void {
    if (!channel.backpressured) {
      channel.backpressured = true
      console.warn(
        `[taud-bridge] session ${sessionId} MessagePort backlog exceeded; pausing stream until renderer catches up`,
      )
    }
    this.closeSessionStream(sessionId)
  }

  private acknowledgeSessionChannel(sessionId: string, channel: SessionChannel, seq: number): void {
    channel.lastAckSeq = Math.max(channel.lastAckSeq, seq)
    channel.lastAckAt = Date.now()

    while (channel.pendingFrames.length > 0 && channel.pendingFrames[0]!.seq <= channel.lastAckSeq) {
      const frame = channel.pendingFrames.shift()!
      channel.unackedBytes = Math.max(0, channel.unackedBytes - frame.bytes)
    }
    if (channel.pendingFrames.length === 0) {
      channel.unackedBytes = 0
      channel.oldestUnackedAt = 0
    } else {
      channel.oldestUnackedAt = channel.pendingFrames[0]!.at
    }

    if (!channel.backpressured) return
    if (channel.lastAckSeq < channel.lastSentSeq || channel.pendingFrames.length > 0) return

    this.resetSessionChannelBacklog(channel)
    const session = this.sessions.get(sessionId)
    if (!session) return
    void this.openSession(sessionId, sessionId, session.cols, session.rows, undefined, {
      forceCreate: false,
    }).catch((error) => this.postError(sessionId, normalizeError(error).message))
  }

  private postBinary(
    sessionId: string,
    type: 'output' | 'snapshot',
    data: Uint8Array,
    seq: number,
  ): void {
    const channel = this.sessionChannels.get(sessionId)
    if (!channel) {
      this.messagesDroppedNoPortTotal += 1
      this.closeSessionStream(sessionId)
      return
    }
    if (channel.backpressured) {
      this.closeSessionStream(sessionId)
      return
    }
    const byteLength = data.byteLength
    if (this.channelBacklogExceeded(channel, byteLength)) {
      this.tripSessionChannelBackpressure(sessionId, channel)
      return
    }
    // Exact-sized owned copy so we can transfer the buffer without retaining a view into `data`.
    const bytes = Uint8Array.from(data)
    try {
      // MessagePortMain typings only list port transfer, but Chromium accepts ArrayBuffer transferables.
      channel.port.postMessage({ type, seq, data: bytes.buffer }, [bytes.buffer] as unknown as MessagePortMain[])
      channel.lastSentSeq = Math.max(channel.lastSentSeq, seq)
      channel.lastSentAt = Date.now()
      channel.unackedBytes += byteLength
      channel.pendingFrames.push({ seq, bytes: byteLength, at: channel.lastSentAt })
      if (channel.oldestUnackedAt === 0) channel.oldestUnackedAt = channel.lastSentAt
      this.messagesPostedTotal += 1
      this.lastMessageType = type
      this.lastPostedAt = channel.lastSentAt
      if (type === 'output') {
        this.dataMessagesPostedTotal += 1
        this.dataCharsPostedTotal += byteLength
        this.lastDataChars = byteLength
      } else {
        this.snapshotMessagesPostedTotal += 1
        this.snapshotBytesPostedTotal += byteLength
      }
    } catch (error) {
      this.postFailuresTotal += 1
      this.lastFailureAt = Date.now()
      this.lastError = normalizeError(error).message
      channel.port.close()
      this.sessionChannels.delete(sessionId)
      this.closeSessionStream(sessionId)
    }
  }

  private postError(sessionId: string, error: string): void {
    this.post({ type: 'error', sessionId, error })
  }

  private post(message: PtyServiceMessage): void {
    const port = this.port
    if (!port) {
      this.messagesDroppedNoPortTotal += 1
      this.lastMessageType = message.type
      return
    }

    try {
      port.postMessage(message)
      this.messagesPostedTotal += 1
      this.lastMessageType = message.type
      this.lastPostedAt = Date.now()
      if (message.type === 'data') {
        this.dataMessagesPostedTotal += 1
        this.dataCharsPostedTotal += message.data.length
        this.lastDataChars = message.data.length
      } else if (message.type === 'snapshot') {
        this.snapshotMessagesPostedTotal += 1
        this.snapshotBytesPostedTotal += message.dataBase64.length
      }
    } catch (error) {
      this.postFailuresTotal += 1
      this.lastFailureAt = Date.now()
      this.lastMessageType = message.type
      this.lastError = normalizeError(error).message
      this.port = null
    }
  }
}

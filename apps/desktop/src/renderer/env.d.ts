/**
 * Type declarations for the renderer process.
 * These types describe the API exposed by the preload script via contextBridge.
 */

import type { AppCommand } from '@tau/shared/app-command'
import type { TaudPtyBridgeDiagnostics } from '../main/pty-protocol'
import type { SettingsData } from '@tau/shared/session'
import type { MuxGraphSnapshot } from '@tau/shared/mux-graph'
import type {
  AttachSessionInput,
  AttachSessionResult,
  CreateSessionInput,
  CreateSessionResult,
  CurrentScreenSnapshotFrame,
  ExitInfo,
  OutputFrame,
  TaudLifecycleDiagnostics,
  TaudLifecycleRecoveryInput,
} from '@tau/shared/taud-protocol'

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

export interface ElectronAPI {
  openExternalUrl(url: string): Promise<void>
  writeClipboardText(text: string): Promise<void>
  createSession(input: CreateSessionInput): Promise<CreateSessionResult>
  attachSession(input: AttachSessionInput): Promise<AttachSessionResult>
  detachSession(sessionId: string): Promise<void>
  writeSessionInput(sessionId: string, data: string, encoding?: 'utf8' | 'binary'): void
  acknowledgeSessionOutput(sessionId: string, seq: number): void
  requestSessionResync(sessionId: string, appliedSeq: number): void
  resizeSession(sessionId: string, cols: number, rows: number): void
  killSession(sessionId: string): Promise<void>
  clearSessionHistory(sessionId: string): Promise<void>
  clearAllSessionHistory(): Promise<void>
  onSessionOutput(sessionId: string, callback: (frame: OutputFrame) => void): () => void
  onSessionSnapshot(
    sessionId: string,
    callback: (frame: CurrentScreenSnapshotFrame) => void,
  ): () => void
  onSessionResize(sessionId: string, callback: (cols: number, rows: number) => void): () => void
  onSessionTitle(sessionId: string, callback: (title: string) => void): () => void
  onSessionExit(sessionId: string, callback: (info: ExitInfo) => void): () => void
  onSessionError(sessionId: string, callback: (error: string) => void): () => void
  /** @deprecated Prefer createSession/attachSession. Kept for benchmarks. */
  spawnPty(
    sessionId: string,
    cols: number,
    rows: number,
    cwd?: string,
  ): Promise<{ cols: number; rows: number }>
  /** @deprecated Prefer writeSessionInput. Kept for benchmarks. */
  sendPtyInput(sessionId: string, data: string): void
  resizePty(sessionId: string, cols: number, rows: number): void
  killPty(sessionId: string): void
  /** @deprecated Prefer onSessionOutput. Kept for benchmarks. */
  onPtyData(sessionId: string, callback: (data: string) => void): () => void
  onPtyError(sessionId: string, callback: (error: string) => void): () => void
  onPtyExit(
    sessionId: string,
    callback: (info: { exitCode: number; signal?: number }) => void,
  ): () => void
  signalReady(): Promise<void>
  onAppCommand(callback: (command: AppCommand) => void): () => void
  getTerminalPreloadDiagnostics(): TerminalPreloadDiagnostics
  getTaudDiagnostics(): Promise<TaudLifecycleDiagnostics | null>
  getTaudPtyBridgeDiagnostics(): Promise<TaudPtyBridgeDiagnostics | null>
  recoverTaud(action: TaudLifecycleRecoveryInput): Promise<TaudLifecycleDiagnostics | null>
  getMuxGraph(): Promise<MuxGraphSnapshot>
  replaceMuxGraph(snapshot: MuxGraphSnapshot, expectedRev: number): Promise<MuxGraphSnapshot>
  waitMuxGraph(afterEventSeq: number): Promise<MuxGraphSnapshot>
  readSettings(): Promise<SettingsData | null>
  writeSettings(data: SettingsData): Promise<void>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

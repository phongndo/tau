import { Schema } from 'effect'

/** Core terminal session lifecycle. Independent from pane identity. */
export const TerminalSessionStatusSchema = Schema.Union([
  Schema.Literal('live'),
  Schema.Literal('detached'),
  Schema.Literal('exited'),
  Schema.Literal('crashed'),
  Schema.Literal('archived'),
  Schema.Literal('killed'),
])

/** Neutral optional context — never a required project/worktree/thread. */
export const SessionContextSchema = Schema.Struct({
  cwd: Schema.optional(Schema.String),
  profile: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
})

export const TerminalSessionMetadataSchema = Schema.Struct({
  id: Schema.String,
  terminalId: Schema.String,
  cwd: Schema.optional(Schema.String),
  argv: Schema.optional(Schema.Array(Schema.String)),
  status: TerminalSessionStatusSchema,
  pid: Schema.optional(Schema.Number),
  cols: Schema.Number,
  rows: Schema.Number,
  title: Schema.optional(Schema.String),
  eventLogPath: Schema.String,
  lastSeq: Schema.Number,
  snapshotPath: Schema.optional(Schema.String),
  snapshotSeq: Schema.optional(Schema.Number),
  startedAt: Schema.String,
  lastActivityAt: Schema.optional(Schema.String),
  endedAt: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Number),
  signal: Schema.optional(Schema.Number),
  context: Schema.optional(SessionContextSchema),
})

/** Core pane surfaces are terminal-only until the extension pane contract exists. */
export const PaneTypeSchema = Schema.Literal('terminal')

export const PaneLayoutSchema = Schema.Struct({
  id: Schema.String,
  terminalId: Schema.String,
  tabId: Schema.String,
  type: PaneTypeSchema,
  name: Schema.String,
  cwd: Schema.optional(Schema.String),
  argv: Schema.optional(Schema.Array(Schema.String)),
  lastSessionId: Schema.optional(Schema.String),
})

export const TabLayoutSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  layout: Schema.Unknown,
  lastActivePaneId: Schema.optional(Schema.String),
  order: Schema.Number,
})

/**
 * Persisted mux layout projection.
 * Version 2 drops workspaces/sidebars/agent fields. Older layouts are discarded.
 */
export const PaneLayoutDataSchema = Schema.Struct({
  version: Schema.Number,
  tabs: Schema.Array(TabLayoutSchema),
  panes: Schema.Array(PaneLayoutSchema),
  activeTabId: Schema.NullOr(Schema.String),
  activePaneId: Schema.NullOr(Schema.String),
  graphRev: Schema.optional(Schema.Number),
})

export const SettingsDataSchema = Schema.Struct({
  version: Schema.Number,
  persistence: Schema.optional(
    Schema.Struct({
      enabled: Schema.Boolean,
      retainDays: Schema.Number,
      maxSessionBytes: Schema.Number,
      persistInput: Schema.Boolean,
    }),
  ),
})

export type TerminalSessionStatus = Schema.Schema.Type<typeof TerminalSessionStatusSchema>
export type SessionContext = Schema.Schema.Type<typeof SessionContextSchema>
export type TerminalSessionMetadata = Schema.Schema.Type<typeof TerminalSessionMetadataSchema>
export type PaneType = Schema.Schema.Type<typeof PaneTypeSchema>
export type PaneLayout = Schema.Schema.Type<typeof PaneLayoutSchema>
export type TabLayout = Schema.Schema.Type<typeof TabLayoutSchema>
export type PaneLayoutData = Schema.Schema.Type<typeof PaneLayoutDataSchema>
export type SettingsData = Schema.Schema.Type<typeof SettingsDataSchema>

export const PANE_LAYOUT_VERSION = 2

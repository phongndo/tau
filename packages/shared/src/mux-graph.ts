import { Schema } from 'effect'

/**
 * Authoritative mux graph schemas (Phase 2.2 / 2.3).
 * Renderer projections must not invent mutations outside these shapes.
 */

const NonEmptyString = Schema.Trim.check(Schema.isNonEmpty())

export const MuxIdSchema = NonEmptyString

export const SplitDirectionSchema = Schema.Union([Schema.Literal('row'), Schema.Literal('column')])

export type MuxPaneTreeNode =
  | string
  | {
      readonly type: 'split'
      readonly direction: 'row' | 'column'
      readonly children: readonly MuxPaneTreeNode[]
      readonly splitPercentages: readonly number[]
    }
  | {
      readonly type: 'tabs'
      readonly tabs: readonly string[]
      readonly activeTabIndex: number
    }

// Tree nodes are validated structurally in mutation helpers; schema stays shallow for Effect beta.
export const MuxPaneTreeNodeSchema = Schema.Unknown

export const MuxPaneSurfaceSchema = Schema.Struct({
  id: MuxIdSchema,
  tabId: MuxIdSchema,
  terminalId: MuxIdSchema,
  type: Schema.Literal('terminal'),
  name: Schema.String,
  cwd: Schema.optional(Schema.String),
  argv: Schema.optional(Schema.Array(Schema.String)),
  sessionId: Schema.optional(Schema.String),
  /** Opaque extension/future metadata — core must round-trip losslessly. */
  extensions: Schema.optional(Schema.Unknown),
})

export const MuxTabSchema = Schema.Struct({
  id: MuxIdSchema,
  name: Schema.String,
  order: Schema.Number,
  root: MuxPaneTreeNodeSchema,
  activePaneId: Schema.optional(Schema.String),
  extensions: Schema.optional(Schema.Unknown),
})

export const MuxGraphSnapshotSchema = Schema.Struct({
  schemaVersion: Schema.Number,
  graphRev: Schema.Number,
  eventSeq: Schema.Number,
  checksum: Schema.optional(Schema.String),
  tabs: Schema.Array(MuxTabSchema),
  panes: Schema.Array(MuxPaneSurfaceSchema),
  activeTabId: Schema.NullOr(Schema.String),
  activePaneId: Schema.NullOr(Schema.String),
  extensions: Schema.optional(Schema.Unknown),
})

export const MuxGraphEventKindSchema = Schema.Union([
  Schema.Literal('snapshot'),
  Schema.Literal('tab-created'),
  Schema.Literal('tab-closed'),
  Schema.Literal('tab-renamed'),
  Schema.Literal('tab-reordered'),
  Schema.Literal('pane-split'),
  Schema.Literal('pane-closed'),
  Schema.Literal('pane-focused'),
  Schema.Literal('layout-replaced'),
  Schema.Literal('session-bound'),
  Schema.Literal('session-unbound'),
])

export const MuxGraphEventSchema = Schema.Struct({
  eventSeq: Schema.Number,
  graphRev: Schema.Number,
  kind: MuxGraphEventKindSchema,
  at: Schema.Number,
  payload: Schema.optional(Schema.Unknown),
})

export const MUX_GRAPH_SCHEMA_VERSION = 1

export type MuxPaneSurface = Schema.Schema.Type<typeof MuxPaneSurfaceSchema>
export type MuxTab = Schema.Schema.Type<typeof MuxTabSchema>
export type MuxGraphSnapshot = Schema.Schema.Type<typeof MuxGraphSnapshotSchema>
export type MuxGraphEvent = Schema.Schema.Type<typeof MuxGraphEventSchema>
export type MuxGraphEventKind = Schema.Schema.Type<typeof MuxGraphEventKindSchema>
export type SplitDirection = Schema.Schema.Type<typeof SplitDirectionSchema>

const SPLIT_PERCENT_MIN = 5
const SPLIT_PERCENT_MAX = 95

/** Normalize split percentages: positive, sum 100, each in [5, 95] when possible. */
export function normalizeSplitPercentages(
  values: readonly number[] | undefined,
  count: number,
): number[] {
  if (count <= 0) return []
  // Bounds are impossible once every child needs at least 5%.
  if (count * SPLIT_PERCENT_MIN > 100) {
    const equal = 100 / count
    return Array.from({ length: count }, () => equal)
  }

  let weights: number[]
  if (!values || values.length !== count) {
    weights = Array.from({ length: count }, () => 1)
  } else {
    weights = values.map((value) => (Number.isFinite(value) && value > 0 ? value : 0))
    if (weights.every((weight) => weight <= 0)) {
      weights = Array.from({ length: count }, () => 1)
    }
  }

  const result = new Array<number>(count)
  const locked = new Array<boolean>(count).fill(false)

  // Water-fill: lock undersized shares to min, then oversized to max, then assign the rest.
  for (let iteration = 0; iteration < count * 2; iteration += 1) {
    let lockedSum = 0
    let unlockedWeight = 0
    for (let index = 0; index < count; index += 1) {
      if (locked[index]) lockedSum += result[index]!
      else unlockedWeight += weights[index]!
    }
    const remaining = 100 - lockedSum
    if (unlockedWeight <= 0) break

    let lockedMin = false
    for (let index = 0; index < count; index += 1) {
      if (locked[index]) continue
      const share = remaining * (weights[index]! / unlockedWeight)
      if (share < SPLIT_PERCENT_MIN) {
        result[index] = SPLIT_PERCENT_MIN
        locked[index] = true
        lockedMin = true
      }
    }
    if (lockedMin) continue

    let lockedMax = false
    for (let index = 0; index < count; index += 1) {
      if (locked[index]) continue
      const share = remaining * (weights[index]! / unlockedWeight)
      if (share > SPLIT_PERCENT_MAX) {
        result[index] = SPLIT_PERCENT_MAX
        locked[index] = true
        lockedMax = true
      }
    }
    if (lockedMax) continue

    for (let index = 0; index < count; index += 1) {
      if (locked[index]) continue
      result[index] = remaining * (weights[index]! / unlockedWeight)
    }
    break
  }

  // Absorb floating-point drift on the largest share while staying in bounds.
  const sum = result.reduce((acc, value) => acc + value, 0)
  if (Number.isFinite(sum) && Math.abs(sum - 100) > 0.001) {
    let adjustIndex = 0
    for (let index = 1; index < count; index += 1) {
      if (result[index]! > result[adjustIndex]!) adjustIndex = index
    }
    result[adjustIndex] = Math.min(
      SPLIT_PERCENT_MAX,
      Math.max(SPLIT_PERCENT_MIN, result[adjustIndex]! + (100 - sum)),
    )
  }
  return result
}

export function assertSplitInvariants(
  direction: SplitDirection,
  children: readonly MuxPaneTreeNode[],
  splitPercentages: readonly number[],
): void {
  if (children.length < 2) {
    throw new Error('split requires at least two children')
  }
  if (splitPercentages.length !== children.length) {
    throw new Error('split percentages must match child count')
  }
  const sum = splitPercentages.reduce((acc, value) => acc + value, 0)
  if (!Number.isFinite(sum) || Math.abs(sum - 100) > 0.01) {
    throw new Error('split percentages must sum to 100')
  }
  // Match daemon validation: every child share is within [5, 95] when that is feasible.
  if (children.length * SPLIT_PERCENT_MIN <= 100) {
    for (const value of splitPercentages) {
      if (!Number.isFinite(value) || value < SPLIT_PERCENT_MIN || value > SPLIT_PERCENT_MAX) {
        throw new Error(`split percentages must be within [${SPLIT_PERCENT_MIN}, ${SPLIT_PERCENT_MAX}]`)
      }
    }
  }
  void direction
}

export function collectPaneIds(node: MuxPaneTreeNode, out: string[] = []): string[] {
  if (typeof node === 'string') {
    out.push(node)
    return out
  }
  if (node.type === 'split') {
    for (const child of node.children) collectPaneIds(child, out)
    return out
  }
  out.push(...node.tabs)
  return out
}

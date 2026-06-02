import type {
  MosaicDirection,
  MosaicNode,
  MosaicSplitNode,
  MosaicTabsNode,
} from 'react-mosaic-component'
import { Schema } from 'effect'
import { create } from 'zustand'
import type { PaneFocusDirection } from '@tau/shared/app-command'
import type { PaneLayoutData } from '@tau/shared/session'
import type { PiThread } from '@tau/shared/taud-protocol'
import { type WorkspaceWorktree, WorkspaceWorktreeSchema } from '@tau/shared/workspace'
import { sanitizeTerminalTitle } from '../osc-title'

export const LOCAL_WORKSPACE_ID = 'tau:local'
export const WORKTREE_CONTEXT_PREFIX = 'worktree:'

export function worktreeContextId(worktreeId: string): string {
  return `${WORKTREE_CONTEXT_PREFIX}${worktreeId}`
}

export function worktreeIdFromContext(contextId: string): string | null {
  return contextId.startsWith(WORKTREE_CONTEXT_PREFIX)
    ? contextId.slice(WORKTREE_CONTEXT_PREFIX.length)
    : null
}

export interface TauState {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  lastActiveLocalTabId: string | null
  tabs: Tab[]
  activeTabId: string | null
  panes: Pane[]
  activePaneId: string | null
  sidebarExpanded: boolean
  sidebarWidth: number
  rightSidebarExpanded: boolean
  rightSidebarWidth: number
  hydrateLayout(data: PaneLayoutData): void
  addWorkspace(workspace: Workspace): void
  upsertWorkspace(workspace: Workspace): void
  upsertWorktree(workspaceId: string, worktree: WorkspaceWorktree): void
  removeWorktree(workspaceId: string, worktreeId: string): void
  removeWorkspace(workspaceId: string): void
  selectWorkspace(workspaceId: string): void
  selectWorktree(worktreeId: string): void
  selectWorkspaceByIndex(index: number): void
  newTab(workspaceId?: string): void
  importPiThreads(workspaceId: string, threads: readonly PiThread[]): void
  openChangesTab(workspaceId?: string): void
  closeTab(tabId: string): void
  closeActiveTab(): void
  selectTab(tabId: string): void
  selectTabByIndex(index: number): void
  reorderTab(tabId: string, targetTabId: string, placement: ReorderPlacement): void
  setTabLayout(tabId: string, layout: MosaicLayoutNode | null): void
  selectPane(paneId: string): void
  selectPaneByDirection(direction: PaneFocusDirection): void
  restartPaneSession(paneId: string): void
  setPaneTitle(paneId: string, title: string): void
  setPaneStatus(paneId: string, status: PaneStatus): void
  splitPane(paneId: string, direction: MosaicDirection): void
  splitActivePane(direction: MosaicDirection): void
  closePane(paneId: string): void
  closeActivePane(): void
  toggleSidebar(): void
  setSidebarExpanded(expanded: boolean): void
  setSidebarWidth(width: number): void
  toggleRightSidebar(): void
  setRightSidebarExpanded(expanded: boolean): void
  setRightSidebarWidth(width: number): void
  reorderWorkspace(
    workspaceId: string,
    targetWorkspaceId: string,
    placement: ReorderPlacement,
  ): void
}

export interface Workspace {
  id: string
  name: string
  projectPath: string
  branch?: string
  worktrees?: WorkspaceWorktree[]
  lastActiveTabId?: string
  order: number
}

export interface Tab {
  id: string
  workspaceId: string
  name: string
  layout: MosaicLayoutNode
  lastActivePaneId?: string
  order: number
}

export type MosaicLayoutNode = MosaicNode<string>

export interface Pane {
  id: string
  terminalId: string
  tabId: string
  type: PaneType
  name: string
  cwd?: string
  agentProvider?: 'pi'
  argv?: string[]
  status?: PaneStatus
  lastSessionId?: string
}

export type PaneType = 'terminal' | 'webview' | 'changes'
export type PaneStatus = 'idle' | 'working' | 'permission' | 'review' | 'archived'
export type ReorderPlacement = 'before' | 'after'

const PaneStatusSchema = Schema.Union([
  Schema.Literal('idle'),
  Schema.Literal('working'),
  Schema.Literal('permission'),
  Schema.Literal('review'),
  Schema.Literal('archived'),
])
const PaneTypeSchema = Schema.Union([
  Schema.Literal('terminal'),
  Schema.Literal('webview'),
  Schema.Literal('changes'),
])

const PersistedWorkspaceSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  projectPath: Schema.String,
  branch: Schema.optional(Schema.String),
  worktrees: Schema.optional(Schema.Array(Schema.Unknown)),
  lastActiveTabId: Schema.optional(Schema.String),
  order: Schema.optional(Schema.Number),
})

const PersistedTabSchema = Schema.Struct({
  id: Schema.String,
  workspaceId: Schema.String,
  name: Schema.String,
  layout: Schema.Unknown,
  lastActivePaneId: Schema.optional(Schema.String),
  order: Schema.optional(Schema.Number),
})

const PersistedPaneSchema = Schema.Struct({
  id: Schema.String,
  terminalId: Schema.optional(Schema.String),
  tabId: Schema.String,
  type: PaneTypeSchema,
  name: Schema.String,
  cwd: Schema.optional(Schema.String),
  agentProvider: Schema.optional(Schema.Literal('pi')),
  argv: Schema.optional(Schema.Array(Schema.String)),
  status: Schema.optional(PaneStatusSchema),
  lastSessionId: Schema.optional(Schema.String),
})

const PersistedTauStateSchema = Schema.Struct({
  workspaces: Schema.optional(Schema.Array(PersistedWorkspaceSchema)),
  activeWorkspaceId: Schema.optional(Schema.NullOr(Schema.String)),
  lastActiveLocalTabId: Schema.optional(Schema.NullOr(Schema.String)),
  tabs: Schema.optional(Schema.Array(PersistedTabSchema)),
  activeTabId: Schema.optional(Schema.NullOr(Schema.String)),
  panes: Schema.optional(Schema.Array(PersistedPaneSchema)),
  activePaneId: Schema.optional(Schema.NullOr(Schema.String)),
  sidebarExpanded: Schema.optional(Schema.Boolean),
  sidebarWidth: Schema.optional(Schema.Number),
  rightSidebarExpanded: Schema.optional(Schema.Boolean),
  rightSidebarWidth: Schema.optional(Schema.Number),
})

const MIN_SPLIT_PERCENTAGE = 5
const MAX_SPLIT_PERCENTAGE = 95

function createId(prefix: string): string {
  const randomUUID = globalThis.crypto?.randomUUID?.()
  if (randomUUID) return `${prefix}-${randomUUID}`

  if (globalThis.crypto?.getRandomValues) {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))

    return `${prefix}-${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
      .slice(6, 8)
      .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`
  }

  return `${prefix}-${Math.random().toString(36).slice(2)}`
}

function createTerminalPane(
  tabId: string,
  index: number,
  options: { thread?: PiThread } = {},
): Pane {
  const thread = options.thread
  const terminalId = thread?.terminalId ?? createId('term')
  const title = piThreadTitle(thread, index)
  return {
    id: thread ? stableImportedId('pane-pi', thread.terminalSessionId) : createId('pane'),
    terminalId,
    tabId,
    type: 'terminal',
    name: title,
    cwd: thread?.cwd,
    agentProvider: 'pi' as const,
    argv: piThreadArgv(thread),
    status: piThreadPaneStatus(thread),
    lastSessionId: thread?.terminalSessionId ?? createId('session'),
  }
}

function createTerminalTab(
  workspaceId: string,
  order: number,
  options: { thread?: PiThread } = {},
): { tab: Tab; pane: Pane } {
  const thread = options.thread
  const tabId = thread ? stableImportedId('tab-pi', thread.terminalSessionId) : createId('tab')
  const pane = createTerminalPane(tabId, 1, options)
  const title = piThreadTitle(thread, order + 1)

  return {
    tab: {
      id: tabId,
      workspaceId,
      name: title,
      layout: pane.id,
      lastActivePaneId: pane.id,
      order,
    },
    pane,
  }
}

function stableImportedId(prefix: string, value: string): string {
  return `${prefix}-${value.replace(/[^a-zA-Z0-9_-]/g, '-')}`
}

function piThreadPaneStatus(thread?: PiThread): PaneStatus {
  if (!thread) return 'idle'
  if (thread.terminalStatus === 'live' || thread.terminalStatus === 'detached') return 'idle'
  if (thread.agentStatus === 'resumable') return 'idle'
  return 'archived'
}

function piThreadTitle(thread: PiThread | undefined, index: number): string {
  const title = usefulPiThreadTitle(thread?.title)
  if (title) return title
  if (thread?.nativeSessionId) return `Pi ${thread.nativeSessionId.slice(0, 8)}`
  return index === 1 ? 'Pi' : `Pi ${index}`
}

function usefulPiThreadTitle(title: string | undefined): string | null {
  const normalized = sanitizeTerminalTitle(title ?? '')
  if (!normalized || normalized.toLowerCase() === 'pi') return null
  return normalized
}

function piThreadArgv(thread?: PiThread): string[] {
  if (thread?.resumeArgv && thread.resumeArgv.length > 0) return [...thread.resumeArgv]
  if (thread?.nativeSessionId) return ['pi', '--session', thread.nativeSessionId]
  return ['pi']
}

function isPiPane(pane: Pick<Pane, 'type' | 'agentProvider'>): boolean {
  return pane.type === 'terminal' && pane.agentProvider === 'pi'
}

function isPiThreadTab(tab: Tab, panes: readonly Pane[]): boolean {
  const tabPanes = panes.filter((pane) => pane.tabId === tab.id)
  return tabPanes.length > 0 && tabPanes.every(isPiPane)
}

function isImportedPiThreadTab(tab: Tab, panes: readonly Pane[]): boolean {
  const tabPanes = panes.filter((pane) => pane.tabId === tab.id)
  return tab.id.startsWith('tab-pi-') && tabPanes.length > 0 && tabPanes.every(isPiPane)
}

function piThreadContextId(fallbackWorkspaceId: string, thread: PiThread): string {
  return thread.worktreeId
    ? worktreeContextId(thread.worktreeId)
    : (thread.workspaceId ?? fallbackWorkspaceId)
}

function createChangesPane(tabId: string): Pane {
  return {
    id: createId('pane'),
    terminalId: createId('term'),
    tabId,
    type: 'changes',
    name: 'Changes',
    status: 'idle',
  }
}

function createChangesTab(workspaceId: string, order: number): { tab: Tab; pane: Pane } {
  const tabId = createId('tab')
  const pane = createChangesPane(tabId)

  return {
    tab: {
      id: tabId,
      workspaceId,
      name: 'Changes',
      layout: pane.id,
      lastActivePaneId: pane.id,
      order,
    },
    pane,
  }
}

function getWorkspaceTabs(tabs: Tab[], workspaceId: string): Tab[] {
  return tabs.filter((tab) => tab.workspaceId === workspaceId).sort((a, b) => a.order - b.order)
}

function isSplitNode(node: MosaicLayoutNode): node is MosaicSplitNode<string> {
  return typeof node === 'object' && node !== null && node.type === 'split'
}

function isTabsNode(node: MosaicLayoutNode): node is MosaicTabsNode<string> {
  return typeof node === 'object' && node !== null && node.type === 'tabs'
}

function equalSplitPercentages(count: number): number[] {
  if (count <= 0) return []
  const percentage = 100 / count
  return Array.from({ length: count }, () => percentage)
}

function normalizeSplitPercentages(
  values: readonly unknown[] | undefined,
  count: number,
): number[] {
  if (count <= 0) return []
  if (!values || values.length !== count) return equalSplitPercentages(count)

  const percentages = values.map((value) =>
    typeof value === 'number' ? Math.max(0, finiteNumber(value, 0)) : 0,
  )
  const total = percentages.reduce((sum, value) => sum + value, 0)
  if (total <= 0) return equalSplitPercentages(count)

  return percentages.map((value) => (value / total) * 100)
}

function splitPercentagesForLayout(layout: MosaicSplitNode<string>): number[] {
  return normalizeSplitPercentages(layout.splitPercentages, layout.children.length)
}

function activeTabId(layout: MosaicTabsNode<string>): string | null {
  return layout.tabs[layout.activeTabIndex] ?? layout.tabs[0] ?? null
}

function getPaneIdsInLayout(layout: MosaicLayoutNode): string[] {
  if (typeof layout === 'string') return [layout]
  if (isSplitNode(layout)) return layout.children.flatMap(getPaneIdsInLayout)
  if (isTabsNode(layout)) return [...layout.tabs]
  return []
}

function getFirstPaneId(layout: MosaicLayoutNode): string | null {
  if (typeof layout === 'string') return layout
  if (isSplitNode(layout)) {
    for (const child of layout.children) {
      const paneId = getFirstPaneId(child)
      if (paneId) return paneId
    }
    return null
  }
  if (isTabsNode(layout)) return activeTabId(layout)
  return null
}

function getPreferredPaneId(tab: Tab): string | null {
  return tab.lastActivePaneId && layoutContainsPane(tab.layout, tab.lastActivePaneId)
    ? tab.lastActivePaneId
    : getFirstPaneId(tab.layout)
}

function getPreferredWorkspaceTab(
  tabs: Tab[],
  workspaces: Workspace[],
  workspaceId: string,
  lastActiveLocalTabId?: string | null,
): Tab | null {
  const workspaceTabs = getWorkspaceTabs(tabs, workspaceId)
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId)
  const preferredTabId =
    workspaceId === LOCAL_WORKSPACE_ID ? lastActiveLocalTabId : workspace?.lastActiveTabId

  return (
    (preferredTabId ? workspaceTabs.find((tab) => tab.id === preferredTabId) : undefined) ??
    workspaceTabs[0] ??
    null
  )
}

function rememberWorkspaceTab(
  workspaces: Workspace[],
  workspaceId: string,
  tabId: string,
): Workspace[] {
  if (workspaceId === LOCAL_WORKSPACE_ID) return workspaces

  let changed = false
  const nextWorkspaces = workspaces.map((workspace) => {
    if (workspace.id !== workspaceId) return workspace
    if (workspace.lastActiveTabId === tabId) return workspace
    changed = true
    return { ...workspace, lastActiveTabId: tabId }
  })

  return changed ? nextWorkspaces : workspaces
}

function rememberLocalTab(
  workspaceId: string,
  tabId: string,
): Pick<TauState, 'lastActiveLocalTabId'> | {} {
  return workspaceId === LOCAL_WORKSPACE_ID ? { lastActiveLocalTabId: tabId } : {}
}

function rememberTabPane(tabs: Tab[], tabId: string, paneId: string | null): Tab[] {
  let changed = false
  const nextTabs = tabs.map((tab) => {
    if (tab.id !== tabId) return tab
    const lastActivePaneId = paneId && layoutContainsPane(tab.layout, paneId) ? paneId : undefined
    if (tab.lastActivePaneId === lastActivePaneId) return tab
    changed = true
    return { ...tab, lastActivePaneId }
  })

  return changed ? nextTabs : tabs
}

type PaneRect = {
  id: string
  left: number
  top: number
  right: number
  bottom: number
}

function getPaneRects(layout: MosaicLayoutNode, bounds: Omit<PaneRect, 'id'>): PaneRect[] {
  if (typeof layout === 'string') return [{ id: layout, ...bounds }]

  if (isTabsNode(layout)) {
    const paneId = activeTabId(layout)
    return paneId ? [{ id: paneId, ...bounds }] : []
  }

  if (!isSplitNode(layout)) return []

  const percentages = splitPercentagesForLayout(layout)
  let offset = layout.direction === 'row' ? bounds.left : bounds.top
  const extent =
    layout.direction === 'row' ? bounds.right - bounds.left : bounds.bottom - bounds.top

  return layout.children.flatMap((child, index) => {
    const nextOffset =
      index === layout.children.length - 1
        ? layout.direction === 'row'
          ? bounds.right
          : bounds.bottom
        : offset + extent * ((percentages[index] ?? 0) / 100)
    const childBounds =
      layout.direction === 'row'
        ? { ...bounds, left: offset, right: nextOffset }
        : { ...bounds, top: offset, bottom: nextOffset }
    offset = nextOffset
    return getPaneRects(child, childBounds)
  })
}

function getRectCenter(rect: PaneRect): { x: number; y: number } {
  return {
    x: (rect.left + rect.right) / 2,
    y: (rect.top + rect.bottom) / 2,
  }
}

function rangesOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
  return Math.max(startA, startB) < Math.min(endA, endB)
}

function findPaneInDirection(
  layout: MosaicLayoutNode,
  paneId: string,
  direction: PaneFocusDirection,
): string | null {
  const rects = getPaneRects(layout, { left: 0, top: 0, right: 1, bottom: 1 })
  const activeRect = rects.find((rect) => rect.id === paneId)
  if (!activeRect) return null

  const activeCenter = getRectCenter(activeRect)
  let best: { id: string; score: number } | null = null

  for (const rect of rects) {
    if (rect.id === paneId) continue

    const center = getRectCenter(rect)
    const horizontalOverlap = rangesOverlap(
      activeRect.left,
      activeRect.right,
      rect.left,
      rect.right,
    )
    const verticalOverlap = rangesOverlap(activeRect.top, activeRect.bottom, rect.top, rect.bottom)
    let primaryDistance: number
    let secondaryDistance: number

    switch (direction) {
      case 'left':
        if (center.x >= activeCenter.x || !verticalOverlap) continue
        primaryDistance = activeCenter.x - center.x
        secondaryDistance = Math.abs(activeCenter.y - center.y)
        break
      case 'right':
        if (center.x <= activeCenter.x || !verticalOverlap) continue
        primaryDistance = center.x - activeCenter.x
        secondaryDistance = Math.abs(activeCenter.y - center.y)
        break
      case 'up':
        if (center.y >= activeCenter.y || !horizontalOverlap) continue
        primaryDistance = activeCenter.y - center.y
        secondaryDistance = Math.abs(activeCenter.x - center.x)
        break
      case 'down':
        if (center.y <= activeCenter.y || !horizontalOverlap) continue
        primaryDistance = center.y - activeCenter.y
        secondaryDistance = Math.abs(activeCenter.x - center.x)
        break
    }

    const score = primaryDistance * 100 + secondaryDistance
    if (!best || score < best.score) {
      best = { id: rect.id, score }
    }
  }

  return best?.id ?? null
}

function layoutContainsPane(layout: MosaicLayoutNode, paneId: string): boolean {
  return getPaneIdsInLayout(layout).includes(paneId)
}

function splitLayoutNode(
  layout: MosaicLayoutNode,
  paneId: string,
  newPaneId: string,
  direction: MosaicDirection,
): MosaicLayoutNode {
  if (layout === paneId) {
    return {
      type: 'split',
      direction,
      children: [paneId, newPaneId],
      splitPercentages: [50, 50],
    }
  }

  if (typeof layout === 'string') return layout

  if (isTabsNode(layout) && layout.tabs.includes(paneId)) {
    return {
      type: 'split',
      direction,
      children: [layout, newPaneId],
      splitPercentages: [50, 50],
    }
  }

  if (isSplitNode(layout)) {
    return {
      ...layout,
      children: layout.children.map((child) =>
        splitLayoutNode(child, paneId, newPaneId, direction),
      ),
    }
  }

  return layout
}

function removePaneFromLayout(
  layout: MosaicLayoutNode,
  paneId: string,
): { layout: MosaicLayoutNode | null; removed: boolean } {
  if (layout === paneId) return { layout: null, removed: true }
  if (typeof layout === 'string') return { layout, removed: false }

  if (isTabsNode(layout)) {
    const tabs = layout.tabs.filter((tab) => tab !== paneId)
    if (tabs.length === layout.tabs.length) return { layout, removed: false }
    if (tabs.length === 0) return { layout: null, removed: true }
    if (tabs.length === 1) return { layout: tabs[0]!, removed: true }

    return {
      layout: {
        ...layout,
        tabs,
        activeTabIndex: Math.min(layout.activeTabIndex, tabs.length - 1),
      },
      removed: true,
    }
  }

  if (isSplitNode(layout)) {
    const percentages = splitPercentagesForLayout(layout)
    const children: MosaicLayoutNode[] = []
    const childPercentages: number[] = []
    let removed = false

    layout.children.forEach((child, index) => {
      const result = removePaneFromLayout(child, paneId)
      removed = removed || result.removed
      if (!result.layout) return
      children.push(result.layout)
      childPercentages.push(percentages[index] ?? 0)
    })

    if (!removed) return { layout, removed: false }
    if (children.length === 0) return { layout: null, removed: true }
    if (children.length === 1) return { layout: children[0]!, removed: true }

    return {
      layout: {
        ...layout,
        children,
        splitPercentages: normalizeSplitPercentages(childPercentages, children.length),
      },
      removed: true,
    }
  }

  return { layout, removed: false }
}

function reorderWorkspaceTabs(tabs: Tab[], workspaceId: string): Tab[] {
  let order = 0
  return tabs.map((tab) => (tab.workspaceId === workspaceId ? { ...tab, order: order++ } : tab))
}

function closeTabState(state: TauState, tabId: string): Partial<TauState> {
  const tab = state.tabs.find((candidate) => candidate.id === tabId)
  if (!tab) return {}
  if (isImportedPiThreadTab(tab, state.panes)) return {}

  const paneIds = new Set(getPaneIdsInLayout(tab.layout))
  const nextTabs = reorderWorkspaceTabs(
    state.tabs.filter((candidate) => candidate.id !== tabId),
    tab.workspaceId,
  )
  const nextPanes = state.panes.filter((pane) => pane.tabId !== tabId && !paneIds.has(pane.id))

  if (state.activeTabId !== tabId) {
    return {
      tabs: nextTabs,
      panes: nextPanes,
      workspaces:
        tab.workspaceId !== LOCAL_WORKSPACE_ID &&
        state.workspaces.some((workspace) => workspace.lastActiveTabId === tabId)
          ? state.workspaces.map((workspace) =>
              workspace.id === tab.workspaceId && workspace.lastActiveTabId === tabId
                ? {
                    ...workspace,
                    lastActiveTabId: getWorkspaceTabs(nextTabs, tab.workspaceId)[0]?.id,
                  }
                : workspace,
            )
          : state.workspaces,
      ...(tab.workspaceId === LOCAL_WORKSPACE_ID && state.lastActiveLocalTabId === tabId
        ? { lastActiveLocalTabId: getWorkspaceTabs(nextTabs, LOCAL_WORKSPACE_ID)[0]?.id ?? null }
        : {}),
    }
  }

  const nextActiveTab = getWorkspaceTabs(nextTabs, tab.workspaceId)[0] ?? null
  const nextActivePaneId = nextActiveTab ? getPreferredPaneId(nextActiveTab) : null

  return {
    tabs: nextTabs,
    panes: nextPanes,
    workspaces: nextActiveTab
      ? rememberWorkspaceTab(state.workspaces, tab.workspaceId, nextActiveTab.id)
      : state.workspaces,
    ...(nextActiveTab ? rememberLocalTab(tab.workspaceId, nextActiveTab.id) : {}),
    activeTabId: nextActiveTab?.id ?? null,
    activePaneId: nextActivePaneId,
  }
}

function closePaneState(state: TauState, paneId: string): Partial<TauState> {
  const pane = state.panes.find((candidate) => candidate.id === paneId)
  const tab = pane ? state.tabs.find((candidate) => candidate.id === pane.tabId) : null
  if (!pane || !tab) return {}

  const result = removePaneFromLayout(tab.layout, pane.id)
  if (!result.removed) return {}
  if (!result.layout) return closeTabState(state, tab.id)

  const layout = result.layout
  const paneIdsInLayout = getPaneIdsInLayout(layout)
  const nextPaneIds = new Set(paneIdsInLayout)
  const activePaneId =
    state.activePaneId === pane.id ? (paneIdsInLayout[0] ?? null) : state.activePaneId
  const lastActivePaneId =
    tab.lastActivePaneId === pane.id ? (activePaneId ?? undefined) : tab.lastActivePaneId

  return {
    tabs: state.tabs.map((candidate) =>
      candidate.id === tab.id ? { ...candidate, layout, lastActivePaneId } : candidate,
    ),
    panes: state.panes.filter(
      (candidate) => candidate.tabId !== tab.id || nextPaneIds.has(candidate.id),
    ),
    activePaneId,
  }
}

function selectWorkspaceTabState(state: TauState, workspaceId: string): Partial<TauState> {
  const workspaceTabs = getWorkspaceTabs(state.tabs, workspaceId)
  const nonImportedWorkspaceTabs = workspaceTabs.filter(
    (tab) => !isImportedPiThreadTab(tab, state.panes),
  )
  const existingTab =
    workspaceTabs.find((tab) => tab.id === state.activeTabId) ??
    getPreferredWorkspaceTab(
      nonImportedWorkspaceTabs,
      state.workspaces,
      workspaceId,
      state.lastActiveLocalTabId,
    ) ??
    getPreferredWorkspaceTab(
      workspaceTabs,
      state.workspaces,
      workspaceId,
      state.lastActiveLocalTabId,
    )
  if (existingTab) {
    const activePaneId = getPreferredPaneId(existingTab)

    return {
      workspaces: rememberWorkspaceTab(state.workspaces, workspaceId, existingTab.id),
      ...rememberLocalTab(workspaceId, existingTab.id),
      activeTabId: existingTab.id,
      activePaneId,
    }
  }

  return {
    activeTabId: null,
    activePaneId: null,
  }
}

type PersistedTauState = Schema.Schema.Type<typeof PersistedTauStateSchema>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNonEmptyString(value: string): boolean {
  return value.trim().length > 0
}

function finiteNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

function clampSplitPercentage(value: number | undefined): number {
  return Math.min(
    MAX_SPLIT_PERCENTAGE,
    Math.max(MIN_SPLIT_PERCENTAGE, finiteNumber(value ?? 50, 50)),
  )
}

function moveRelativeTo<T extends { id: string; order: number }>(
  items: T[],
  itemId: string,
  targetItemId: string,
  placement: ReorderPlacement,
): T[] {
  if (itemId === targetItemId) return items

  const movingItem = items.find((item) => item.id === itemId)
  if (!movingItem || !items.some((item) => item.id === targetItemId)) return items

  const orderedItems = items.filter((item) => item.id !== itemId)
  const targetIndex = orderedItems.findIndex((item) => item.id === targetItemId)
  orderedItems.splice(placement === 'after' ? targetIndex + 1 : targetIndex, 0, movingItem)

  return orderedItems.map((item, order) => ({ ...item, order }))
}

function reorderAllWorkspaceTabs(tabs: Tab[]): Tab[] {
  const counters = new Map<string, number>()

  return [...tabs]
    .sort((a, b) => a.order - b.order)
    .map((tab) => {
      const order = counters.get(tab.workspaceId) ?? 0
      counters.set(tab.workspaceId, order + 1)
      return { ...tab, order }
    })
}

function decodePersistedLayout(
  layout: unknown,
  paneIdsForTab: ReadonlySet<string>,
): MosaicLayoutNode | null {
  if (typeof layout === 'string') return paneIdsForTab.has(layout) ? layout : null
  if (!isRecord(layout)) return null

  if (layout.type === 'tabs') {
    if (!Array.isArray(layout.tabs)) return null

    const tabs = layout.tabs.filter(
      (tab): tab is string => typeof tab === 'string' && paneIdsForTab.has(tab),
    )
    if (tabs.length === 0) return null
    if (tabs.length === 1) return tabs[0]!

    const activeTabIndex = Math.min(
      tabs.length - 1,
      Math.max(
        0,
        Math.trunc(
          typeof layout.activeTabIndex === 'number' ? finiteNumber(layout.activeTabIndex, 0) : 0,
        ),
      ),
    )

    return {
      type: 'tabs',
      tabs,
      activeTabIndex,
    }
  }

  if (layout.type === 'split') {
    const direction = layout.direction
    if (direction !== 'row' && direction !== 'column') return null
    if (!Array.isArray(layout.children)) return null

    const rawPercentages = Array.isArray(layout.splitPercentages)
      ? layout.splitPercentages
      : undefined
    const children: MosaicLayoutNode[] = []
    const childPercentages: unknown[] = []

    layout.children.forEach((child, index) => {
      const decodedChild = decodePersistedLayout(child, paneIdsForTab)
      if (!decodedChild) return
      children.push(decodedChild)
      if (rawPercentages) childPercentages.push(rawPercentages[index])
    })

    if (children.length === 0) return null
    if (children.length === 1) return children[0]!

    return {
      type: 'split',
      direction,
      children,
      splitPercentages: normalizeSplitPercentages(
        rawPercentages ? childPercentages : undefined,
        children.length,
      ),
    }
  }

  const direction = layout.direction
  if (direction !== 'row' && direction !== 'column') return null

  const first = decodePersistedLayout(layout.first, paneIdsForTab)
  const second = decodePersistedLayout(layout.second, paneIdsForTab)
  if (!first || !second) return first ?? second

  return {
    type: 'split',
    direction,
    children: [first, second],
    splitPercentages: (() => {
      const splitPercentage = clampSplitPercentage(
        typeof layout.splitPercentage === 'number' ? layout.splitPercentage : undefined,
      )
      return [splitPercentage, 100 - splitPercentage]
    })(),
  }
}

function normalizePersistedState(persistedState: unknown): Partial<TauState> {
  const decoded = Schema.decodeUnknownOption(PersistedTauStateSchema)(persistedState)
  if (decoded._tag === 'None') return {}

  const persisted = decoded.value as PersistedTauState
  const workspaces = (persisted.workspaces ?? [])
    .filter(
      (workspace) => isNonEmptyString(workspace.id) && isNonEmptyString(workspace.projectPath),
    )
    .sort((a, b) => finiteNumber(a.order ?? 0, 0) - finiteNumber(b.order ?? 0, 0))
    .map<Workspace>((workspace, order) => ({
      ...workspace,
      name: sanitizeTerminalTitle(workspace.name) ?? workspaceNameFallback(workspace.projectPath),
      worktrees: workspace.worktrees
        ? workspace.worktrees.flatMap((worktree) => {
            const decoded = Schema.decodeUnknownOption(WorkspaceWorktreeSchema)(worktree)
            return decoded._tag === 'Some' ? [decoded.value] : []
          })
        : undefined,
      lastActiveTabId: isNonEmptyString(workspace.lastActiveTabId ?? '')
        ? workspace.lastActiveTabId
        : undefined,
      order,
    }))

  const panes = (persisted.panes ?? [])
    .filter((pane) => isNonEmptyString(pane.id) && isNonEmptyString(pane.tabId))
    .map<Pane>((pane) => ({
      ...pane,
      terminalId: isNonEmptyString(pane.terminalId ?? '') ? pane.terminalId! : createId('term'),
      name: sanitizeTerminalTitle(pane.name) ?? 'Pi',
      agentProvider: pane.agentProvider,
      argv: pane.argv?.filter((arg) => typeof arg === 'string'),
      status: pane.status === 'archived' ? 'idle' : (pane.status ?? 'idle'),
      lastSessionId: isNonEmptyString(pane.lastSessionId ?? '')
        ? pane.lastSessionId
        : createId('session'),
    }))
    .filter((pane) => pane.type !== 'terminal')
  const paneIdsByTab = new Map<string, Set<string>>()
  for (const pane of panes) {
    const paneIds = paneIdsByTab.get(pane.tabId) ?? new Set<string>()
    paneIds.add(pane.id)
    paneIdsByTab.set(pane.tabId, paneIds)
  }

  const usedPaneIds = new Set<string>()
  const tabs = reorderAllWorkspaceTabs(
    (persisted.tabs ?? []).flatMap<Tab>((tab) => {
      if (!isNonEmptyString(tab.id) || !isNonEmptyString(tab.workspaceId)) return []
      if (!contextExists(workspaces, tab.workspaceId)) return []

      const layout = decodePersistedLayout(tab.layout, paneIdsByTab.get(tab.id) ?? new Set())
      if (!layout) return []
      for (const paneId of getPaneIdsInLayout(layout)) {
        usedPaneIds.add(paneId)
      }

      return [
        {
          ...tab,
          name: sanitizeTerminalTitle(tab.name) ?? 'Pi',
          layout,
          lastActivePaneId:
            isNonEmptyString(tab.lastActivePaneId ?? '') &&
            layoutContainsPane(layout, tab.lastActivePaneId!)
              ? tab.lastActivePaneId
              : (getFirstPaneId(layout) ?? undefined),
          order: finiteNumber(tab.order ?? 0, 0),
        },
      ]
    }),
  )

  const tabIds = new Set(tabs.map((tab) => tab.id))
  const repairedWorkspaces = workspaces.map((workspace) =>
    workspace.lastActiveTabId && tabIds.has(workspace.lastActiveTabId)
      ? workspace
      : { ...workspace, lastActiveTabId: undefined },
  )
  const lastActiveLocalTabId =
    persisted.lastActiveLocalTabId &&
    tabs.some(
      (tab) => tab.workspaceId === LOCAL_WORKSPACE_ID && tab.id === persisted.lastActiveLocalTabId,
    )
      ? persisted.lastActiveLocalTabId
      : null

  return {
    workspaces: repairedWorkspaces,
    activeWorkspaceId:
      persisted.activeWorkspaceId && contextExists(workspaces, persisted.activeWorkspaceId)
        ? persisted.activeWorkspaceId
        : null,
    lastActiveLocalTabId,
    tabs,
    activeTabId: persisted.activeTabId ?? null,
    panes: panes.filter((pane) => usedPaneIds.has(pane.id)),
    activePaneId: persisted.activePaneId ?? null,
    sidebarExpanded: persisted.sidebarExpanded ?? true,
    sidebarWidth: finiteNumber(persisted.sidebarWidth ?? 240, 240),
    rightSidebarExpanded: persisted.rightSidebarExpanded ?? false,
    rightSidebarWidth: finiteNumber(persisted.rightSidebarWidth ?? 240, 240),
  }
}

function workspaceNameFallback(projectPath: string): string {
  return projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? projectPath
}

function repairPersistedState(state: TauState): TauState {
  const hasActiveWorkspace =
    state.activeWorkspaceId !== null && contextExists(state.workspaces, state.activeWorkspaceId)
  const activeWorkspaceId = hasActiveWorkspace ? state.activeWorkspaceId : null
  const nextState = { ...state, activeWorkspaceId }

  if (!activeWorkspaceId) return { ...nextState, activeTabId: null, activePaneId: null }

  return {
    ...nextState,
    ...selectWorkspaceTabState(nextState, activeWorkspaceId),
  }
}

function contextExists(workspaces: Workspace[], contextId: string): boolean {
  if (workspaces.some((workspace) => workspace.id === contextId)) return true
  const worktreeId = worktreeIdFromContext(contextId)
  return worktreeId
    ? workspaces.some((workspace) =>
        (workspace.worktrees ?? []).some((worktree) => worktree.id === worktreeId),
      )
    : false
}

function upsertWorktreeInWorkspace(
  workspaces: Workspace[],
  workspaceId: string,
  worktree: WorkspaceWorktree,
): Workspace[] {
  return workspaces.map((workspace) => {
    if (workspace.id !== workspaceId) return workspace
    const existing = workspace.worktrees ?? []
    const nextWorktrees = existing.some((candidate) => candidate.id === worktree.id)
      ? existing.map((candidate) => (candidate.id === worktree.id ? worktree : candidate))
      : [...existing, worktree]
    return {
      ...workspace,
      worktrees: nextWorktrees.sort((a, b) => a.orderIndex - b.orderIndex),
    }
  })
}

export const useTauStore = create<TauState>()((set) => ({
  workspaces: [],
  activeWorkspaceId: null,
  lastActiveLocalTabId: null,
  tabs: [],
  activeTabId: null,
  panes: [],
  activePaneId: null,
  sidebarExpanded: true,
  sidebarWidth: 240,
  rightSidebarExpanded: false,
  rightSidebarWidth: 240,
  hydrateLayout: (data) =>
    set((state) => {
      const persisted = normalizePersistedState(data)
      return repairPersistedState({ ...state, ...persisted })
    }),
  addWorkspace: (workspace) =>
    set((state) => {
      const existingWorkspace = state.workspaces.find(({ id }) => id === workspace.id)
      if (existingWorkspace) {
        const preferredTab = getPreferredWorkspaceTab(
          state.tabs,
          state.workspaces,
          existingWorkspace.id,
          state.lastActiveLocalTabId,
        )
        return {
          activeWorkspaceId: existingWorkspace.id,
          ...(preferredTab
            ? {
                activeTabId: preferredTab.id,
                activePaneId: getPreferredPaneId(preferredTab),
                workspaces: rememberWorkspaceTab(
                  state.workspaces,
                  existingWorkspace.id,
                  preferredTab.id,
                ),
              }
            : selectWorkspaceTabState(state, existingWorkspace.id)),
        }
      }

      const orderedWorkspace: Workspace = {
        ...workspace,
        order: state.workspaces.length,
      }

      return {
        workspaces: [...state.workspaces, orderedWorkspace],
        activeWorkspaceId: orderedWorkspace.id,
        activeTabId: null,
        activePaneId: null,
      }
    }),
  upsertWorkspace: (workspace) =>
    set((state) => {
      const existingIndex = state.workspaces.findIndex(
        (candidate) =>
          candidate.id === workspace.id || candidate.projectPath === workspace.projectPath,
      )
      if (existingIndex === -1) {
        return {
          workspaces: [
            ...state.workspaces,
            {
              ...workspace,
              order: Number.isFinite(workspace.order) ? workspace.order : state.workspaces.length,
            },
          ].map((candidate, order) => ({ ...candidate, order })),
        }
      }

      const existingWorkspace = state.workspaces[existingIndex]
      if (!existingWorkspace) return {}
      const oldWorkspaceId = existingWorkspace.id
      const nextWorkspace = {
        ...existingWorkspace,
        ...workspace,
        order: existingWorkspace.order,
        lastActiveTabId: existingWorkspace.lastActiveTabId ?? workspace.lastActiveTabId,
        worktrees: workspace.worktrees ?? existingWorkspace.worktrees,
      }
      const workspaceIdChanged = oldWorkspaceId !== nextWorkspace.id

      return {
        workspaces: state.workspaces.map((candidate, index) =>
          index === existingIndex ? nextWorkspace : candidate,
        ),
        tabs: workspaceIdChanged
          ? state.tabs.map((tab) =>
              tab.workspaceId === oldWorkspaceId ? { ...tab, workspaceId: nextWorkspace.id } : tab,
            )
          : state.tabs,
        activeWorkspaceId:
          workspaceIdChanged && state.activeWorkspaceId === oldWorkspaceId
            ? nextWorkspace.id
            : state.activeWorkspaceId,
      }
    }),
  upsertWorktree: (workspaceId, worktree) =>
    set((state) => {
      const workspaces = upsertWorktreeInWorkspace(state.workspaces, workspaceId, worktree)
      const contextId = worktreeContextId(worktree.id)
      const nextState = { ...state, workspaces, activeWorkspaceId: contextId }
      return {
        workspaces,
        activeWorkspaceId: contextId,
        ...selectWorkspaceTabState(nextState, contextId),
      }
    }),
  removeWorktree: (workspaceId, worktreeId) =>
    set((state) => {
      const contextId = worktreeContextId(worktreeId)
      const workspaces = state.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              worktrees: (workspace.worktrees ?? []).filter(
                (worktree) => worktree.id !== worktreeId,
              ),
            }
          : workspace,
      )
      const removedTabIds = new Set(
        state.tabs.filter((tab) => tab.workspaceId === contextId).map((tab) => tab.id),
      )
      const tabs = state.tabs.filter((tab) => tab.workspaceId !== contextId)
      const panes = state.panes.filter((pane) => !removedTabIds.has(pane.tabId))
      const activeWorkspaceId =
        state.activeWorkspaceId === contextId ? workspaceId : state.activeWorkspaceId
      const nextState = { ...state, workspaces, tabs, panes, activeWorkspaceId }
      return {
        workspaces,
        tabs,
        panes,
        activeWorkspaceId,
        ...(state.activeWorkspaceId === contextId
          ? selectWorkspaceTabState(nextState, workspaceId)
          : {}),
      }
    }),
  removeWorkspace: (workspaceId) =>
    set((state) => {
      const removedWorkspace = state.workspaces.find(({ id }) => id === workspaceId)
      const removedContextIds = new Set([
        workspaceId,
        ...(removedWorkspace?.worktrees ?? []).map((worktree) => worktreeContextId(worktree.id)),
      ])
      const workspaces = state.workspaces
        .filter(({ id }) => id !== workspaceId)
        .map((workspace, order) => ({ ...workspace, order }))
      const removedTabIds = new Set(
        state.tabs.filter((tab) => removedContextIds.has(tab.workspaceId)).map((tab) => tab.id),
      )
      const tabs = state.tabs.filter((tab) => !removedContextIds.has(tab.workspaceId))
      const panes = state.panes.filter((pane) => !removedTabIds.has(pane.tabId))
      const activeWorkspaceId =
        state.activeWorkspaceId !== null && removedContextIds.has(state.activeWorkspaceId)
          ? (workspaces.find(({ order }) => order === 0)?.id ?? null)
          : state.activeWorkspaceId

      const nextState = { ...state, workspaces, tabs, panes, activeWorkspaceId }
      const nextTab = activeWorkspaceId
        ? getPreferredWorkspaceTab(tabs, workspaces, activeWorkspaceId, state.lastActiveLocalTabId)
        : null

      return {
        workspaces,
        activeWorkspaceId,
        tabs,
        panes,
        activeTabId: nextTab?.id ?? null,
        activePaneId: nextTab ? getPreferredPaneId(nextTab) : null,
        ...(activeWorkspaceId ? selectWorkspaceTabState(nextState, activeWorkspaceId) : {}),
      }
    }),
  selectWorkspace: (workspaceId) =>
    set((state) => ({
      activeWorkspaceId: workspaceId,
      ...selectWorkspaceTabState(state, workspaceId),
    })),
  selectWorktree: (worktreeId) =>
    set((state) => {
      const contextId = worktreeContextId(worktreeId)
      if (!contextExists(state.workspaces, contextId)) return {}
      return {
        activeWorkspaceId: contextId,
        ...selectWorkspaceTabState(state, contextId),
      }
    }),
  selectWorkspaceByIndex: (index) =>
    set((state) => {
      const workspace = [...state.workspaces].sort((a, b) => a.order - b.order)[index]
      if (!workspace) return {}

      return {
        activeWorkspaceId: workspace.id,
        ...selectWorkspaceTabState(state, workspace.id),
      }
    }),
  newTab: (workspaceId) =>
    set((state) => {
      const targetWorkspaceId = workspaceId ?? state.activeWorkspaceId
      if (!targetWorkspaceId || !contextExists(state.workspaces, targetWorkspaceId)) return {}
      const order = getWorkspaceTabs(state.tabs, targetWorkspaceId).length
      const { tab, pane } = createTerminalTab(targetWorkspaceId, order)

      return {
        workspaces: rememberWorkspaceTab(state.workspaces, targetWorkspaceId, tab.id),
        ...rememberLocalTab(targetWorkspaceId, tab.id),
        tabs: [...state.tabs, tab],
        activeTabId: tab.id,
        panes: [...state.panes, pane],
        activePaneId: pane.id,
      }
    }),
  importPiThreads: (workspaceId, threads) =>
    set((state) => {
      if (!contextExists(state.workspaces, workspaceId)) return {}

      const targetWorkspaceIds = new Set<string>([workspaceId])
      for (const thread of threads) {
        const targetWorkspaceId = piThreadContextId(workspaceId, thread)
        if (contextExists(state.workspaces, targetWorkspaceId))
          targetWorkspaceIds.add(targetWorkspaceId)
      }
      const replacedTabIds = new Set(
        state.tabs
          .filter(
            (tab) => targetWorkspaceIds.has(tab.workspaceId) && isPiThreadTab(tab, state.panes),
          )
          .map((tab) => tab.id),
      )
      let tabs = state.tabs.filter((tab) => !replacedTabIds.has(tab.id))
      let panes = state.panes.filter((pane) => !replacedTabIds.has(pane.tabId))
      let changed = false

      for (const thread of threads) {
        const targetWorkspaceId = piThreadContextId(workspaceId, thread)
        if (!contextExists(state.workspaces, targetWorkspaceId)) continue

        const order = getWorkspaceTabs(tabs, targetWorkspaceId).length

        const { tab, pane } = createTerminalTab(targetWorkspaceId, order, { thread })
        tabs = [...tabs, tab]
        panes = [...panes, pane]
        changed = true
      }

      if (!changed && replacedTabIds.size === 0) return {}

      const activeTabStillExists =
        state.activeTabId !== null && tabs.some((tab) => tab.id === state.activeTabId)
      const needsActiveClear = state.activeTabId !== null && !activeTabStillExists
      const piTabIds = new Set(
        tabs
          .filter((tab) => targetWorkspaceIds.has(tab.workspaceId) && isPiThreadTab(tab, panes))
          .map((tab) => tab.id),
      )
      const workspaces = state.workspaces.map((workspace) =>
        workspace.lastActiveTabId && piTabIds.has(workspace.lastActiveTabId)
          ? { ...workspace, lastActiveTabId: undefined }
          : workspace,
      )

      return {
        workspaces,
        tabs: reorderAllWorkspaceTabs(tabs),
        panes,
        ...(needsActiveClear
          ? {
              activeTabId: null,
              activePaneId: null,
            }
          : {}),
      }
    }),
  openChangesTab: (workspaceId) =>
    set((state) => {
      const targetWorkspaceId = workspaceId ?? state.activeWorkspaceId
      if (!targetWorkspaceId || !contextExists(state.workspaces, targetWorkspaceId)) return {}

      const existingPane = state.panes.find(
        (pane) =>
          pane.type === 'changes' &&
          state.tabs.some((tab) => tab.id === pane.tabId && tab.workspaceId === targetWorkspaceId),
      )
      const existingTab = existingPane
        ? state.tabs.find((tab) => tab.id === existingPane.tabId)
        : null

      if (existingTab && existingPane) {
        return {
          workspaces: rememberWorkspaceTab(state.workspaces, targetWorkspaceId, existingTab.id),
          ...rememberLocalTab(targetWorkspaceId, existingTab.id),
          activeTabId: existingTab.id,
          activePaneId: existingPane.id,
        }
      }

      const order = getWorkspaceTabs(state.tabs, targetWorkspaceId).length
      const { tab, pane } = createChangesTab(targetWorkspaceId, order)

      return {
        workspaces: rememberWorkspaceTab(state.workspaces, targetWorkspaceId, tab.id),
        ...rememberLocalTab(targetWorkspaceId, tab.id),
        tabs: [...state.tabs, tab],
        activeTabId: tab.id,
        panes: [...state.panes, pane],
        activePaneId: pane.id,
      }
    }),
  closeTab: (tabId) => set((state) => closeTabState(state, tabId)),
  closeActiveTab: () =>
    set((state) => (state.activeTabId ? closeTabState(state, state.activeTabId) : {})),
  selectTab: (tabId) =>
    set((state) => {
      const tab = state.tabs.find((candidate) => candidate.id === tabId)
      if (!tab) return {}

      return {
        workspaces: rememberWorkspaceTab(state.workspaces, tab.workspaceId, tab.id),
        ...rememberLocalTab(tab.workspaceId, tab.id),
        activeWorkspaceId:
          tab.workspaceId === LOCAL_WORKSPACE_ID ? state.activeWorkspaceId : tab.workspaceId,
        activeTabId: tab.id,
        activePaneId: getPreferredPaneId(tab),
      }
    }),
  selectTabByIndex: (index) =>
    set((state) => {
      const workspaceId = state.activeWorkspaceId
      if (!workspaceId) return {}
      const tab = getWorkspaceTabs(state.tabs, workspaceId)[index]
      if (!tab) return {}

      return {
        workspaces: rememberWorkspaceTab(state.workspaces, tab.workspaceId, tab.id),
        ...rememberLocalTab(tab.workspaceId, tab.id),
        activeTabId: tab.id,
        activePaneId: getPreferredPaneId(tab),
      }
    }),
  reorderTab: (tabId, targetTabId, placement) =>
    set((state) => {
      const tab = state.tabs.find((candidate) => candidate.id === tabId)
      const targetTab = state.tabs.find((candidate) => candidate.id === targetTabId)
      if (!tab || !targetTab || tab.workspaceId !== targetTab.workspaceId) return {}

      const workspaceTabs = getWorkspaceTabs(state.tabs, tab.workspaceId)
      const reorderedTabs = moveRelativeTo(workspaceTabs, tabId, targetTabId, placement)
      if (reorderedTabs === workspaceTabs) return {}

      const reorderedById = new Map(reorderedTabs.map((candidate) => [candidate.id, candidate]))

      return {
        tabs: state.tabs.map((candidate) => reorderedById.get(candidate.id) ?? candidate),
      }
    }),
  setTabLayout: (tabId, layout) =>
    set((state) => {
      if (!layout) return closeTabState(state, tabId)

      const tab = state.tabs.find((candidate) => candidate.id === tabId)
      if (!tab) return {}

      const paneIds = new Set(getPaneIdsInLayout(layout))
      const firstPaneId = paneIds.values().next().value ?? null
      const activePaneId =
        state.activeTabId === tabId && (!state.activePaneId || !paneIds.has(state.activePaneId))
          ? firstPaneId
          : state.activePaneId
      const lastActivePaneId =
        tab.lastActivePaneId && paneIds.has(tab.lastActivePaneId)
          ? tab.lastActivePaneId
          : (firstPaneId ?? undefined)

      return {
        tabs: state.tabs.map((candidate) =>
          candidate.id === tabId ? { ...candidate, layout, lastActivePaneId } : candidate,
        ),
        panes: state.panes.filter((pane) => pane.tabId !== tabId || paneIds.has(pane.id)),
        activePaneId,
      }
    }),
  selectPane: (paneId) =>
    set((state) => {
      const pane = state.panes.find((candidate) => candidate.id === paneId)
      if (!pane) return {}
      const tab = state.tabs.find((candidate) => candidate.id === pane.tabId)

      return {
        tabs: rememberTabPane(state.tabs, pane.tabId, pane.id),
        workspaces: tab
          ? rememberWorkspaceTab(state.workspaces, tab.workspaceId, tab.id)
          : state.workspaces,
        ...(tab ? rememberLocalTab(tab.workspaceId, tab.id) : {}),
        activePaneId: pane.id,
        activeTabId: pane.tabId,
      }
    }),
  selectPaneByDirection: (direction) =>
    set((state) => {
      const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId)
      const paneId = state.activePaneId ?? (activeTab ? getFirstPaneId(activeTab.layout) : null)
      if (!activeTab || !paneId) return {}

      const nextPaneId = findPaneInDirection(activeTab.layout, paneId, direction)
      if (!nextPaneId) return {}

      return {
        tabs: rememberTabPane(state.tabs, activeTab.id, nextPaneId),
        activePaneId: nextPaneId,
      }
    }),
  restartPaneSession: (paneId) =>
    set((state) => {
      const pane = state.panes.find((candidate) => candidate.id === paneId)
      if (!pane || pane.type !== 'terminal') return {}

      return {
        panes: state.panes.map((candidate) =>
          candidate.id === pane.id
            ? { ...candidate, lastSessionId: createId('session'), status: 'idle' }
            : candidate,
        ),
      }
    }),
  setPaneTitle: (paneId, title) =>
    set((state) => {
      const pane = state.panes.find((candidate) => candidate.id === paneId)
      if (!pane) return {}
      if (isPiPane(pane)) return {}

      const name = sanitizeTerminalTitle(title)
      if (!name) return {}

      const tab = state.tabs.find((candidate) => candidate.id === pane.tabId)
      const paneIds = tab ? getPaneIdsInLayout(tab.layout) : []
      const nextPanes =
        pane.name === name
          ? state.panes
          : state.panes.map((candidate) =>
              candidate.id === pane.id ? { ...candidate, name } : candidate,
            )
      const nextTabs =
        tab &&
        tab.name !== name &&
        (paneId === state.activePaneId || paneIds.length === 1) &&
        paneIds.includes(paneId)
          ? state.tabs.map((candidate) =>
              candidate.id === tab.id ? { ...candidate, name } : candidate,
            )
          : state.tabs

      if (nextPanes === state.panes && nextTabs === state.tabs) return {}
      return { panes: nextPanes, tabs: nextTabs }
    }),
  setPaneStatus: (paneId, status) =>
    set((state) => {
      const pane = state.panes.find((candidate) => candidate.id === paneId)
      if (!pane || pane.status === status) return {}

      return {
        panes: state.panes.map((candidate) =>
          candidate.id === pane.id ? { ...candidate, status } : candidate,
        ),
      }
    }),
  splitPane: (paneId, direction) =>
    set((state) => {
      const pane = state.panes.find((candidate) => candidate.id === paneId)
      const tab = pane ? state.tabs.find((candidate) => candidate.id === pane.tabId) : null
      if (!pane || !tab || !layoutContainsPane(tab.layout, pane.id)) return {}

      const paneIndex = state.panes.filter((candidate) => candidate.tabId === tab.id).length + 1
      const newPane = createTerminalPane(tab.id, paneIndex)
      const layout = splitLayoutNode(tab.layout, pane.id, newPane.id, direction)

      return {
        tabs: state.tabs.map((candidate) =>
          candidate.id === tab.id
            ? { ...candidate, layout, lastActivePaneId: newPane.id }
            : candidate,
        ),
        panes: [...state.panes, newPane],
        activeTabId: tab.id,
        activePaneId: newPane.id,
      }
    }),
  splitActivePane: (direction) =>
    set((state) => {
      const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId)
      const paneId = state.activePaneId ?? (activeTab ? getFirstPaneId(activeTab.layout) : null)
      if (!paneId) return {}

      const pane = state.panes.find((candidate) => candidate.id === paneId)
      const tab = pane ? state.tabs.find((candidate) => candidate.id === pane.tabId) : null
      if (!pane || !tab || !layoutContainsPane(tab.layout, pane.id)) return {}

      const paneIndex = state.panes.filter((candidate) => candidate.tabId === tab.id).length + 1
      const newPane = createTerminalPane(tab.id, paneIndex)
      const layout = splitLayoutNode(tab.layout, pane.id, newPane.id, direction)

      return {
        tabs: state.tabs.map((candidate) =>
          candidate.id === tab.id
            ? { ...candidate, layout, lastActivePaneId: newPane.id }
            : candidate,
        ),
        panes: [...state.panes, newPane],
        activeTabId: tab.id,
        activePaneId: newPane.id,
      }
    }),
  closePane: (paneId) => set((state) => closePaneState(state, paneId)),
  closeActivePane: () =>
    set((state) => (state.activePaneId ? closePaneState(state, state.activePaneId) : {})),
  toggleSidebar: () => set((state) => ({ sidebarExpanded: !state.sidebarExpanded })),
  setSidebarExpanded: (expanded) => set({ sidebarExpanded: expanded }),
  setSidebarWidth: (width) => set({ sidebarWidth: width }),
  toggleRightSidebar: () => set((state) => ({ rightSidebarExpanded: !state.rightSidebarExpanded })),
  setRightSidebarExpanded: (expanded) => set({ rightSidebarExpanded: expanded }),
  setRightSidebarWidth: (width) => set({ rightSidebarWidth: width }),
  reorderWorkspace: (workspaceId, targetWorkspaceId, placement) =>
    set((state) => {
      const workspaces = moveRelativeTo(state.workspaces, workspaceId, targetWorkspaceId, placement)
      return workspaces === state.workspaces ? {} : { workspaces }
    }),
}))

export function selectPaneLayoutData(state: TauState): PaneLayoutData {
  const persistedTabs = state.tabs.filter((tab) => !isPiThreadTab(tab, state.panes))
  const persistedTabIds = new Set(persistedTabs.map((tab) => tab.id))
  const persistedPanes = state.panes.filter((pane) => persistedTabIds.has(pane.tabId))
  const activeTabId =
    state.activeTabId && persistedTabIds.has(state.activeTabId) ? state.activeTabId : null
  const activePaneId =
    state.activePaneId && persistedPanes.some((pane) => pane.id === state.activePaneId)
      ? state.activePaneId
      : null

  return {
    version: 2,
    workspaces: state.workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      projectPath: workspace.projectPath,
      branch: workspace.branch,
      worktrees: workspace.worktrees,
      lastActiveTabId:
        workspace.lastActiveTabId && persistedTabIds.has(workspace.lastActiveTabId)
          ? workspace.lastActiveTabId
          : undefined,
      order: workspace.order,
    })),
    activeWorkspaceId: state.activeWorkspaceId,
    lastActiveLocalTabId: state.lastActiveLocalTabId,
    tabs: persistedTabs.map((tab) => ({
      id: tab.id,
      workspaceId: tab.workspaceId,
      name: tab.name,
      layout: tab.layout,
      lastActivePaneId: tab.lastActivePaneId,
      order: tab.order,
    })),
    panes: persistedPanes.map((pane) => ({
      id: pane.id,
      terminalId: pane.terminalId,
      tabId: pane.tabId,
      type: pane.type,
      name: pane.name,
      cwd: pane.cwd,
      agentProvider: pane.agentProvider,
      argv: pane.argv,
      status: pane.status,
      lastSessionId: pane.lastSessionId,
    })),
    activeTabId,
    activePaneId,
    sidebarExpanded: state.sidebarExpanded,
    sidebarWidth: state.sidebarWidth,
    rightSidebarExpanded: state.rightSidebarExpanded,
    rightSidebarWidth: state.rightSidebarWidth,
  }
}

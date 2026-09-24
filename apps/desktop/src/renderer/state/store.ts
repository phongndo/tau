import type { MosaicDirection } from './layout'
import { Schema } from 'effect'
import { createStore } from 'zustand/vanilla'
import type { PaneFocusDirection } from '@tau/shared/app-command'
import { PANE_LAYOUT_VERSION, type PaneLayoutData } from '@tau/shared/session'
import type { MuxGraphSnapshot } from '@tau/shared/mux-graph'
import { sanitizeTerminalTitle } from '../osc-title'
import {
  getFirstPaneId,
  getPaneIdsInLayout,
  getPaneRects,
  getVisiblePaneIdForPane,
  isSplitNode,
  isTabsNode,
  layoutContainsPane,
  normalizeSplitPercentages,
  splitPercentagesForLayout,
  type MosaicLayoutNode,
  type PaneRect,
} from './layout'

export interface TauState {
  tabs: Tab[]
  workspaces: Workspace[]
  activeTabId: string | null
  panes: Pane[]
  activePaneId: string | null
  graphRev: number
  eventSeq: number
  graphExtensions?: unknown
  hydrateLayout(data: PaneLayoutData): void
  applyMuxGraph(snapshot: MuxGraphSnapshot): void
  markMuxGraphRevision(graphRev: number, eventSeq: number): void
  newTab(): void
  newWorkspace(): void
  selectWorkspace(workspaceId: string): void
  renameWorkspace(workspaceId: string, name: string): void
  closeWorkspace(workspaceId: string): void
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
  renameTab(tabId: string, name: string): void
  splitPane(paneId: string, direction: MosaicDirection): void
  splitActivePane(direction: MosaicDirection): void
  closePane(paneId: string): void
  closeActivePane(): void
}

export interface Tab {
  id: string
  workspaceId: string
  name: string
  layout: MosaicLayoutNode
  lastActivePaneId?: string
  order: number
  extensions?: unknown
}

export interface Workspace {
  id: string
  name: string
  activeTabId?: string
}

const DEFAULT_WORKSPACE_ID = 'default'

function extensionRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function workspacesFromGraph(extensions: unknown, tabs: Tab[]): Workspace[] {
  const raw = extensionRecord(extensions).tauWorkspaces
  const saved = Array.isArray(raw)
    ? raw.filter(
        (item): item is Workspace =>
          item &&
          typeof item === 'object' &&
          typeof item.id === 'string' &&
          typeof item.name === 'string',
      )
    : []
  const ids = new Set(tabs.map((tab) => tab.workspaceId))
  const workspaces: Workspace[] = []
  for (const workspace of saved) {
    if (!ids.has(workspace.id) || workspaces.some((item) => item.id === workspace.id)) continue
    const activeTab = tabs.find(
      (tab) => tab.id === workspace.activeTabId && tab.workspaceId === workspace.id,
    )
    workspaces.push({
      id: workspace.id,
      name: workspace.name.trim() || 'Workspace',
      activeTabId: activeTab?.id,
    })
  }
  for (const id of ids) {
    if (!workspaces.some((workspace) => workspace.id === id))
      workspaces.push({ id, name: id === DEFAULT_WORKSPACE_ID ? 'Workspace 1' : 'Workspace' })
  }
  return workspaces
}

function rememberWorkspaceTab(workspaces: Workspace[], tab: Tab): Workspace[] {
  return workspaces.map((workspace) =>
    workspace.id === tab.workspaceId ? { ...workspace, activeTabId: tab.id } : workspace,
  )
}

export type { MosaicLayoutNode } from './layout'

export interface Pane {
  id: string
  terminalId: string
  tabId: string
  type: 'terminal'
  name: string
  cwd?: string
  argv?: string[]
  lastSessionId?: string
  extensions?: unknown
}

export type ReorderPlacement = 'before' | 'after'

const PersistedTabSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  layout: Schema.Unknown,
  lastActivePaneId: Schema.optional(Schema.String),
  order: Schema.optional(Schema.Number),
})

const PersistedPaneSchema = Schema.Struct({
  id: Schema.String,
  terminalId: Schema.optional(Schema.String),
  tabId: Schema.String,
  type: Schema.optional(Schema.Literal('terminal')),
  name: Schema.String,
  cwd: Schema.optional(Schema.String),
  argv: Schema.optional(Schema.Array(Schema.String)),
  lastSessionId: Schema.optional(Schema.String),
})

const PersistedTauStateSchema = Schema.Struct({
  version: Schema.optional(Schema.Number),
  tabs: Schema.optional(Schema.Array(PersistedTabSchema)),
  activeTabId: Schema.optional(Schema.NullOr(Schema.String)),
  panes: Schema.optional(Schema.Array(PersistedPaneSchema)),
  activePaneId: Schema.optional(Schema.NullOr(Schema.String)),
  graphRev: Schema.optional(Schema.Number),
})

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

function createTerminalPane(tabId: string, name = 'Terminal'): Pane {
  return {
    id: createId('pane'),
    terminalId: createId('term'),
    tabId,
    type: 'terminal',
    name,
    lastSessionId: createId('session'),
  }
}

function createTerminalTab(
  order: number,
  workspaceId = DEFAULT_WORKSPACE_ID,
): { tab: Tab; pane: Pane } {
  const tabId = createId('tab')
  const pane = createTerminalPane(tabId)
  return {
    tab: {
      id: tabId,
      workspaceId,
      name: order === 0 ? 'Shell' : `Shell ${order + 1}`,
      layout: pane.id,
      lastActivePaneId: pane.id,
      order,
    },
    pane,
  }
}

function ensureDefaultShell(
  state: Pick<TauState, 'tabs' | 'panes' | 'activeTabId' | 'activePaneId'>,
) {
  if (state.tabs.length > 0) return state
  const { tab, pane } = createTerminalTab(0)
  return {
    tabs: [tab],
    panes: [pane],
    activeTabId: tab.id,
    activePaneId: pane.id,
  }
}

function getPreferredPaneId(tab: Tab): string | null {
  if (tab.lastActivePaneId) {
    const visiblePaneId = getVisiblePaneIdForPane(tab.layout, tab.lastActivePaneId)
    if (visiblePaneId) return visiblePaneId
  }
  return getFirstPaneId(tab.layout)
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
    if (!best || score < best.score) best = { id: rect.id, score }
  }

  return best?.id ?? null
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
): { layout: MosaicLayoutNode | null; removed: boolean; replacementPaneId?: string | null } {
  if (layout === paneId) return { layout: null, removed: true, replacementPaneId: null }
  if (typeof layout === 'string') return { layout, removed: false }

  if (isTabsNode(layout)) {
    const tabs = layout.tabs.filter((tab) => tab !== paneId)
    if (tabs.length === layout.tabs.length) return { layout, removed: false }
    if (tabs.length === 0) return { layout: null, removed: true }
    if (tabs.length === 1) return { layout: tabs[0]!, removed: true, replacementPaneId: tabs[0]! }
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
    let replacementPaneId: string | null | undefined

    layout.children.forEach((child, index) => {
      const result = removePaneFromLayout(child, paneId)
      removed = removed || result.removed
      replacementPaneId ??= result.replacementPaneId
      if (!result.layout) return
      children.push(result.layout)
      childPercentages.push(percentages[index] ?? 0)
    })

    if (!removed) return { layout, removed: false }
    if (children.length === 0) return { layout: null, removed: true, replacementPaneId }
    if (children.length === 1) return { layout: children[0]!, removed: true, replacementPaneId }

    return {
      layout: {
        ...layout,
        children,
        splitPercentages: normalizeSplitPercentages(childPercentages, children.length),
      },
      removed: true,
      replacementPaneId,
    }
  }

  return { layout, removed: false }
}

function reorderTabs(tabs: Tab[]): Tab[] {
  return tabs.map((tab, index) => ({ ...tab, order: index }))
}

function bumpRev(state: TauState): number {
  return state.graphRev + 1
}

const initialShell = ensureDefaultShell({
  tabs: [],
  panes: [],
  activeTabId: null,
  activePaneId: null,
})

export const useTauStore = createStore<TauState>((set, get) => ({
  ...initialShell,
  workspaces: [
    {
      id: DEFAULT_WORKSPACE_ID,
      name: 'Workspace 1',
      activeTabId: initialShell.activeTabId ?? undefined,
    },
  ],
  graphRev: 0,
  eventSeq: 0,
  graphExtensions: undefined,

  hydrateLayout(data) {
    const decoded = Schema.decodeUnknownOption(PersistedTauStateSchema)(data)
    if (decoded._tag === 'None') {
      set({
        ...ensureDefaultShell({ tabs: [], panes: [], activeTabId: null, activePaneId: null }),
        workspaces: [{ id: DEFAULT_WORKSPACE_ID, name: 'Workspace 1' }],
        graphRev: 0,
        graphExtensions: undefined,
      })
      return
    }

    const value = decoded.value
    // Discard pre-v2 workspace-centric layouts.
    if (typeof value.version === 'number' && value.version < PANE_LAYOUT_VERSION) {
      set({
        ...ensureDefaultShell({ tabs: [], panes: [], activeTabId: null, activePaneId: null }),
        workspaces: [{ id: DEFAULT_WORKSPACE_ID, name: 'Workspace 1' }],
        graphRev: 0,
        graphExtensions: undefined,
      })
      return
    }

    const panes: Pane[] = (value.panes ?? [])
      .filter((pane) => pane.type === undefined || pane.type === 'terminal')
      .map((pane) => ({
        id: pane.id,
        terminalId: pane.terminalId ?? createId('term'),
        tabId: pane.tabId,
        type: 'terminal' as const,
        name: pane.name,
        cwd: pane.cwd,
        argv: pane.argv ? [...pane.argv] : undefined,
        lastSessionId: pane.lastSessionId,
      }))

    const paneIds = new Set(panes.map((pane) => pane.id))
    const tabs: Tab[] = (value.tabs ?? [])
      .map((tab, index) => ({
        id: tab.id,
        workspaceId: DEFAULT_WORKSPACE_ID,
        name: tab.name,
        layout: tab.layout as MosaicLayoutNode,
        lastActivePaneId: tab.lastActivePaneId,
        order: tab.order ?? index,
      }))
      .filter((tab) => getPaneIdsInLayout(tab.layout).every((id) => paneIds.has(id)))
      .sort((a, b) => a.order - b.order)

    const shell = ensureDefaultShell({
      tabs,
      panes,
      activeTabId: value.activeTabId ?? tabs[0]?.id ?? null,
      activePaneId: value.activePaneId ?? null,
    })

    const activeTab =
      shell.tabs.find((tab) => tab.id === shell.activeTabId) ?? shell.tabs[0] ?? null
    const activePaneId =
      (shell.activePaneId && paneIds.has(shell.activePaneId)
        ? shell.activePaneId
        : activeTab
          ? getPreferredPaneId(activeTab)
          : null) ?? null

    set({
      ...shell,
      workspaces: [{ id: DEFAULT_WORKSPACE_ID, name: 'Workspace 1', activeTabId: activeTab?.id }],
      activeTabId: activeTab?.id ?? null,
      activePaneId,
      graphRev: value.graphRev ?? 0,
      eventSeq: 0,
      graphExtensions: undefined,
    })
  },

  applyMuxGraph(snapshot) {
    const panes: Pane[] = snapshot.panes.map((pane) => ({
      id: pane.id,
      terminalId: pane.terminalId,
      tabId: pane.tabId,
      type: 'terminal',
      name: pane.name,
      cwd: pane.cwd,
      argv: pane.argv ? [...pane.argv] : undefined,
      lastSessionId: pane.sessionId,
      extensions: pane.extensions,
    }))
    const tabs: Tab[] = snapshot.tabs
      .map((tab) => ({
        id: tab.id,
        workspaceId:
          typeof extensionRecord(tab.extensions).tauWorkspaceId === 'string'
            ? (extensionRecord(tab.extensions).tauWorkspaceId as string)
            : DEFAULT_WORKSPACE_ID,
        name: tab.name,
        order: tab.order,
        layout: tab.root as MosaicLayoutNode,
        lastActivePaneId: tab.activePaneId,
        extensions: tab.extensions,
      }))
      .sort((left, right) => left.order - right.order)
    const shell = ensureDefaultShell({
      tabs,
      panes,
      activeTabId: snapshot.activeTabId,
      activePaneId: snapshot.activePaneId,
    })
    const selected = shell.tabs.find((tab) => tab.id === shell.activeTabId)
    const workspaces = workspacesFromGraph(snapshot.extensions, shell.tabs)
    set({
      ...shell,
      workspaces: selected ? rememberWorkspaceTab(workspaces, selected) : workspaces,
      graphRev: snapshot.graphRev,
      eventSeq: snapshot.eventSeq,
      graphExtensions: snapshot.extensions,
    })
  },

  markMuxGraphRevision(graphRev, eventSeq) {
    set({ graphRev, eventSeq })
  },

  newTab() {
    set((state) => {
      const activeWorkspaceId =
        state.tabs.find((tab) => tab.id === state.activeTabId)?.workspaceId ??
        state.workspaces[0]?.id ??
        DEFAULT_WORKSPACE_ID
      const orderInWorkspace = state.tabs.filter(
        (item) => item.workspaceId === activeWorkspaceId,
      ).length
      const { tab, pane } = createTerminalTab(orderInWorkspace, activeWorkspaceId)
      tab.order = state.tabs.length
      return {
        tabs: [...state.tabs, tab],
        workspaces: rememberWorkspaceTab(state.workspaces, tab),
        panes: [...state.panes, pane],
        activeTabId: tab.id,
        activePaneId: pane.id,
        graphRev: bumpRev(state),
      }
    })
  },

  newWorkspace() {
    set((state) => {
      const id = createId('workspace')
      const { tab, pane } = createTerminalTab(state.tabs.length, id)
      tab.name = 'Shell'
      const name = `Workspace ${state.workspaces.length + 1}`
      return {
        workspaces: [...state.workspaces, { id, name, activeTabId: tab.id }],
        tabs: [...state.tabs, tab],
        panes: [...state.panes, pane],
        activeTabId: tab.id,
        activePaneId: pane.id,
        graphRev: bumpRev(state),
      }
    })
  },

  selectWorkspace(workspaceId) {
    const state = get()
    const workspace = state.workspaces.find((item) => item.id === workspaceId)
    if (!workspace) return
    const tab =
      state.tabs.find(
        (item) => item.id === workspace.activeTabId && item.workspaceId === workspaceId,
      ) ?? state.tabs.find((item) => item.workspaceId === workspaceId)
    if (tab) state.selectTab(tab.id)
  },

  renameWorkspace(workspaceId, name) {
    const normalized = name.trim().slice(0, 80)
    if (!normalized) return
    set((state) => ({
      workspaces: state.workspaces.map((item) =>
        item.id === workspaceId ? { ...item, name: normalized } : item,
      ),
      graphRev: bumpRev(state),
    }))
  },

  closeWorkspace(workspaceId) {
    set((state) => {
      const closing = state.tabs.filter((tab) => tab.workspaceId === workspaceId)
      if (closing.length === 0) return state
      const closedIds = new Set(closing.map((tab) => tab.id))
      let tabs = reorderTabs(state.tabs.filter((tab) => !closedIds.has(tab.id)))
      let panes = state.panes.filter((pane) => !closedIds.has(pane.tabId))
      let workspaces = state.workspaces.filter((item) => item.id !== workspaceId)
      if (tabs.length === 0) {
        const shell = createTerminalTab(0)
        tabs = [shell.tab]
        panes = [shell.pane]
        workspaces = [{ id: DEFAULT_WORKSPACE_ID, name: 'Workspace 1', activeTabId: shell.tab.id }]
      }
      const next = tabs.find((tab) => tab.id === state.activeTabId) ?? tabs[0]!
      return {
        tabs,
        panes,
        workspaces,
        activeTabId: next.id,
        activePaneId: next.id === state.activeTabId ? state.activePaneId : getPreferredPaneId(next),
        graphRev: bumpRev(state),
      }
    })
  },

  closeTab(tabId) {
    set((state) => {
      const tab = state.tabs.find((candidate) => candidate.id === tabId)
      if (!tab) return state
      const paneIds = new Set(getPaneIdsInLayout(tab.layout))
      const nextTabs = reorderTabs(state.tabs.filter((candidate) => candidate.id !== tabId))
      const nextPanes = state.panes.filter((pane) => pane.tabId !== tabId && !paneIds.has(pane.id))

      if (nextTabs.length === 0) {
        const shell = ensureDefaultShell({
          tabs: [],
          panes: [],
          activeTabId: null,
          activePaneId: null,
        })
        return {
          ...shell,
          workspaces: [
            {
              id: DEFAULT_WORKSPACE_ID,
              name: 'Workspace 1',
              activeTabId: shell.activeTabId ?? undefined,
            },
          ],
          graphRev: bumpRev(state),
        }
      }

      const closingActive = state.activeTabId === tabId
      const remainingInWorkspace = nextTabs.filter(
        (candidate) => candidate.workspaceId === tab.workspaceId,
      )
      const nextActiveTab = closingActive
        ? (remainingInWorkspace.filter((candidate) => candidate.order < tab.order).at(-1) ??
          remainingInWorkspace[0] ??
          nextTabs[0]!)
        : (nextTabs.find((candidate) => candidate.id === state.activeTabId) ?? nextTabs[0]!)

      return {
        tabs: nextTabs,
        panes: nextPanes,
        workspaces: state.workspaces
          .filter((workspace) =>
            nextTabs.some((candidate) => candidate.workspaceId === workspace.id),
          )
          .map((workspace) =>
            workspace.activeTabId === tabId
              ? {
                  ...workspace,
                  activeTabId:
                    nextActiveTab.workspaceId === workspace.id
                      ? nextActiveTab.id
                      : nextTabs.find((candidate) => candidate.workspaceId === workspace.id)?.id,
                }
              : workspace,
          ),
        activeTabId: nextActiveTab.id,
        activePaneId: closingActive ? getPreferredPaneId(nextActiveTab) : state.activePaneId,
        graphRev: bumpRev(state),
      }
    })
  },

  closeActiveTab() {
    const { activeTabId } = get()
    if (activeTabId) get().closeTab(activeTabId)
  },

  selectTab(tabId) {
    set((state) => {
      const tab = state.tabs.find((candidate) => candidate.id === tabId)
      if (!tab) return state
      return {
        activeTabId: tabId,
        activePaneId: getPreferredPaneId(tab),
        workspaces: rememberWorkspaceTab(state.workspaces, tab),
        graphRev: bumpRev(state),
      }
    })
  },

  selectTabByIndex(index) {
    const state = get()
    const workspaceId = state.tabs.find((tab) => tab.id === state.activeTabId)?.workspaceId
    const tabs = [...state.tabs]
      .filter((tab) => tab.workspaceId === workspaceId)
      .sort((a, b) => a.order - b.order)
    const tab = tabs[index]
    if (tab) get().selectTab(tab.id)
  },

  reorderTab(tabId, targetTabId, placement) {
    set((state) => {
      if (tabId === targetTabId) return state
      const tabs = [...state.tabs].sort((a, b) => a.order - b.order)
      const from = tabs.findIndex((tab) => tab.id === tabId)
      const to = tabs.findIndex((tab) => tab.id === targetTabId)
      if (from < 0 || to < 0) return state
      if (tabs[from]!.workspaceId !== tabs[to]!.workspaceId) return state
      const [moved] = tabs.splice(from, 1)
      if (!moved) return state
      const insertAt = placement === 'before' ? (from < to ? to - 1 : to) : from < to ? to : to + 1
      tabs.splice(Math.max(0, insertAt), 0, moved)
      return { tabs: reorderTabs(tabs), graphRev: bumpRev(state) }
    })
  },

  setTabLayout(tabId, layout) {
    set((state) => {
      if (!layout) {
        get().closeTab(tabId)
        return get()
      }
      const tabs = state.tabs.map((tab) => {
        if (tab.id !== tabId) return tab
        const lastActivePaneId =
          tab.lastActivePaneId && layoutContainsPane(layout, tab.lastActivePaneId)
            ? tab.lastActivePaneId
            : (getFirstPaneId(layout) ?? undefined)
        return { ...tab, layout, lastActivePaneId }
      })
      const activeTab = tabs.find((tab) => tab.id === state.activeTabId)
      return {
        tabs,
        activePaneId: activeTab ? getPreferredPaneId(activeTab) : state.activePaneId,
        graphRev: bumpRev(state),
      }
    })
  },

  selectPane(paneId) {
    set((state) => {
      const pane = state.panes.find((candidate) => candidate.id === paneId)
      if (!pane) return state
      return {
        activeTabId: pane.tabId,
        activePaneId: paneId,
        tabs: rememberTabPane(state.tabs, pane.tabId, paneId),
        workspaces: rememberWorkspaceTab(
          state.workspaces,
          state.tabs.find((tab) => tab.id === pane.tabId)!,
        ),
        graphRev: bumpRev(state),
      }
    })
  },

  selectPaneByDirection(direction) {
    const state = get()
    const tab = state.tabs.find((candidate) => candidate.id === state.activeTabId)
    if (!tab || !state.activePaneId) return
    const next = findPaneInDirection(tab.layout, state.activePaneId, direction)
    if (next) get().selectPane(next)
  },

  restartPaneSession(paneId) {
    set((state) => ({
      panes: state.panes.map((pane) =>
        pane.id === paneId ? { ...pane, lastSessionId: createId('session') } : pane,
      ),
      graphRev: bumpRev(state),
    }))
  },

  setPaneTitle(paneId, title) {
    const normalized = sanitizeTerminalTitle(title)
    if (!normalized) return
    set((state) => {
      const panes = state.panes.map((pane) =>
        pane.id === paneId ? { ...pane, name: normalized } : pane,
      )
      const pane = panes.find((candidate) => candidate.id === paneId)
      if (!pane) return state
      const tabs = state.tabs.map((tab) => {
        if (tab.id !== pane.tabId) return tab
        if (getFirstPaneId(tab.layout) !== paneId) return tab
        return extensionRecord(tab.extensions).tauManualName ? tab : { ...tab, name: normalized }
      })
      return { panes, tabs, graphRev: bumpRev(state) }
    })
  },

  renameTab(tabId, name) {
    const normalized = sanitizeTerminalTitle(name)
    set((state) => ({
      tabs: state.tabs.map((tab) => {
        if (tab.id !== tabId) return tab
        const extensions = { ...extensionRecord(tab.extensions) }
        if (normalized) extensions.tauManualName = normalized
        else delete extensions.tauManualName
        return { ...tab, name: normalized ?? 'Shell', extensions }
      }),
      graphRev: bumpRev(state),
    }))
  },

  splitPane(paneId, direction) {
    set((state) => {
      const pane = state.panes.find((candidate) => candidate.id === paneId)
      if (!pane) return state
      const tab = state.tabs.find((candidate) => candidate.id === pane.tabId)
      if (!tab) return state
      const nextPane = createTerminalPane(tab.id)
      const layout = splitLayoutNode(tab.layout, paneId, nextPane.id, direction)
      return {
        panes: [...state.panes, nextPane],
        tabs: state.tabs.map((candidate) =>
          candidate.id === tab.id
            ? { ...candidate, layout, lastActivePaneId: nextPane.id }
            : candidate,
        ),
        activeTabId: tab.id,
        activePaneId: nextPane.id,
        graphRev: bumpRev(state),
      }
    })
  },

  splitActivePane(direction) {
    const { activePaneId } = get()
    if (activePaneId) get().splitPane(activePaneId, direction)
  },

  closePane(paneId) {
    set((state) => {
      const pane = state.panes.find((candidate) => candidate.id === paneId)
      if (!pane) return state
      const tab = state.tabs.find((candidate) => candidate.id === pane.tabId)
      if (!tab) return state

      const result = removePaneFromLayout(tab.layout, paneId)
      if (!result.removed) return state

      if (!result.layout) {
        get().closeTab(tab.id)
        return get()
      }

      const removedIds = new Set(
        getPaneIdsInLayout(tab.layout).filter(
          (id) => !getPaneIdsInLayout(result.layout!).includes(id),
        ),
      )
      const nextPanes = state.panes.filter((candidate) => !removedIds.has(candidate.id))
      const nextActivePaneId =
        result.replacementPaneId ??
        (state.activePaneId && !removedIds.has(state.activePaneId)
          ? state.activePaneId
          : getFirstPaneId(result.layout))

      return {
        panes: nextPanes,
        tabs: state.tabs.map((candidate) =>
          candidate.id === tab.id
            ? {
                ...candidate,
                layout: result.layout!,
                lastActivePaneId: nextActivePaneId ?? undefined,
              }
            : candidate,
        ),
        activePaneId: nextActivePaneId,
        graphRev: bumpRev(state),
      }
    })
  },

  closeActivePane() {
    const { activePaneId } = get()
    if (activePaneId) get().closePane(activePaneId)
  },
}))

export function selectMuxGraphSnapshot(state: TauState): MuxGraphSnapshot {
  return {
    schemaVersion: 1,
    graphRev: state.graphRev,
    eventSeq: state.eventSeq,
    tabs: state.tabs.map((tab) => ({
      id: tab.id,
      name: tab.name,
      order: tab.order,
      root: tab.layout,
      activePaneId: tab.lastActivePaneId,
      extensions: { ...extensionRecord(tab.extensions), tauWorkspaceId: tab.workspaceId },
    })),
    panes: state.panes.map((pane) => ({
      id: pane.id,
      terminalId: pane.terminalId,
      tabId: pane.tabId,
      type: 'terminal' as const,
      name: pane.name,
      cwd: pane.cwd,
      argv: pane.argv,
      sessionId: pane.lastSessionId,
      extensions: pane.extensions,
    })),
    activeTabId: state.activeTabId,
    activePaneId: state.activePaneId,
    extensions: { ...extensionRecord(state.graphExtensions), tauWorkspaces: state.workspaces },
  }
}

/** Legacy export used only by migration tests; daemon mux graph is authoritative. */
export function selectPaneLayoutData(state: TauState): PaneLayoutData {
  return {
    version: PANE_LAYOUT_VERSION,
    tabs: state.tabs.map((tab) => ({
      id: tab.id,
      name: tab.name,
      layout: tab.layout,
      lastActivePaneId: tab.lastActivePaneId,
      order: tab.order,
    })),
    panes: state.panes.map((pane) => ({
      id: pane.id,
      terminalId: pane.terminalId,
      tabId: pane.tabId,
      type: 'terminal' as const,
      name: pane.name,
      cwd: pane.cwd,
      argv: pane.argv,
      lastSessionId: pane.lastSessionId,
    })),
    activeTabId: state.activeTabId,
    activePaneId: state.activePaneId,
    graphRev: state.graphRev,
  }
}

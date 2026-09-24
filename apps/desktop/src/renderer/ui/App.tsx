import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { defaultSettings } from '@tau/shared/preferences'
import type { SettingsData } from '@tau/shared/session'
import type { AppCommand } from '@tau/shared/app-command'
import type {
  TaudLifecycleDiagnostics,
  TaudLifecycleRecoveryAction,
} from '@tau/shared/taud-protocol'
import { sanitizeTerminalTitle } from '../osc-title'
import { disposeTerminalRuntime } from '../terminal'
import { markRendererEvent } from '../trace'
import {
  getFirstPaneId,
  isSplitNode,
  isTabsNode,
  splitPercentagesForLayout,
  type MosaicLayoutNode,
} from '../state/layout'
import { startGraphSync } from '../state/graph-sync'
import { useTau } from '../state/solid'
import { useTauStore, type Pane, type Tab, type Workspace } from '../state/store'
import { TerminalPane } from './TerminalPane'
import { SettingsPage } from './SettingsPage'

function PaneLeaf(props: {
  pane: Pane | undefined
  active: string | null
  focus: Record<string, number>
  search: Record<string, number>
  onSelect(id: string): void
  onTitle(id: string, title: string): void
  onProcessTitle(id: string, title: string): void
  onRestart(id: string): void
}) {
  return (
    <Show keyed when={props.pane?.lastSessionId ?? props.pane?.id}>
      {(sessionId) => (
        <div
          classList={{ 'pane-tile': true, 'pane-tile-active': props.pane?.id === props.active }}
          data-pane-id={props.pane?.id}
          onPointerDown={() => {
            const id = props.pane?.id
            if (id) props.onSelect(id)
          }}
        >
          <TerminalPane
            sessionId={sessionId}
            terminalId={props.pane?.terminalId}
            cwd={props.pane?.cwd}
            argv={props.pane?.argv}
            isActive={props.pane?.id === props.active}
            focusToken={props.focus[props.pane?.id ?? ''] ?? 0}
            searchToken={props.search[props.pane?.id ?? ''] ?? 0}
            onTitleChange={(title) => {
              const id = props.pane?.id
              if (id) props.onTitle(id, title)
            }}
            onProcessTitleChange={(title) => {
              const id = props.pane?.id
              if (id) props.onProcessTitle(id, title)
            }}
            onRestartSession={() => {
              const id = props.pane?.id
              if (id) props.onRestart(id)
            }}
          />
        </div>
      )}
    </Show>
  )
}

function PaneTree(props: {
  node: MosaicLayoutNode
  panes: Map<string, Pane>
  active: string | null
  focus: Record<string, number>
  search: Record<string, number>
  onSelect(id: string): void
  onTitle(id: string, title: string): void
  onProcessTitle(id: string, title: string): void
  onRestart(id: string): void
  onResize(node: MosaicLayoutNode): void
}) {
  let container: HTMLDivElement | undefined
  const [draft, setDraft] = createSignal<number[] | null>(null)
  const split = () => (isSplitNode(props.node) ? props.node : null)
  const percentages = () => draft() ?? (split() ? splitPercentagesForLayout(split()!) : [])
  const resize = (index: number, event: PointerEvent) => {
    const node = split()
    if (!node || !container) return
    event.preventDefault()
    const bounds = container.getBoundingClientRect()
    const vertical = node.direction === 'column'
    const size = vertical ? bounds.height : bounds.width
    if (!size) return
    const initial = splitPercentagesForLayout(node)
    const start = vertical ? event.clientY : event.clientX
    const begin = [...initial]
    const move = (moveEvent: PointerEvent) => {
      const delta = (((vertical ? moveEvent.clientY : moveEvent.clientX) - start) / size) * 100
      const bounded = Math.max(
        18,
        Math.min(begin[index]! + begin[index + 1]! - 18, begin[index]! + delta),
      )
      const next = [...begin]
      next[index] = bounded
      next[index + 1] = begin[index]! + begin[index + 1]! - bounded
      setDraft(next)
    }
    const end = (upEvent: PointerEvent) => {
      move(upEvent)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      const next = draft()
      setDraft(null)
      if (next) props.onResize({ ...node, splitPercentages: next })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  return (
    <Show
      when={split()}
      fallback={
        <Show
          when={isTabsNode(props.node) ? props.node : null}
          fallback={
            <PaneLeaf
              pane={props.panes.get(props.node as string)}
              active={props.active}
              focus={props.focus}
              search={props.search}
              onSelect={props.onSelect}
              onTitle={props.onTitle}
              onProcessTitle={props.onProcessTitle}
              onRestart={props.onRestart}
            />
          }
        >
          {(tabs) => (
            <div class="nested-tabs">
              <div class="nested-tabbar" role="tablist" aria-label="Pane tabs">
                <For each={tabs().tabs}>
                  {(id, index) => (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={index() === tabs().activeTabIndex}
                      classList={{
                        'nested-tab': true,
                        selected: index() === tabs().activeTabIndex,
                      }}
                      onClick={() => {
                        props.onResize({ ...tabs(), activeTabIndex: index() })
                        props.onSelect(id)
                      }}
                    >
                      {props.panes.get(id)?.name ?? 'Terminal'}
                    </button>
                  )}
                </For>
              </div>
              <div class="nested-tab-content">
                <PaneLeaf
                  pane={props.panes.get(tabs().tabs[tabs().activeTabIndex] ?? '')}
                  active={props.active}
                  focus={props.focus}
                  search={props.search}
                  onSelect={props.onSelect}
                  onTitle={props.onTitle}
                  onProcessTitle={props.onProcessTitle}
                  onRestart={props.onRestart}
                />
              </div>
            </div>
          )}
        </Show>
      }
    >
      {(node) => (
        <div
          class="split-layout"
          classList={{ 'split-column': node().direction === 'column' }}
          ref={(element) => {
            container = element
          }}
        >
          <For each={node().children}>
            {(child, index) => (
              <>
                <div
                  class="split-child"
                  style={{ 'flex-basis': `${percentages()[index()] ?? 50}%` }}
                >
                  <PaneTree
                    node={child}
                    panes={props.panes}
                    active={props.active}
                    focus={props.focus}
                    search={props.search}
                    onSelect={props.onSelect}
                    onTitle={props.onTitle}
                    onProcessTitle={props.onProcessTitle}
                    onRestart={props.onRestart}
                    onResize={(updated) => {
                      const current = split()
                      if (!current) return
                      props.onResize({
                        ...current,
                        children: current.children.map((entry, i) =>
                          i === index() ? updated : entry,
                        ),
                      })
                    }}
                  />
                </div>
                <Show when={index() < node().children.length - 1}>
                  <hr
                    class="split-handle"
                    aria-label="Resize split"
                    onPointerDown={(event) => resize(index(), event)}
                  />
                </Show>
              </>
            )}
          </For>
        </div>
      )}
    </Show>
  )
}

export function App() {
  const isMac = navigator.platform.startsWith('Mac')
  document.documentElement.dataset.platform = isMac ? 'macos' : 'other'
  const tabs = useTau((state) => state.tabs)
  const workspaces = useTau((state) => state.workspaces)
  const panes = useTau((state) => state.panes)
  const activeTabId = useTau((state) => state.activeTabId)
  const activePaneId = useTau((state) => state.activePaneId)
  const sorted = createMemo(() => [...tabs()].sort((a, b) => a.order - b.order))
  const byId = createMemo(() => new Map(panes().map((pane) => [pane.id, pane])))
  const activeTab = createMemo(
    () => sorted().find((tab) => tab.id === activeTabId()) ?? sorted()[0],
  )
  const activeWorkspaceId = createMemo(() => activeTab()?.workspaceId)
  const workspaceTabs = createMemo(() =>
    sorted().filter((tab) => tab.workspaceId === activeWorkspaceId()),
  )
  const [loaded, setLoaded] = createSignal(false)
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  const [settingsSearchFocus, setSettingsSearchFocus] = createSignal(0)
  const [sidebarWidth, setSidebarWidth] = createSignal(196)
  const [editingWorkspace, setEditingWorkspace] = createSignal<string | null>(null)
  const [editingTab, setEditingTab] = createSignal<string | null>(null)
  const [processTitles, setProcessTitles] = createSignal<Record<string, string>>({})
  const [settings, setSettings] = createSignal<SettingsData>(defaultSettings)
  const systemColors = window.matchMedia('(prefers-color-scheme: dark)')
  const tabTitle = (tab: Tab) => {
    const extensions = tab.extensions as Record<string, unknown> | undefined
    if (typeof extensions?.tauManualName === 'string') return extensions.tauManualName
    const id = tab.lastActivePaneId ?? getFirstPaneId(tab.layout)
    return (
      sanitizeTerminalTitle(
        id ? (processTitles()[id] ?? byId().get(id)?.name ?? tab.name) : tab.name,
      ) ?? tab.name
    )
  }
  const [focus, setFocus] = createSignal<Record<string, number>>({})
  const [search, setSearch] = createSignal<Record<string, number>>({})
  const [diagnostics, setDiagnostics] = createSignal<TaudLifecycleDiagnostics | null>(null)
  const [recoverError, setRecoverError] = createSignal('')
  const [recovering, setRecovering] = createSignal(false)
  let previous = new Map<string, string>()

  const saveSidebarWidth = (width: number) => {
    try {
      window.localStorage.setItem('sidebar-width', String(width))
    } catch {
      // Resizing still works when browser storage is unavailable.
    }
  }
  const resizeSidebar = (event: PointerEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    const start = event.clientX
    const initial = sidebarWidth()
    const move = (pointer: PointerEvent) => {
      setSidebarWidth(
        Math.round(
          Math.max(
            156,
            Math.min(Math.min(360, window.innerWidth - 320), initial + pointer.clientX - start),
          ),
        ),
      )
    }
    const end = (pointer: PointerEvent) => {
      move(pointer)
      saveSidebarWidth(sidebarWidth())
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }
  const closeWorkspace = (workspace: Workspace) => {
    if (
      settings().behavior?.confirmClose &&
      !window.confirm(`Close ${workspace.name}? Sessions stay available for recovery.`)
    )
      return
    useTauStore.getState().closeWorkspace(workspace.id)
  }

  const applySettings = (data: SettingsData) => {
    setSettings(data)
    const appearance = data.appearance ?? defaultSettings.appearance!
    const theme =
      appearance.theme === 'system' ? (systemColors.matches ? 'dark' : 'light') : appearance.theme
    document.documentElement.dataset.theme =
      theme === 'midnight' || theme === 'slate' ? 'dark' : theme
    document.documentElement.dataset.accent = appearance.accent
    for (const key of ['chrome', 'sidebar', 'accent', 'text'] as const) {
      const color = appearance.customColors?.[key]
      if (color) document.documentElement.style.setProperty(`--${key}`, color)
      else document.documentElement.style.removeProperty(`--${key}`)
    }
    document.documentElement.style.setProperty(
      '--terminal-font-size',
      `${data.terminal?.fontSize ?? 14}px`,
    )
    document.documentElement.style.setProperty(
      '--terminal-font-family',
      data.terminal?.fontFamily ?? 'monospace',
    )
    window.dispatchEvent(new Event('tau:appearance'))
  }
  const saveSettings = async (data: SettingsData) => {
    const old = settings()
    applySettings(data)
    try {
      await window.electronAPI.writeSettings(data)
    } catch (error) {
      applySettings(old)
      throw error
    }
  }
  const closeTab = (id: string) => {
    if (
      settings().behavior?.confirmClose &&
      !window.confirm('Close this tab? Sessions stay available for recovery.')
    )
      return
    useTauStore.getState().closeTab(id)
  }
  const closePane = () => {
    if (
      settings().behavior?.confirmClose &&
      !window.confirm('Close this pane? Sessions stay available for recovery.')
    )
      return
    useTauStore.getState().closeActivePane()
  }
  const runCommand = (command: AppCommand) => {
    const state = useTauStore.getState()
    switch (command.type) {
      case 'new-tab':
        setSettingsOpen(false)
        state.newTab()
        break
      case 'close-tab':
        if (state.activeTabId) closeTab(state.activeTabId)
        break
      case 'close-pane':
        closePane()
        break
      case 'split-pane-vertical':
        state.splitActivePane('row')
        break
      case 'split-pane-horizontal':
        state.splitActivePane('column')
        break
      case 'switch-tab':
        setSettingsOpen(false)
        state.selectTabByIndex(command.index)
        break
      case 'cycle-tab': {
        setSettingsOpen(false)
        const current = state.tabs.find((tab) => tab.id === state.activeTabId)
        if (!current) break
        const inWorkspace = state.tabs
          .filter((tab) => tab.workspaceId === current.workspaceId)
          .sort((a, b) => a.order - b.order)
        const index = inWorkspace.findIndex((tab) => tab.id === current.id)
        const next =
          inWorkspace[(index + command.direction + inWorkspace.length) % inWorkspace.length]
        if (next) state.selectTab(next.id)
        break
      }
      case 'focus-pane':
        state.selectPaneByDirection(command.direction)
        break
      case 'focus-terminal': {
        if (state.activePaneId)
          setFocus((value) => ({
            ...value,
            [state.activePaneId!]: (value[state.activePaneId!] ?? 0) + 1,
          }))
        break
      }
      case 'search-terminal': {
        if (settingsOpen()) {
          setSettingsSearchFocus((value) => value + 1)
          break
        }
        if (state.activePaneId)
          setSearch((value) => ({
            ...value,
            [state.activePaneId!]: (value[state.activePaneId!] ?? 0) + 1,
          }))
        break
      }
      case 'open-settings':
        setSettingsOpen(true)
        break
    }
  }
  onMount(() => {
    const onSystemColorsChange = () => {
      if (settings().appearance?.theme === 'system') applySettings(settings())
    }
    systemColors.addEventListener('change', onSystemColorsChange)
    try {
      const savedWidth = Number(window.localStorage.getItem('sidebar-width'))
      if (Number.isFinite(savedWidth) && savedWidth >= 156 && savedWidth <= 360)
        setSidebarWidth(savedWidth)
    } catch {
      // A blocked storage backend must not prevent terminal startup.
    }
    markRendererEvent('ui:app-mounted')
    const stopGraph = startGraphSync(() => setLoaded(true))
    const stopCommands = window.electronAPI.onAppCommand(runCommand)
    void window.electronAPI
      .readSettings()
      .then((value) => applySettings(value ?? defaultSettings))
      .catch((error) => console.warn('[settings]', error))
    onCleanup(() => {
      systemColors.removeEventListener('change', onSystemColorsChange)
      stopGraph()
      stopCommands()
    })
  })
  createEffect(() => {
    if (!loaded()) return
    const frame = requestAnimationFrame(() => {
      void window.electronAPI.signalReady()
    })
    onCleanup(() => cancelAnimationFrame(frame))
  })
  createEffect(() => {
    document.title = activeTab() ? tabTitle(activeTab()!) : 'Terminal'
  })
  createEffect(() => {
    if (!loaded()) return
    const next = new Map(panes().map((pane) => [pane.id, pane.lastSessionId ?? pane.id]))
    for (const [id, session] of previous) if (!next.has(id)) disposeTerminalRuntime(session)
    if ([...previous.keys()].some((id) => !next.has(id))) {
      setProcessTitles((titles) =>
        Object.fromEntries(Object.entries(titles).filter(([id]) => next.has(id))),
      )
    }
    previous = next
  })
  createEffect(() => {
    if (!settingsOpen()) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancelled = false
    const refresh = async () => {
      try {
        const value = await window.electronAPI.getTaudDiagnostics()
        if (!cancelled) setDiagnostics(value)
      } catch (error) {
        if (!cancelled) setRecoverError(String(error))
      }
      if (!cancelled) timer = setTimeout(refresh, 5000)
    }
    void refresh()
    onCleanup(() => {
      cancelled = true
      if (timer) clearTimeout(timer)
    })
  })
  const recover = async (action: TaudLifecycleRecoveryAction) => {
    setRecovering(true)
    setRecoverError('')
    try {
      setDiagnostics(await window.electronAPI.recoverTaud(action))
    } catch (error) {
      setRecoverError(String(error))
    } finally {
      setRecovering(false)
    }
  }
  return (
    <div
      class="tau-shell"
      classList={{
        'sidebar-hidden': settings().appearance?.sidebar === false,
        'settings-open': settingsOpen(),
        macos: isMac,
      }}
    >
      <Show when={loaded()}>
        <aside
          class="sidebar drag-region"
          aria-label="Workspaces"
          style={{ '--sidebar-width': `${sidebarWidth()}px` }}
        >
          <div class="sidebar-header">
            <span>Workspaces</span>
            <button
              type="button"
              class="sidebar-add no-drag"
              aria-label="New workspace"
              title="New workspace"
              onClick={() => useTauStore.getState().newWorkspace()}
            >
              +
            </button>
          </div>
          <nav class="sidebar-tabs" aria-label="Workspaces">
            <For each={workspaces()}>
              {(workspace) => (
                <div
                  class="sidebar-tab"
                  classList={{ selected: workspace.id === activeWorkspaceId() }}
                >
                  <Show
                    when={editingWorkspace() === workspace.id}
                    fallback={
                      <button
                        type="button"
                        class="sidebar-tab-select"
                        aria-current={workspace.id === activeWorkspaceId() ? 'page' : undefined}
                        title={`${workspace.name} · Double-click to rename`}
                        onClick={() => {
                          setSettingsOpen(false)
                          useTauStore.getState().selectWorkspace(workspace.id)
                        }}
                        onDblClick={() => setEditingWorkspace(workspace.id)}
                      >
                        <span class="truncate">{workspace.name}</span>
                      </button>
                    }
                  >
                    <input
                      class="workspace-name-input no-drag"
                      aria-label="Workspace name"
                      value={workspace.name}
                      ref={(element) =>
                        queueMicrotask(() => {
                          element.focus()
                          element.select()
                        })
                      }
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          useTauStore
                            .getState()
                            .renameWorkspace(workspace.id, event.currentTarget.value)
                          setEditingWorkspace(null)
                        } else if (event.key === 'Escape') setEditingWorkspace(null)
                      }}
                      onBlur={(event) => {
                        if (editingWorkspace() !== workspace.id) return
                        useTauStore
                          .getState()
                          .renameWorkspace(workspace.id, event.currentTarget.value)
                        setEditingWorkspace(null)
                      }}
                    />
                  </Show>
                  <button
                    type="button"
                    class="sidebar-tab-close"
                    aria-label={`Close ${workspace.name}`}
                    onClick={() => closeWorkspace(workspace)}
                  >
                    ×
                  </button>
                </div>
              )}
            </For>
          </nav>
          <div class="sidebar-footer">
            <button
              type="button"
              class="sidebar-footer-button"
              onClick={() => setSettingsOpen(true)}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <circle cx="10" cy="10" r="3" />
                <path d="M10 1.8v2M10 16.2v2M1.8 10h2M16.2 10h2M4.2 4.2l1.4 1.4m8.8 8.8 1.4 1.4m0-11.6-1.4 1.4m-8.8 8.8-1.4 1.4" />
              </svg>
              Settings
            </button>
          </div>
        </aside>
        <button
          type="button"
          class="sidebar-resize no-drag"
          aria-label={`Resize sidebar, ${sidebarWidth()} pixels`}
          title="Drag to resize sidebar"
          onPointerDown={resizeSidebar}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            const step = event.shiftKey ? 20 : 10
            const delta = event.key === 'ArrowLeft' ? -step : step
            const width = Math.max(156, Math.min(360, sidebarWidth() + delta))
            setSidebarWidth(width)
            saveSidebarWidth(width)
          }}
        />
        <section class="workspace">
          <header class="topbar drag-region">
            <button
              type="button"
              class="topbar-icon no-drag"
              aria-label="Toggle sidebar"
              title="Toggle sidebar"
              onClick={() =>
                void saveSettings({
                  ...settings(),
                  appearance: {
                    ...settings().appearance!,
                    sidebar: !settings().appearance?.sidebar,
                  },
                })
              }
            >
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <rect x="2" y="3" width="16" height="14" rx="2" />
                <path d="M7 3v14" />
              </svg>
            </button>
            <nav class="topbar-tabstrip no-drag" aria-label="Terminal tabs">
              <For each={workspaceTabs()}>
                {(tab) => (
                  <div class="topbar-tab" classList={{ selected: tab.id === activeTabId() }}>
                    <Show
                      when={editingTab() === tab.id}
                      fallback={
                        <button
                          type="button"
                          class="topbar-tab-select"
                          aria-current={tab.id === activeTabId() ? 'page' : undefined}
                          title={`${tabTitle(tab)} · Double-click to rename`}
                          onClick={() => {
                            setSettingsOpen(false)
                            useTauStore.getState().selectTab(tab.id)
                          }}
                          onDblClick={() => setEditingTab(tab.id)}
                        >
                          {tabTitle(tab)}
                        </button>
                      }
                    >
                      <input
                        class="topbar-tab-name-input"
                        aria-label="Tab name; clear for automatic naming"
                        value={tabTitle(tab)}
                        ref={(element) =>
                          queueMicrotask(() => {
                            element.focus()
                            element.select()
                          })
                        }
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            useTauStore.getState().renameTab(tab.id, event.currentTarget.value)
                            setEditingTab(null)
                          } else if (event.key === 'Escape') setEditingTab(null)
                        }}
                        onBlur={(event) => {
                          if (editingTab() !== tab.id) return
                          useTauStore.getState().renameTab(tab.id, event.currentTarget.value)
                          setEditingTab(null)
                        }}
                      />
                    </Show>
                    <button
                      type="button"
                      class="topbar-tab-close"
                      aria-label={`Close ${tab.name}`}
                      onClick={() => closeTab(tab.id)}
                    >
                      ×
                    </button>
                  </div>
                )}
              </For>
              <button
                type="button"
                class="topbar-tab-add"
                aria-label="New tab"
                title="New tab"
                onClick={() => useTauStore.getState().newTab()}
              >
                +
              </button>
            </nav>
            <div class="topbar-actions no-drag">
              <button
                type="button"
                title="Split right"
                aria-label="Split right"
                onClick={() => useTauStore.getState().splitActivePane('row')}
              >
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <rect x="2" y="3" width="16" height="14" rx="2" />
                  <path d="M10 3v14" />
                </svg>
              </button>
              <button
                type="button"
                title="Split down"
                aria-label="Split down"
                onClick={() => useTauStore.getState().splitActivePane('column')}
              >
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <rect x="2" y="3" width="16" height="14" rx="2" />
                  <path d="M2 10h16" />
                </svg>
              </button>
              <button
                type="button"
                class="topbar-settings"
                title="Settings"
                aria-label="Settings"
                onClick={() => setSettingsOpen(true)}
              >
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <circle cx="10" cy="10" r="3" />
                  <path d="M10 1.8v2M10 16.2v2M1.8 10h2M16.2 10h2M4.2 4.2l1.4 1.4m8.8 8.8 1.4 1.4m0-11.6-1.4 1.4m-8.8 8.8-1.4 1.4" />
                </svg>
              </button>
            </div>
          </header>
          <div class="workspace-body" style={{ display: settingsOpen() ? 'none' : '' }}>
            <Show when={activeTab()}>
              {(tab) => (
                <PaneTree
                  node={tab().layout}
                  panes={byId()}
                  active={activePaneId()}
                  focus={focus()}
                  search={search()}
                  onSelect={(id) => {
                    if (id !== useTauStore.getState().activePaneId)
                      useTauStore.getState().selectPane(id)
                  }}
                  onTitle={(id, title) => useTauStore.getState().setPaneTitle(id, title)}
                  onProcessTitle={(id, title) => {
                    const normalized = sanitizeTerminalTitle(title)
                    if (normalized)
                      setProcessTitles((current) => ({ ...current, [id]: normalized }))
                  }}
                  onRestart={(id) => {
                    setProcessTitles((titles) => {
                      const next = { ...titles }
                      delete next[id]
                      return next
                    })
                    useTauStore.getState().restartPaneSession(id)
                  }}
                  onResize={(layout) => useTauStore.getState().setTabLayout(tab().id, layout)}
                />
              )}
            </Show>
          </div>
          <Show when={settingsOpen()}>
            <SettingsPage
              settings={settings()}
              searchFocusToken={settingsSearchFocus()}
              onChange={saveSettings}
              onBack={() => setSettingsOpen(false)}
              diagnostics={diagnostics()}
              recovering={recovering()}
              recoverError={recoverError()}
              onRecover={recover}
            />
          </Show>
        </section>
      </Show>
    </div>
  )
}

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
import { useTauStore, type Pane, type Tab } from '../state/store'
import { TerminalPane } from './TerminalPane'
import { SettingsPage } from './SettingsPage'

function PaneLeaf(props: {
  pane: Pane | undefined
  active: string | null
  focus: Record<string, number>
  search: Record<string, number>
  onSelect(id: string): void
  onTitle(id: string, title: string): void
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
  const tabs = useTau((state) => state.tabs)
  const panes = useTau((state) => state.panes)
  const activeTabId = useTau((state) => state.activeTabId)
  const activePaneId = useTau((state) => state.activePaneId)
  const sorted = createMemo(() => [...tabs()].sort((a, b) => a.order - b.order))
  const byId = createMemo(() => new Map(panes().map((pane) => [pane.id, pane])))
  const activeTab = createMemo(
    () => sorted().find((tab) => tab.id === activeTabId()) ?? sorted()[0],
  )
  const [loaded, setLoaded] = createSignal(false)
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  const [settings, setSettings] = createSignal<SettingsData>(defaultSettings)
  const [focus, setFocus] = createSignal<Record<string, number>>({})
  const [search, setSearch] = createSignal<Record<string, number>>({})
  const [diagnostics, setDiagnostics] = createSignal<TaudLifecycleDiagnostics | null>(null)
  const [recoverError, setRecoverError] = createSignal('')
  const [recovering, setRecovering] = createSignal(false)
  let previous = new Map<string, string>()

  const applySettings = (data: SettingsData) => {
    setSettings(data)
    document.documentElement.dataset.theme = data.appearance?.theme ?? 'midnight'
    document.documentElement.dataset.accent = data.appearance?.accent ?? 'blue'
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
    markRendererEvent('ui:app-mounted')
    const stopGraph = startGraphSync(() => setLoaded(true))
    const stopCommands = window.electronAPI.onAppCommand(runCommand)
    void window.electronAPI
      .readSettings()
      .then((value) => applySettings(value ?? defaultSettings))
      .catch((error) => console.warn('[settings]', error))
    onCleanup(() => {
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
    document.title = activeTab() ? `${activeTab()!.name} — Tau` : 'Tau'
  })
  createEffect(() => {
    if (!loaded()) return
    const next = new Map(panes().map((pane) => [pane.id, pane.lastSessionId ?? pane.id]))
    for (const [id, session] of previous) if (!next.has(id)) disposeTerminalRuntime(session)
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
  const tabTitle = (tab: Tab) => {
    const id = getFirstPaneId(tab.layout)
    return sanitizeTerminalTitle(id ? (byId().get(id)?.name ?? tab.name) : tab.name) ?? tab.name
  }

  return (
    <div
      class="tau-shell"
      classList={{ 'sidebar-hidden': settings().appearance?.sidebar === false }}
    >
      <Show when={loaded()}>
        <aside class="sidebar glass" aria-label="Workspaces">
          <div class="sidebar-brand drag-region">
            <span class="brand-mark">τ</span>
            <span>tau</span>
            <span class="brand-caption">/ TERMINAL</span>
          </div>
          <div class="sidebar-section-title">
            WORKSPACES{' '}
            <button
              type="button"
              aria-label="New tab"
              title="New tab"
              onClick={() => useTauStore.getState().newTab()}
            >
              ＋
            </button>
          </div>
          <nav class="sidebar-tabs" aria-label="Terminal tabs">
            <For each={sorted()}>
              {(tab, index) => (
                <div class="sidebar-tab" classList={{ selected: tab.id === activeTabId() }}>
                  <button
                    type="button"
                    class="sidebar-tab-select"
                    onClick={() => {
                      setSettingsOpen(false)
                      useTauStore.getState().selectTab(tab.id)
                    }}
                  >
                    <span class="tab-index">{String(index() + 1).padStart(2, '0')}</span>
                    <span class="truncate">{tabTitle(tab)}</span>
                  </button>
                  <button
                    type="button"
                    class="sidebar-tab-close"
                    aria-label={`Close ${tab.name}`}
                    onClick={() => closeTab(tab.id)}
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
              ⚙ <span>Settings</span>
              <span class="sidebar-footer-hint">⌘ ,</span>
            </button>
          </div>
        </aside>
        <section class="workspace">
          <header class="topbar glass drag-region">
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
              ☷
            </button>
            <span class="topbar-divider" />
            <span class="topbar-location">WORKSPACE</span>
            <span class="topbar-chevron">/</span>
            <strong class="topbar-title">
              {activeTab() ? tabTitle(activeTab()!) : 'Terminal'}
            </strong>
            <div class="topbar-actions no-drag">
              <button
                type="button"
                title="Split right"
                aria-label="Split right"
                onClick={() => useTauStore.getState().splitActivePane('row')}
              >
                ◫
              </button>
              <button
                type="button"
                title="Split down"
                aria-label="Split down"
                onClick={() => useTauStore.getState().splitActivePane('column')}
              >
                ⊟
              </button>
              <button
                type="button"
                title="New tab"
                aria-label="New tab"
                onClick={() => useTauStore.getState().newTab()}
              >
                ＋
              </button>
              <button
                type="button"
                title="Settings"
                aria-label="Settings"
                onClick={() => setSettingsOpen(true)}
              >
                ⚙
              </button>
            </div>
          </header>
          <div class="workspace-body" style={{ display: settingsOpen() ? 'none' : '' }}>
            <Show when={activeTab()}>
              {(tab) => (
                <div class="pane-frame">
                  <div class="pane-header">
                    <span class="live-dot" />{' '}
                    <span class="pane-header-label">{tabTitle(tab())}</span>
                    <span class="pane-header-spacer" />
                    <span class="pane-header-meta">SHELL · LIVE</span>
                  </div>
                  <div class="pane-content">
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
                      onRestart={(id) => useTauStore.getState().restartPaneSession(id)}
                      onResize={(layout) => useTauStore.getState().setTabLayout(tab().id, layout)}
                    />
                  </div>
                </div>
              )}
            </Show>
          </div>
          <Show when={settingsOpen()}>
            <SettingsPage
              settings={settings()}
              onChange={saveSettings}
              onBack={() => setSettingsOpen(false)}
              diagnostics={diagnostics()}
              recovering={recovering()}
              recoverError={recoverError()}
              onRecover={recover}
            />
          </Show>
          <footer class="statusbar glass">
            <span class="live-dot" /> <span>TAUD {diagnostics()?.state ?? 'CONNECTED'}</span>
            <span class="statusbar-spacer" />
            <span>
              {panes().length} PANE{panes().length === 1 ? '' : 'S'}
            </span>
            <span class="statusbar-key">⌘ ,</span>
            <span>SETTINGS</span>
          </footer>
        </section>
      </Show>
    </div>
  )
}

import { type ComponentType, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Mosaic, type MosaicNode, type MosaicProps } from 'react-mosaic-component'
import 'react-mosaic-component/react-mosaic-component.css'
import type { AppCommand } from '@tau/shared/app-command'
import type { TaudLifecycleDiagnostics, TaudLifecycleRecoveryAction } from '@tau/shared/taud-protocol'
import { sanitizeTerminalTitle } from '../osc-title'
import { disposeTerminalRuntime } from '../terminal'
import { markRendererEvent } from '../trace'
import { getFirstPaneId, type MosaicLayoutNode } from '../state/layout'
import { selectMuxGraphSnapshot, useTauStore, type Pane, type Tab } from '../state/store'
import { TerminalPane } from './TerminalPane'

type TerminalPreloadDiagnostics = ReturnType<Window['electronAPI']['getTerminalPreloadDiagnostics']>
type TaudPtyBridgeDiagnostics = Awaited<
  ReturnType<Window['electronAPI']['getTaudPtyBridgeDiagnostics']>
>

const MosaicView = Mosaic as unknown as ComponentType<MosaicProps<string>>

type DaemonRecoveryNotice = {
  level: 'info' | 'warning' | 'error'
  title: string
  detail?: string
}

function daemonRecoveryNotice(
  diagnostics: TaudLifecycleDiagnostics | null,
  error: string | null,
): DaemonRecoveryNotice | null {
  if (error) {
    return { level: 'error', title: 'Daemon diagnostics unavailable', detail: error }
  }
  if (!diagnostics) return null
  if (diagnostics.state === 'owned-live' || diagnostics.state === 'external-live') {
    if (diagnostics.recoveryAction === 'none') return null
  }
  if (diagnostics.state === 'version-mismatch') {
    return {
      level: 'error',
      title: 'Daemon protocol mismatch',
      detail: diagnostics.lastReason ?? diagnostics.lastError,
    }
  }
  if (diagnostics.state === 'crashed' || diagnostics.state === 'stale-socket') {
    return {
      level: 'warning',
      title: 'Daemon needs recovery',
      detail: diagnostics.lastReason ?? diagnostics.lastError,
    }
  }
  if (diagnostics.state === 'starting' || diagnostics.state === 'absent') {
    return {
      level: 'info',
      title: 'Starting terminal daemon…',
      detail: diagnostics.lastReason,
    }
  }
  return null
}

function recoveryActionLabel(action: TaudLifecycleRecoveryAction): string | null {
  switch (action) {
    case 'start-daemon':
      return 'Start daemon'
    case 'clear-stale-socket-and-start':
      return 'Clear stale socket'
    case 'restart-owned-daemon':
      return 'Restart daemon'
    case 'replace-incompatible-daemon':
      return 'Replace daemon'
    case 'reuse-external-daemon':
      return 'Reuse daemon'
    default:
      return null
  }
}

const SettingsPage = memo(function SettingsPage({ onBack }: { onBack(): void }) {
  return (
    <section className="settings-page" aria-label="Settings">
      <div className="settings-titlebar" aria-hidden="true" />
      <aside className="settings-nav" aria-label="Settings navigation">
        <button type="button" className="settings-back-link" onClick={onBack}>
          <span aria-hidden="true">←</span>
          <span>Back to app</span>
        </button>
        <nav className="settings-nav-list" aria-label="Settings sections">
          <div className="settings-nav-current" aria-current="page">
            General
          </div>
        </nav>
      </aside>
      <main className="settings-main">
        <div className="settings-main-inner">
          <header className="settings-main-header">
            <h1>General</h1>
            <p className="settings-muted">
              Appearance, terminal, multiplexer, keybindings, and extensions settings land in Phase
              3.
            </p>
          </header>
        </div>
      </main>
    </section>
  )
})

const DaemonRecoveryIndicator = memo(function DaemonRecoveryIndicator({
  notice,
  diagnostics,
  isRecovering,
  recoveryError,
  onRecover,
}: {
  notice: DaemonRecoveryNotice | null
  diagnostics: TaudLifecycleDiagnostics | null
  isRecovering: boolean
  recoveryError: string | null
  onRecover(action: TaudLifecycleRecoveryAction): void
}) {
  if (!notice) return null
  const action = diagnostics?.recoveryAction ?? 'none'
  const label = recoveryActionLabel(action)

  return (
    <output className={`daemon-recovery-host daemon-recovery-panel-${notice.level}`}>
      <div className="daemon-recovery-panel-header">
        <strong>{notice.title}</strong>
        {notice.detail ? <span>{notice.detail}</span> : null}
      </div>
      {recoveryError ? <div className="daemon-recovery-panel-value-error">{recoveryError}</div> : null}
      {label && action !== 'none' ? (
        <button
          type="button"
          className="daemon-recovery-action-button"
          disabled={isRecovering}
          onClick={() => onRecover(action)}
        >
          {isRecovering ? 'Working…' : label}
        </button>
      ) : null}
    </output>
  )
})

const TabBar = memo(function TabBar({
  tabs,
  activeTabId,
  labels,
  onSelect,
  onClose,
  onNew,
  onOpenSettings,
}: {
  tabs: readonly Tab[]
  activeTabId: string | null
  labels: ReadonlyMap<string, string>
  onSelect(tabId: string): void
  onClose(tabId: string): void
  onNew(): void
  onOpenSettings(): void
}) {
  return (
    <div className="tab-bar thread-titlebar" role="tablist" aria-label="Terminal tabs">
      <div className="tab-bar-tabs">
        {tabs.map((tab) => {
          const selected = tab.id === activeTabId
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              className={selected ? 'tab-chip tab-chip-active' : 'tab-chip'}
              onClick={() => onSelect(tab.id)}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault()
                  onClose(tab.id)
                }
              }}
            >
              <span className="tab-chip-label">{labels.get(tab.id) ?? tab.name}</span>
              <button
                type="button"
                className="tab-chip-close"
                aria-label={`Close ${tab.name}`}
                onClick={(event) => {
                  event.stopPropagation()
                  onClose(tab.id)
                }}
              >
                ×
              </button>
            </button>
          )
        })}
      </div>
      <div className="tab-bar-actions">
        <button type="button" className="icon-button" aria-label="New tab" title="New tab" onClick={onNew}>
          +
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Settings"
          title="Settings"
          onClick={onOpenSettings}
        >
          ⚙
        </button>
      </div>
    </div>
  )
})

const PaneTile = memo(function PaneTile({
  pane,
  isActive,
  focusToken,
  searchToken,
  onSelect,
  onTitleChange,
  onRestartSession,
}: {
  pane: Pane
  isActive: boolean
  focusToken: number
  searchToken: number
  onSelect(): void
  onTitleChange(title: string): void
  onRestartSession(): void
}) {
  return (
    <div
      className={isActive ? 'pane-tile pane-tile-active' : 'pane-tile'}
      data-pane-id={pane.id}
      onPointerDown={(event) => {
        if (event.target instanceof Node && event.currentTarget.contains(event.target)) onSelect()
      }}
    >
      <TerminalPane
        sessionId={pane.lastSessionId ?? pane.id}
        terminalId={pane.terminalId}
        cwd={pane.cwd}
        argv={pane.argv}
        isActive={isActive}
        focusToken={focusToken}
        searchToken={searchToken}
        onTitleChange={onTitleChange}
        onRestartSession={onRestartSession}
      />
    </div>
  )
})

const PaneGrid = memo(function PaneGrid({
  tab,
  panesById,
  activePaneId,
  terminalFocusTokens,
  terminalSearchTokens,
  onLayoutRelease,
  onSelectPane,
  onPaneTitle,
  onRestartPaneSession,
}: {
  tab: Tab
  panesById: Map<string, Pane>
  activePaneId: string | null
  terminalFocusTokens: ReadonlyMap<string, number>
  terminalSearchTokens: ReadonlyMap<string, number>
  onLayoutRelease(tabId: string, layout: MosaicLayoutNode | null): void
  onSelectPane(paneId: string): void
  onPaneTitle(paneId: string, title: string): void
  onRestartPaneSession(paneId: string): void
}) {
  const [draftLayout, setDraftLayout] = useState<MosaicLayoutNode | null>(tab.layout)

  useEffect(() => {
    setDraftLayout(tab.layout)
  }, [tab.layout])

  const handleLayoutChange = useCallback((layout: MosaicNode<string> | null) => {
    setDraftLayout(layout as MosaicLayoutNode | null)
  }, [])

  const handleLayoutRelease = useCallback(
    (layout: MosaicNode<string> | null) => {
      const next = layout as MosaicLayoutNode | null
      setDraftLayout(next)
      onLayoutRelease(tab.id, next)
    },
    [onLayoutRelease, tab.id],
  )

  const renderTile = useCallback(
    (paneId: string) => {
      const pane = panesById.get(paneId)
      if (!pane) return <div className="pane-tile pane-tile-missing" />
      return (
        <PaneTile
          pane={pane}
          isActive={pane.id === activePaneId}
          focusToken={terminalFocusTokens.get(pane.id) ?? 0}
          searchToken={terminalSearchTokens.get(pane.id) ?? 0}
          onSelect={() => onSelectPane(pane.id)}
          onTitleChange={(title) => onPaneTitle(pane.id, title)}
          onRestartSession={() => onRestartPaneSession(pane.id)}
        />
      )
    },
    [
      activePaneId,
      onPaneTitle,
      onRestartPaneSession,
      onSelectPane,
      panesById,
      terminalFocusTokens,
      terminalSearchTokens,
    ],
  )

  return (
    <div className="pane-mosaic-shell">
      <MosaicView
        value={draftLayout}
        onChange={handleLayoutChange}
        onRelease={handleLayoutRelease}
        renderTile={renderTile}
        className="tau-mosaic"
        resize={{ minimumPaneSizePercentage: 18 }}
        zeroStateView={<div className="pane-grid-empty" />}
      />
    </div>
  )
})

export function App() {
  const tabs = useTauStore((state) => state.tabs)
  const panes = useTauStore((state) => state.panes)
  const activeTabId = useTauStore((state) => state.activeTabId)
  const activePaneId = useTauStore((state) => state.activePaneId)
  const newTab = useTauStore((state) => state.newTab)
  const closeTab = useTauStore((state) => state.closeTab)
  const closeActiveTab = useTauStore((state) => state.closeActiveTab)
  const selectTab = useTauStore((state) => state.selectTab)
  const selectTabByIndex = useTauStore((state) => state.selectTabByIndex)
  const setTabLayout = useTauStore((state) => state.setTabLayout)
  const selectPane = useTauStore((state) => state.selectPane)
  const selectPaneByDirection = useTauStore((state) => state.selectPaneByDirection)
  const restartPaneSession = useTauStore((state) => state.restartPaneSession)
  const setPaneTitle = useTauStore((state) => state.setPaneTitle)
  const splitActivePane = useTauStore((state) => state.splitActivePane)
  const closeActivePane = useTauStore((state) => state.closeActivePane)
  const applyMuxGraph = useTauStore((state) => state.applyMuxGraph)
  const markMuxGraphRevision = useTauStore((state) => state.markMuxGraphRevision)

  const [layoutLoaded, setLayoutLoaded] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [terminalFocusCounts, setTerminalFocusCounts] = useState<Record<string, number>>({})
  const [terminalSearchCounts, setTerminalSearchCounts] = useState<Record<string, number>>({})
  const [taudDiagnostics, setTaudDiagnostics] = useState<TaudLifecycleDiagnostics | null>(null)
  const [taudDiagnosticsError, setTaudDiagnosticsError] = useState<string | null>(null)
  const [daemonDiagnosticsOpen, setDaemonDiagnosticsOpen] = useState(false)
  const [daemonRecoveryInFlight, setDaemonRecoveryInFlight] = useState(false)
  const [daemonRecoveryError, setDaemonRecoveryError] = useState<string | null>(null)
  const previousPaneSessionsRef = useRef<Map<string, string>>(new Map())
  const authoritativeGraphRevRef = useRef(0)
  const authoritativeEventSeqRef = useRef(0)
  /** Subscription cursor; may advance past local mutation base while submissions are in flight. */
  const subscribedEventSeqRef = useRef(0)
  const applyingGraphRef = useRef(false)
  const graphAvailableRef = useRef(false)
  const graphSubmitQueueRef = useRef<Promise<void>>(Promise.resolve())
  const pendingGraphSubmissionsRef = useRef(0)
  /** Latest local graph waiting to be pushed; coalesced across rapid UI mutations. */
  const pendingGraphCandidateRef = useRef<ReturnType<typeof selectMuxGraphSnapshot> | null>(null)
  /** Remote snapshot observed while local submissions were in flight; applied when the queue drains. */
  const deferredRemoteGraphRef = useRef<ReturnType<typeof selectMuxGraphSnapshot> | null>(null)

  useEffect(() => {
    markRendererEvent('ui:app-mounted')
  }, [])

  useEffect(() => {
    if (!layoutLoaded) return
    markRendererEvent('ui:layout-loaded')
  }, [layoutLoaded])

  useEffect(() => {
    let cancelled = false
    async function loadGraph() {
      try {
        let graph = await window.electronAPI.getMuxGraph()
        if (graph.tabs.length === 0) {
          const initial = selectMuxGraphSnapshot(useTauStore.getState())
          try {
            graph = await window.electronAPI.replaceMuxGraph(
              { ...initial, graphRev: graph.graphRev, eventSeq: graph.eventSeq },
              graph.graphRev,
            )
          } catch (error) {
            // Another window likely won the empty-graph init race. Adopt whatever is authoritative
            // instead of treating a normal revision conflict as missing graph support.
            console.warn('[mux-graph] Initial graph replace conflicted; adopting daemon snapshot:', error)
            graph = await window.electronAPI.getMuxGraph()
          }
        }
        if (cancelled) return
        authoritativeGraphRevRef.current = graph.graphRev
        authoritativeEventSeqRef.current = graph.eventSeq
        subscribedEventSeqRef.current = graph.eventSeq
        graphAvailableRef.current = true
        applyingGraphRef.current = true
        applyMuxGraph(graph)
        applyingGraphRef.current = false
      } catch (error) {
        graphAvailableRef.current = false
        console.warn('[mux-graph] Daemon lacks graph authority; using this window until it is upgraded:', error)
      } finally {
        if (!cancelled) setLayoutLoaded(true)
      }
    }
    void loadGraph()
    return () => {
      cancelled = true
    }
  }, [applyMuxGraph])

  useEffect(() => {
    if (!layoutLoaded || !graphAvailableRef.current) return
    let cancelled = false

    const applyDeferredRemoteGraph = () => {
      if (cancelled || pendingGraphSubmissionsRef.current > 0) return
      const deferred = deferredRemoteGraphRef.current
      if (!deferred) return
      deferredRemoteGraphRef.current = null
      // Only apply if still newer than the mutation base after local submissions drained.
      if (
        deferred.graphRev < authoritativeGraphRevRef.current ||
        (deferred.graphRev === authoritativeGraphRevRef.current &&
          deferred.eventSeq <= authoritativeEventSeqRef.current)
      ) {
        return
      }
      authoritativeGraphRevRef.current = deferred.graphRev
      authoritativeEventSeqRef.current = deferred.eventSeq
      subscribedEventSeqRef.current = Math.max(subscribedEventSeqRef.current, deferred.eventSeq)
      applyingGraphRef.current = true
      applyMuxGraph(deferred)
      applyingGraphRef.current = false
    }

    const unsubscribe = useTauStore.subscribe((state, previous) => {
      if (cancelled || applyingGraphRef.current) return
      if (
        state.tabs === previous.tabs &&
        state.panes === previous.panes &&
        state.activeTabId === previous.activeTabId &&
        state.activePaneId === previous.activePaneId
      ) {
        return
      }

      // Coalesce rapid local edits into one pending candidate. The expected revision is read when
      // each queued submission starts so consecutive mutations chain against the revision produced
      // by the previous successful replace (rather than all sharing the pre-flight snapshot).
      pendingGraphCandidateRef.current = selectMuxGraphSnapshot(state)
      pendingGraphSubmissionsRef.current += 1
      graphSubmitQueueRef.current = graphSubmitQueueRef.current
        .then(async () => {
          if (cancelled) return
          while (!cancelled) {
            const candidate = pendingGraphCandidateRef.current
            if (!candidate) break
            pendingGraphCandidateRef.current = null
            const expectedRev = authoritativeGraphRevRef.current
            const expectedEventSeq = authoritativeEventSeqRef.current
            try {
              const graph = await window.electronAPI.replaceMuxGraph(
                {
                  ...candidate,
                  graphRev: expectedRev,
                  eventSeq: expectedEventSeq,
                },
                expectedRev,
              )
              authoritativeGraphRevRef.current = graph.graphRev
              authoritativeEventSeqRef.current = graph.eventSeq
              subscribedEventSeqRef.current = Math.max(subscribedEventSeqRef.current, graph.eventSeq)
              applyingGraphRef.current = true
              markMuxGraphRevision(graph.graphRev, graph.eventSeq)
              applyingGraphRef.current = false
            } catch (error) {
              console.warn('[mux-graph] Mutation conflicted; resynchronizing:', error)
              try {
                const graph = await window.electronAPI.getMuxGraph()
                if (cancelled) return
                authoritativeGraphRevRef.current = graph.graphRev
                authoritativeEventSeqRef.current = graph.eventSeq
                subscribedEventSeqRef.current = Math.max(subscribedEventSeqRef.current, graph.eventSeq)
                // Drop candidates built on the pre-conflict base; the store is about to match the
                // authoritative snapshot. Fresh local edits after apply will re-queue.
                pendingGraphCandidateRef.current = null
                deferredRemoteGraphRef.current = null
                applyingGraphRef.current = true
                applyMuxGraph(graph)
                applyingGraphRef.current = false
              } catch (resyncError) {
                graphAvailableRef.current = false
                console.warn('[mux-graph] Resynchronization unavailable:', resyncError)
              }
              return
            }
          }
        })
        .finally(() => {
          pendingGraphSubmissionsRef.current = Math.max(
            0,
            pendingGraphSubmissionsRef.current - 1,
          )
          if (pendingGraphSubmissionsRef.current === 0 && !cancelled) {
            applyDeferredRemoteGraph()
          }
        })
    })

    async function subscribe() {
      while (!cancelled) {
        try {
          const graph = await window.electronAPI.waitMuxGraph(subscribedEventSeqRef.current)
          if (cancelled || !graph) return
          if (graph.eventSeq === subscribedEventSeqRef.current) continue
          // Always advance the wait cursor so we do not busy-loop. While local submissions are in
          // flight, defer applying remote snapshots until the queue drains (otherwise the event is
          // lost and the UI stays stale until the next local edit conflicts).
          subscribedEventSeqRef.current = graph.eventSeq
          if (pendingGraphSubmissionsRef.current > 0) {
            deferredRemoteGraphRef.current = graph
            continue
          }
          deferredRemoteGraphRef.current = null
          authoritativeGraphRevRef.current = graph.graphRev
          authoritativeEventSeqRef.current = graph.eventSeq
          applyingGraphRef.current = true
          applyMuxGraph(graph)
          applyingGraphRef.current = false
        } catch (error) {
          if (cancelled) return
          const detail = error instanceof Error ? error.message : String(error)
          if (detail.includes('unknown method')) {
            graphAvailableRef.current = false
            console.warn('[mux-graph] Subscription unsupported by the running daemon')
            return
          }
          console.warn('[mux-graph] Subscription interrupted:', error)
          await new Promise((resolve) => setTimeout(resolve, 1_000))
        }
      }
    }
    void subscribe()

    return () => {
      cancelled = true
      deferredRemoteGraphRef.current = null
      unsubscribe()
    }
  }, [applyMuxGraph, layoutLoaded, markMuxGraphRevision])

  // Diagnostics only while the recovery panel is open (Phase 1.6 / 2.10).
  useEffect(() => {
    if (!layoutLoaded || !daemonDiagnosticsOpen) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const refresh = async () => {
      try {
        const diagnostics = await window.electronAPI.getTaudDiagnostics()
        if (cancelled) return
        setTaudDiagnostics(diagnostics)
        setTaudDiagnosticsError(null)
      } catch (error) {
        if (cancelled) return
        setTaudDiagnostics(null)
        setTaudDiagnosticsError(error instanceof Error ? error.message : String(error))
      } finally {
        if (!cancelled) timer = setTimeout(refresh, 5000)
      }
    }
    void refresh()
    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
    }
  }, [daemonDiagnosticsOpen, layoutLoaded])

  useEffect(() => {
    if (!layoutLoaded) return
    const frame = window.requestAnimationFrame(() => {
      void window.electronAPI.signalReady()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [layoutLoaded, activePaneId])

  useEffect(() => {
    const activeTab = tabs.find((tab) => tab.id === activeTabId)
    document.title = activeTab ? `${activeTab.name} — Tau` : 'Tau'
  }, [activeTabId, tabs])

  useEffect(() => {
    if (!layoutLoaded) return
    const next = new Map(panes.map((pane) => [pane.id, pane.lastSessionId ?? pane.id]))
    for (const [paneId, sessionId] of previousPaneSessionsRef.current) {
      if (!next.has(paneId)) {
        // Pane/tab close detaches the renderer stream only. Sessions outlive UI surfaces; kill is
        // reserved for explicit termination actions.
        disposeTerminalRuntime(sessionId)
      }
    }
    previousPaneSessionsRef.current = next
  }, [layoutLoaded, panes])

  useEffect(() => {
    const focusActiveTerminal = () => {
      const paneId = useTauStore.getState().activePaneId
      if (!paneId) return
      setTerminalFocusCounts((counts) => ({ ...counts, [paneId]: (counts[paneId] ?? 0) + 1 }))
    }
    const searchActiveTerminal = () => {
      const paneId = useTauStore.getState().activePaneId
      if (!paneId) return
      setTerminalSearchCounts((counts) => ({ ...counts, [paneId]: (counts[paneId] ?? 0) + 1 }))
    }

    const runCommand = (command: AppCommand) => {
      switch (command.type) {
        case 'new-tab':
          setIsSettingsOpen(false)
          newTab()
          break
        case 'close-tab':
          closeActiveTab()
          break
        case 'close-pane':
          closeActivePane()
          break
        case 'split-pane-vertical':
          splitActivePane('row')
          break
        case 'split-pane-horizontal':
          splitActivePane('column')
          break
        case 'switch-tab':
          setIsSettingsOpen(false)
          selectTabByIndex(command.index)
          break
        case 'focus-pane':
          selectPaneByDirection(command.direction)
          break
        case 'focus-terminal':
          focusActiveTerminal()
          break
        case 'search-terminal':
          searchActiveTerminal()
          break
        case 'open-settings':
          setIsSettingsOpen(true)
          break
      }
    }

    return window.electronAPI.onAppCommand(runCommand)
  }, [
    closeActivePane,
    closeActiveTab,
    newTab,
    selectPaneByDirection,
    selectTabByIndex,
    splitActivePane,
  ])

  const sortedTabs = useMemo(() => [...tabs].sort((a, b) => a.order - b.order), [tabs])
  const panesById = useMemo(() => new Map(panes.map((pane) => [pane.id, pane])), [panes])
  const activeTab = useMemo(
    () => sortedTabs.find((tab) => tab.id === activeTabId) ?? sortedTabs[0] ?? null,
    [activeTabId, sortedTabs],
  )
  const tabLabelsById = useMemo(() => {
    const entries = tabs.map((tab): [string, string] => {
      const firstPaneId = getFirstPaneId(tab.layout)
      const pane = firstPaneId ? panesById.get(firstPaneId) : null
      return [tab.id, sanitizeTerminalTitle(pane?.name ?? tab.name) ?? tab.name]
    })
    return new Map(entries)
  }, [panesById, tabs])
  const terminalFocusTokens = useMemo(
    () => new Map(Object.entries(terminalFocusCounts)),
    [terminalFocusCounts],
  )
  const terminalSearchTokens = useMemo(
    () => new Map(Object.entries(terminalSearchCounts)),
    [terminalSearchCounts],
  )

  const notice = useMemo(
    () => daemonRecoveryNotice(taudDiagnostics, taudDiagnosticsError),
    [taudDiagnostics, taudDiagnosticsError],
  )

  const handleRecover = useCallback(async (action: TaudLifecycleRecoveryAction) => {
    setDaemonRecoveryInFlight(true)
    setDaemonRecoveryError(null)
    try {
      const diagnostics = await window.electronAPI.recoverTaud(action)
      setTaudDiagnostics(diagnostics)
      setTaudDiagnosticsError(null)
    } catch (error) {
      setDaemonRecoveryError(error instanceof Error ? error.message : String(error))
    } finally {
      setDaemonRecoveryInFlight(false)
    }
  }, [])

  // Silence unused diagnostics type imports used only for future panel expansion.
  void (null as unknown as TerminalPreloadDiagnostics)
  void (null as unknown as TaudPtyBridgeDiagnostics)

  if (!layoutLoaded) {
    return <div className="tau-shell" />
  }

  if (isSettingsOpen) {
    return (
      <div className="tau-shell tau-settings-shell">
        <SettingsPage onBack={() => setIsSettingsOpen(false)} />
      </div>
    )
  }

  return (
    <div className="tau-shell tau-shell-sidebar-hidden">
      <section className="tau-main">
        <main className="main-content">
          <TabBar
            tabs={sortedTabs}
            activeTabId={activeTab?.id ?? null}
            labels={tabLabelsById}
            onSelect={(tabId) => {
              setIsSettingsOpen(false)
              selectTab(tabId)
            }}
            onClose={closeTab}
            onNew={() => {
              setIsSettingsOpen(false)
              newTab()
            }}
            onOpenSettings={() => {
              setDaemonDiagnosticsOpen(true)
              setIsSettingsOpen(true)
            }}
          />
          {notice ? (
            <DaemonRecoveryIndicator
              notice={notice}
              diagnostics={taudDiagnostics}
              isRecovering={daemonRecoveryInFlight}
              recoveryError={daemonRecoveryError}
              onRecover={handleRecover}
            />
          ) : null}
          <div className="pane-grid">
            {activeTab ? (
              <div className="pane-grid-layer pane-grid-layer-active">
                <PaneGrid
                  tab={activeTab}
                  panesById={panesById}
                  activePaneId={activePaneId}
                  terminalFocusTokens={terminalFocusTokens}
                  terminalSearchTokens={terminalSearchTokens}
                  onLayoutRelease={setTabLayout}
                  onSelectPane={selectPane}
                  onPaneTitle={setPaneTitle}
                  onRestartPaneSession={restartPaneSession}
                />
              </div>
            ) : (
              <div className="pane-grid-layer pane-grid-layer-active">
                <div className="pane-grid-empty">
                  <button type="button" className="empty-new-tab-button" onClick={() => newTab()}>
                    New shell
                  </button>
                </div>
              </div>
            )}
          </div>
        </main>
      </section>
    </div>
  )
}

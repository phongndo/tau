import { useTauStore, selectMuxGraphSnapshot } from './store'
import { markRendererEvent } from '../trace'
import type { MuxGraphSnapshot } from '@tau/shared/mux-graph'

/** Keep the daemon authoritative; coalesce local graph edits and defer remote updates in flight. */
export function startGraphSync(onLoaded: () => void): () => void {
  let cancelled = false
  let available = false
  let rev = 0
  let eventSeq = 0
  let cursor = 0
  let inFlight = false
  let applying = false
  let candidate: MuxGraphSnapshot | null = null
  let deferred: MuxGraphSnapshot | null = null
  let unsubscribe: (() => void) | undefined

  function apply(graph: MuxGraphSnapshot) {
    rev = graph.graphRev
    eventSeq = graph.eventSeq
    cursor = Math.max(cursor, graph.eventSeq)
    applying = true
    try {
      useTauStore.getState().applyMuxGraph(graph)
    } finally {
      applying = false
    }
  }

  async function submit() {
    if (inFlight) return
    inFlight = true
    try {
      while (!cancelled && candidate) {
        const next = candidate
        candidate = null
        try {
          const graph = await window.electronAPI.replaceMuxGraph(
            { ...next, graphRev: rev, eventSeq },
            rev,
          )
          if (cancelled) return
          rev = graph.graphRev
          eventSeq = graph.eventSeq
          cursor = Math.max(cursor, graph.eventSeq)
          applying = true
          try {
            useTauStore.getState().markMuxGraphRevision(rev, eventSeq)
          } finally {
            applying = false
          }
        } catch (error) {
          console.warn('[mux-graph] Mutation conflicted; resynchronizing:', error)
          try {
            const graph = await window.electronAPI.getMuxGraph()
            if (cancelled) return
            candidate = null
            deferred = null
            apply(graph)
          } catch (cause) {
            available = false
            console.warn('[mux-graph] Resynchronization unavailable:', cause)
          }
        }
      }
    } finally {
      inFlight = false
      if (
        deferred &&
        !cancelled &&
        (deferred.graphRev > rev || (deferred.graphRev === rev && deferred.eventSeq > eventSeq))
      )
        apply(deferred)
      deferred = null
      if (candidate && !cancelled) void submit()
    }
  }

  async function wait() {
    while (!cancelled && available) {
      try {
        const graph = await window.electronAPI.waitMuxGraph(cursor)
        if (cancelled || !graph) return
        if (graph.eventSeq === cursor) continue
        cursor = graph.eventSeq
        if (inFlight) deferred = graph
        else apply(graph)
      } catch (error) {
        if (cancelled) return
        if (String(error).includes('unknown method')) return
        console.warn('[mux-graph] Subscription interrupted:', error)
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
  }

  void (async () => {
    try {
      let graph = await window.electronAPI.getMuxGraph()
      if (graph.tabs.length === 0) {
        try {
          graph = await window.electronAPI.replaceMuxGraph(
            {
              ...selectMuxGraphSnapshot(useTauStore.getState()),
              graphRev: graph.graphRev,
              eventSeq: graph.eventSeq,
            },
            graph.graphRev,
          )
        } catch {
          graph = await window.electronAPI.getMuxGraph()
        }
      }
      if (cancelled) return
      apply(graph)
      available = true
    } catch (error) {
      console.warn('[mux-graph] Daemon unavailable:', error)
    }
    if (cancelled) return
    onLoaded()
    markRendererEvent('ui:layout-loaded')
    if (!available) return
    unsubscribe = useTauStore.subscribe((state, previous) => {
      if (
        applying ||
        (state.tabs === previous.tabs &&
          state.panes === previous.panes &&
          state.activeTabId === previous.activeTabId &&
          state.activePaneId === previous.activePaneId)
      )
        return
      candidate = selectMuxGraphSnapshot(state)
      void submit()
    })
    void wait()
  })()

  return () => {
    cancelled = true
    available = false
    unsubscribe?.()
  }
}

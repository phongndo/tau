import assert from 'node:assert/strict'
import test from 'node:test'
import { collectPaneIds, assertSplitInvariants, type MuxPaneTreeNode } from '@tau/shared/mux-graph'
import { selectMuxGraphSnapshot, useTauStore } from '../src/renderer/state/store'

function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

function validateNode(node: MuxPaneTreeNode): void {
  if (typeof node === 'string') return
  if (node.type === 'tabs') {
    assert.ok(node.tabs.length > 0)
    assert.ok(node.activeTabIndex >= 0 && node.activeTabIndex < node.tabs.length)
    return
  }
  assert.equal(node.children.length, 2)
  assertSplitInvariants(node.direction, node.children, node.splitPercentages)
  for (const child of node.children) validateNode(child)
}

function validateProjection(): void {
  const graph = selectMuxGraphSnapshot(useTauStore.getState())
  const paneIds = new Set(graph.panes.map((pane) => pane.id))
  const referenced: string[] = []
  const tabIds = new Set(graph.tabs.map((tab) => tab.id))
  assert.equal(tabIds.size, graph.tabs.length)
  for (const tab of graph.tabs) {
    validateNode(tab.root as MuxPaneTreeNode)
    referenced.push(...collectPaneIds(tab.root as MuxPaneTreeNode))
  }
  assert.equal(new Set(referenced).size, referenced.length)
  assert.deepEqual(new Set(referenced), paneIds)
  for (const pane of graph.panes) assert.ok(tabIds.has(pane.tabId))
}

test('random pane-tree mutation sequences preserve mux invariants', () => {
  for (let seed = 1; seed <= 100; seed += 1) {
    const rng = random(seed)
    useTauStore.getState().applyMuxGraph({
      schemaVersion: 1,
      graphRev: 0,
      eventSeq: 0,
      tabs: [],
      panes: [],
      activeTabId: null,
      activePaneId: null,
    })

    for (let step = 0; step < 100; step += 1) {
      const state = useTauStore.getState()
      const action = Math.floor(rng() * 6)
      if (action === 0 || state.tabs.length === 0) state.newTab()
      else if (action === 1 && state.activePaneId) state.splitActivePane(rng() < 0.5 ? 'row' : 'column')
      else if (action === 2 && state.panes.length > 1) state.closeActivePane()
      else if (action === 3 && state.tabs.length > 1 && state.activeTabId) state.closeActiveTab()
      else if (action === 4 && state.panes.length > 0) {
        state.selectPane(state.panes[Math.floor(rng() * state.panes.length)]!.id)
      } else if (state.tabs.length > 0) {
        state.selectTab(state.tabs[Math.floor(rng() * state.tabs.length)]!.id)
      }
      validateProjection()
    }
  }
})

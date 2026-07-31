import assert from 'node:assert/strict'
import test from 'node:test'
import { Schema } from 'effect'
import { PANE_LAYOUT_VERSION, type PaneLayoutData } from '@tau/shared/session'
import { CreateSessionInputSchema } from '@tau/shared/taud-protocol'
import { collectPaneIds, normalizeSplitPercentages } from '@tau/shared/mux-graph'
import { selectPaneLayoutData, useTauStore } from '../src/renderer/state/store'

function resetStore(): void {
  useTauStore.setState({
    tabs: [],
    panes: [],
    activeTabId: null,
    activePaneId: null,
    graphRev: 0,
  })
  // Force default shell via hydrate of empty invalid layout
  useTauStore.getState().hydrateLayout({
    version: PANE_LAYOUT_VERSION,
    tabs: [],
    panes: [],
    activeTabId: null,
    activePaneId: null,
  })
}

test('fresh store opens a shell tab without project or agent metadata', () => {
  resetStore()
  const state = useTauStore.getState()
  assert.equal(state.tabs.length, 1)
  assert.equal(state.panes.length, 1)
  assert.equal(state.panes[0]?.type, 'terminal')
  assert.equal(state.activeTabId, state.tabs[0]?.id)
  assert.equal(state.activePaneId, state.panes[0]?.id)
  assert.equal('workspaceId' in (state.tabs[0] as object), false)
  assert.equal('agentProvider' in (state.panes[0] as object), false)
})

test('create session schema does not require workspace or agent fields', () => {
  const decoded = Schema.decodeUnknownOption(CreateSessionInputSchema)({
    terminalId: 'term-1',
    cols: 80,
    rows: 24,
    cwd: '/tmp',
  })
  assert.equal(decoded._tag, 'Some')
  if (decoded._tag === 'Some') {
    assert.equal(decoded.value.terminalId, 'term-1')
    assert.equal('workspaceId' in decoded.value, false)
  }
})

test('tabs and splits work without workspaces', () => {
  resetStore()
  const store = useTauStore.getState()
  store.newTab()
  store.splitActivePane('row')
  const state = useTauStore.getState()
  assert.equal(state.tabs.length, 2)
  assert.ok(state.panes.length >= 2)
  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId)
  assert.ok(activeTab)
  assert.equal(typeof activeTab.layout, 'object')
  const layout = selectPaneLayoutData(state)
  assert.equal(layout.version, PANE_LAYOUT_VERSION)
  assert.equal('workspaces' in layout, false)
})

test('discards pre-v2 workspace-centric layouts', () => {
  resetStore()
  const legacy = {
    version: 1,
    workspaces: [{ id: 'ws', name: 'Project', projectPath: '/tmp/p', order: 0 }],
    tabs: [],
    panes: [],
    activeTabId: null,
    activePaneId: null,
  } as unknown as PaneLayoutData
  useTauStore.getState().hydrateLayout(legacy)
  const state = useTauStore.getState()
  assert.equal(state.tabs.length, 1)
  assert.equal(state.panes[0]?.type, 'terminal')
})

test('mux graph split percentages stay bounded', () => {
  const percentages = normalizeSplitPercentages([1, 99], 2)
  assert.deepEqual(percentages, [5, 95])
  const threeWay = normalizeSplitPercentages([1, 1, 98], 3)
  assert.equal(threeWay.length, 3)
  assert.ok(Math.abs(threeWay.reduce((sum, value) => sum + value, 0) - 100) < 0.01)
  for (const value of threeWay) {
    assert.ok(value >= 5 && value <= 95, `expected ${value} in [5, 95]`)
  }
  assert.deepEqual(collectPaneIds({ type: 'split', direction: 'row', children: ['a', 'b'], splitPercentages: [50, 50] }), [
    'a',
    'b',
  ])
})

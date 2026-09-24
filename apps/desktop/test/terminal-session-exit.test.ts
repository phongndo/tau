import assert from 'node:assert/strict'
import test from 'node:test'
import { PANE_LAYOUT_VERSION } from '@tau/shared/session'
import { useTauStore } from '../src/renderer/state/store'
import { handleTerminalSessionExit } from '../src/renderer/state/terminal-session-exit'

function resetStore(): void {
  useTauStore.getState().hydrateLayout({
    version: PANE_LAYOUT_VERSION,
    tabs: [],
    panes: [],
    activeTabId: null,
    activePaneId: null,
  })
}

test('exit closes the final terminal window and replaces its dead session for next launch', () => {
  resetStore()
  const pane = useTauStore.getState().panes[0]!
  let closed = 0
  handleTerminalSessionExit(pane.id, pane.lastSessionId!, () => closed++)
  assert.equal(closed, 1)
  assert.notEqual(useTauStore.getState().panes[0]?.lastSessionId, pane.lastSessionId)
})

test('exit closes only its pane when another terminal remains', () => {
  resetStore()
  const first = useTauStore.getState().panes[0]!
  useTauStore.getState().splitPane(first.id, 'row')
  let closed = 0
  handleTerminalSessionExit(first.id, first.lastSessionId!, () => closed++)
  assert.equal(closed, 0)
  assert.equal(
    useTauStore.getState().panes.some((pane) => pane.id === first.id),
    false,
  )
  assert.equal(useTauStore.getState().panes.length, 1)
})

test('stale shell exit cannot close a restarted pane', () => {
  resetStore()
  const pane = useTauStore.getState().panes[0]!
  useTauStore.getState().restartPaneSession(pane.id)
  let closed = 0
  handleTerminalSessionExit(pane.id, pane.lastSessionId!, () => closed++)
  assert.equal(closed, 0)
  assert.equal(useTauStore.getState().panes[0]?.id, pane.id)
})

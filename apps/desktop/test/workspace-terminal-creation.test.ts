import assert from 'node:assert/strict'
import test from 'node:test'
import type { PiThread } from '@tau/shared/taud-protocol'
import { selectPaneLayoutData, useTauStore, type Workspace } from '../src/renderer/state/store'

function resetStore(): void {
  useTauStore.setState({
    workspaces: [],
    activeWorkspaceId: null,
    lastActiveLocalTabId: null,
    tabs: [],
    activeTabId: null,
    panes: [],
    activePaneId: null,
    sidebarExpanded: true,
    sidebarWidth: 240,
  })
}

function workspace(id: string): Workspace {
  return {
    id,
    name: id,
    projectPath: `/tmp/${id}`,
    order: 0,
  }
}

test('adding a workspace selects it without creating a thread', () => {
  resetStore()

  useTauStore.getState().addWorkspace(workspace('workspace-a'))

  const state = useTauStore.getState()
  assert.equal(state.activeWorkspaceId, 'workspace-a')
  assert.equal(state.activeTabId, null)
  assert.equal(state.activePaneId, null)
  assert.equal(state.tabs.length, 0)
  assert.equal(state.panes.length, 0)
})

test('newTab explicitly creates the first Pi thread for the active workspace', () => {
  resetStore()

  useTauStore.getState().addWorkspace(workspace('workspace-a'))
  useTauStore.getState().newTab()

  const state = useTauStore.getState()
  assert.equal(state.tabs.length, 1)
  assert.equal(state.panes.length, 1)
  assert.equal(state.tabs[0]?.workspaceId, 'workspace-a')
  assert.equal(state.tabs[0]?.name, 'Pi')
  assert.equal(state.panes[0]?.agentProvider, 'pi')
  assert.deepEqual(state.panes[0]?.argv, ['pi'])
  assert.equal(state.activeTabId, state.tabs[0]?.id)
  assert.equal(state.activePaneId, state.panes[0]?.id)
})

test('layout hydration drops persisted terminal panes', () => {
  resetStore()

  useTauStore.getState().hydrateLayout({
    version: 2,
    workspaces: [workspace('workspace-a')],
    activeWorkspaceId: 'workspace-a',
    lastActiveLocalTabId: null,
    tabs: [
      {
        id: 'tab-shell',
        workspaceId: 'workspace-a',
        name: 'zsh',
        layout: 'pane-shell',
        lastActivePaneId: 'pane-shell',
        order: 0,
      },
    ],
    panes: [
      {
        id: 'pane-shell',
        terminalId: 'term-shell',
        tabId: 'tab-shell',
        type: 'terminal',
        name: 'zsh',
        status: 'idle',
        lastSessionId: 'session-shell',
      },
      {
        id: 'pane-pi',
        terminalId: 'term-pi',
        tabId: 'tab-pi',
        type: 'terminal',
        name: 'Pi review',
        agentProvider: 'pi',
        argv: ['pi', '--session', '/tmp/pi-session.jsonl'],
        status: 'idle',
        lastSessionId: 'session-pi',
      },
    ],
    activeTabId: 'tab-shell',
    activePaneId: 'pane-shell',
    sidebarExpanded: true,
    sidebarWidth: 240,
    rightSidebarExpanded: false,
    rightSidebarWidth: 240,
  })

  const state = useTauStore.getState()
  assert.equal(state.tabs.length, 0)
  assert.equal(state.panes.length, 0)
  assert.equal(state.activeTabId, null)
  assert.equal(state.activePaneId, null)
})

test('importPiThreads imports repository Pi sessions without duplicates', () => {
  resetStore()

  const thread: PiThread = {
    id: 'agent-pi',
    terminalSessionId: 'session-pi',
    terminalId: 'term-pi',
    workspaceId: 'workspace-a',
    cwd: '/tmp/workspace-a',
    terminalStatus: 'detached',
    agentStatus: 'resumable',
    nativeSessionId: 'native-pi',
    resumeArgv: ['pi', '--session', '/tmp/pi-session.jsonl'],
    title: 'Pi review',
    lastSeq: 7,
    lastActivityAt: '2026-05-31T00:00:00Z',
  }

  useTauStore.getState().addWorkspace(workspace('workspace-a'))
  useTauStore.getState().importPiThreads('workspace-a', [thread])
  useTauStore.getState().importPiThreads('workspace-a', [thread])

  const state = useTauStore.getState()
  assert.equal(state.tabs.length, 1)
  assert.equal(state.panes.length, 1)
  assert.equal(state.tabs[0]?.name, 'Pi review')
  assert.equal(state.panes[0]?.name, 'Pi review')
  assert.equal(state.panes[0]?.agentProvider, 'pi')
  assert.deepEqual(state.panes[0]?.argv, ['pi', '--session', '/tmp/pi-session.jsonl'])
  assert.equal(state.panes[0]?.terminalId, 'term-pi')
  assert.equal(state.panes[0]?.lastSessionId, 'session-pi')
  assert.equal(state.activeTabId, null)
  assert.equal(state.activePaneId, null)
})

test('importPiThreads uses session-derived names instead of generic pi labels', () => {
  resetStore()

  const thread: PiThread = {
    id: 'agent-pi',
    terminalSessionId: 'session-pi',
    terminalId: 'term-pi',
    workspaceId: 'workspace-a',
    cwd: '/tmp/workspace-a',
    terminalStatus: 'detached',
    agentStatus: 'resumable',
    nativeSessionId: '1234567890abcdef',
    title: 'pi',
    lastSeq: 7,
    lastActivityAt: '2026-05-31T00:00:00Z',
  }

  useTauStore.getState().addWorkspace(workspace('workspace-a'))
  useTauStore.getState().importPiThreads('workspace-a', [thread])

  const state = useTauStore.getState()
  assert.equal(state.tabs[0]?.name, 'Pi 12345678')
  assert.equal(state.panes[0]?.name, 'Pi 12345678')
  assert.deepEqual(state.panes[0]?.argv, ['pi', '--session', '1234567890abcdef'])
})

test('process titles do not rename Pi threads', () => {
  resetStore()

  const thread: PiThread = {
    id: 'agent-pi',
    terminalSessionId: 'session-pi',
    terminalId: 'term-pi',
    workspaceId: 'workspace-a',
    cwd: '/tmp/workspace-a',
    terminalStatus: 'detached',
    agentStatus: 'resumable',
    nativeSessionId: 'native-pi',
    title: 'Pi review',
    lastSeq: 7,
    lastActivityAt: '2026-05-31T00:00:00Z',
  }

  useTauStore.getState().addWorkspace(workspace('workspace-a'))
  useTauStore.getState().importPiThreads('workspace-a', [thread])
  const paneId = useTauStore.getState().panes[0]?.id
  assert.ok(paneId)

  useTauStore.getState().setPaneTitle(paneId, 'node')

  const state = useTauStore.getState()
  assert.equal(state.tabs[0]?.name, 'Pi review')
  assert.equal(state.panes[0]?.name, 'Pi review')
})

test('closeTab does not locally remove imported Pi threads', () => {
  resetStore()

  const thread: PiThread = {
    id: 'agent-pi',
    terminalSessionId: 'session-pi',
    terminalId: 'term-pi',
    workspaceId: 'workspace-a',
    cwd: '/tmp/workspace-a',
    terminalStatus: 'detached',
    agentStatus: 'resumable',
    nativeSessionId: 'native-pi',
    title: 'Pi review',
    lastSeq: 7,
    lastActivityAt: '2026-05-31T00:00:00Z',
  }

  useTauStore.getState().addWorkspace(workspace('workspace-a'))
  useTauStore.getState().importPiThreads('workspace-a', [thread])
  const tabId = useTauStore.getState().tabs[0]?.id
  assert.ok(tabId)

  useTauStore.getState().closeTab(tabId)

  const state = useTauStore.getState()
  assert.equal(state.tabs.length, 1)
  assert.equal(state.panes.length, 1)
  assert.equal(state.tabs[0]?.id, tabId)
})

test('persisted layout excludes Pi thread projections', () => {
  resetStore()

  const thread: PiThread = {
    id: 'agent-pi',
    terminalSessionId: 'session-pi',
    terminalId: 'term-pi',
    workspaceId: 'workspace-a',
    cwd: '/tmp/workspace-a',
    terminalStatus: 'detached',
    agentStatus: 'resumable',
    nativeSessionId: 'native-pi',
    title: 'Pi review',
    lastSeq: 7,
    lastActivityAt: '2026-05-31T00:00:00Z',
  }

  useTauStore.getState().addWorkspace(workspace('workspace-a'))
  useTauStore.getState().importPiThreads('workspace-a', [thread])

  const layout = selectPaneLayoutData(useTauStore.getState())
  assert.equal(layout.tabs.length, 0)
  assert.equal(layout.panes.length, 0)
  assert.equal(layout.activeTabId, null)
  assert.equal(layout.activePaneId, null)
})

test('selecting a workspace falls back to imported daemon Pi threads', () => {
  resetStore()

  const thread: PiThread = {
    id: 'agent-pi',
    terminalSessionId: 'session-pi',
    terminalId: 'term-pi',
    workspaceId: 'workspace-a',
    cwd: '/tmp/workspace-a',
    terminalStatus: 'detached',
    agentStatus: 'resumable',
    title: 'Daemon-only Pi thread',
    lastSeq: 7,
    lastActivityAt: '2026-05-31T00:00:00Z',
  }

  useTauStore.getState().addWorkspace(workspace('workspace-a'))
  useTauStore.getState().importPiThreads('workspace-a', [thread])
  useTauStore.getState().selectWorkspace('workspace-a')

  const state = useTauStore.getState()
  assert.equal(state.tabs.length, 1)
  assert.equal(state.tabs[0]?.id, 'tab-pi-session-pi')
  assert.equal(state.activeTabId, 'tab-pi-session-pi')
  assert.equal(state.activePaneId, 'pane-pi-session-pi')
})

test('closeTab can close locally created Pi threads', () => {
  resetStore()

  useTauStore.getState().addWorkspace(workspace('workspace-a'))
  useTauStore.getState().newTab('workspace-a')
  const tabId = useTauStore.getState().tabs[0]?.id
  assert.ok(tabId)

  useTauStore.getState().closeTab(tabId)

  const state = useTauStore.getState()
  assert.equal(state.tabs.length, 0)
  assert.equal(state.panes.length, 0)
  assert.equal(state.activeTabId, null)
  assert.equal(state.activePaneId, null)
})

test('importPiThreads replaces the local Pi projection from source of truth', () => {
  resetStore()

  const firstThread: PiThread = {
    id: 'agent-pi-first',
    terminalSessionId: 'session-pi-first',
    terminalId: 'term-pi-first',
    workspaceId: 'workspace-a',
    cwd: '/tmp/workspace-a',
    terminalStatus: 'detached',
    agentStatus: 'resumable',
    nativeSessionId: 'native-pi-first',
    title: 'First Pi thread',
    lastSeq: 7,
    lastActivityAt: '2026-05-31T00:00:00Z',
  }
  const secondThread: PiThread = {
    id: 'agent-pi-second',
    terminalSessionId: 'session-pi-second',
    terminalId: 'term-pi-second',
    workspaceId: 'workspace-a',
    cwd: '/tmp/workspace-a',
    terminalStatus: 'detached',
    agentStatus: 'resumable',
    nativeSessionId: 'native-pi-second',
    title: 'Second Pi thread',
    lastSeq: 8,
    lastActivityAt: '2026-05-31T00:01:00Z',
  }

  useTauStore.getState().addWorkspace(workspace('workspace-a'))
  useTauStore.getState().importPiThreads('workspace-a', [firstThread])
  useTauStore.getState().importPiThreads('workspace-a', [secondThread])

  let state = useTauStore.getState()
  assert.equal(state.tabs.length, 1)
  assert.equal(state.panes.length, 1)
  assert.equal(state.tabs[0]?.name, 'Second Pi thread')
  assert.equal(state.panes[0]?.terminalId, 'term-pi-second')

  useTauStore.getState().importPiThreads('workspace-a', [])

  state = useTauStore.getState()
  assert.equal(state.tabs.length, 0)
  assert.equal(state.panes.length, 0)
  assert.equal(state.activeTabId, null)
  assert.equal(state.activePaneId, null)
})

test('selecting a workspace with no tabs does not create a thread', () => {
  resetStore()

  useTauStore.getState().addWorkspace(workspace('workspace-a'))
  useTauStore.getState().newTab()
  useTauStore.getState().addWorkspace(workspace('workspace-b'))

  let state = useTauStore.getState()
  assert.equal(state.activeWorkspaceId, 'workspace-b')
  assert.equal(state.activeTabId, null)
  assert.equal(state.activePaneId, null)
  assert.equal(state.tabs.length, 1)
  assert.equal(state.panes.length, 1)

  useTauStore.getState().selectWorkspace('workspace-a')
  state = useTauStore.getState()
  assert.equal(state.activeTabId, state.tabs[0]?.id)
  assert.equal(state.activePaneId, state.panes[0]?.id)

  useTauStore.getState().selectWorkspace('workspace-b')
  state = useTauStore.getState()
  assert.equal(state.activeTabId, null)
  assert.equal(state.activePaneId, null)
  assert.equal(state.tabs.length, 1)
  assert.equal(state.panes.length, 1)
})

import { useTauStore } from './store'

/** A PTY exit ends only the shell that owns that session, including after a restart. */
export function handleTerminalSessionExit(
  paneId: string,
  sessionId: string,
  closeWindow: () => void,
): void {
  const state = useTauStore.getState()
  const pane = state.panes.find((item) => item.id === paneId)
  if (!pane || pane.lastSessionId !== sessionId) return
  const finalPane = state.panes.length === 1
  state.closePane(paneId)
  if (finalPane) closeWindow()
}

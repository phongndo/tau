import { TauTerminal } from '../src/renderer/tau-terminal'

// Export to the classic script served by the Electron surface smoke harness.
Object.assign(window, { TauSurfaceTest: { TauTerminal } })

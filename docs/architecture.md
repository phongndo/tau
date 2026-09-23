# Current architecture

Tau's desktop is a client of the Zig `taud` daemon. The daemon owns PTYs, sessions, VT state, event logs, current-screen snapshots, SQLite session metadata, and the persistent mux graph. An Electron window can disconnect and attach again without killing a live PTY. A fresh shell starts when there is no saved layout. The current pane surface is a terminal; there is no loaded extension runtime or `tau ctl` CLI.

## Ownership and change points

| Change                                     | Start here                                                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Wire schemas, mux snapshots and events     | [`packages/shared/src/`](../packages/shared/src/) (`mux-graph.ts`, `session.ts`, `taud-protocol.ts`)                                  |
| Graph validation, revisions, persistence   | [`apps/daemon/src/mux_graph.zig`](../apps/daemon/src/mux_graph.zig) and [`daemon/control.zig`](../apps/daemon/src/daemon/control.zig) |
| PTY lifecycle, streams and resource limits | [`apps/daemon/src/`](../apps/daemon/src/) (`session.zig`, `rpc.zig`, `limits.zig`, `daemon/`)                                         |
| Daemon connection and renderer IPC         | [`apps/desktop/src/main/`](../apps/desktop/src/main/) (`taud-client.ts`, `taud-pty-bridge.ts`, `index.ts`)                            |
| Renderer layout and terminal presentation  | [`apps/desktop/src/renderer/`](../apps/desktop/src/renderer/) (`state/store.ts`, `terminal.ts`, `terminal-output-writer.ts`)          |

The renderer keeps an interactive projection of tabs and panes. Graph replacement goes through Electron main to `taud`; mutations carry an expected revision to reject stale writes. The daemon validates snapshots, increments `graphRev` and `eventSeq`, and persists a checksummed graph with a previous checkpoint for recovery. Pane identity and session identity are separate: closing or replacing a view does not by itself mean killing its PTY. Read [terminal byte path](terminal-byte-path.md) when changing stream ownership, acknowledgements or reload behavior.

## Trust boundary

The desktop window uses context isolation, renderer sandboxing and disabled Node integration. The preload exposes a bounded API rather than raw filesystem, process or socket access. The main process limits navigation and new windows; the renderer HTML declares its CSP. The daemon uses a private local socket and same-user peer checks where supported. Request/frame validation and resource limits live at the daemon boundary and in the shared protocol. See [`apps/desktop/test/security-boundaries.test.ts`](../apps/desktop/test/security-boundaries.test.ts) and the daemon's socket tests for executable checks. This describes the current local client, not a sandbox for future third-party extensions.

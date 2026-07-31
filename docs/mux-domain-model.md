# Canonical Mux Domain Model (Phase 2.2)

Versioned schemas live in `@tau/shared` (`session.ts`, `mux-graph.ts`, `taud-protocol.ts`).
`taud` is the durability and mutation authority; Electron is a disposable client.

## Entities

```text
ClientRef  -> WindowRef -> Tab -> PaneTree -> PaneSurface -> SessionAttachment -> TerminalSession
```

### Client / window reference

- `clientId`: opaque connection id from the control handshake
- `windowId`: UI window id (Electron BrowserWindow)
- Not durable across app reinstalls; used for routing focus and ownership hints

### Tab

- `id`, `name`, `order`
- `root`: pane tree node id or inline tree
- `activePaneId`
- No workspace/project/thread fields

### Pane tree

- Leaf: pane id
- Split: `{ type: "split", direction: "row" | "column", children: Node[], splitPercentages: number[] }`
- Nested tabs nodes are allowed for mosaic compatibility but are not required

### Pane surface

- `id`, `tabId`
- `type`: `"terminal"` only in core (extension types later as `"ext:<id>"`)
- `name`, optional `cwd`, optional `argv`
- `sessionId` / `terminalId` linkage
- Optional neutral `context` record (cwd, profile, remote) — never required project IDs

### Terminal session

- Daemon-owned process/PTY state machine: live | detached | exited | crashed | archived | killed
- `cols`/`rows`, `cwd`, `argv`, seq, snapshot paths
- Independent of panes

### Session attachment

- Binding of a client/pane to a session stream
- Carries attach mode: `live` | `fresh` | `command-resume`
- Agent-resume is extension territory and not a core attach mode

### Graph revision and event sequence

- `graphRev`: increments on every committed graph mutation
- `eventSeq`: increments on every emitted control/graph event
- Snapshots include both counters for gap detection

## Semantics

### Detach / terminate / archive / forget / clear-history

| Op | Session process | Metadata | Event log |
| --- | --- | --- | --- |
| detach | keeps running | kept | kept |
| terminate/kill | signaled | kept until forget | kept per policy |
| archive | already dead | retained | retained |
| forget | must be dead | deleted | deleted |
| clear-history | unchanged | kept | truncated |

### Multi-client ownership

- First writer does not “own” exclusively; all authenticated local clients may mutate
- Optional `expectedGraphRev` on mutations prevents lost updates
- On conflict: error `graph_rev_mismatch` + full snapshot

### Unavailable extension pane types

- Represented as `{ type: "ext:<id>", unavailable: true, payload: opaque }`
- Core renders a placeholder; never drops unknown payload fields on round-trip
- Until extension panes exist, core rejects non-`terminal` types on write

## Persistence

- Graph snapshots: atomic write (temp + rename), schema version, checksum
- Keep previous valid checkpoint for corrupt/truncated recovery
- Layout files written by the renderer during Phase 1 migration are replaced by
  daemon graph snapshots as Phase 2.3 lands

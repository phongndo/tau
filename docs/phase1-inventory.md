# Phase 1 Feature Inventory

One-page classification of Tau features before the mux-kernel strip.
Git history is the archive. Deleted workflows may return only through public extension APIs (Phase 4+).

## Required mux core

| Area | Items |
| --- | --- |
| Daemon | PTY spawn/attach/detach/kill/resize, event log, screen snapshots, session persistence, cleanup, control + stream protocols, local socket lifecycle |
| Electron main | Daemon client lifecycle, MessagePort PTY bridge, layout/settings file stores, app commands/keybindings, window lifecycle |
| Renderer | Terminal pane (xterm WebGL), tab strip, split pane tree, focus/resize, terminal search, settings shell, recovery/diagnostics UI |
| Shared | Session schemas, control/stream protocol types, current-screen snapshot codec, storage paths, app commands |
| Benchmarks | Latency, input-priority, attach-replay, soak, renderer, IPC, startup, package smoke, reload |

## Temporary migration code

| Item | Decision |
| --- | --- |
| Legacy localStorage layout keys (`tao-workspaces`, `tau-workspaces`) | One-shot read then clear; remove after Phase 1 ships |
| Optional `workspace_id` / `worktree_id` columns on `terminal_sessions` | Keep nullable columns for DB compatibility; stop writing new values; ignore on attach |
| Agent/session FTS tables already on disk | Leave tables; stop writing; drop in a later daemon schema bump if unused |

## Delete now

| Surface | Modules / assets |
| --- | --- |
| Projects / workspaces sidebar | `App.tsx` project list, search dialog, workspace reorder |
| Worktree UI | Worktree nested controls, context IDs |
| Git / files / changes sidebar | Right sidebar, file tree, diff panels, PR/ports UI |
| Diff stack | `@pierre/diffs`, `@pierre/trees`, `diff-parser*`, diff workers |
| Workspace services | `workspace-service.ts`, `workspaceQueries.ts`, `git-state-watcher*`, preload workspace IPC |
| Shared workspace package | `packages/shared/src/workspace.ts` and export |
| Pi / agent core | Pi thread import, agent status presentation, agent adapters in `taud`, agent stream frames from core UI |
| Daemon workflow RPC | workspace/worktree/git/pi-thread request types, fixtures, handlers |
| Daemon modules | `workspace.zig`, `worktree.zig`, `worktree_name.zig`, `git.zig`, `adapter.zig`, `agent_index.zig` |
| Pane types | `changes`, `webview` |
| Benchmarks / tests | workspace-metadata, file-tree, git-watcher, workspace-service tests |
| Docs plans | workflow-specific plan docs superseded by TODO.md |

## Rebuild later as extensions

| Extension (Phase 5) | Former core surface |
| --- | --- |
| `@tau/projects` | Project sidebar, directory pick, project order |
| `@tau/worktrees` | Worktree create/remove/adopt UI and daemon ops |
| `@tau/git` | Status, file tree, diff, stage/unstage/revert, branch, PR, ports |
| `@tau/pi` | Pi launch, thread discovery, resume, status |
| `@tau/agents` | Generic agent detection / archive / resume presentation |
| `@tau/browser` | `webview` pane type |

## User data migration decision

**No one-time export or migration is required.**

- Workflow metadata (projects, worktrees, Pi threads, Git UI state) is not carried forward.
- Terminal session durability remains via `taud` event logs and snapshots.
- Layout files that only encode workspace-centric graphs are discarded; a fresh shell tab is created.
- Removal version for any residual compatibility shims: **next minor after Phase 1 land** (drop legacy layout keys and ignored workspace columns then).

## Extension-return rule

Deleted workflow behavior may re-enter the product **only** through:

1. Public `@tau/sdk` contribution points, and/or
2. The versioned structured control protocol (`tau ctl`),

never by restoring private core modules or privileged daemon adapters.

# Tau Rework Plan

Tau is pivoting to a performance-first graphical terminal multiplexer with a Pi-like extension model. It is not a chat UI for Pi, an AI IDE, or a project/worktree manager.

The terminal is the product. Tau provides a small, dependable mux kernel and a clean settings surface; workflows are assembled from extensions or driven through a structured control API.

Three goals are co-equal and non-negotiable:

1. **Extreme Electron performance**: terminal latency, throughput, frame pacing, startup, idle use, and recovery are continuously measured and protected by budgets.
2. **The smallest practical distribution**: Electron creates a real runtime floor, so Tau minimizes and reports every byte above that floor instead of bundling optional workflows.
3. **Extreme extensibility**: humans and agents can create, validate, load, script, compose, and reload extensions without rebuilding Tau.

## Product Direction

Tau should feel like a composable desktop tmux:

- Any shell, REPL, TUI, or agent can run without a special adapter.
- Tabs, splits, terminal sessions, detach/reattach, and recovery are first-class.
- Pi is a normal terminal program. A Pi extension may add launchers, status, resume actions, or settings, but Pi has no privileged place in the core.
- Git, projects, worktrees, file trees, diffs, chat transcripts, remote connections, and agent-specific UI are optional extensions.
- The default app stays quiet and useful instead of accumulating built-in workflow panels.
- Agents can treat Tau as a programmable terminal substrate through TypeScript extensions and a structured CLI/RPC control plane.

Pi is the design reference for extensibility: small TypeScript modules, lifecycle events, explicit registration APIs, global and local discovery, namespaced state, hot reload, and clear trust boundaries. Tau should not copy Pi's agent-specific concepts into the mux kernel.

## Core Primitive

The core model is:

```text
Window -> Tab -> Pane -> Session
```

- **Window**: an application window and its layout.
- **Tab**: a named pane tree.
- **Pane**: a position in that tree and the host for terminal or extension content.
- **Session**: a daemon-owned process/PTY that can outlive a renderer or window.
- **Context**: optional metadata such as a directory, remote target, or profile. Context is not synonymous with a project.

The core must not require repositories, worktrees, threads, agents, or conversations.

## What Ships in Core

Core is deliberately small, but it is not empty. A usable mux requires:

- PTY/process lifecycle in `taud`.
- Persistent sessions, snapshots, attach/detach, resize, and recovery.
- Terminal rendering, input, copy/paste, search, and accessibility.
- Windows, tabs, split trees, focus, resize, move, close, and restore.
- A command registry and command palette.
- A keybinding registry with user overrides.
- A structured local control protocol and CLI for scripting mux operations.
- A settings service, settings UI, validation, defaults, and migrations.
- Extension discovery, activation, deactivation, reload, diagnostics, and trust.
- Namespaced storage and a stable capability API for extensions.

Everything outside this list must justify being core. "Convenient for one workflow" is not enough.

## Performance Is a Product Feature

Tau should not merely be fast "for Electron." It should aggressively remove Electron overhead from the terminal data path:

- `taud` owns PTYs and durable process state outside the renderer.
- Terminal bytes use the shortest practical daemon-to-renderer path and never pass through React state, settings, or ordinary extension event handlers.
- The renderer performs bounded work per frame, uses GPU acceleration where it helps, and keeps control-plane work off the terminal input/output path.
- Hidden panes detach their rendering cost without stopping their sessions.
- Extensions are lazy, timed, and isolated from input and output hot paths by default.
- Idle windows do not poll, animate, or redraw without a reason.

CI must measure and ratchet budgets for:

- Launch to first usable terminal and first output.
- Keystroke-to-PTY and echo latency percentiles.
- Sustained input/output throughput and dropped data.
- Frame-time percentiles during terminal floods and split layouts.
- Main, renderer, daemon, and extension-host memory.
- Idle CPU/wakeups and long-session growth.
- Packaged and compressed artifact size, with a per-dependency breakdown.

A change that adds a feature but violates a performance budget is incomplete. Benchmarks must exercise packaged builds as well as development mode.

## Small Distribution

Electron itself is not a small runtime, so "small binary" must be precise and honest:

- Track the Electron runtime, Tau application payload, `taud`, native modules, and optional extensions separately.
- Minimize Tau's payload above the Electron floor and publish both compressed download and installed-size numbers.
- Do not bundle Pi, agent SDKs, Git UI libraries, editors, language services, or workflow assets in core.
- Install first-party and third-party workflow extensions on demand.
- Lazy-load infrequent settings and extension-management code where it produces a measured win.
- Keep `taud` a focused native binary and avoid duplicating daemon capabilities in JavaScript.
- Reject dependencies whose value does not justify their startup, memory, and package-size cost.

Size budgets belong in CI and should ratchet downward as hardcoded workflow features are extracted.

## Agent-Native Extensibility

Agents should be able to build on Tau from inside a Tau pane. This requires more than a plugin API:

- Extensions are plain TypeScript with a no-build development path, typed APIs, schemas, and small copyable examples.
- Tau exposes machine-readable extension metadata, contribution schemas, command IDs, capabilities, and diagnostics.
- A stable `tau` control CLI and local RPC protocol can list windows/tabs/panes/sessions, invoke commands, create layouts, launch processes, subscribe to events, and request extension reloads.
- Extension validation, type checking, dry-run activation, reload, logs, and failure output are available non-interactively.
- Documentation is versioned with the installed SDK so an agent can inspect the exact API it is targeting.
- Generated extensions use the same trust and capability flow as human-authored code; agent authorship never bypasses approval.

The ideal loop is: describe a workflow, let an agent write or edit an extension, validate it, reload it, and use it immediately without restarting sessions or rebuilding Tau.

## Clean Default UI

The default UI should contain only:

- A minimal native title/tab bar.
- The active terminal pane tree.
- Small controls for tab and split operations.
- A command palette.
- A clean settings screen.
- Extension-owned surfaces only when their extension is enabled.

There should be no default chat transcript, project sidebar, file explorer, diff viewer, worktree flow, or agent dashboard. Opening Tau should immediately produce a terminal.

## Settings Foundation

Settings are the primary durable GUI surface and must be designed as a host, not a hardcoded list.

Core settings are limited to:

- **Appearance**: theme and core chrome.
- **Terminal**: font, colors, cursor, scrollback, renderer, and default shell/profile.
- **Multiplexer**: restore behavior, tab/split defaults, and close confirmation.
- **Keybindings**: searchable command-to-key mappings.
- **Extensions**: discovery paths, enablement, trust, diagnostics, and updates.

Extension settings are contributed as namespaced sections with:

- A stable extension and section ID.
- A schema and defaults.
- Optional validation and migrations.
- User or directory-local scope.
- Search metadata.
- Automatic removal from the UI when the extension is disabled, without deleting its data silently.

Core must never add Pi, Git, worktree, model, provider, or project settings. Those belong to their owning extensions.

## Extension Model

A Tau extension is a TypeScript module with a default factory, following the useful parts of Pi's model:

```ts
export default function (tau: ExtensionAPI) {
  tau.commands.register('example.open', {
    /* ... */
  })
  tau.settings.register({ id: 'example.general' /* ... */ })
  tau.launchers.register({ id: 'example.shell' /* ... */ })
  tau.on('session:started', (event, context) => {
    /* ... */
  })
}
```

Extensions should be discoverable from:

- `~/.tau/extensions/` for user extensions.
- `.tau/extensions/` for directory-local extensions after trust is granted.
- Explicit local paths and installed npm/git packages in settings.

Initial contribution points:

- Commands and keybindings.
- Terminal launch profiles and session resume providers.
- Tab and pane actions.
- Pane types and pane decorations.
- Sidebar, toolbar, status, and command-palette items.
- Settings sections.
- Themes.
- Session lifecycle hooks.
- Terminal title, cwd, environment, and output metadata adapters.
- Import/export and persistence adapters.

Later contribution points may include remote transports and terminal middleware. They require a stronger capability and isolation model and should not be rushed.

See [`docs/extension-system.md`](docs/extension-system.md) for the proposed architecture and composition rules.

## Composition Rules

Extensibility is only useful when extensions compose predictably:

- Every contribution has a stable, namespaced ID and an owning extension.
- Registration returns a disposable; deactivation removes all owned contributions.
- Commands and actions compose additively. Replacing core behavior requires an explicit override capability and user approval.
- Ordered contribution points use declared placement and deterministic tie-breaking, not load-order accidents.
- Extensions communicate through public events and capabilities, never imports from Tau internals.
- Extension state is namespaced and versioned.
- UI slots have bounded contracts. Extensions cannot place controls over Tau-owned trust or permission prompts.
- One failing extension must not prevent terminals from opening or settings from loading.

## Trust Model

Like Pi extensions, Tau extensions are code, not passive themes.

- User-installed extensions are trusted local code and must show their source and requested capabilities.
- Directory-local extensions never run before the directory is trusted.
- Process, filesystem, network, terminal input/output interception, and arbitrary UI each require visible capabilities.
- Core trust, permission, recovery, and extension-management UI cannot be replaced by extensions.
- Extension failures and slow activation are isolated, logged, and recoverable through safe mode.

The first implementation may support only trusted local extensions, but it must state that honestly rather than imply a sandbox that does not exist.

## Pi's Place

Pi is an excellent first-party example extension, not Tau's kernel.

A Pi extension can provide:

- A `pi` launch profile.
- Discovery and resume actions for Pi sessions.
- Pane status derived from Pi events when available.
- Pi-specific commands, keybindings, and settings.
- Optional widgets or metadata around the terminal.

The extension must not replace the terminal with a Tau-owned chat UI. Pi remains fully usable with no extension installed by simply running `pi` in a pane.

## Existing Feature Migration

Do not perform a destructive rewrite. Keep the proven PTY and mux work, then extract workflow-specific code behind public extension contracts.

### Keep in core

- `taud` PTY ownership and stream protocol.
- Terminal renderer and attach/recovery path.
- Pane layout and split behavior.
- Core session persistence.

### Extract into first-party extensions

- Projects/workspaces sidebar.
- Pi thread discovery and resume behavior.
- Git status, changes, diff, and file tree views.
- Worktree creation and management.
- Agent-specific status and actions.

### Remove rather than extract

- Any planned default chat renderer.
- Project/thread terminology in generic mux APIs.
- Assumptions that every pane belongs to a repository or Pi session.

Compatibility readers can preserve existing layouts while the domain model migrates from workspace/tab records to window/tab/pane/session records.

## Implementation Backlog

### 1. Freeze the old pivot and set budgets

- Remove Pi-chat-first claims from product docs and package descriptions.
- Stop adding chat, project, Git, or worktree features to core.
- Classify every current UI feature as core, first-party extension, compatibility shim, or removal.
- Record packaged-build baselines for latency, startup, throughput, frame pacing, memory, idle use, and artifact size.
- Put regression budgets and artifact-size breakdowns in CI before adding new framework code.

### 2. Stabilize the mux kernel

- Make a plain shell the zero-configuration startup path.
- Remove workspace IDs as a requirement for tabs and panes.
- Define stable window, tab, pane, session, and context schemas.
- Keep layout migrations for existing users.

### 3. Build settings as a host

- Add core setting definitions with typed defaults and migrations.
- Build searchable navigation from registered setting sections.
- Add namespaced extension settings and scope handling.
- Add safe mode and extension diagnostics to the Extensions page.

### 4. Build the extension runtime

- Define `ExtensionAPI`, lifecycle events, contribution registries, disposables, and capability declarations.
- Implement user extension discovery and explicit local paths first.
- Support a no-build TypeScript authoring loop with validation, dry-run activation, reload, and structured diagnostics.
- Generate machine-readable API and contribution metadata from the same source as the SDK types.
- Add activation timeouts, failure isolation, lazy activation, reload, and diagnostics.
- Add directory-local trust before enabling `.tau/extensions/`.

### 5. Build the automation control plane

- Define a versioned local RPC protocol shared by the control CLI and extensions where appropriate.
- Add structured list, create, split, focus, launch, invoke-command, subscribe, and reload operations.
- Keep session/process operations owned by `taud` and window/layout operations owned by the desktop host.
- Support JSON input/output and useful exit codes so agents do not need to scrape UI text.
- Ensure control clients cannot bypass extension capabilities or directory trust.

### 6. Prove composition and agent authoring

- Ship example extensions that each use more than one contribution point.
- Verify two extensions can contribute commands, settings, status, and pane actions without relying on load order.
- Have an agent build, validate, load, exercise, and revise an extension using only installed docs and CLI introspection.
- Verify disable/reload removes contributions and leaves live terminal sessions intact.
- Verify extension activation and event traffic stay within terminal latency and memory budgets.

### 7. Extract current workflows

- Extract projects, Git, worktrees, and Pi integration one vertical slice at a time.
- Keep compatibility shims until saved layouts migrate.
- Delete the old hardcoded implementation after each extracted extension reaches parity.

## Smallest Credible Demo

The pivot is proven when Tau can:

1. Open directly into a shell without creating a project.
2. Create tabs and horizontal/vertical splits.
3. Detach, restart the window, and reattach to live sessions.
4. Meet published packaged-build budgets for startup, latency, throughput, frame pacing, memory, idle use, and artifact size.
5. Change core terminal and mux settings in a clean settings UI.
6. Discover and load a local no-build TypeScript extension.
7. Let that extension add a command, launcher, status item, and settings section.
8. Let an agent inspect the installed API, generate the extension, validate it, and reload it through structured CLI commands.
9. Script tabs, panes, sessions, commands, and events through JSON CLI/RPC without scraping the UI.
10. Reload or disable the extension and remove those contributions cleanly without killing sessions.
11. Run Pi normally in any pane.
12. Optionally enable a Pi extension for Pi-specific convenience without changing the core experience.

## Non-goals

- A built-in graphical chat client.
- A Pi-only shell or Pi-owned persistence model.
- A generic IDE bundled into core.
- A required project/worktree workflow.
- An unrestricted renderer plugin API with no trust boundary.
- A marketplace before local extension loading, recovery, and composition are dependable.

## Decisions

- Tau is a terminal multiplexer, not a chat UI.
- Extreme Electron performance, minimal payload, and extreme extensibility are co-equal product requirements.
- The terminal is primary and universal.
- Pi is optional and extension-owned.
- The core ships a clean settings host, mux primitives, and a structured automation control plane.
- Workflow features are extensions installed on demand.
- Extension APIs use explicit contribution points and lifecycle events.
- Humans and agents use the same typed, inspectable, trust-gated extension system.
- Composition, unloadability, trust, recovery, performance, and size are requirements, not later polish.

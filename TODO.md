# Tau TODO

Tau is a performance-first, agent-extensible graphical terminal multiplexer.

The work is intentionally ordered:

1. **Remove everything that is not required for a terminal multiplexer.**
2. **Secure and prove the mux foundation before adding extensibility.**
3. Build the minimal desktop mux experience and settings host.
4. Add the structured control plane and extension runtime.
5. Reintroduce workflows only as optional extensions.

Do not begin broad extension or workflow work until Phases 1 and 2 meet their exit criteria.

## Non-negotiable constraints

- Terminal bytes never flow through React state or ordinary extension handlers.
- `taud` owns durable PTYs and canonical mux state.
- Renderer, window, and extension failures never kill live sessions.
- Core starts without a project, repository, worktree, agent, or extension.
- Core actions are addressable through stable commands and structured control APIs.
- Disabled extensions have zero startup, process, timer, and renderer-frame cost.
- Tau reports its payload separately from Electron's runtime floor.
- Performance claims come from packaged-build measurements on reference hardware.
- Security and trust UI remain Tau-owned and cannot be replaced by extensions.

## Existing foundation to preserve

- [x] Zig daemon owns PTYs and process lifecycle.
- [x] Binary daemon attach stream.
- [x] Renderer MessagePort bridge.
- [x] Daemon screen snapshots and event logs.
- [x] xterm.js WebGL renderer with fallback.
- [x] Split-pane layout implementation.
- [x] Session attach/detach and recovery scaffolding.
- [x] Terminal latency, throughput, startup, renderer, soak, and smoke benchmarks.
- [x] File-backed settings and layout persistence scaffolding.

# Phase 1 — Strip Tau to the mux kernel

## Goal

At the end of this phase, Tau opens directly into a shell and contains only terminal, tab, split, session, command, settings, and recovery foundations. Workflow-specific code is removed, not hidden behind flags.

Git history is the archive. Do not retain dead implementations in core for a possible future extension.

## 1.1 Freeze the removal boundary

- [x] Write a one-page inventory classifying every current feature as:
  - [x] Required mux core.
  - [x] Temporary migration code.
  - [x] Delete now.
  - [x] Rebuild later as an extension.
- [x] Decide whether any existing user data requires a one-time export or migration.
- [x] If migration is required, define its removal version before writing compatibility code.
- [x] Add a rule that deleted workflows may return only through public extension APIs.

## 1.2 Remove product assumptions

- [x] Remove the requirement to add or select a project before opening a terminal.
- [x] Remove workspace IDs as required fields for tabs, panes, and sessions.
- [x] Remove worktree IDs from generic terminal creation and attachment.
- [x] Remove thread/conversation terminology from mux APIs.
- [x] Remove agent-provider fields from generic pane and session schemas.
- [x] Replace optional directory/project metadata with a neutral `cwd` or context record.
- [x] Make a plain shell the zero-configuration and first-run path.

## 1.3 Remove workflow UI

- [x] Delete the projects/workspaces sidebar.
- [x] Delete project/thread search.
- [x] Delete project add, remove, reorder, and nested thread controls.
- [x] Delete worktree controls and worktree-specific UI state.
- [x] Delete the Git/file/changes right sidebar.
- [x] Delete the file tree.
- [x] Delete diff and changed-files views.
- [x] Delete Git branch, pull-request, port, staging, and revert UI.
- [x] Delete Pi thread import and Pi-specific opening/status UI.
- [x] Delete agent-specific archive/resume presentation from the core terminal pane.
- [x] Remove `changes` and `webview` pane types from the core pane schema for now.
- [x] Keep only terminal panes until the extension pane contract exists.
- [x] Reduce the default shell to title/tab controls, terminal panes, command entry, and settings.

## 1.4 Remove workflow services

- [x] Delete renderer workspace metadata caches and workspace queries.
- [x] Delete diff parser workers and clients from core.
- [x] Delete Git state watchers from Electron main.
- [x] Delete workspace, worktree, Git, pull-request, file-tree, and port IPC handlers.
- [x] Delete Pi thread discovery IPC from core.
- [x] Delete bundled Pi/Codex/Claude adapter behavior from `taud`.
- [x] Delete workspace/worktree daemon commands and protocol frames.
- [ ] Delete workspace/worktree persistence tables and migrations if no supported migration requires them.
- [x] Delete workflow-specific protocol fixtures and tests after replacing any shared mux coverage.
- [x] Keep generic process title, cwd, exit, resize, and terminal notification signals only.

## 1.5 Remove dependencies and assets

- [x] Remove `@pierre/diffs` from core.
- [x] Remove `@pierre/trees` from core.
- [x] Remove dependencies used only by deleted workflow surfaces.
- [x] Audit `react-icons`; replace core usage with a tiny curated SVG set if packaging measurements justify it.
- [x] Audit `react-resizable-panels` and remove it if the mux shell does not use it.
- [x] Audit Tailwind integration and remove it if the renderer uses only authored CSS.
- [ ] Audit the copied Ghostty WASM artifact and remove it if the renderer does not use it.
- [ ] Subset or replace the bundled Nerd Font symbols.
- [x] Remove deleted workflow assets, screenshots, fixtures, benchmarks, and documentation.
- [x] Regenerate the lockfile and capture dependency-size changes.

## 1.6 Simplify the renderer

- [x] Split the monolithic `App.tsx` into a small shell, tab strip, pane tree, terminal pane, and settings route.
- [x] Do not replace the monolith with global React contexts that rerender terminal panes.
- [x] Keep terminal creation, input, output, fit, and rendering imperative.
- [x] Remove selectors, effects, and callbacks that exist only for projects, Git, worktrees, Pi, and diffs.
- [x] Remove unconditional daemon diagnostics polling from the app shell.
- [x] Poll diagnostics only while diagnostics UI is visible, then replace polling with events in Phase 2.
- [ ] Remove decorative animations that continue while idle.
- [ ] Verify a terminal output flood causes no React commits.

## 1.7 Clean the terminal data path

- [x] Remove the duplicate production output dispatch through both `handleSessionOutput` and `handlePtyData`.
- [x] Keep benchmark observers explicit and inactive outside benchmark runs.
- [x] Stop buffering compatibility output for channels with no subscriber.
- [x] Separate data-plane decoding from control-plane schema validation.
- [x] Inventory every allocation, encoding, copy, callback, and scheduler hop from PTY read to xterm write.
- [ ] Add trace markers at daemon read, main receipt, renderer receipt, xterm write completion, and render completion.
- [x] Document the current byte path before redesigning it in Phase 2.

## 1.8 Make production builds real production builds

- [ ] Add explicit debug, `ReleaseFast`, and `ReleaseSmall` daemon build modes.
- [ ] Select the packaged daemon mode from measured startup, throughput, RSS, and size results.
- [ ] Strip the packaged daemon and retain separate symbols for diagnostics.
- [ ] Measure SQLite, FTS5, libghostty-vt, and debug metadata contributions to daemon size.
- [ ] Remove production source maps from shipped artifacts or publish them separately.
- [x] Generate an artifact inventory for Electron, Tau JS/CSS, `taud`, fonts, WASM, native modules, and extensions.

## 1.9 Remove obsolete tests and preserve core coverage

- [x] Delete workspace metadata benchmarks.
- [x] Delete file-tree benchmarks.
- [x] Delete Git watcher tests.
- [x] Delete workspace service tests.
- [x] Keep and strengthen latency, input-priority, attach, renderer, IPC, startup, reload, and soak tests.
- [ ] Add a shell-only packaged smoke test.
- [x] Add a test proving no project or agent metadata is needed to create a session.
- [x] Add a test proving deleted workflow modules are absent from the renderer bundle.

## Phase 1 exit criteria

- [x] Fresh install opens directly into a usable shell.
- [x] Tabs and splits function without projects or workspaces.
- [x] Core schemas contain no required project, worktree, thread, or agent concepts.
- [x] Renderer bundle contains no Git, diff, file-tree, worktree, or Pi UI code.
- [x] Daemon starts no Git, workspace, worktree, or agent adapter services.
- [x] Idle app performs no workflow polling.
- [x] Production artifact report is checked into CI output.
- [x] All core tests pass after deleted workflow tests and dependencies are removed.
- [ ] A packaged baseline is recorded for startup, latency, throughput, frame pacing, RSS, idle CPU, and size.

# Phase 2 — Secure and prove the mux foundation

## Goal

At the end of this phase, `taud` is the authoritative, versioned, crash-resistant mux server. Electron is a disposable client. Terminal I/O is lossless at the authoritative layer, bounded at every queue, and isolated from UI and future extension code.

“Secure” includes correctness, lifecycle safety, protocol safety, resource bounds, crash recovery, and local security—not only authentication.

## 2.1 Define mux invariants

- [x] Write invariants before implementing the new graph:
  - [x] Session identity is independent from pane identity.
  - [x] IDs are opaque, stable, never positional, and never silently reused.
  - [x] Every pane belongs to exactly one valid pane tree.
  - [x] Every split has exactly two valid children and a bounded ratio.
  - [x] Closing a pane and terminating a session are distinct operations.
  - [x] Renderer disconnect never implies session termination.
  - [x] Every graph mutation increments a monotonic revision.
  - [x] Every emitted event has a monotonic sequence.
  - [x] Authoritative PTY input and output are never silently dropped.
  - [x] Resource use is bounded per session and per client.
- [x] Encode graph invariants in constructors and mutation functions, not UI assumptions.
- [ ] Add property tests that generate and mutate random pane trees.

## 2.2 Define the canonical domain model

- [x] Define versioned schemas for:
  - [x] Client/window reference.
  - [x] Tab.
  - [x] Pane tree and split ratio.
  - [x] Pane surface.
  - [x] Terminal session.
  - [x] Session attachment.
  - [x] Optional neutral context metadata.
  - [x] Session lifecycle state.
  - [x] Graph revision and event sequence.
- [x] Decide whether one session may attach to multiple panes.
- [x] Define detach, terminate, archive, forget, and clear-history semantics.
- [x] Define ownership when multiple clients control the same graph.
- [x] Define expected-revision behavior for conflicting mutations.
- [x] Define how unavailable future extension pane types are represented safely.

## 2.3 Move mux truth into `taud`

- [x] Store the canonical tab and pane graph in `taud`.
- [x] Make renderer state a subscribed projection, never the authority.
- [x] Add atomic graph snapshots.
- [x] Add ordered graph events after each committed mutation.
- [ ] Add snapshot-plus-event replay for newly connected or recovering clients.
- [ ] Detect event gaps and require a fresh snapshot.
- [ ] Persist graph state atomically with schema versions and checksums.
- [ ] Recover from a truncated or corrupt latest snapshot using the previous valid checkpoint.
- [x] Keep unknown future/extension metadata lossless.
- [x] Migrate or discard old layout state according to the Phase 1 decision.

## 2.4 Build a dedicated terminal fast lane

- [x] Separate the terminal data plane from the validated command/control plane.
- [ ] Prototype a dedicated MessagePort per visible session.
- [ ] Transfer `ArrayBuffer`/`Uint8Array` output rather than cloning JavaScript strings.
- [ ] Write bytes directly through xterm's byte-capable API where correctness permits.
- [ ] Validate session/channel setup once rather than schema-decoding every output chunk.
- [ ] Transfer snapshots as binary, never base64.
- [ ] Send input bytes through the reverse fast channel.
- [x] Keep control messages, errors, titles, and lifecycle events on the typed control plane.
- [ ] Benchmark dedicated ports against a multiplexed binary port before freezing the design.
- [ ] Measure all copies and allocations instead of assuming transfer is zero-copy.

## 2.5 Guarantee authoritative output correctness

- [ ] Remove arbitrary renderer output dropping.
- [ ] Add renderer acknowledgement of the latest applied output sequence.
- [ ] Keep authoritative output in daemon state/event logs until persistence policy permits cleanup.
- [ ] When renderer lag exceeds budget, send a complete current-screen snapshot and resume after its sequence.
- [ ] Never splice or discard arbitrary bytes inside an ANSI/UTF-8 sequence.
- [ ] Distinguish authoritative output loss from intentionally skipped obsolete presentation frames.
- [ ] Add corruption tests for split UTF-8, CSI, OSC, DCS, images, and resize sequences.
- [ ] Add a flood test that forces snapshot resynchronization and verifies the final screen exactly.
- [ ] Make queue age and acknowledged sequence visible in diagnostics.

## 2.6 Bound memory and hidden-session cost

- [ ] Define hard per-session and global queue budgets.
- [ ] Define whether backpressure blocks the child process or triggers renderer resynchronization.
- [ ] Keep daemon screen state bounded by terminal dimensions and configured scrollback policy.
- [ ] Replace unlimited parked xterm runtimes with a small measured LRU cache.
- [ ] Unsubscribe and dispose old hidden terminal renderers while keeping daemon sessions alive.
- [ ] Rehydrate disposed renderers from daemon snapshots.
- [ ] Ensure renderer CPU/GPU cost scales with visible panes plus the explicit warm cache, not total sessions.
- [ ] Add 10-, 100-, and 500-session detached scaling tests.
- [ ] Add visible-pane limits or degradation behavior for layouts too dense to render usefully.

## 2.7 Secure daemon lifecycle

- [ ] Make daemon startup/connect ownership deterministic under concurrent app launches.
- [ ] Harden PID file and socket creation against stale files and symlink races.
- [x] Use private storage directories and restrictive socket/file permissions.
- [ ] Verify local peer identity where supported (`getpeereid`, `SO_PEERCRED`, or equivalent).
- [x] Add a protocol handshake with version, capabilities, build ID, and compatibility result.
- [x] Reject incompatible clients without corrupting or killing live sessions.
- [ ] Make restart, replace, reuse, and detach behavior explicit and idempotent.
- [ ] Ensure process groups and child cleanup follow documented detach/terminate semantics.
- [ ] Test daemon crash during create, attach, resize, persistence, and graph mutation.
- [ ] Test Electron crash during every session lifecycle stage.

## 2.8 Secure protocol boundaries

- [x] Use separate control and stream protocols or clearly separated frame types.
- [x] Validate all control inputs at the daemon boundary.
- [ ] Enforce maximum frame, argv, environment, path, title, metadata, and subscription sizes.
- [ ] Enforce per-client rate, queue, and outstanding-request limits.
- [ ] Use structured error codes without leaking secrets or arbitrary environment data.
- [ ] Redact credentials and sensitive environment variables from logs, snapshots, resume metadata, and diagnostics.
- [x] Use argv arrays; never interpolate untrusted values into shell strings.
- [ ] Normalize and validate cwd paths without silently broadening access.
- [ ] Reject malformed frames without terminating unrelated sessions or the daemon.
- [ ] Fuzz control decoding, stream parsing, graph mutations, and persistence recovery.

## 2.9 Secure the Electron client

- [x] Keep `contextIsolation` enabled.
- [x] Keep Node integration disabled in the terminal renderer.
- [ ] Enable renderer sandboxing unless a measured required feature prevents it.
- [x] Add a restrictive Content Security Policy.
- [x] Expose the smallest possible preload API.
- [x] Remove workflow IPC from preload after Phase 1.
- [x] Do not expose filesystem, process, or socket primitives directly to renderer code.
- [ ] Validate control responses before applying them to UI state.
- [x] Keep OS trust, permission, recovery, and diagnostics UI in the core renderer.
- [ ] Add tests proving web content cannot access terminal control ports or privileged preload methods.

## 2.10 Make idle truly idle

- [ ] Replace process-title polling with OSC/process lifecycle events where possible.
- [x] Replace renderer diagnostics polling with subscriptions or on-demand reads.
- [ ] Trigger cleanup from lifecycle events with only a coarse unref'd safety sweep.
- [ ] Stop resize observers, animations, cursors, and render loops for disposed hidden terminals.
- [ ] Add idle wakeup counts to benchmarks.
- [ ] Add a test that leaves 100 detached sessions idle with no renderer-side per-session timers.

## 2.11 Establish strict performance SLOs

Keep smoke ceilings, but add competitive performance gates.

- [x] Define reference hardware, OS, power mode, display refresh rate, and packaged build configuration.
- [x] Freeze SLOs for:
  - [x] Daemon input round-trip p50/p95/p99.
  - [x] Key-to-display p50/p95/p99.
  - [x] Input latency during output floods.
  - [x] PTY spawn and attach latency.
  - [x] Output throughput and final-screen correctness.
  - [x] Frame-time percentiles with one, four, and eight visible panes.
  - [x] Renderer memory versus visible and detached session counts.
  - [x] Idle CPU and wakeups.
  - [x] Renderer/daemon restart recovery time.
  - [x] Core artifact size excluding and including Electron.
- [ ] Ratchet current loose smoke thresholds into separate strict performance thresholds.
- [ ] Run PR-relative benchmarks and nightly absolute benchmarks on dedicated hardware.
- [ ] Save raw samples, traces, machine metadata, dependency lock, and commit with every result.
- [ ] Extend cross-terminal benchmarks to pinned cmux and Herdr versions where scenarios are comparable.
- [ ] Never use estimated parser throughput as an end-to-end product claim.

## 2.12 Prove recovery and concurrency

- [ ] Renderer reload during sustained output.
- [ ] Renderer crash with multiple live sessions.
- [ ] Electron main crash with detached daemon.
- [ ] Extension-host crash placeholder, before extensions are implemented.
- [ ] Two clients mutate the same pane tree concurrently.
- [ ] Client disconnects before receiving a mutation result.
- [ ] Resize storms while attaching and snapshotting.
- [ ] Session exits while a renderer is resynchronizing.
- [ ] Corrupt event-log tail and corrupt graph snapshot.
- [ ] Disk full during persistence.
- [ ] Socket backpressure and slow/malicious client.
- [ ] Protocol downgrade and upgrade behavior.
- [ ] Overnight high-output soak with repeated renderer restarts.

## Phase 2 exit criteria

- [ ] `taud` is the authoritative owner of sessions and mux graph state.
- [ ] Electron can be killed and reopened without losing live sessions or layout state.
- [ ] Core UI contains no direct authoritative layout mutations.
- [ ] Terminal input/output fast lane bypasses React, ordinary IPC calls, and per-chunk schema decoding.
- [ ] Authoritative output loss is zero in all enforced tests.
- [ ] Renderer lag recovers through sequence-aware snapshot resynchronization.
- [ ] Renderer resource cost scales with visible panes, not total sessions.
- [ ] Local sockets, storage, protocol limits, and Electron boundaries pass security tests.
- [ ] Randomized pane-tree/property tests pass.
- [ ] Protocol and persistence fuzz tests pass.
- [ ] Packaged builds meet strict startup, latency, frame, memory, idle, recovery, and size SLOs.
- [ ] A 100-session test passes with bounded renderer memory and no per-session idle polling.

# Phase 3 — Minimal desktop mux and settings

Begin only after Phase 2 is stable.

- [ ] Build a minimal native-feeling tab strip/sidebar for many sessions.
- [ ] Support create, rename, move, swap, split, resize, zoom, focus, detach, and close.
- [ ] Build every interaction on stable commands, not direct state mutations.
- [ ] Add a fast command palette.
- [ ] Add searchable keybindings with conflict detection.
- [ ] Add generic pane attention/unread state without making agents a core concept.
- [ ] Support appropriate terminal-originated OSC notifications.
- [ ] Add jump-to-latest-attention and acknowledge commands.
- [ ] Build registered Appearance, Terminal, Multiplexer, Keybindings, and Extensions settings sections.
- [ ] Add settings validation, defaults, migrations, reset, import, and export.
- [ ] Store secrets in the OS credential store.
- [ ] Verify settings and command UI do not rerender terminal surfaces.

## Phase 3 exit criteria

- [ ] Tau is excellent as a plain terminal multiplexer with no extensions.
- [ ] All GUI actions use the same stable command registry planned for automation.
- [ ] Generic notifications make many concurrent terminal tasks manageable.
- [ ] Settings remain small, fast, searchable, and independent from workflow features.

# Phase 4 — Structured automation and extension runtime

## 4.1 Universal control plane

- [ ] Expose every core command through a versioned local control protocol.
- [ ] Add `tau ctl --json` as the canonical automation interface.
- [ ] Support list, create, split, move, focus, resize, launch, attach, detach, invoke, subscribe, and reload operations.
- [ ] Return stable IDs, protocol versions, structured results, and diagnostic codes.
- [ ] Add safe caller context and explicit target IDs.
- [ ] Add `--no-focus` for background operations.
- [ ] Inject `TAU_SOCKET_PATH`, `TAU_WINDOW_ID`, `TAU_TAB_ID`, `TAU_PANE_ID`, and `TAU_SESSION_ID`.
- [ ] Ensure automation cannot bypass trust or capabilities.

## 4.2 Extension SDK and host

- [ ] Create a versioned `@tau/sdk` from canonical schemas.
- [ ] Define lifecycle, events, registries, contributions, disposables, and capabilities.
- [ ] Run extensions in a lazy dedicated host process, never the terminal renderer.
- [ ] Prototype Node's built-in TypeScript stripping before adding a transpiler dependency.
- [ ] Support user-local extensions and explicit local paths first.
- [ ] Add activation timeouts, cancellation, automatic cleanup, logs, and safe mode.
- [ ] Keep the extension host stopped when no extensions are enabled.
- [ ] Keep project-local extensions disabled until directory trust exists.
- [ ] Do not claim sandboxing before process/RPC enforcement exists.

## 4.3 Initial safe contribution points

- [ ] Commands.
- [ ] Default keybindings.
- [ ] Launch profiles.
- [ ] Schema-rendered settings.
- [ ] Status items.
- [ ] Tab and pane actions.
- [ ] Command-palette sources.
- [ ] Bounded lifecycle events.
- [ ] Namespaced versioned storage.

## 4.4 Agent authoring loop

- [ ] Install version-matched types, Markdown docs, examples, and JSON schemas.
- [ ] Add structured API inspection.
- [ ] Add extension validation and dry-run activation.
- [ ] Add atomic hot reload where possible.
- [ ] Add structured extension logs and source-located diagnostics.
- [ ] Add a small Tau agent skill for safe control and extension authoring.
- [ ] Test an agent creating, validating, loading, revising, and unloading an extension without rebuilding Tau or restarting sessions.

# Phase 5 — Optional first-party extensions

Rebuild these from public APIs. Do not move old private implementations back into core.

- [ ] `@tau/agents`: process detection, working/blocked/done state, notifications, and resume providers.
- [ ] `@tau/pi`: Pi launch, discovery, resume, status, commands, and settings.
- [ ] `@tau/projects`: optional directory/project navigation.
- [ ] `@tau/git`: branch, status, file tree, changes, staging, and diff surfaces.
- [ ] `@tau/worktrees`: optional worktree lifecycle and sandbox workflows.
- [ ] `@tau/browser`: isolated Chromium pane and browser automation.
- [ ] `@tau/ssh`: remote launch profiles and transports.
- [ ] Keep every extension lazy and separately measured.
- [ ] Verify disabling an extension removes contributions without killing terminal sessions.

# Phase 6 — Composition, packaging, and distribution

- [ ] Require namespaced IDs and ownership for every contribution.
- [ ] Make every registration disposable.
- [ ] Resolve UI placement deterministically with explicit anchors.
- [ ] Require explicit approval and fallback for overrides.
- [ ] Rate-limit and coalesce extension UI updates.
- [ ] Isolate custom panes in separate sandboxed renderer processes.
- [ ] Test slow, crashing, leaking, and noisy extensions.
- [ ] Report Electron runtime, core Tau payload, daemon, SDK, and extensions separately.
- [ ] Install workflow extensions on demand with pinned versions and integrity metadata.
- [ ] Add extension update rollback.
- [ ] Delay a marketplace until trust, safe mode, diagnostics, and deterministic unload are proven.

# Competitive definition of done

Tau can credibly rival cmux and Herdr when:

- [ ] Plain Tau is an excellent, fast, durable terminal multiplexer.
- [ ] Arbitrary shell processes survive renderer and window restarts.
- [ ] Every core action is available through GUI commands and structured automation.
- [ ] Stable IDs, caller context, structured errors, and safe background targeting are standard.
- [ ] Renderer cost scales with visible panes rather than total sessions.
- [ ] A failing extension cannot block terminal input or destroy a session.
- [ ] An agent can build and hot-reload a useful extension from installed documentation.
- [ ] Agent, browser, project, Git, worktree, Pi, and SSH features are optional and add no disabled cost.
- [ ] Reproducible packaged-build performance and artifact-size results are public.
- [ ] Core and certified-extension performance SLOs are enforced on dedicated hardware.

# Deferred non-goals

- [ ] No default graphical chat client.
- [ ] No Pi or agent kernel.
- [ ] No project/worktree requirement.
- [ ] No workflow-specific settings in core.
- [ ] No unrestricted React/Electron extension API.
- [ ] No ordinary extension events on the terminal byte path.
- [ ] No claim that an Electron desktop bundle is smaller than a single native Herdr binary.
- [ ] No marketplace before the foundation and trust model are proven.

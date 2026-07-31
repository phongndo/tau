# Terminal and multiplexer parity roadmap

Research date: 2026-07-30

## Recommendation

Tau should target **excellent terminal-multiplexer parity**, not feature-for-feature parity with an agent workspace.

The shortest high-quality path is:

1. Lock down terminal correctness and input regression gates.
2. Complete core mux actions and expose them through one command registry.
3. Add configurable keybindings, profiles, appearance, accessibility, shell integration, and durable scrollback navigation.
4. Add attention/notification and selection workflows through neutral core APIs.
5. Defer remote domains and advanced terminal protocols until the local mux passes packaged performance and soak gates.

Do not move terminal bytes through React, ordinary extension events, or schema decoding. `taud` remains the owner of PTYs, graph state, sequence numbers, snapshots, and durable history.

## What T3 Code actually provides

T3 Code's current terminal drawer includes:

- Multiple terminals.
- Horizontal and vertical splits.
- Terminal creation, close, and delete actions.
- Context-sensitive configurable shortcuts.
- Fit/resize handling.
- URL and filesystem-path activation.
- Selection copy.
- An application-specific “Add to chat” selection action.

Its source and keybinding documentation show these directly:

- [T3 Code terminal drawer](https://raw.githubusercontent.com/pingdotgg/t3code/main/apps/web/src/components/ThreadTerminalDrawer.tsx)
- [T3 Code keybindings](https://raw.githubusercontent.com/pingdotgg/t3code/main/docs/user/keybindings.md)

T3 Code is a useful UX reference, but not the terminal-correctness ceiling. Its issue history also demonstrates two traps Tau should test explicitly:

- A non-cell-safe `lineHeight: 1.2` broke terminal-rendered QR codes; it was changed to `1` ([issue #336](https://github.com/pingdotgg/t3code/issues/336)).
- A terminal shortcut worked outside xterm but failed while xterm owned focus on Windows; capture-phase interception fixed it ([issue #2113](https://github.com/pingdotgg/t3code/issues/2113)).

Tau should reproduce the generic interactions, not T3 Code's thread, worktree, provider, or chat coupling. “Add selection to chat” belongs behind a public extension command accepting a bounded text selection.

## Broader parity target

T3 parity alone is too narrow. WezTerm's documented baseline includes local and remote mux panes/tabs/windows, searchable scrollback, hyperlinks, selection, bracketed paste, mouse reporting, rich text attributes, hot-reloaded configuration, and graphics protocols ([WezTerm features](https://wezterm.org/features.html)).

Ghostty distinguishes two useful parity layers:

- End-user features: windows, tabs, splits, ligatures, native integration.
- Application protocols: Kitty graphics and keyboard protocols, synchronized rendering, and theme notifications.

That distinction should shape Tau's sequencing ([Ghostty features](https://ghostty.org/docs/features)).

## Tau's current baseline

Tau already has important pieces that should be preserved:

- Durable daemon-owned PTYs and mux graph.
- Binary per-session output lanes with sequencing, acknowledgements, and snapshot resync.
- Tabs, horizontal/vertical splits, close, directional focus, and terminal search commands.
- xterm.js WebGL rendering with context-loss fallback.
- Unicode 11 and grapheme addons.
- Search, web links, image, and clipboard addons.
- A 10,000-row in-renderer scrollback buffer.
- Durable event logs, current-screen snapshots, and daemon search metadata.
- Hidden-terminal runtime LRU disposal.
- Packaged performance SLOs.

The main parity gaps are product surface and validation rather than raw terminal rendering.

## Prioritized roadmap

### P0 — Correctness before new surface area

These are release blockers, not optional polish.

- Make packaged input-echo validation mandatory by default; a disabled input probe allowed a terminal-input regression to pass smoke testing.
- Test renderer → preload → MessagePort → main → stream → daemon → PTY input as an end-to-end path.
- Keep output as transferable `ArrayBuffer`; benchmark any input representation separately because input is latency-sensitive but low-volume.
- Add protocol upgrade tests with an old persistent daemon, including capability mismatch, no retry storm, preserved live sessions, and an explicit upgrade choice.
- Add VT conformance fixtures covering cursor movement, erase, alternate screen, SGR, OSC title/color/link handling, bracketed paste, mouse modes, wide/combining characters, emoji, and resize reflow.
- Add IME, dead-key, Alt/Option, Ctrl, function-key, Windows, macOS, and Linux keyboard matrices.
- Add malformed and oversized OSC/DCS/APC/CSI fuzzing and bounded parser/resource assertions.
- Add golden screenshots for box drawing, Powerline, QR codes, wide glyphs, ligatures, and selection.
- Enforce packaged key-to-display, flood-input, attach, memory, and idle SLOs before enabling each feature by default.

xterm.js publishes an explicit sequence support table; use it as the starting compatibility matrix rather than relying on visual smoke tests ([xterm.js VT features](https://xtermjs.org/docs/api/vtfeatures/)).

### P1 — Complete the local mux interaction model

Implement all actions as versioned commands against daemon authority:

- Create, rename, close, kill, archive, and detach session.
- Split horizontally/vertically.
- Resize split, equalize splits, zoom/unzoom pane.
- Move and swap panes.
- Move panes across tabs/windows.
- Directional and indexed focus.
- Reopen recently closed layout references when the session still exists.
- Duplicate pane with an explicit choice between attaching the same session and launching a new session.
- Drag/drop backed by the same commands, never separate direct mutations.
- Context menus that invoke registered commands.

Quality gates:

- Optimistic revision conflicts and two-client mutation tests for every graph command.
- Keyboard-only access to every action.
- No terminal-surface remount for graph operations that do not replace the session.
- Undo is limited to graph mutations that are safe and revision-valid; never pretend a killed process can be undone.

### P1 — Command palette and keybindings

T3 Code's strongest transferable idea is context-sensitive commands. Tau should add:

- A single command registry used by menus, palette, keybindings, automation, and extensions.
- Searchable command palette with stable command IDs.
- User keybindings with platform defaults, chord support, conflict detection, reset, import/export, and diagnostics.
- Context expressions such as `terminalFocus`, `terminalOpen`, `paneZoomed`, `tabCount`, and `selectionActive`.
- A clear precedence model between terminal input and app commands.
- An xterm custom-key handler plus capture-phase app handling where platform behavior requires it.
- A visible shortcut inspector showing why a command did or did not match.

Never capture ordinary shell keystrokes merely because they resemble an application shortcut.

### P1 — Terminal interaction polish

- Search UI with next/previous, regex, case sensitivity, whole word, match count, overview ruler, and keyboard navigation.
- Copy, copy as HTML, paste, select all, clear viewport, clear scrollback, and reset terminal.
- Platform-correct word/line selection and forced selection while mouse reporting is active.
- Safe URL activation and file-path activation through validated main-process handlers.
- Configurable “open file at line/column” resolver as a neutral command.
- Selection action menu with Copy and extension-contributed actions; no core chat dependency.
- Tab/pane title editing, process title display, cwd display, and title source policy.
- Optional quick-terminal window/panel after the normal window lifecycle is proven.

### P2 — Settings, profiles, and accessibility

Tau currently persists only durability settings. Add registered sections for:

- **Appearance:** font family/size/weight, theme, cursor, opacity, padding, bell, ligatures.
- **Terminal:** scrollback limit, shell integration, copy/paste policy, mouse behavior, Unicode width policy.
- **Multiplexer:** tab placement, split behavior, close confirmation, restore policy, hidden-runtime LRU size.
- **Keybindings:** searchable bindings and conflicts.
- **Profiles:** argv, cwd policy, environment allowlist, icon/color, startup title.

Defaults must preserve cell geometry: line height `1`, no fractional letter spacing unless validated, and no transparency by default.

Accessibility work:

- Expose xterm.js `screenReaderMode` rather than permanently disabling it.
- Offer a WCAG-AA contrast mode using `minimumContrastRatio: 4.5`.
- Announce pane/tab changes, process exit, search counts, and recovery state without announcing raw terminal floods.
- Respect reduced motion and system light/dark preferences.
- Test VoiceOver and NVDA paths.
- Maintain visible focus independent of terminal cursor visibility.

xterm.js explicitly documents screen-reader support, minimum contrast controls, forced selection, scrollback, and security requirements for link handlers ([xterm.js terminal options](https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/)).

Settings changes must update live xterm instances through a narrow runtime API. They must not flow output through React or recreate PTYs.

### P2 — Shell integration and durable navigation

Implement shell integration as a capability, not a shell assumption:

- OSC 7 current working directory.
- OSC 133 command prompt/start/executed/finished marks.
- Command duration and exit status.
- Jump to previous/next prompt.
- Select/copy command output.
- Relaunch in cwd and split in cwd.
- Command-complete attention signals.

Keep raw escape handling bounded in `taud`/the VT layer. Publish only normalized, rate-limited metadata to UI subscribers.

Durable history should support:

- Paged retrieval from daemon event logs without replaying the entire stream through React.
- Search across live and archived sessions.
- Jump from search result to a sequence/time range.
- Clear-history semantics distinct from terminal ED/clear-screen semantics.
- Retention and privacy controls with exact byte accounting.

### P2 — Attention, notifications, and session scale

For 100–500 sessions:

- Generic unread/attention state based on normalized events, never agent detection.
- Badge tabs/panes for exit, bell, command completion, and explicit OSC notification.
- Jump-to-next-attention and acknowledge commands.
- Notification coalescing, rate limits, focus suppression, and per-profile policy.
- No polling or mounted xterm instance per hidden session.

### P3 — Advanced terminal protocols

Add only with protocol fixtures, resource limits, and cross-terminal tests:

- Synchronized output.
- Kitty keyboard protocol.
- Verified Sixel and iTerm2 image behavior; keep image memory bounded.
- Kitty graphics only if a real application compatibility need justifies it.
- Light/dark mode notifications.
- Hyperlink IDs and semantic prompt/command marks.
- Secure keyboard entry indication and policy where the platform supports it.

Do not claim protocol support merely because an addon parses one happy-path sample.

### P3 — Remote mux domains

After local durability is complete:

- SSH-backed remote `taud` domains.
- Capability-negotiated reconnect and roaming.
- TLS only where SSH transport is unsuitable.
- Explicit host identity, trust, and known-hosts UX.
- Separate local/remote clipboard, link, notification, and file-open policies.
- Network loss tests that preserve remote PTYs and ordered graph replay.

Model this as a backend/domain capability. Do not scatter WSL/SSH path special cases through the renderer.

## Security requirements

- Allowlist external URL schemes; reject `javascript:`, `data:`, credentials in URLs, control characters, and oversized links.
- Treat OSC 8 labels and destinations as untrusted terminal output. xterm.js itself warns that custom link handlers must validate destinations ([xterm.js terminal options](https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/)).
- Require explicit policy/consent for OSC 52 clipboard writes and bound decoded payload size.
- Paste confirmation for multiline or suspicious control-bearing text, configurable per trusted profile.
- Bound titles, cwd values, notification bodies, image dimensions, image bytes, search expressions, and history page sizes.
- Never expose arbitrary filesystem open, process spawn, or socket APIs to the renderer.
- Keep secrets out of core until a feature explicitly needs them; then use Tau-owned permission UI and the OS credential store.
- Extension actions receive bounded semantic events or explicit user selections, not the terminal byte stream by default.

## Definition of quality for each feature

A feature is complete only when it has:

1. A stable command or protocol contract.
2. Daemon-authoritative mutation semantics where durable state is involved.
3. Bounds, validation, and explicit failure codes.
4. Keyboard and accessibility behavior.
5. Unit, integration, multi-client, restart, and malformed-input coverage as applicable.
6. Packaged latency/memory/idle measurements.
7. No terminal bytes in React state.
8. No per-session idle renderer work for hidden sessions.
9. Documented upgrade and downgrade behavior.
10. A way to disable optional behavior at zero runtime cost.

## Suggested delivery slices

1. **Input and compatibility gate:** mandatory packaged echo test, old-daemon upgrade test, keyboard matrix.
2. **Command foundation:** command registry, palette, context keys, conflict-aware keybindings.
3. **Mux completeness:** rename/move/swap/resize/zoom/detach with revision tests.
4. **Terminal polish:** search options, selection/context actions, safe file links, title policy.
5. **Settings/accessibility:** appearance, profiles, live runtime updates, contrast and screen-reader modes.
6. **Shell marks/history:** OSC 7/133, prompt navigation, daemon-paged history and search.
7. **Attention at scale:** generic notifications and 100/500-session gates.
8. **Advanced protocols:** synchronized output and keyboard/image protocols, individually gated.
9. **Remote domains:** only after all local durability exit criteria pass.

This order reaches and surpasses T3 Code's generic terminal UX without weakening Tau's mux-kernel architecture.

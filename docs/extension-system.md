# Extension System

This document proposes the extension architecture for Tau's terminal-multiplexer pivot. The API examples describe direction, not a frozen compatibility contract.

## Goals

- Keep the mux kernel and packaged application small while allowing complete terminal workflows to be assembled on demand.
- Make simple extensions as easy to author as Pi extensions, including a no-build TypeScript path.
- Let humans and agents inspect the installed API, generate extensions, validate them, and reload them non-interactively.
- Let independent extensions compose without importing Tau internals.
- Make activation, deactivation, reload, failure, and migration explicit.
- Keep extensions off the terminal byte path by default and preserve terminal latency budgets.
- Keep terminal sessions alive even when an extension or renderer fails.

## Non-goals

- Making PTY ownership, split layout, settings storage, or trust prompts replaceable.
- Treating arbitrary code as sandboxed when it is not.
- Exposing the Electron main process or React tree as a public API.
- Coupling extension APIs to Pi, Git, repositories, or AI agents.

## Package Shape

A single-file extension exports a factory:

```ts
import type { ExtensionAPI } from '@tau/sdk'

export default function activate(tau: ExtensionAPI) {
  tau.commands.register('clock.show', {
    title: 'Show clock',
    run: (context) => context.ui.notify(new Date().toLocaleTimeString()),
  })
}
```

A package can declare one or more entries:

```json
{
  "name": "tau-clock",
  "keywords": ["tau-extension"],
  "tau": {
    "extensions": ["./extensions/index.ts"]
  }
}
```

Discovery starts with:

| Location                       | Scope             | Trust                                  |
| ------------------------------ | ----------------- | -------------------------------------- |
| `~/.tau/extensions/*.ts`       | User              | Explicitly enabled by the user         |
| `~/.tau/extensions/*/index.ts` | User              | Explicitly enabled by the user         |
| `.tau/extensions/*.ts`         | Directory         | Loaded only after directory trust      |
| Explicit settings path         | User or directory | Same trust as the owning settings file |

npm and git package installation can be added after local discovery, reload, and safe mode are reliable.

## Agent Authoring Contract

An agent working in a Tau pane should be able to build an extension against the exact installed version without web research or a Tau source checkout.

The installed application should provide:

- Version-matched TypeScript types, concise Markdown documentation, and complete examples.
- Machine-readable manifests for APIs, events, commands, contribution points, settings schemas, and capabilities.
- A no-build loader for local TypeScript extensions, with expensive transpilation machinery loaded only when needed.
- Structured commands equivalent to:

  ```text
  tau extension inspect --json
  tau extension check ./my-extension.ts --json
  tau extension activate ./my-extension.ts --dry-run --json
  tau extension reload com.example.my-extension --json
  tau extension logs com.example.my-extension --json
  ```

- Stable diagnostic codes, source locations, actionable validation errors, and nonzero exit statuses.
- Atomic reload: validate and activate the new instance before disposing the working instance when capabilities permit it.
- A tiny starter template that an agent can copy rather than a required generator framework.

These command names are illustrative until the CLI contract is frozen. Their structured behavior is a requirement.

Agent-generated code receives no implicit privilege. Directory trust, capability approval, source visibility, and safe mode work exactly as they do for human-authored extensions.

## Lifecycle

```text
Tau starts
  -> extensions:discover
  -> extension:will-activate
  -> activate(factory)
  -> extension:did-activate
  -> window:open
  -> tab/pane/session events
  -> extension:will-deactivate
  -> dispose all owned registrations
  -> extension:did-deactivate
```

Activation may be asynchronous but has a timeout. Long-lived work starts from a lifecycle handler, not module evaluation. Deactivation is idempotent and receives an abort signal.

Every registration is owned automatically by the active extension. The runtime disposes leaked registrations even if the extension's own cleanup throws.

## API Shape

Registries use one consistent pattern:

```ts
interface Registry<T> {
  register(contribution: T): Disposable
}

interface Disposable {
  dispose(): void
}
```

An illustrative API:

```ts
interface ExtensionAPI {
  readonly extension: {
    id: string
    version: string
    source: string
  }

  readonly commands: CommandRegistry
  readonly keybindings: KeybindingRegistry
  readonly launchers: LauncherRegistry
  readonly panes: PaneRegistry
  readonly chrome: ChromeRegistry
  readonly settings: SettingsRegistry
  readonly themes: ThemeRegistry
  readonly storage: ExtensionStorage

  on<K extends keyof TauEvents>(
    event: K,
    handler: (event: TauEvents[K], context: ExtensionContext) => void | Promise<void>,
  ): Disposable
}
```

`ExtensionContext` exposes stable capabilities and snapshots, not internal stores:

```ts
interface ExtensionContext {
  readonly windowId: string | null
  readonly tabId: string | null
  readonly paneId: string | null
  readonly sessionId: string | null
  readonly cwd: string | null
  readonly signal: AbortSignal
  readonly ui: ExtensionUI
  readonly sessions: SessionCapabilities
  readonly layout: LayoutCapabilities
}
```

## Contribution Points

### Commands

Commands are the common action layer for the command palette, menus, keybindings, and extension UI.

```ts
tau.commands.register('example.restart-active-session', {
  title: 'Restart active session',
  category: 'Example',
  when: 'pane.type == terminal && session.status == exited',
  run: ({ sessions, sessionId }) => sessions.restart(sessionId),
})
```

IDs are namespaced. Core commands use `tau.*`; extensions use their package ID. Duplicate IDs are rejected with diagnostics rather than resolved by load order.

### Keybindings

Extensions contribute defaults against command IDs. User bindings always win. Conflicts are shown in settings and remain deterministic.

### Launchers

Launchers describe how to create a session or extension pane:

```ts
tau.launchers.register({
  id: 'example.dev-shell',
  title: 'Development shell',
  kind: 'terminal',
  resolve: async (context) => ({
    cwd: context.cwd,
    argv: ['nix', 'develop'],
  }),
})
```

A Pi extension should use a launcher rather than a core-only Pi pane type.

### Panes

The terminal pane remains built in. Extensions may add pane types through a bounded host contract. Custom panes do not receive access to core React components or the DOM outside their host.

The initial implementation should prefer declarative views or isolated web contents. Trusted in-renderer component modules can be considered later, but only as an explicit high-risk capability.

### Chrome

Extensions may contribute to declared slots:

- Sidebar views.
- Tab and pane actions.
- Toolbar groups.
- Status items.
- Command-palette sources.
- Pane decorations.

Each item declares a stable ID, placement, priority, visibility expression, and command. Security-sensitive core UI is not a slot.

### Settings

Settings contributions are schema-driven:

```ts
tau.settings.register({
  id: 'example.general',
  title: 'Example',
  order: 100,
  scope: ['user', 'directory'],
  schema: {
    type: 'object',
    properties: {
      greeting: {
        type: 'string',
        title: 'Greeting',
        default: 'Hello',
      },
    },
  },
  migrate(previous, fromVersion) {
    return previous
  },
})
```

Values are stored under the extension ID and validated on read and write. Disabling an extension hides its section but retains data until the user explicitly removes it.

A custom settings renderer is a later capability. The schema renderer must cover ordinary text, number, boolean, enum, path, keybinding, and secret fields first.

### Events

Initial events should be observational unless an interception point is explicitly required:

- `window:opened`, `window:closed`.
- `tab:created`, `tab:focused`, `tab:closed`.
- `pane:created`, `pane:focused`, `pane:closed`.
- `session:starting`, `session:started`, `session:detached`, `session:exited`.
- `session:title-changed`, `session:cwd-changed`.
- `settings:changed`.
- `extension:reloaded`.

Interception hooks such as environment mutation or terminal input/output filters require dedicated capabilities, deterministic middleware order, timeouts, and fail-open/fail-closed semantics.

## Automation Control Plane

Extensions are for durable behavior; the control plane is for scripts, agents, and one-off composition. Both operate on the same command and capability model.

A versioned local protocol, exposed through `tau ctl --json`, should support:

- Listing windows, tabs, panes, sessions, commands, launchers, and enabled extensions.
- Creating, naming, moving, splitting, focusing, resizing, and closing tabs and panes.
- Launching commands in new or existing terminal sessions.
- Invoking registered commands with structured arguments.
- Reading non-sensitive session metadata and subscribing to lifecycle events.
- Validating, enabling, disabling, and reloading extensions.
- Returning stable object IDs, error codes, and protocol versions.

Session/process requests route to `taud`; window/layout requests route to the desktop host. The CLI must not launch a second Electron UI merely to control the running app. Text formatted for humans may be available, but JSON must be the canonical automation interface so agents never scrape labels or terminal pixels.

Sending terminal input, reading buffered output, filesystem access, and process spawning are privileged operations. The control API must apply the same capability and trust policy as extensions.

## Composition

### Ownership

The host records the owner of every command, setting section, launcher, event handler, and UI item. Deactivation removes everything owned by that extension in reverse registration order.

### Ordering

Ordered UI contributions use named anchors:

```ts
{ placement: { after: 'tau.status.session' }, priority: 20 }
```

The host topologically resolves anchors, then uses priority and contribution ID as stable tie-breakers. Cycles are diagnosed and fall back to ID order.

### Overrides

Normal contributions are additive. Replacing a core command, renderer, or launcher requires:

1. An override-specific API.
2. A declared capability.
3. User approval naming both the original and replacement.
4. A guaranteed fallback when the extension unloads.

### Shared State

Extensions communicate through typed public events or explicit capabilities. They do not read one another's storage. Optional dependencies are discovered by capability ID, not filesystem imports.

## Settings Storage

A future settings file should separate core and extension data:

```json
{
  "version": 2,
  "core": {
    "appearance": {},
    "terminal": {},
    "mux": {},
    "keybindings": {},
    "extensions": {}
  },
  "extensionData": {
    "com.example.clock": {
      "version": 1,
      "values": {}
    }
  }
}
```

Requirements:

- Atomic writes.
- Schema validation at the process boundary.
- Per-section migrations.
- Unknown extension data preserved losslessly.
- Secrets stored through the OS credential store, not plain JSON.
- User and trusted directory scopes merged predictably.

## Execution and Isolation

The long-term boundary is:

```text
Renderer UI <-> Extension host <-> Electron main <-> taud
```

- `taud` remains the sole owner of PTYs and durable process sessions.
- The renderer displays registered contributions and sends commands.
- A dedicated extension host executes trusted extension code.
- Main and daemon capabilities are exposed through narrow RPC methods.

Until a dedicated host exists, extensions must be labeled "trusted, in-process code." The UI must include safe mode that starts Tau without third-party extensions and does not require those extensions to render the settings page.

## Performance and Size Contract

Extensibility cannot tax users who have no extensions enabled:

- The extension loader and TypeScript path are lazy and absent from terminal startup work where possible.
- Disabled and event-lazy extensions consume no renderer frames and create no timers, watchers, or processes.
- Extension activation and handlers have time and memory diagnostics.
- High-frequency terminal output is not emitted as ordinary extension events. Extensions request explicit, bounded observation capabilities.
- Status and decoration updates are coalesced and rate-limited before reaching React.
- Custom panes are independently containable and cannot force the terminal canvas to rerender.
- The SDK reuses host types/protocols and avoids bundling a second application runtime into every package.
- First-party workflow extensions are packaged and measured separately from core.

CI should compare startup, input latency, throughput, frame pacing, idle CPU, memory, and package size with zero extensions, representative extensions, and a deliberately failing extension. Extension work is incomplete if it regresses the terminal hot path or core artifact budget.

## Capabilities

Example capability declarations:

- `sessions.read` / `sessions.control`.
- `layout.read` / `layout.control`.
- `filesystem.read` / `filesystem.write`.
- `process.spawn`.
- `network`.
- `terminal.environment`.
- `terminal.input.intercept`.
- `terminal.output.observe` / `terminal.output.intercept`.
- `ui.chrome` / `ui.custom-pane` / `ui.renderer-code`.
- `secrets`.

Capabilities are visible in extension settings. A capability declaration is not a sandbox by itself; enforcement must exist at the process/RPC boundary before Tau claims it is restricted.

## Failure and Recovery

- Activation failures are shown in Extensions settings with source and stack trace.
- Slow handlers have budgets and diagnostics.
- Event dispatch catches failures per extension.
- A renderer reload never kills daemon-owned sessions.
- Repeated startup failure offers safe mode automatically.
- Disabling or reloading an extension cannot make its custom panes silently execute as another pane type; unavailable panes show a recoverable placeholder.
- Extension logs are namespaced and exportable.

## First Vertical Slice

The first implementation should prove the architecture with no marketplace and no arbitrary custom renderer:

1. Define extension metadata, events, disposables, registries, and performance budgets.
2. Discover explicitly configured user-local extensions through a lazy no-build TypeScript path.
3. Support commands, launchers, status items, and schema-rendered settings.
4. Add machine-readable API inspection, validation, dry-run activation, diagnostics, reload, disable, and safe mode.
5. Add a JSON control slice for listing panes, creating a split, launching a process, invoking a command, subscribing to events, and reloading an extension.
6. Build a sample extension that launches a shell command, adds a status item, and exposes one setting.
7. Have an agent create and revise that extension using only installed docs and structured CLI output.
8. Build a Pi convenience extension using exactly the same public API.
9. Verify both can be disabled while their daemon-owned sessions remain attachable.
10. Verify zero-extension startup, terminal latency, memory, idle use, and package size remain within budget.

# Tau

Tau is a performance-first, agent-extensible graphical terminal multiplexer. It pairs a deliberately lean Electron/React terminal UI with a Zig daemon (`taud`) that owns PTYs, persistence, snapshots, and attachable sessions.

Tau has three co-equal goals: extreme terminal performance, the smallest practical distribution above Electron's runtime floor, and a composable extension/control API that agents can script and build on. It is terminal-first rather than a chat UI or IDE. Core is a mux kernel: tabs, splits, sessions, commands, keybindings, settings, automation, and (later) extension hosting. Projects, Git, worktrees, Pi, and other workflows return only as optional extensions. See [`TODO.md`](TODO.md) and [`docs/`](docs/).

## What is in this repo

- **Desktop app** (`apps/desktop`): Electron, React, xterm.js WebGL, tabs/splits, settings, and terminal recovery UI.
- **Daemon** (`apps/daemon`): Zig `taud` process for PTY lifecycle, VT parsing via `libghostty-vt`, snapshots, event logs, SQLite metadata, and mux graph authority.
- **Shared package** (`packages/shared`): typed session, mux-graph, and control/stream protocol definitions used by main, preload, renderer, and scripts.

`taud` runs outside the renderer so live sessions can survive window reloads/restarts. The Electron app is mostly a client: it starts or connects to the daemon, opens attach streams over Unix sockets, and renders terminal/session state.

## Quick start

```bash
nix develop          # Pinned Bun, Node compatibility tools, Zig 0.15.x, ZLS, nixpkgs-fmt
bun install --frozen-lockfile
bun run dev             # build taud, then start Electron with HMR
```

Other common commands:

```bash
bun run build        # production desktop build, including taud
bun run start        # run the built Electron app
bun run check        # lint, format checks, TypeScript, persistence/tooling tests, Zig tests
bun run zig:check    # Zig lint + format check + tests
```

Bun's version is pinned in root `package.json`; Nix and CI use that version. Bun manages
workspaces, runs TypeScript and tests, and hosts the Vite tooling. Electron still runs
the desktop app, and Zig still builds/runs `taud`. Use `bun run build`, not `bun build`
(the latter is Bun's own bundler). See [tooling benchmarks](docs/tooling-benchmarks.md)
for migration scope, measured before/after results, and reproduction.

## Layout

```text
tau/
├── apps/
│   ├── daemon/      # Zig taud mux daemon
│   └── desktop/     # Electron main/preload/renderer app and benchmarks
├── packages/        # Shared workspace packages
├── docs/            # Mux invariants, domain model, byte path, SLOs, security
├── scripts/         # Repo-level maintenance and packaging scripts
├── patches/         # Dependency patches, if needed
└── assets/          # Shared assets
```

## Benchmarks

Benchmarks live under `apps/desktop/bench` and are exposed through root scripts where useful:

```bash
bun run bench                 # parser comparison benchmark
bun run bench:latency         # taud input latency
bun run bench:renderer        # xterm.js DOM vs WebGL renderer
bun run bench:cross           # cross-terminal comparison
bun run bench:startup         # startup timing
bun run bench:all             # desktop benchmark bundle
bun run --filter @tau/desktop bench:taud  # taud vs node-pty comparison
bun run bench:tooling --manager bun --output out/bench/tooling-bun.json
```

See [`apps/desktop/bench/TAUD-BENCHMARK-RESULTS.md`](apps/desktop/bench/TAUD-BENCHMARK-RESULTS.md) for methodology and captured results.

## Docs

- [`rework.md`](rework.md) — terminal-multiplexer pivot and migration plan
- [`docs/extension-system.md`](docs/extension-system.md) — proposed extension architecture and composition rules
- [`docs/README.md`](docs/README.md) — architecture notes and plans
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — setup, workflow, style, and daemon memory-safety notes
- [`packages/README.md`](packages/README.md) — shared package summary

## License

[MIT](LICENSE)

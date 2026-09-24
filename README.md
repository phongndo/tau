# Tau

Tau is an experiment to see how fast a native Electron terminal multiplexer can be. It uses xterm.js and a Zig daemon (`taud`). It opens into a shell; tabs and splits organize terminals, while daemon-owned PTYs can survive a window or renderer restart.

Today the desktop app has a sidebar-based mux UI, terminal search, preferences (appearance, terminal, shortcuts, sessions), and session recovery. A structured control CLI and extension runtime are product goals, **not shipped APIs**. Pi, Git, and project workflows are not built into the terminal.

## Run locally

```bash
nix develop
bun install --frozen-lockfile
bun run dev
```

The dev shell provides the pinned Bun and Zig toolchains. On NixOS, the install script also prepares the Electron binary for the host. For non-interactive commands use `nix develop -c <command>`.

```bash
bun run build   # Build the desktop app and taud
bun run start   # Run the built app
bun run check   # Lint, format, TypeScript, curated tests, and Zig tests
```

Use `bun run build`, not `bun build` (Bun's own bundler). Script names and benchmark budgets live in [package.json](package.json) and [apps/desktop/package.json](apps/desktop/package.json).

## Find your way around

- [apps/desktop](apps/desktop): Electron shell and preload, Solid UI, Bun preferences service, terminal tests and benchmarks.
- [apps/daemon](apps/daemon): Zig PTY, mux graph, snapshots, event log and SQLite metadata.
- [packages/shared](packages/shared): shared schemas and protocol definitions.
- [docs/README.md](docs/README.md): current technical notes and dated performance evidence.
- [CONTRIBUTING.md](CONTRIBUTING.md): development and verification guidance.

## License

[MIT](LICENSE)

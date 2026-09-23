# Contributing to Tau

## Setup

Install [Nix with flakes enabled](https://nixos.org/download), then:

```bash
git clone https://github.com/phongndo/tau.git
cd tau
nix develop
bun install --frozen-lockfile
bun run dev
```

For one-off commands use `nix develop -c <command>`. Bun's version is pinned in [package.json](package.json); Nix pins Zig and supplies Node for compatibility. The root `postinstall` handles Electron installation and NixOS ELF repair. Use `bun run <script>` for repository scripts rather than Bun's built-in `bun build` or unscoped `bun test`.

## Changing code

- Follow the boundary in [docs/architecture.md](docs/architecture.md): `taud` owns durable PTYs and the mux graph; Electron main owns the bridge, and the renderer presents terminals. Keep terminal bytes off the React state path.
- For output transport and recovery changes, read [docs/terminal-byte-path.md](docs/terminal-byte-path.md) and run `bun run test:persistence`; for daemon changes run `bun run zig:test`.
- `bun run check` runs the curated lint, format, TypeScript, Bun tests, and Zig tests. `bun run build` checks the production bundle. For performance-sensitive changes use the relevant benchmark script in [package.json](package.json); distinguish headless smoke results from hardware-renderer measurements.
- Zig ownership changes: use `std.testing.allocator` in tests, pair acquired resources with cleanup on partial failure, and exercise teardown. `bun run zig:leak-check` runs the daemon with a debug allocator under a temporary `HOME` rather than touching `~/.tau`.

TypeScript uses oxlint and oxfmt; Zig uses `zig fmt` and `zig ast-check`. `bun run fmt` formats TypeScript and Zig. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).

## Documentation

Keep current behavior and non-obvious boundaries in the owning code or technical note; link to scripts and schemas rather than copying inventories or command flags. Replace stale claims when behavior changes. Put dated, reproducible measurements in `docs/benchmarks/` with hardware, commands, samples, and limitations. Use issues or a working session for speculative plans and progress checklists; Git preserves old versions.

Tau is licensed under [MIT](LICENSE).

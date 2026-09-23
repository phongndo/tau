# Contributing to Tau

Thanks for your interest in contributing!

## Getting Started

### Prerequisites

Install [Nix](https://nixos.org/download) — if using the standard installer, enable flakes by adding `experimental-features = nix-command flakes` to `~/.config/nix/nix.conf`. The [Determinate Nix Installer](https://github.com/DeterminateSystems/nix-installer) enables flakes by default. Then:

```bash
git clone https://github.com/phongndo/tau.git
cd tau
nix develop          # Enter the reproducible dev shell
bun install --frozen-lockfile
bun run dev             # Start terminal with HMR
```

## Development Workflow

1. **Fork** the repository
2. **Create a branch** (`feat/split-panes`, `fix/escape-key`, etc.)
3. **Make your changes**
4. **Run checks:**
   ```bash
   bun run check  # TypeScript + Zig lint/format/type/test checks
   bun run build  # Production build, including taud
   bun run bench  # Verify no performance regressions
   ```
5. **Commit** using [Conventional Commits](https://www.conventionalcommits.org/):
   ```
   feat: add split pane support
   fix: escape key not working in nvim
   perf: optimize vertex packing loop
   docs: update WebGL renderer plan
   ```
6. **Push** and open a **Pull Request**

## Project Structure

```
tau/
├── apps/
│   ├── daemon/        # Zig taud persistence daemon
│   └── desktop/
│       ├── src/
│       │   ├── main/       # Electron main process (window, PTY, IPC)
│       │   ├── preload/    # contextBridge (security boundary)
│       │   └── renderer/   # Terminal UI (ghostty-web + rendering)
│       ├── bench/      # Desktop benchmark suite
│       └── public/     # Desktop runtime assets
├── packages/           # Shared workspace packages
├── docs/               # Architecture + plans
├── scripts/            # Repo-level maintenance scripts
├── patches/            # Future dependency patches
├── assets/             # Shared repo assets
└── .github/            # CI + templates
```

## Architecture

See [docs](docs/README.md) for architecture notes and plans.

## Code Style

- **TypeScript**: `oxlint` for linting and `oxfmt` for formatting.
- **Zig**: `zig fmt`, `zig ast-check`, and `zig build test` are wired through `bun run zig:*` scripts.
- **Nix**: `nix fmt` formats `flake.nix`; the dev shell provides `zig`, `zls`, `node` (compatibility), and the Bun version pinned in `package.json`.
- Run `bun run fmt` to auto-format TypeScript and Zig. Run `bun run zig:lsp` inside `nix develop` to verify the Zig language server is available.
- **Commit messages**: [Conventional Commits](https://www.conventionalcommits.org/).

## Zig Daemon Memory Safety

Fast local checks:

```bash
bun run zig:fmt:check
bun run zig:test
bun run zig:check
bun run --filter @tau/daemon check
```

Leak smoke check:

```bash
bun run zig:leak-check
```

`bun run zig:leak-check` runs `taud --check` with `TAUD_DEBUG_ALLOC=1` and a temporary `HOME`, so it does not mutate your real `~/.tau`. `TAUD_DEBUG_ALLOC=1` keeps production behavior unchanged except that `main.zig` uses Zig's `std.heap.DebugAllocator`; if the debug allocator reports a leak, `taud` exits nonzero.

When adding Zig code:

- Use `std.testing.allocator` in unit tests so the test runner reports leaks.
- Use `std.testing.FailingAllocator` or `std.testing.checkAllAllocationFailures` for constructors that allocate multiple owned fields or transfer ownership.
- Add `errdefer` immediately after every allocation/resource acquired during partial initialization.
- Exercise create → mutate → remove/deinit paths for sessions, VT state, snapshots, RPC JSON, event-log files, sqlite lookup results, and adapter helpers.
- Free every caller-owned slice in the same test that receives it.

There is also a manual/nightly GitHub Actions Valgrind workflow (`Memory Tools`). DebugAllocator is the required PR gate; Valgrind is slower and may need investigation if Zig/libc/sqlite/Ghostty report platform-specific noise.

## License

Tau is licensed under MIT. All contributions are accepted under the same terms.

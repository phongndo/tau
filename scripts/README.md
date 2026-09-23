# Scripts

Repository-level maintenance scripts used by workspace packages.

- `zig-tools.ts` discovers Zig/ZON files under `apps/daemon` and runs `zig fmt`, `zig fmt --check`, or `zig ast-check` for cross-platform Bun scripts.
- `electron-install.ts` is the root `postinstall` and desktop `predev`/`prestart` repair hook. It downloads Electron and patches its ELF interpreter on NixOS. Electron's dependency lifecycle hook is deliberately not trusted, so there is only one installer.
- `bench-tooling.ts` measures frozen installs and real workspace commands under pnpm or Bun. See [`docs/tooling-benchmarks.md`](../docs/tooling-benchmarks.md) for methodology, captured results, and reproduction.

TypeScript scripts run directly under Bun. Use `bun run <script>` for package scripts (not `bun build`, which invokes Bun's bundler). Tests run with Bun's test runner; existing `node:test` and `node:assert` suites retain Bun's compatibility imports so their assertions stay portable to Node/Electron.

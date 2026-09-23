# Tau documentation

Start with the [project overview](../README.md) for setup and scope, or [contributing](../CONTRIBUTING.md) for development checks. These notes describe implemented behavior; schemas and scripts remain the source of truth for exact fields and commands.

- [Architecture](architecture.md) — daemon/desktop ownership, mux state, and security boundary. Read when changing persistence, graph mutations, or IPC.
- [Terminal byte path](terminal-byte-path.md) — output/input transport, buffer ownership, and reload recovery. Read when changing terminal I/O or output allocations.

## Measured evidence

These are dated results, not current performance promises:

- [Bun tooling migration](tooling-benchmarks.md) — macOS development workflow comparison and raw samples.
- [Dependency upgrade](benchmarks/dependency-upgrade-2026-09-23.md) — compatibility decisions and bounded before/after observations.
- [Output allocations](benchmarks/output-allocation-2026-09-23.md) — allocation counts, real-xterm workload, and packaged smoke results.

The executable benchmark definitions and thresholds are in [package.json](../package.json) and [apps/desktop/package.json](../apps/desktop/package.json). Check the code and rerun a relevant benchmark before relying on an older result.

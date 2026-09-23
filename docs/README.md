# Docs

Architecture notes, implementation plans, and performance methodology for Tau.

- [`../rework.md`](../rework.md) — terminal-multiplexer pivot and migration plan.
- [`extension-system.md`](extension-system.md) — proposed extension runtime, contribution points, settings host, composition, and trust model.
- [`plans/installer-channels.md`](plans/installer-channels.md) — installer and release-channel planning.
- [`benchmarks/dependency-upgrade-2026-09-23.md`](benchmarks/dependency-upgrade-2026-09-23.md) — dependency compatibility decisions and measured before/after performance.
- [`benchmarks/output-allocation-2026-09-23.md`](benchmarks/output-allocation-2026-09-23.md) — terminal allocation accounting, xterm writer comparison, and reload/input validation.
- [`terminal-byte-path.md`](terminal-byte-path.md) — current output/input flow, buffer ownership, batching, and reload teardown.

The Electron desktop app currently lives in `apps/desktop`.

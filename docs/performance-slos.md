# Performance SLOs (Phase 2.11)

## Reference configuration

| Dimension | Value |
| --- | --- |
| Hardware | Apple Silicon reference laptop (document exact model in CI metadata) |
| OS | macOS current stable |
| Power | Plugged in, default power mode |
| Display | 60 Hz or native ProMotion with refresh recorded |
| Build | Packaged Electron app + `taud` ReleaseFast (or measured ReleaseSmall) |

Every result must save: raw samples, traces, machine metadata, lockfile hash, commit SHA.

## Strict gates (packaged)

| Metric | p50 | p95 | p99 | Notes |
| --- | --- | --- | --- | --- |
| Daemon input round-trip | ≤ 8 ms | ≤ 20 ms | ≤ 40 ms | local socket |
| Key-to-display | ≤ 20 ms | ≤ 40 ms | ≤ 80 ms | idle terminal |
| Input during output flood | ≤ 40 ms | ≤ 120 ms | ≤ 250 ms | 8 MiB flood |
| PTY spawn | ≤ 40 ms | ≤ 100 ms | ≤ 200 ms | |
| Attach + snapshot | ≤ 50 ms | ≤ 150 ms | ≤ 300 ms | |
| Output throughput | ≥ 64 MiB/s sustained smoke floor | | | final screen exact |
| Frame time 1 pane | ≤ 8 ms p95 | ≤ 16 ms p99 | | flood |
| Frame time 4 panes | ≤ 12 ms p95 | ≤ 24 ms p99 | | |
| Frame time 8 panes | ≤ 16 ms p95 | ≤ 33 ms p99 | | |
| Idle CPU | ≈ 0% app + daemon | wakeups counted | | 100 detached sessions: no per-session renderer timers |
| Renderer RSS | scales with visible panes + warm LRU, not total sessions | | | |
| Recovery | renderer reload ≤ 8 s; attach ≤ 5 s; echo ≤ 1 s | | | |
| Core payload | report excluding Electron and including Electron separately | | | |

## Smoke vs strict

- Existing `TAU_*_ENFORCE` smoke ceilings remain as PR-relative floors.
- Strict thresholds above are nightly absolute gates on dedicated hardware.
- Never publish estimated parser throughput as an end-to-end product claim.

## Cross-terminal

Extend `bench:cross` to pinned cmux and Herdr versions where scenarios are comparable.

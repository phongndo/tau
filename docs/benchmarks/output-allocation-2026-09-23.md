# Terminal output allocation pass — 2026-09-23

## Scope and environment

Compare the output path at `27fb89c6879b1ed4f08e1873374229ce6ca7d190` with the allocation/batching changes accompanying this report. Dependencies are unchanged. See [byte-path ownership rules](../terminal-byte-path.md) for implemented behavior.

- Host `z`: NixOS, Linux 6.18.48, x86_64, AMD Ryzen 9 9950X, 32 logical CPUs.
- Commands run through `nix develop`; Bun 1.4.2, development Node 24.15.0.
- Electron 44.4.5: embedded Node 24.21.0, Chromium 152.0.7977.130, V8 15.2.124.28-electron.0. xterm 6.0.0.
- Xvfb: 1280×800×24. No hardware-display/GPU performance claim.
- `bun.lock` SHA-256: `5e1097fa96ba7089f8e89d343ce46d04fc755dbc836259f5e9308f0778ffc2ad`.
- After-source SHA-256: preload `125d4c5288d16f9e461b5cd6171edec4ba5c281bcea5c0bf7241d2eb850073f7`; writer `96f99be90357486f70014193276f12e9b6952532c8e3dd21a21af5e5fe11b0c3`.

## Allocation accounting

An isolated VM probe ran the real preload and writer implementations with mocked transport/xterm completion. Input: 2,048 × 4,096-byte frames (8 MiB). Counts instrument explicit decoder and writer byte-buffer construction, **not all runtime allocations or process RSS**.

| Measurement                                                            |    Before |     After |
| ---------------------------------------------------------------------- | --------: | --------: |
| Compatibility decoder constructions, binary-only session               |     2,048 |         0 |
| Compatibility decode calls, binary-only session                        |     2,048 |         0 |
| Retained compatibility text after delivery, characters                 | 1,048,576 |         0 |
| Writer byte-buffer constructions, isolated frames drained individually |     2,048 |         0 |
| Writer byte-buffer constructions, 256-frame queued waves               |     2,048 |       128 |
| Writer copied bytes, queued waves                                      | 8,388,608 | 8,388,608 |
| Writer writes/acknowledgements, queued waves                           |     2,048 |       128 |

Batching reduces object/callback churn, not the number of bytes copied into aggregate batches. The no-copy benefit applies to individually written, exact-sized, explicitly owned buffers. Main's socket-payload copy and Electron's cloning boundaries remain intentional.

The maintained preload and writer tests cover ownership, UTF-8 streaming, startup buffering, overflow recovery, bounded batching, queue compaction, synchronous/asynchronous completions, yielding, and disposal.

## Real xterm writer workload

A temporary Electron harness bundled each writer implementation and used the same real xterm terminal: 120 columns, 40 rows, 1,000 scrollback rows, default renderer, no WebGL addon. It queued 256-frame waves and awaited `drain()` between waves. Every run checked the final visible line and final acknowledged sequence.

Each frame contained `('0123456789abcdef'.repeat(7) + '\r\n').repeat(36)`: 4,104 bytes. Total: 2,048 frames / 8,404,992 bytes. One warm-up was discarded, followed by five samples per implementation. Baseline samples preceded after samples, rather than alternating. The standalone harness used Node integration and disabled background throttling to isolate xterm scheduling; production sandbox/context-isolation settings were not changed.

| Measurement                                        |      Before |      After |
| -------------------------------------------------- | ----------: | ---------: |
| Median write/drain duration                        | 16,935.1 ms | 1,243.2 ms |
| xterm writes / acknowledgements per run            |       2,048 |        144 |
| Queued-byte high-water mark                        |   1,050,624 |  1,050,624 |
| Worst observed interval of a 5 ms event-loop timer |     28.4 ms |    32.9 ms |

Raw duration samples, milliseconds:

- Before: `[16932.1, 16920.9, 16935.1, 16952.5, 16947.7]`
- After: `[1229.0, 1243.2, 1216.9, 1248.2, 1249.5]`

Raw per-run maximum timer intervals, milliseconds:

- Before: `[28.4, 21.0, 23.6, 26.9, 25.4]`
- After: `[25.5, 31.0, 20.5, 23.4, 32.9]`

This workload demonstrates removal of per-frame scheduling overhead. It does **not** establish a comparable whole-application speedup, lower RSS/CPU, improved physical presentation latency, or improved input latency. The timer probe does not replace an input-to-presentation measurement.

## Packaged correctness and loaded input

The original loaded-input probe missed echo markers when it trimmed the output tail before searching. The smoke now checks both completion and echo markers before trimming; there is regression coverage for an echo followed by more than 4 KiB of output. Earlier timeouts cannot serve as a latency baseline.

Five 8 MiB flood/input-echo smokes passed after the allocation changes. Echo samples were `[3.4, 10.3, 4.0, 7.3, 2.1]` ms. A final run after the bridge fix also passed, at 4.1 ms. This checks real IPC/PTY echo during output, not output rendered through the production xterm writer.

Reload validation exposed an in-flight attach whose snapshot arrived after its renderer port closed. The bridge now binds attach completion to the owning ports and generation, closes revoked streams, and prevents obsolete completions/errors from affecting a replacement renderer. Nine deterministic bridge tests cover cancellation and preserve propagation of current-owner failures.

A separate smoke-fixture conflict came from replacing the layout concurrently with UI startup. The smoke now observes the UI's persisted layout and verifies tab/pane IDs and active selection after reload; it does not retry conflicts or relax dropped-output checks.

Final validation:

- `bun run check` and `bun run build` passed.
- Reload budget smoke: **20/20** passed after both fixes.
- `bench:app-soak:budget`: passed, three reload cycles with two sessions, including echo and RSS bounds. This is a short budget check, not a long-term leak test.
- Final packaged 8 MiB flood/input smoke passed with no output-drop diagnostic.

Re-run package checks under an available display, through `nix develop -c`, using `bun run bench:reload:budget`, `bun run bench:app-soak:budget`, and `TAU_ELECTRON_SMOKE_OUTPUT_BYTES=8388608 TAU_ELECTRON_SMOKE_MAX_INPUT_ECHO_MS=500 TAU_ELECTRON_SMOKE_OUTPUT_TIMEOUT_MS=8000 bun run smoke:package`.

Temporary probe scripts, raw JSON, and diagnostic logs were kept in `/tmp/tau-output-opt/`, not added to the repository. That directory is session evidence, not a durable reproduction dependency; the workload and raw comparison samples are specified above.
